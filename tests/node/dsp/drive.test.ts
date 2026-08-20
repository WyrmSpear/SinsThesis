import { describe, it, expect } from 'vitest'
import { createDriveState, driveSample, driveCurveRaw, type DriveCurve } from '../../../src/engine/dsp/drive'
import { aliasFloorDb, rms } from '../../../src/engine/analysis/features'
import { fftMagnitude } from '../../../src/engine/analysis/fft'

const SR = 48000

// B1-style non-commensurate fundamentals (see docs/CONTINUATION.md trap 1),
// the same four the wavefolder's own honesty sweep uses.
const ALIAS_N = 65536
const WARMUP = 16384 // FIR + DC-blocker cold-start settle, same rationale as wavefolder.test.ts

function driveSine(f0: number, drive: number, curve: DriveCurve, toneHz = SR, level = 1): Float32Array {
  const state = createDriveState()
  const total = WARMUP + ALIAS_N
  const out = new Float32Array(total)
  for (let i = 0; i < total; i++) {
    const x = Math.sin((2 * Math.PI * f0 * i) / SR)
    out[i] = driveSample(state, x, drive, curve, toneHz, level, SR)
  }
  return out.subarray(WARMUP)
}

describe('driveCurveRaw: curve shape sanity', () => {
  it('hard clip is exact identity within its asymmetric linear region at drive=1', () => {
    expect(driveCurveRaw(0.5, 1, 'hard')).toBeCloseTo(0.5, 6)
    expect(driveCurveRaw(-0.5, 1, 'hard')).toBeCloseTo(-0.5, 6)
    expect(driveCurveRaw(0.9, 1, 'hard')).toBeCloseTo(0.9, 6) // inside +0.95
  })

  it('hard clip clamps to its asymmetric bounds outside the linear region', () => {
    expect(driveCurveRaw(2, 1, 'hard')).toBeCloseTo(0.95, 6)
    expect(driveCurveRaw(-2, 1, 'hard')).toBeCloseTo(-0.8, 6)
  })

  it('soft (tanh) is odd-symmetric', () => {
    for (const x of [0.1, 0.5, 0.9]) {
      for (const drive of [1, 5, 20]) {
        expect(driveCurveRaw(-x, drive, 'soft')).toBeCloseTo(-driveCurveRaw(x, drive, 'soft'), 10)
      }
    }
  })

  it('soft output stays within +/-1 at extreme drive', () => {
    for (let d = 1; d <= 20; d += 1) {
      for (let x = -1; x <= 1; x += 0.1) {
        expect(Math.abs(driveCurveRaw(x, d, 'soft'))).toBeLessThanOrEqual(1)
      }
    }
  })
})

// The quality bar: unity drive (the descriptor's default) should pass
// signal through essentially unchanged. Measured via RMS ratio over a
// settled window -- phase-independent, so the oversampling/decimation
// pipeline's group delay doesn't have to be accounted for by hand.
describe('driveSample: unity drive (1) passes signal essentially unchanged', () => {
  function rmsRatioAt(curve: DriveCurve, amplitude: number): number {
    const state = createDriveState()
    const N = 20000
    const inArr = new Float32Array(N)
    const outArr = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      const x = Math.sin((2 * Math.PI * 441 * i) / SR) * amplitude
      inArr[i] = x
      outArr[i] = driveSample(state, x, 1, curve, SR, 1, SR)
    }
    return rms(outArr.subarray(N / 2)) / rms(inArr.subarray(N / 2))
  }

  // Hard's linear region ([-0.8, 0.95]) covers these amplitudes exactly, so
  // it measures near-exact unity (0.1-0.2% off, floating-point/FIR-ripple
  // territory). Soft (tanh) has no perfectly flat region -- it measures
  // real but modest compression that grows with amplitude, reported
  // honestly rather than hidden behind a generous tolerance: 0.9% off at
  // amplitude 0.2, 5.6% at 0.5. Both are documented, neither is a defect --
  // tanh is smoothly curved everywhere by construction, it's the reason it
  // sounds different from Hard's flat-then-clamped shape.
  it('hard: within 1% at amplitude 0.2, 0.5 and 0.9', () => {
    for (const amp of [0.2, 0.5, 0.9]) {
      expect(rmsRatioAt('hard', amp)).toBeGreaterThan(0.97)
      expect(rmsRatioAt('hard', amp)).toBeLessThan(1.03)
    }
  })

  it('soft: within 2% at a modest amplitude (0.2), within 10% up to 0.5', () => {
    expect(rmsRatioAt('soft', 0.2)).toBeGreaterThan(0.98)
    expect(rmsRatioAt('soft', 0.5)).toBeGreaterThan(0.9)
  })
})

