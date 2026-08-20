import { describe, it, expect } from 'vitest'
import {
  buildSamplerBuffer, createSamplerState, sampleAt, samplerPlaybackRate,
  downmixToMono, computeWaveformPeaks, EMPTY_SAMPLER_BUFFER, SAMPLER_MIP_LEVELS,
  type SamplerParams,
} from '../../../src/engine/dsp/sampler'
import { aliasFloorDb, rms } from '../../../src/engine/analysis/features'
import { fftMagnitude } from '../../../src/engine/analysis/fft'

const SR = 48000

function sineTone(frames: number, f0: number, sampleRate = SR, amp = 0.8): Float32Array {
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) out[i] = amp * Math.sin((2 * Math.PI * f0 * i) / sampleRate)
  return out
}

const baseParams: SamplerParams = { tune: 0, start: 0, end: 1, mode: 'oneshot', reverse: false }

describe('samplerPlaybackRate', () => {
  it('is 1 at tune=0, cv=0 -- plays at the recorded pitch', () => {
    expect(samplerPlaybackRate(0, 0)).toBeCloseTo(1, 10)
  })

  it('doubles per octave of CV, same convention as pitchToFreq', () => {
    expect(samplerPlaybackRate(0, 1)).toBeCloseTo(2, 10)
    expect(samplerPlaybackRate(0, -1)).toBeCloseTo(0.5, 10)
    expect(samplerPlaybackRate(0, 2)).toBeCloseTo(4, 10)
  })

  it('tune in semitones composes with cv', () => {
    expect(samplerPlaybackRate(12, 0)).toBeCloseTo(2, 10)
    expect(samplerPlaybackRate(-12, 1)).toBeCloseTo(1, 6)
  })

  it('clamps gracefully at an extreme rather than exploding to Infinity', () => {
    expect(Number.isFinite(samplerPlaybackRate(0, 1000))).toBe(true)
    expect(Number.isFinite(samplerPlaybackRate(0, -1000))).toBe(true)
  })
})

describe('downmixToMono', () => {
  it('passes a mono buffer through unchanged', () => {
    const ch = new Float32Array([0.1, -0.2, 0.3])
    // Compared against `Array.from(ch)`, not the JS-double literals -- `ch`
    // is already float32-rounded (0.1 -> 0.10000000149011612), so the
    // meaningful claim is "no further change," not "equals the exact
    // mathematical value," which not even the input itself satisfies.
    expect(Array.from(downmixToMono([ch]))).toEqual(Array.from(ch))
  })

  it('averages stereo channels', () => {
    const l = new Float32Array([1, 0, -1])
    const r = new Float32Array([0, 0, 1])
    expect(Array.from(downmixToMono([l, r]))).toEqual([0.5, 0, 0])
  })
})

describe('buildSamplerBuffer', () => {
  it('builds SAMPLER_MIP_LEVELS mips, all the same length as the source', () => {
    const mono = sineTone(2000, 220)
    const buf = buildSamplerBuffer(mono, SR)
    expect(buf.mips.length).toBe(SAMPLER_MIP_LEVELS)
    for (const mip of buf.mips) expect(mip.length).toBe(mono.length)
    expect(buf.frames).toBe(mono.length)
  })

  it('level 0 is the unfiltered source, bit for bit', () => {
    const mono = sineTone(500, 220)
    const buf = buildSamplerBuffer(mono, SR)
    expect(Array.from(buf.mips[0]!)).toEqual(Array.from(mono))
  })

  it('higher mip levels measurably attenuate a tone above their own cutoff', () => {
    // A 12 kHz tone: comfortably inside level 0's passband (nyquist =
    // 24 kHz), but well above level 2's cutoff (~24000/4*0.85 = 5100 Hz).
    const mono = sineTone(8192, 12000)
    const buf = buildSamplerBuffer(mono, SR)
    const rmsLevel0 = rms(buf.mips[0]!.subarray(2000))
    const rmsLevel2 = rms(buf.mips[2]!.subarray(2000))
    expect(rmsLevel2).toBeLessThan(rmsLevel0 * 0.3)
  })

  it('a tone well below every mip level\'s cutoff passes through consistently -- the "level consistency" bar', () => {
    // 8 Hz sits far below even the top mip level's cutoff (nyquist/2^6 *
    // 0.75 ~= 281 Hz), so every level should read close to the same RMS as
    // the unfiltered source -- antialiasing shouldn't quietly rob level
    // from ordinary low-frequency material regardless of playback rate.
    const mono = sineTone(32768, 8)
    const buf = buildSamplerBuffer(mono, SR)
    const reference = rms(mono.subarray(4000))
    for (const mip of buf.mips) {
      expect(rms(mip.subarray(4000))).toBeGreaterThan(reference * 0.9)
    }
  })
})

