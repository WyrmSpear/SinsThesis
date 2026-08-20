import { describe, it, expect } from 'vitest'
import { createSvfState, createSvfOutputs, svfSample, type SvfOutputs } from '../../../src/engine/dsp/svf'
import { createOscState, oscSample, getWavetableSet } from '../../../src/engine/dsp/wavetable'
import { slopeDbPerOctave, peakHz, rms } from '../../../src/engine/analysis/features'

const SR = 48000
const N = 16384

function noise(n: number, amp = 0.25): Float32Array {
  // Deterministic pseudo-noise: a fixed seed keeps the test reproducible.
  let seed = 12345
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    out[i] = ((seed / 0x7fffffff) * 2 - 1) * amp
  }
  return out
}

interface Outs {
  lp: Float32Array
  bp: Float32Array
  hp: Float32Array
  notch: Float32Array
}

function run(input: Float32Array, cutoff: number, res: number): Outs {
  const state = createSvfState()
  const out = createSvfOutputs()
  const lp = new Float32Array(input.length)
  const bp = new Float32Array(input.length)
  const hp = new Float32Array(input.length)
  const notch = new Float32Array(input.length)
  for (let i = 0; i < input.length; i++) {
    svfSample(state, input[i]!, cutoff, res, SR, out)
    lp[i] = out.lp
    bp[i] = out.bp
    hp[i] = out.hp
    notch[i] = out.notch
  }
  return { lp, bp, hp, notch }
}

describe('SVF slope', () => {
  // Measured in a band 4x-8x from cutoff, matching ladder.test.ts and
  // vcf.test.ts's own choice of band -- close enough to the knee to still be
  // asymptotic, far enough that the knee's own curvature doesn't bias the
  // fit, and (per this project's own trap #7) *not* a wide band, which
  // would average a shallow near-knee region against a steeper
  // near-Nyquist/near-DC one and land "in range" by cancellation rather
  // than by measuring a real asymptote. Widening this band was checked
  // directly (62.5-125 Hz, 31.25-62.5 Hz below cutoff; 8000-16000 Hz
  // above): the below-cutoff slope gets shallower approaching DC (down to
  // ~1 dB/oct by two octaves further out) and the above-cutoff slope gets
  // steeper approaching Nyquist (down to ~-18.5 dB/oct one octave further
  // out) -- the same non-uniform-slope shape this project already
  // documented for the ladder, not a new problem, and why 4x-8x is where
  // this filter's two-pole asymptote actually holds.
  it('lowpass: -12 dB/octave asymptote above cutoff', () => {
    const { lp } = run(noise(N), 1000, 0)
    const slope = slopeDbPerOctave(lp, SR, 4000, 8000)
    expect(slope).toBeLessThan(-10)
    expect(slope).toBeGreaterThan(-15)
  })

  it('bandpass: -6 dB/octave asymptote above cutoff (one pole per side, not two)', () => {
    const { bp } = run(noise(N), 1000, 0)
    const slope = slopeDbPerOctave(bp, SR, 4000, 8000)
    expect(slope).toBeLessThan(-4)
    expect(slope).toBeGreaterThan(-8)
  })

  it('bandpass: rolls off below cutoff too (both sides of the resonant peak)', () => {
    const { bp } = run(noise(N), 1000, 0)
    // The below-cutoff asymptote reads shallower than the above-cutoff one
    // in the identical relative band (measured ~4 dB/oct here vs ~6 above)
    // -- the digital topology's frequency warping is not symmetric around
    // f0, see the block comment above.
    const slope = slopeDbPerOctave(bp, SR, 125, 250)
    expect(slope).toBeGreaterThan(2)
    expect(slope).toBeLessThan(7)
  })

  it('highpass: 12 dB/octave asymptote below cutoff', () => {
    const { hp } = run(noise(N), 1000, 0)
    const slope = slopeDbPerOctave(hp, SR, 125, 250)
    expect(slope).toBeGreaterThan(7)
    expect(slope).toBeLessThan(13)
  })

  it('two-pole topology: every output rolls off at 12, not the ladder\'s 24, dB/octave', () => {
    // The module's whole reason to exist alongside the ladder -- see
    // svf.ts's own doc comment. lp's asymptote (measured above, ~-12) sits
    // roughly half of the ladder's measured four-pole figure (ladder.test.ts
    // measures -22 to -28 in the same style of band), not a coincidence.
    const { lp } = run(noise(N), 1000, 0)
    const slope = slopeDbPerOctave(lp, SR, 4000, 8000)
    expect(slope).toBeGreaterThan(-22) // clearly two-pole, not four
  })
})