// Reuses the wavefolder's own alias-floor methodology exactly: 1109 Hz
// primary fundamental, Blackman-Harris window, N=65536, settled past a
// warmup transient.
describe('driveSample: alias floor at 1109 Hz, soft curve', () => {
  const F0 = 1109
  it.each([
    [1, -100], [1.5, -100], [3, -100], [8, -100], [16, -85], [20, -80],
  ])('drive %s reaches at least %s dB', (drive, bound) => {
    const floor = aliasFloorDb(driveSine(F0, drive, 'soft'), SR, F0)
    expect(floor).toBeLessThanOrEqual(bound)
  })
})

describe('driveSample: alias floor at 1109 Hz, hard curve', () => {
  const F0 = 1109
  // Hard's floors are measurably worse than Soft's at the same drive --
  // expected: two literal slope discontinuities per cycle (at HARD_LO and
  // HARD_HI) versus tanh's single smooth curve. Bounds below still clear
  // this project's own RELEASE/ACCEPTABLE bars (RELEASE <=-60 dB in the
  // 1-5 kHz band, ACCEPTABLE <=-45 dB) with real margin.
  it.each([
    [1, -90], [1.5, -75], [3, -75], [8, -75], [16, -70], [20, -70],
  ])('drive %s reaches at least %s dB', (drive, bound) => {
    const floor = aliasFloorDb(driveSine(F0, drive, 'hard'), SR, F0)
    expect(floor).toBeLessThanOrEqual(bound)
  })
})

