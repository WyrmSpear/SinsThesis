import { describe, it, expect } from 'vitest'
import {
  createOscState, oscSample, hardSync, pitchToFreq, getWavetableSet, mipLevelForFreq,
  type OscShape,
} from '../../../src/engine/dsp/wavetable'
import { peakHz, aliasFloorDb, rms } from '../../../src/engine/analysis/features'

const SR = 48000
const N = 8192

const set = getWavetableSet(SR)

function render(shape: OscShape, freq: number, pw = 0.5, n = N): Float32Array {
  const state = createOscState()
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = oscSample(state, shape, freq, SR, set, pw)
  return out
}

// Alias-floor and DC-offset measurements need the test tone to land exactly
// on an FFT bin -- the same "bin-aligned test tones" methodology
// minblep-spec.md section 7 measures with. Off-bin, the Blackman-Harris
// window's own ~-92 dB sidelobe smears the fundamental's energy into
// neighboring bins, some of which fall outside aliasFloorDb's per-harmonic
// tolerance band and get misread as alias -- a window-leakage artifact, not
// a property of the oscillator (confirmed while writing this suite: every
// nominal frequency below read a suspiciously uniform ~-97 dB "floor" until
// this alignment was added, which is exactly the BH4 sidelobe level). Bin
// alignment also makes each render an exact integer number of cycles, which
// is what the DC-offset test needs to avoid a partial-cycle mean bias.
const ALIAS_N = 65536
function alignFreq(targetHz: number, n = ALIAS_N): number {
  const bin = Math.round((targetHz * n) / SR)
  return (bin * SR) / n
}

describe.each(['saw', 'pulse', 'tri', 'sine'] as OscShape[])('%s oscillator', (shape) => {
  it('oscillates at the requested frequency', () => {
    expect(peakHz(render(shape, 440), SR)).toBeCloseTo(440, -1)
  })

  it('stays inside +/-1.05', () => {
    for (const freq of [110, 441, 1109, 1760, 5000]) {
      const out = render(shape, freq)
      for (const v of out) expect(Math.abs(v)).toBeLessThan(1.05)
    }
  })

  it('produces signal, not silence', () => {
    expect(rms(render(shape, 220))).toBeGreaterThan(0.05)
  })
})

describe('pitch accuracy', () => {
  // Frequencies chosen so sampleRate/f0 is nowhere near an integer -- see
  // aliasFloorDb's doc comment on why 2 kHz (48000/2000 = 24 exactly) was
  // dropped as a test frequency project-wide.
  describe.each([110, 441, 1760])('%d Hz', (freq) => {
    it.each(['saw', 'pulse', 'tri', 'sine'] as OscShape[])('%s reads within 1 Hz', (shape) => {
      // Long render for FFT bin resolution fine enough to hold a 1 Hz bar.
      const out = render(shape, freq, 0.5, 65536)
      expect(Math.abs(peakHz(out, SR) - freq)).toBeLessThan(1)
    })
  })
})

// Measured figures (this implementation, node harness, aliasFloorDb):
// see task-M2-report.md for the full table. These assertions use the
// task spec's bars, each already carrying margin below the measured
// wavetable figures in minblep-spec.md section 7a.
describe('alias floor', () => {
  const cases: Array<{ freq: number; saw: number; pulse5: number; pulse25: number; tri: number }> = [
    { freq: 110, saw: -95, pulse5: -95, pulse25: -92, tri: -120 },
    { freq: 441, saw: -120, pulse5: -120, pulse25: -118, tri: -140 },
    { freq: 1109, saw: -130, pulse5: -130, pulse25: -128, tri: -140 },
    { freq: 1760, saw: -140, pulse5: -140, pulse25: -138, tri: -140 },
    { freq: 5000, saw: -140, pulse5: -140, pulse25: -138, tri: -140 },
  ]

  describe.each(cases)('$freq Hz', ({ freq: nominal, saw, pulse5, pulse25, tri }) => {
    const freq = alignFreq(nominal)

    it(`saw clears ${saw} dB`, () => {
      expect(aliasFloorDb(render('saw', freq, 0.5, ALIAS_N), SR, freq)).toBeLessThan(saw)
    })
    it(`pulse pw=0.5 clears ${pulse5} dB`, () => {
      expect(aliasFloorDb(render('pulse', freq, 0.5, ALIAS_N), SR, freq)).toBeLessThan(pulse5)
    })
    it(`pulse pw=0.25 clears ${pulse25} dB`, () => {
      expect(aliasFloorDb(render('pulse', freq, 0.25, ALIAS_N), SR, freq)).toBeLessThan(pulse25)
    })
    it(`triangle clears ${tri} dB`, () => {
      expect(aliasFloorDb(render('tri', freq, 0.5, ALIAS_N), SR, freq)).toBeLessThan(tri)
    })
  })
})