describe('computeWaveformPeaks', () => {
  it('captures the true min/max within each bucket', () => {
    const mono = new Float32Array(100)
    mono[10] = 0.9
    mono[60] = -0.7
    const { min, max } = computeWaveformPeaks(mono, 10)
    expect(min.length).toBe(10)
    expect(max.length).toBe(10)
    expect(max[1]).toBeCloseTo(0.9, 5) // bucket 1 covers indices [10,20)
    expect(min[6]).toBeCloseTo(-0.7, 5) // bucket 6 covers indices [60,70)
  })

  it('handles an empty buffer without throwing', () => {
    const { min, max } = computeWaveformPeaks(new Float32Array(0), 10)
    expect(min.length).toBe(10)
    expect(max.length).toBe(10)
  })
})

describe('sampleAt: gate-triggered playback', () => {
  it('is silent until the gate rises', () => {
    const mono = sineTone(4000, 440)
    const buf = buildSamplerBuffer(mono, SR)
    const state = createSamplerState()
    expect(sampleAt(state, buf, 0, 0, baseParams, SR)).toBe(0)
    expect(sampleAt(state, buf, 0, 0, baseParams, SR)).toBe(0)
  })

  it('one-shot plays through to the end once triggered, ignoring gate release', () => {
    const mono = sineTone(2000, 440)
    const buf = buildSamplerBuffer(mono, SR)
    const state = createSamplerState()
    let anyNonzero = false
    // One sample of gate-high triggers it; release immediately afterward,
    // and a one-shot should still play the whole buffer through.
    sampleAt(state, buf, 1, 0, baseParams, SR)
    for (let i = 0; i < 2000; i++) {
      const v = sampleAt(state, buf, 0, 0, baseParams, SR)
      if (v !== 0) anyNonzero = true
    }
    expect(anyNonzero).toBe(true)
  })

  it('one-shot goes silent once it reaches the end of the region', () => {
    const mono = sineTone(500, 440)
    const buf = buildSamplerBuffer(mono, SR)
    const state = createSamplerState()
    sampleAt(state, buf, 1, 0, baseParams, SR)
    for (let i = 0; i < 500; i++) sampleAt(state, buf, 1, 0, baseParams, SR)
    // Well past the buffer's own length -- must have gone silent, not NaN
    // or stuck replaying garbage.
    for (let i = 0; i < 100; i++) expect(sampleAt(state, buf, 1, 0, baseParams, SR)).toBe(0)
  })

  it('loop mode stops on gate release and resumes fresh on the next rising edge', () => {
    const mono = sineTone(4000, 440)
    const buf = buildSamplerBuffer(mono, SR)
    const state = createSamplerState()
    const p: SamplerParams = { ...baseParams, mode: 'loop' }
    sampleAt(state, buf, 1, 0, p, SR) // rising edge, trigger
    for (let i = 0; i < 100; i++) sampleAt(state, buf, 1, 0, p, SR)
    // release
    expect(sampleAt(state, buf, 0, 0, p, SR)).toBe(0)
    expect(sampleAt(state, buf, 0, 0, p, SR)).toBe(0)
  })

  it('reverse plays from the end toward the start', () => {
    const mono = new Float32Array(1000)
    for (let i = 0; i < 1000; i++) mono[i] = i / 999 // ramp 0 -> 1
    const buf = buildSamplerBuffer(mono, SR)
    const state = createSamplerState()
    const p: SamplerParams = { ...baseParams, tune: -60, reverse: true } // very slow, to sample densely
    const first = sampleAt(state, buf, 1, 0, p, SR)
    const second = sampleAt(state, buf, 1, 0, p, SR)
    // Reading backward from near the end (~1.0) then moving toward the
    // start (~0.0): values should be decreasing near the top of the ramp.
    expect(first).toBeGreaterThan(second)
    expect(first).toBeGreaterThan(0.9)
  })

  it('an empty buffer stays silent and never throws', () => {
    const state = createSamplerState()
    expect(sampleAt(state, EMPTY_SAMPLER_BUFFER, 1, 0, baseParams, SR)).toBe(0)
  })
})