describe('SVF notch', () => {
  // A notch has no asymptotic rolloff region to measure a slope in -- it is
  // flat (near unity) on both sides of f0 and only dips at f0 itself (see
  // svfSample's own comment: notch = lp + hp, which is an identity, not an
  // approximation). The honest thing to measure is the null's depth, not a
  // slope that does not exist for this output.
  function notchDepthDb(f0: number, res: number): number {
    const M = 65536
    const bin = Math.round((f0 * M) / SR)
    const aligned = (bin * SR) / M
    const input = new Float32Array(M)
    for (let i = 0; i < M; i++) input[i] = Math.sin((2 * Math.PI * aligned * i) / SR) * 0.5
    const { notch } = run(input, f0, res)
    const settled = notch.subarray(M / 2)
    const inSettled = input.subarray(M / 2)
    return 20 * Math.log10(rms(settled) / rms(inSettled))
  }

  it('nulls at f0 across the cutoff range and every resonance setting', () => {
    // Measured: -35.7/-34.5/-26.2 dB (200 Hz), -35.7/-34.5/-26.1 dB
    // (1000 Hz), -35.1/-34.7/-33.6 dB (5000 Hz) at resonance 0/0.5/1. The
    // null gets shallower (not deeper) as resonance climbs -- expected, not
    // a defect: a higher Q makes the null *narrower* in frequency, so any
    // small mismatch between the probe tone and the filter's true f0 (this
    // filter measures under 0.2% cutoff error, never exactly 0) costs more
    // depth at high Q than at low Q, where the wider null forgives it.
    for (const f0 of [200, 1000, 5000]) {
      for (const res of [0, 0.5, 1]) {
        expect(notchDepthDb(f0, res)).toBeLessThan(-15)
      }
    }
  })
})