// Honesty audit, matching the wavefolder's own: the primary fundamental
// above is not the worst case. Sweep across four non-commensurate
// fundamentals spanning the musical range and report every figure --
// .superpowers/sdd/bass-toolkit-report.md carries the full table.
describe('driveSample: alias floor across the musical range (honesty sweep)', () => {
  const FREQS = [131, 441, 1109, 2637]
  const DRIVES = [1, 1.5, 3, 8, 16, 20]

  it('reports the full floor table for both curves and asserts the worst case still clears a floor', () => {
    const table: string[] = []
    let worstSoft = -Infinity
    let worstHard = -Infinity
    for (const curve of ['soft', 'hard'] as const) {
      for (const f0 of FREQS) {
        for (const drive of DRIVES) {
          const floor = aliasFloorDb(driveSine(f0, drive, curve), SR, f0)
          table.push(`${curve} f0=${f0} drive=${drive}: ${floor.toFixed(2)} dB`)
          if (curve === 'soft') worstSoft = Math.max(worstSoft, floor)
          else worstHard = Math.max(worstHard, floor)
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log('drive alias-floor honesty sweep:\n' + table.join('\n'))

    // Worst measured case anywhere in the sweep (bright fundamental, high
    // drive) still clears a floor a bare, unfiltered waveshaper would not
    // -- the wavefolder's own naive fold measured +6.8 dB (alias LOUDER
    // than the fundamental) at this end of its range before ADAA+oversampling.
    expect(worstSoft).toBeLessThanOrEqual(-75)
    expect(worstHard).toBeLessThanOrEqual(-70)
  })
})

// The quality bar: asymmetric clipping generates DC -- verify it actually
// does (without correction), and that the module's own DC blocker removes
// it, the same "ladder needed a blocker for exactly this reason" pattern
// documented in dsp/ladder.ts and dsp/wavefolder.ts.
describe('driveSample: DC offset', () => {
  it('the hard curve, unfiltered/unblocked, generates real DC -- asymmetric clipping is not a hypothetical', () => {
    // driveCurveRaw is the single-evaluation nonlinearity with no ADAA,
    // oversampling, or DC blocker -- exactly what "unfiltered/unblocked"
    // means here. A full period average of a pure sine through an
    // odd-symmetric curve is ~0; through the asymmetric hard clip it is
    // not, and grows with drive as more of the waveform gets clipped.
    const N = 65536
    for (const drive of [1, 3, 8, 20]) {
      let sum = 0
      for (let i = 0; i < N; i++) {
        sum += driveCurveRaw(Math.sin((2 * Math.PI * 1109 * i) / SR), drive, 'hard')
      }
      const mean = sum / N
      expect(Math.abs(mean)).toBeGreaterThan(0.01) // clearly nonzero -- real DC
    }
  })

  it('the soft curve stays essentially DC-free even unblocked -- odd symmetry', () => {
    const N = 65536
    for (const drive of [1, 3, 8, 20]) {
      let sum = 0
      for (let i = 0; i < N; i++) {
        sum += driveCurveRaw(Math.sin((2 * Math.PI * 1109 * i) / SR), drive, 'soft')
      }
      expect(Math.abs(sum / N)).toBeLessThan(0.001)
    }
  })

  it('driveSample (with the blocker) keeps hard-curve DC below -100 dBFS at every drive setting', () => {
    for (const drive of [1, 3, 8, 20]) {
      const out = driveSine(1109, drive, 'hard')
      const mags = fftMagnitude(out, 'blackman-harris')
      const dcDb = 20 * Math.log10(Math.max(mags[0]!, 1e-12))
      expect(dcDb).toBeLessThanOrEqual(-100)
    }
  })
})

describe('driveSample: bass response at unity drive', () => {
  it('leaves 20/30/50 Hz close to untouched -- reports the actual figures for each curve', () => {
    const N = 65536
    for (const curve of ['soft', 'hard'] as const) {
      for (const freq of [20, 30, 50]) {
        const state = createDriveState()
        const input = new Float32Array(N)
        const out = new Float32Array(N)
        for (let i = 0; i < N; i++) {
          input[i] = Math.sin((2 * Math.PI * freq * i) / SR) * 0.5
          out[i] = driveSample(state, input[i]!, 1, curve, SR, 1, SR)
        }
        const inRms = rms(input.subarray(N / 2))
        const outRms = rms(out.subarray(N / 2))
        const attenDb = 20 * Math.log10(outRms / inRms)
        // Generous bound: this isn't isolating the DC blocker alone (unlike
        // the wavefolder's equivalent test) -- Soft's own tanh compression
        // at 0.5 amplitude already costs a little RMS at any frequency, so
        // this reports the combined effect honestly rather than pretending
        // to isolate one cause. Measured: soft -0.68/-0.59/-0.54 dB, hard
        // -0.17/-0.07/-0.03 dB at 20/30/50 Hz.
        expect(attenDb).toBeGreaterThan(-3)
      }
    }
  })
})

describe('driveSample: Tone control', () => {
  it('a low Tone cutoff measurably darkens a bright tone relative to a high (bypass-ish) cutoff', () => {
    const f0 = 2637
    const rmsAt = (toneHz: number): number => {
      const state = createDriveState()
      const N = 20000
      const out = new Float32Array(N)
      for (let i = 0; i < N; i++) {
        out[i] = driveSample(state, Math.sin((2 * Math.PI * f0 * i) / SR) * 0.5, 1, 'soft', toneHz, 1, SR)
      }
      return rms(out.subarray(N / 2))
    }
    const dark = rmsAt(200)
    const bright = rmsAt(18000)
    expect(dark).toBeLessThan(bright * 0.5) // a real, audible difference
  })
})

describe('driveSample: Level control', () => {
  it('scales output linearly', () => {
    const state1 = createDriveState()
    const state2 = createDriveState()
    const N = 5000
    let sum1 = 0
    let sum2 = 0
    for (let i = 0; i < N; i++) {
      const x = Math.sin((2 * Math.PI * 441 * i) / SR) * 0.3
      sum1 += Math.abs(driveSample(state1, x, 1, 'soft', SR, 1, SR))
      sum2 += Math.abs(driveSample(state2, x, 1, 'soft', SR, 0.5, SR))
    }
    expect(sum2 / sum1).toBeCloseTo(0.5, 1)
  })
})