describe('sampleAt: exact-rate passthrough (interpolation sanity)', () => {
  it('reproduces the source almost exactly at rate=1 (tune=0, cv=0)', () => {
    const mono = sineTone(4000, 441)
    const buf = buildSamplerBuffer(mono, SR)
    const state = createSamplerState()
    const out = new Float32Array(3000)
    sampleAt(state, buf, 1, 0, baseParams, SR) // rising edge, sample 0
    out[0] = mono[0]!
    for (let i = 1; i < 3000; i++) out[i] = sampleAt(state, buf, 1, 0, baseParams, SR)
    // Cubic interpolation landing exactly on integer source samples at
    // rate 1 should reproduce them to within float rounding.
    let maxErr = 0
    for (let i = 0; i < 3000; i++) maxErr = Math.max(maxErr, Math.abs(out[i]! - mono[i]!))
    expect(maxErr).toBeLessThan(1e-5)
  })
})

// ---- alias floor across playback rates ------------------------------------
//
// Same methodology as tests/node/dsp/wavefolder.test.ts's own alias-floor
// tests: a non-commensurate fundamental (docs/CONTINUATION.md trap 1),
// Blackman-Harris windowed FFT, measured past a warmup region. Critically,
// the "recorded source" here is NOT a plain sine -- a pure tone has no
// energy near its own Nyquist for a resampler to mishandle, so measuring
// one would only prove "a sampler can play back silence-above-the-
// fundamental cleanly," which is true of even a naive nearest-sample
// reader. `richTone` below is a bandlimited-sawtooth-style sum of
// harmonics reaching up near the *source's own* Nyquist (`HARMONICS *
// ALIAS_F0` just under 24 kHz at 48 kHz) -- genuine high-frequency content
// that a faster-than-1x playback rate will try to push past the *output's*
// Nyquist unless the mip level actually in use has filtered it out first.
// This is the sampler's equivalent of the wavefolder test's folded sine:
// the stimulus a naive implementation would fail on.

const ALIAS_F0 = 1109
const HARMONICS = 20 // 1109 * 20 = 22180 Hz, just under 24 kHz Nyquist at 48 kHz
const ALIAS_N = 65536
const WARMUP = 4096

function richTone(frames: number, f0: number, sampleRate = SR): Float32Array {
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let s = 0
    for (let h = 1; h <= HARMONICS; h++) s += Math.sin((2 * Math.PI * f0 * h * i) / sampleRate) / h
    out[i] = s
  }
  let peak = 0
  for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(out[i]!))
  const norm = 0.8 / (peak || 1)
  for (let i = 0; i < frames; i++) out[i]! *= norm
  return out
}

function playedBackAt(rateOctaves: number, sourceFrames: number): Float32Array {
  const mono = richTone(sourceFrames, ALIAS_F0)
  const buf = buildSamplerBuffer(mono, SR)
  const state = createSamplerState()
  const out = new Float32Array(WARMUP + ALIAS_N)
  const p: SamplerParams = { ...baseParams, tune: 0 }
  for (let i = 0; i < out.length; i++) {
    out[i] = sampleAt(state, buf, 1, rateOctaves, p, SR)
  }
  return out.subarray(WARMUP)
}