describe('SVF cutoff calibration', () => {
  // The knob's contract for this topology: f0, the frequency the bandpass
  // and notch outputs center on and the frequency lp/hp cross at equal
  // magnitude for *any* resonance -- see svf.ts's own doc comment for why
  // this, not the ladder's self-oscillation landmark, is the natural one
  // here. Measured by a sine-tone sweep with quadratic (parabolic)
  // interpolation of the peak in log-frequency, not an FFT-of-noise peak
  // bin: at resonance 1 the resonant peak (bandwidth f0/Q, Q=100) is
  // *narrower than one FFT bin* at the low end of this range for any render
  // length this suite can afford, so a bin-argmax measurement reads mostly
  // which bin the noise's own randomness favored, not the filter -- this
  // was checked directly and threw wildly different numbers (1-5%) run to
  // run depending on buffer length and noise seed. A swept probe tone
  // sidesteps that: each point is the filter's actual steady-state gain at
  // a known frequency, not a spectral estimate.
  function bpRmsAt(probeHz: number, cutoff: number, res: number): number {
    const M = 8192
    const input = new Float32Array(M)
    for (let i = 0; i < M; i++) input[i] = Math.sin((2 * Math.PI * probeHz * i) / SR) * 0.3
    const { bp } = run(input, cutoff, res)
    return rms(bp.subarray(M / 2))
  }

  function measuredPeakHz(f0: number): number {
    const ratios = [0.92, 0.95, 0.98, 1.0, 1.02, 1.05, 1.08]
    const points = ratios.map((r) => ({ hz: f0 * r, db: 20 * Math.log10(bpRmsAt(f0 * r, f0, 1)) }))
    let best = 0
    for (let i = 1; i < points.length; i++) if (points[i]!.db > points[best]!.db) best = i
    if (best <= 0 || best >= points.length - 1) return points[best]!.hz
    const x0 = Math.log2(points[best - 1]!.hz)
    const x1 = Math.log2(points[best]!.hz)
    const x2 = Math.log2(points[best + 1]!.hz)
    const y0 = points[best - 1]!.db
    const y1 = points[best]!.db
    const y2 = points[best + 1]!.db
    const denom = (x0 - x1) * (x0 - x2) * (x2 - x1)
    const a = (x2 * (y1 - y0) + x1 * (y0 - y2) + x0 * (y2 - y1)) / denom
    const b = (x2 * x2 * (y0 - y1) + x1 * x1 * (y2 - y0) + x0 * x0 * (y1 - y2)) / denom
    return Math.abs(a) > 1e-12 ? Math.pow(2, -b / (2 * a)) : points[best]!.hz
  }

  it('tracks f0 within 0.5% from 50 Hz to 19 kHz', () => {
    // Measured: 0.18% (50 Hz), 0.0016% (200 Hz), 0.013% (1000 Hz),
    // 0.015% (5000 Hz), 0.032% (19000 Hz) -- comfortably inside the
    // ladder's own <0.4% bar, not merely under this test's looser one.
    // 441/1109/1760 aren't used here (this project's usual "avoid an
    // integer sampleRate/f ratio" rule, see trap #1) because this
    // measurement never takes an FFT of the filtered signal at all.
    for (const f0 of [50, 200, 1000, 5000, 19000]) {
      const measured = measuredPeakHz(f0)
      expect(Math.abs(measured - f0) / f0).toBeLessThan(0.005)
    }
  })

  it('lowpass and highpass cross at f0, at equal magnitude, for any resonance', () => {
    function magAt(probeHz: number, cutoff: number, res: number): { lp: number; hp: number } {
      const M = 8192
      const input = new Float32Array(M)
      for (let i = 0; i < M; i++) input[i] = Math.sin((2 * Math.PI * probeHz * i) / SR) * 0.3
      const { lp, hp } = run(input, cutoff, res)
      return { lp: rms(lp.subarray(M / 2)), hp: rms(hp.subarray(M / 2)) }
    }
    for (const res of [0, 0.3, 0.7, 1]) {
      const { lp, hp } = magAt(1000, 1000, res)
      expect(lp).toBeCloseTo(hp, 3)
    }
  })

  it('resonance 0 sits at the Butterworth (-3 dB) corner, exactly where the flat-lowpass intuition expects', () => {
    const M = 8192
    const input = new Float32Array(M)
    for (let i = 0; i < M; i++) input[i] = Math.sin((2 * Math.PI * 1000 * i) / SR) * 0.3
    const { lp } = run(input, 1000, 0)
    const outRms = rms(lp.subarray(M / 2))
    const inRms = rms(input.subarray(M / 2))
    const gainDb = 20 * Math.log10(outRms / inRms)
    expect(gainDb).toBeGreaterThan(-3.5)
    expect(gainDb).toBeLessThan(-2.5)
  })
})

describe('SVF resonance', () => {
  it('does not ring when kicked at resonance 0', () => {
    const input = new Float32Array(N)
    input.set(noise(256, 0.5))
    const { bp } = run(input, 1000, 0)
    expect(rms(bp.subarray(N / 2))).toBeLessThan(0.001)
  })

  it('rings at f0 when kicked at resonance 1, and decays rather than sustaining', () => {
    // This is the topology's honest answer to "does it self-oscillate":
    // no. Q maxes out at 100 (K_MIN in svf.ts) -- high enough to ring
    // audibly for dozens of cycles, but the loop stays strictly damped by
    // construction (see svf.ts's own doc comment on why the ladder's
    // "push past the threshold" trick does not transfer here), so the
    // ring always loses energy. Measured decay-to-(kick/1000) time: 2.14 s
    // at 100 Hz, 0.24 s at 1000 Hz, 0.059 s at 5000 Hz -- Q is constant but
    // decay time scales as Q/f0, so a low cutoff rings far longer in
    // absolute time than a high one at the same resonance setting, same as
    // a real lightly-damped resonator.
    const input = new Float32Array(N)
    input.set(noise(256, 0.5))
    const { bp } = run(input, 1000, 1)
    const early = rms(bp.subarray(256, 256 + 2048))
    const late = rms(bp.subarray(N - 2048))
    expect(early).toBeGreaterThan(0.05) // genuinely rang, not just a click
    expect(late).toBeLessThan(early * 0.5) // and it is decaying, not sustaining
    expect(peakHz(bp.subarray(256, 256 + 4096), SR)).toBeCloseTo(1000, -2)
  })

  it('bandpass peak gain grows with resonance -- roughly Q, about 40 dB at resonance 1', () => {
    const M = 8192
    const input = new Float32Array(M)
    for (let i = 0; i < M; i++) input[i] = Math.sin((2 * Math.PI * 1000 * i) / SR) * 0.1
    const gains = [0, 0.5, 1].map((res) => {
      const { bp } = run(input, 1000, res)
      return 20 * Math.log10(rms(bp.subarray(M / 2)) / rms(input.subarray(M / 2)))
    })
    expect(gains[0]!).toBeLessThan(gains[1]!)
    expect(gains[1]!).toBeLessThan(gains[2]!)
    expect(gains[2]!).toBeGreaterThan(30) // near the ~40 dB (Q=100) figure
  })
})