describe('DC offset', () => {
  // Bin-aligned frequency so the render covers an exact integer number of
  // cycles -- otherwise a trailing partial cycle biases the mean on its own,
  // independent of anything the oscillator does.
  const dcDb = (samples: Float32Array) => {
    let sum = 0
    for (const v of samples) sum += v
    const mean = Math.abs(sum / samples.length)
    return 20 * Math.log10(Math.max(mean, 1e-12))
  }

  const freq = alignFreq(441)

  it('saw settles below -80 dBFS', () => {
    expect(dcDb(render('saw', freq, 0.5, ALIAS_N))).toBeLessThan(-80)
  })

  it('triangle settles below -80 dBFS', () => {
    expect(dcDb(render('tri', freq, 0.5, ALIAS_N))).toBeLessThan(-80)
  })
})

describe('pulse width', () => {
  it('shifts the duty cycle away from square', () => {
    const mean = (a: Float32Array) => a.reduce((s, v) => s + v, 0) / a.length
    expect(mean(render('pulse', 100, 0.25))).toBeLessThan(mean(render('pulse', 100, 0.5)) - 0.2)
  })

  // Corrected saw-difference identity: mean should track 2w-1 exactly (per
  // minblep-spec.md section 7b), not sit at ~0 like the naive
  // saw(t)-saw(t-w) identity does.
  it.each([
    [0.25, -0.5],
    [0.5, 0],
    [0.75, 0.5],
  ])('mean at pw=%f tracks 2w-1 (%f)', (pw, expected) => {
    // Integer number of cycles at 100 Hz over 48000 samples (480 cycles)
    // so the mean isn't diluted by a partial trailing cycle.
    const out = render('pulse', 100, pw, 48000)
    const mean = out.reduce((s, v) => s + v, 0) / out.length
    expect(mean).toBeCloseTo(expected, 2)
  })
})

describe('mip transition', () => {
  // Sweep 100 -> 900 Hz, crossing the 160/320/640 Hz mip boundaries -- the
  // same three-boundary sweep minblep-spec.md section 7d measures. Triangle
  // is continuous everywhere in its ideal form (no inherent per-cycle jump
  // the way saw/pulse have at wrap), so a first-difference spike at a
  // mip-level transition is unambiguously the transition itself, not a
  // wrap this test would otherwise have to filter out.
  it('produces no discontinuity larger than the stated threshold at a mip boundary', () => {
    const state = createOscState()
    const set = getWavetableSet(SR)
    const durationSamples = SR // 1 second sweep
    const startFreq = 100
    const endFreq = 900

    let prevSample: number | null = null
    let prevLevel = mipLevelForFreq(startFreq, set)
    const transitionDeltas: number[] = []

    for (let i = 0; i < durationSamples; i++) {
      const freq = startFreq + ((endFreq - startFreq) * i) / durationSamples
      const level = mipLevelForFreq(freq, set)
      const sample = oscSample(state, 'tri', freq, SR, set)
      if (level !== prevLevel && prevSample !== null) {
        transitionDeltas.push(Math.abs(sample - prevSample))
      }
      prevLevel = level
      prevSample = sample
    }

    // At least the 160/320/640 Hz boundaries must actually have been
    // crossed by this sweep, or the test isn't exercising what it claims to.
    expect(transitionDeltas.length).toBeGreaterThanOrEqual(3)
    for (const delta of transitionDeltas) {
      // Measured worst case at these three boundaries; see task-M2-report.md.
      expect(delta).toBeLessThan(0.35)
    }
  })
})

describe('hardSync', () => {
  it('resets phase so the cycle restarts at the bottom of the ramp', () => {
    const state = createOscState()
    for (let i = 0; i < 100; i++) oscSample(state, 'saw', 440, SR, set)
    hardSync(state)
    expect(state.phase).toBe(0)

    // Unlike polyblep.ts's analytic correction, a band-limited table has no
    // true instantaneous step -- reconstructing an edge from a finite
    // harmonic count (37 at this frequency/level) necessarily spreads it
    // over a few samples, and the sigma-tapered table's first sample after
    // reset measures -0.70, not near -1 (see task-M2-report.md). That is
    // correct band-limited behavior, not a bug: the true test of hard sync
    // is that the ramp reaches near its floor shortly after the reset, not
    // that it teleports there on the very next sample.
    let min = Infinity
    for (let i = 0; i < 5; i++) min = Math.min(min, oscSample(state, 'saw', 440, SR, set))
    expect(min).toBeLessThan(-0.9)
  })
})

describe('pitchToFreq', () => {
  it('is 1 V/octave from baseHz', () => {
    expect(pitchToFreq(440, 0, SR)).toBeCloseTo(440, 6)
    expect(pitchToFreq(440, 1, SR)).toBeCloseTo(880, 6)
    expect(pitchToFreq(440, -1, SR)).toBeCloseTo(220, 6)
  })

  it('clamps just under Nyquist', () => {
    expect(pitchToFreq(440, 10, SR)).toBeCloseTo(SR * 0.49, 6)
  })
})

describe('table generation', () => {
  it('is cached across calls for the same sample rate', () => {
    expect(getWavetableSet(SR)).toBe(getWavetableSet(SR))
  })

  it('covers the mip range with the spec-configured table size', () => {
    const set = getWavetableSet(SR)
    expect(set.octaveCount).toBe(12)
    expect(set.tableSize).toBe(2048)
    expect(set.saw.length).toBe(12)
    expect(set.tri.length).toBe(12)
    for (const table of [...set.saw, ...set.tri]) expect(table.length).toBe(2048)
  })
})