describe('sampleAt: alias floor across playback rates', () => {
  it('reports the floor at each rate (see this file for the numbers this bar is measured against)', () => {
    const rates = [
      { octaves: 0, rate: 1 },
      { octaves: 0.585, rate: 1.5 },
      { octaves: 1, rate: 2 },
      { octaves: 1.585, rate: 3 },
      { octaves: 2, rate: 4 },
      { octaves: 3, rate: 8 },
      { octaves: 4, rate: 16 },
    ]
    const results: string[] = []
    for (const { octaves, rate } of rates) {
      const sourceFrames = Math.ceil((WARMUP + ALIAS_N) * rate) + 8
      const out = playedBackAt(octaves, sourceFrames)
      const floor = aliasFloorDb(out, SR, ALIAS_F0 * rate)
      results.push(`rate ${rate}x (fundamental ${(ALIAS_F0 * rate).toFixed(0)} Hz): ${floor.toFixed(2)} dB`)
    }
    // eslint-disable-next-line no-console
    console.log(results.join('\n'))
    expect(results.length).toBe(rates.length)
  })

  it('rate 1 (no pitch shift) stays clean -- regression check', () => {
    const out = playedBackAt(0, WARMUP + ALIAS_N + 8)
    expect(aliasFloorDb(out, SR, ALIAS_F0)).toBeLessThanOrEqual(-100)
  })

  it('rate 1.5 (a fractional rate, between mip levels) reaches RELEASE grade', () => {
    // The regression case: reading a fractionally-blended pair of mip
    // levels here used to measure only -32.6 dB (see safeMipLevel's own
    // doc comment) -- ceiling-selecting a single, fully safe level instead
    // fixed it. Measured -77.6 dB.
    const sourceFrames = Math.ceil((WARMUP + ALIAS_N) * 1.5) + 8
    const out = playedBackAt(0.5849625007211562, sourceFrames) // log2(1.5)
    expect(aliasFloorDb(out, SR, ALIAS_F0 * 1.5)).toBeLessThanOrEqual(-60)
  })

  it('rate 2 (one octave up) reaches RELEASE grade', () => {
    const sourceFrames = Math.ceil((WARMUP + ALIAS_N) * 2) + 8
    const out = playedBackAt(1, sourceFrames)
    expect(aliasFloorDb(out, SR, ALIAS_F0 * 2)).toBeLessThanOrEqual(-60)
  })

  it('rate 4 (two octaves up) reaches RELEASE grade', () => {
    const sourceFrames = Math.ceil((WARMUP + ALIAS_N) * 4) + 8
    const out = playedBackAt(2, sourceFrames)
    expect(aliasFloorDb(out, SR, ALIAS_F0 * 4)).toBeLessThanOrEqual(-60)
  })

  it('rate 8 (three octaves up) reaches RELEASE grade', () => {
    const sourceFrames = Math.ceil((WARMUP + ALIAS_N) * 8) + 8
    const out = playedBackAt(3, sourceFrames)
    expect(aliasFloorDb(out, SR, ALIAS_F0 * 8)).toBeLessThanOrEqual(-60)
  })

  it('rate 16 (four octaves up, near the top of the covered range) is reported honestly', () => {
    const sourceFrames = Math.ceil((WARMUP + ALIAS_N) * 16) + 8
    const out = playedBackAt(4, sourceFrames)
    const floor = aliasFloorDb(out, SR, ALIAS_F0 * 16)
    // eslint-disable-next-line no-console
    console.log(`rate 16x floor: ${floor.toFixed(2)} dB`)
    expect(floor).toBeLessThanOrEqual(-60)
  })
})