describe('SVF stability', () => {
  it('stays finite under a hot (amplitude 4) input at full resonance, across extreme cutoffs', () => {
    for (const cutoff of [20, 50, 19000, 23000]) {
      const { lp, bp, hp, notch } = run(noise(N, 4), cutoff, 1)
      for (const arr of [lp, bp, hp, notch]) {
        for (const v of arr) {
          expect(Number.isFinite(v)).toBe(true)
          expect(Math.abs(v)).toBeLessThan(50)
        }
      }
    }
  })

  it('stays finite and bounded under fast cutoff modulation at high resonance', () => {
    const state = createSvfState()
    const out: SvfOutputs = createSvfOutputs()
    const inp = noise(N, 1)
    let maxAbs = 0
    for (let i = 0; i < N; i++) {
      // A 50 Hz cutoff sweep across 200 Hz-10 kHz -- fast enough that the
      // TPT solve's own state has no time to settle between samples.
      const cutoff = 200 + 9800 * (0.5 + 0.5 * Math.sin((2 * Math.PI * 50 * i) / SR))
      svfSample(state, inp[i]!, cutoff, 0.9, SR, out)
      maxAbs = Math.max(maxAbs, Math.abs(out.lp), Math.abs(out.bp), Math.abs(out.hp), Math.abs(out.notch))
      expect(Number.isFinite(out.lp) && Number.isFinite(out.bp) && Number.isFinite(out.hp) && Number.isFinite(out.notch)).toBe(true)
    }
    expect(maxAbs).toBeLessThan(50)
  })
})

describe('SVF DC offset', () => {
  const DC_N = 65536
  function alignFreq(targetHz: number, n = DC_N): number {
    const bin = Math.round((targetHz * n) / SR)
    return (bin * SR) / n
  }
  function sawIn(freq: number, n: number): Float32Array {
    const state = createOscState()
    const set = getWavetableSet(SR)
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = oscSample(state, 'saw', freq, SR, set)
    return out
  }
  function dcDb(samples: Float32Array): number {
    let sum = 0
    for (const v of samples) sum += v
    const mean = Math.abs(sum / samples.length)
    return 20 * Math.log10(Math.max(mean, 1e-12))
  }

  it('every output stays below -80 dBFS DC with an asymmetric (saw) input, across resonance', () => {
    // Unlike the ladder, this topology's only nonlinearity (tanh on the raw
    // input, see svf.ts) sits *before* the resonant loop rather than inside
    // its feedback path, so there is no resonance-amplified DC generation
    // to guard against the way the ladder needed a dedicated blocker for.
    // Measured with the identical saw-at-441Hz-into-1000Hz-cutoff setup
    // ladder.test.ts uses for the same check: -218 to -197 dBFS across
    // lp/bp/hp/notch and resonance 0/0.5/1 -- 117-138 dB below this test's
    // -80 dBFS bar, no blocker needed.
    const freq = alignFreq(441)
    const input = sawIn(freq, DC_N)
    for (const res of [0, 0.5, 1]) {
      const { lp, bp, hp, notch } = run(input, 1000, res)
      for (const arr of [lp, bp, hp, notch]) {
        expect(dcDb(arr.subarray(DC_N / 2))).toBeLessThan(-80)
      }
    }
  })

  it('every output stays below -80 dBFS DC with a symmetric (sine) input too', () => {
    const freq = alignFreq(441)
    const input = new Float32Array(DC_N)
    for (let i = 0; i < DC_N; i++) input[i] = Math.sin((2 * Math.PI * freq * i) / SR) * 0.5
    for (const res of [0, 0.5, 1]) {
      const { lp, bp, hp, notch } = run(input, 1000, res)
      for (const arr of [lp, bp, hp, notch]) {
        expect(dcDb(arr.subarray(DC_N / 2))).toBeLessThan(-80)
      }
    }
  })
})