describe('sampleAt: no click at a mip level boundary', () => {
  it('crossing a level boundary is no worse than the material\'s own ordinary sample-to-sample motion', () => {
    // A rich, high-frequency-heavy source (harder to hide a level-switch
    // seam in than a plain sine), swept slowly through rate=2 -- the exact
    // boundary safeMipLevel switches levels at -- while playing. Compared
    // against the *same* material's own baseline delta (playing steadily,
    // no boundary crossed) rather than an assumed constant: a harmonically
    // rich signal has real high-frequency content of its own, which already
    // produces a nontrivial sample-to-sample delta with nothing wrong at
    // all -- the meaningful claim is "the boundary doesn't add a spike on
    // top of that," not "the delta is below some arbitrary number."
    const mono = richTone(20000, 400)
    const buf = buildSamplerBuffer(mono, SR)

    function maxDelta(cvAt: (i: number) => number): number {
      const state = createSamplerState()
      sampleAt(state, buf, 1, cvAt(0), baseParams, SR) // rising edge
      let worst = 0
      let prev = 0
      for (let i = 0; i < 4000; i++) {
        const v = sampleAt(state, buf, 1, cvAt(i), baseParams, SR)
        if (i > 0) worst = Math.max(worst, Math.abs(v - prev))
        prev = v
      }
      return worst
    }

    // Steady well inside level 1's territory (rate ~1.9) -- the baseline.
    const baseline = maxDelta(() => Math.log2(1.9))
    // Sweeps from just below rate=2 to just above it, crossing the
    // level 1 -> level 2 boundary partway through.
    const crossing = maxDelta((i) => Math.log2(1.999 + (0.003 * i) / 4000))

    expect(crossing).toBeLessThan(baseline * 2)
  })
})

// ---- loop-point crossfade: no click at the wrap ----------------------------

describe('sampleAt: loop wrap has no click', () => {
  it('a deliberately discontinuous loop region does not produce a large sample-to-sample jump', () => {
    const n = 4000
    const mono = new Float32Array(n)
    // A ramp from -0.9 to +0.9 with NO return to -0.9 -- a hard, naive wrap
    // here would jump by ~1.8 in one sample.
    for (let i = 0; i < n; i++) mono[i] = -0.9 + (1.8 * i) / (n - 1)
    const buf = buildSamplerBuffer(mono, SR)
    const state = createSamplerState()
    const p: SamplerParams = { ...baseParams, mode: 'loop', tune: -12 } // half rate: read densely, more wraps observed per source pass
    sampleAt(state, buf, 1, 0, p, SR)

    let maxDelta = 0
    let prev = 0
    const total = 20000 // several laps
    for (let i = 0; i < total; i++) {
      const v = sampleAt(state, buf, 1, 0, p, SR)
      if (i > 0) maxDelta = Math.max(maxDelta, Math.abs(v - prev))
      prev = v
    }
    const rawDiscontinuity = Math.abs(mono[0]! - mono[n - 1]!) // ~1.8
    expect(rawDiscontinuity).toBeGreaterThan(1.5)
    // The crossfaded wrap's worst single-sample step should be a small
    // fraction of what a hard, uncrossfaded wrap would produce.
    expect(maxDelta).toBeLessThan(rawDiscontinuity * 0.15)
  })

  it('the same small-delta guarantee holds across many wraps of ordinary (non-adversarial) material', () => {
    // A plain sine, several laps -- not the deliberately-discontinuous
    // ramp above. This is the same claim (bounded sample-to-sample step at
    // every wrap), checked with the same delta methodology rather than an
    // FFT alias-floor metric: a short, low-duty-cycle transient at each
    // wrap (the crossfade window) still shows up as broadband energy in an
    // FFT taken over many laps -- that metric answers "is there continuous
    // aliasing," not "is there a click," and the two are genuinely
    // different questions for a once-per-loop event. The declick claim
    // itself is a bounded-step claim, so it's measured as one.
    const periodSamples = 200
    const periods = 20
    const n = periodSamples * periods
    const mono = sineTone(n, SR / periodSamples, SR, 0.8)
    const buf = buildSamplerBuffer(mono, SR)
    const state = createSamplerState()
    const p: SamplerParams = { ...baseParams, mode: 'loop' }
    sampleAt(state, buf, 1, 0, p, SR)

    let maxDelta = 0
    let prev = 0
    for (let i = 0; i < 20000; i++) {
      const v = sampleAt(state, buf, 1, 0, p, SR)
      if (i > 0) maxDelta = Math.max(maxDelta, Math.abs(v - prev))
      prev = v
    }
    // The steady-state per-sample delta of a 0.8-amplitude sine at this
    // frequency is small; a click at the wrap would spike far above it.
    // Bounding against the signal's own peak-to-peak range (1.6) rather
    // than a bare constant keeps this comparable to the ramp test above.
    expect(maxDelta).toBeLessThan(1.6 * 0.15)
  })
})

// ---- DC offset --------------------------------------------------------------

describe('sampleAt: DC offset', () => {
  it('playing a zero-mean tone at various rates introduces no meaningful DC', () => {
    for (const octaves of [0, 1, -1, 2]) {
      const mono = sineTone(8000, 300)
      const buf = buildSamplerBuffer(mono, SR)
      const state = createSamplerState()
      const p: SamplerParams = { ...baseParams }
      const out = new Float32Array(6000)
      sampleAt(state, buf, 1, octaves, p, SR)
      for (let i = 0; i < 6000; i++) out[i] = sampleAt(state, buf, 1, octaves, p, SR)
      const mags = fftMagnitude(out.subarray(0, 4096), 'blackman-harris')
      const dcDb = 20 * Math.log10(Math.max(mags[0]!, 1e-12))
      expect(dcDb).toBeLessThan(-40)
    }
  })
})

// ---- stability under extreme settings --------------------------------------

describe('sampleAt: stability under extreme settings', () => {
  it('stays finite at an extreme positive pitch CV', () => {
    const mono = sineTone(2000, 440)
    const buf = buildSamplerBuffer(mono, SR)
    const state = createSamplerState()
    sampleAt(state, buf, 1, 50, baseParams, SR)
    for (let i = 0; i < 1000; i++) {
      const v = sampleAt(state, buf, 1, 50, baseParams, SR)
      expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('stays finite at an extreme negative pitch CV', () => {
    const mono = sineTone(2000, 440)
    const buf = buildSamplerBuffer(mono, SR)
    const state = createSamplerState()
    sampleAt(state, buf, 1, -50, baseParams, SR)
    for (let i = 0; i < 1000; i++) {
      const v = sampleAt(state, buf, 1, -50, baseParams, SR)
      expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('a degenerate (near-zero-width) loop region at a high rate does not hang or NaN', () => {
    const mono = sineTone(2000, 440)
    const buf = buildSamplerBuffer(mono, SR)
    const state = createSamplerState()
    const p: SamplerParams = { tune: 36, start: 0.5, end: 0.5001, mode: 'loop', reverse: false }
    sampleAt(state, buf, 1, 0, p, SR)
    for (let i = 0; i < 5000; i++) {
      const v = sampleAt(state, buf, 1, 0, p, SR)
      expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('start > end is clamped to a valid minimal region rather than crashing', () => {
    const mono = sineTone(2000, 440)
    const buf = buildSamplerBuffer(mono, SR)
    const state = createSamplerState()
    const p: SamplerParams = { tune: 0, start: 0.9, end: 0.1, mode: 'oneshot', reverse: false }
    expect(() => {
      sampleAt(state, buf, 1, 0, p, SR)
      for (let i = 0; i < 100; i++) sampleAt(state, buf, 1, 0, p, SR)
    }).not.toThrow()
  })

  it('rapid retriggering never produces a non-finite sample', () => {
    const mono = sineTone(2000, 440)
    const buf = buildSamplerBuffer(mono, SR)
    const state = createSamplerState()
    for (let i = 0; i < 2000; i++) {
      const gate = i % 7 < 3 ? 1 : 0 // fast on/off, forcing repeated edges
      const v = sampleAt(state, buf, gate, 0, baseParams, SR)
      expect(Number.isFinite(v)).toBe(true)
    }
  })
})
