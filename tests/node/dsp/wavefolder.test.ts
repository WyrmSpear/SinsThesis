import { describe, it, expect } from 'vitest'
import { foldSample, createWavefolderState, wavefolderSample } from '../../../src/engine/dsp/wavefolder'
import { spectralCentroid, aliasFloorDb, rms } from '../../../src/engine/analysis/features'
import { fftMagnitude } from '../../../src/engine/analysis/fft'

const SR = 48000
const N = 8192

function foldedSine(drive: number): Float32Array {
  const out = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    out[i] = foldSample(Math.sin((2 * Math.PI * 200 * i) / SR), drive)
  }
  return out
}

// B1: non-commensurate fundamental (48000/1109 = 43.28..., no small-integer
// ratio -- see docs/CONTINUATION.md trap 1) and a large N for FFT resolution,
// matching the wavefolder spec's own measurement methodology exactly.
const ALIAS_F0 = 1109
const ALIAS_N = 65536

// The oversampling FIR's ring buffers start at zero, so the very first
// samples see a cold-start edge (silence snapping to a full-scale sine) the
// steady state never produces -- a one-time startup transient, not a
// periodic aliasing artifact, but its broadband energy would otherwise
// swamp the measurement. Same convention as this codebase's ladder
// self-oscillation tests (docs/CONTINUATION.md trap 6): render past the
// transient and only measure the settled tail.
//
// 16384 samples (~0.34 s), not 4096: the DC blocker's corner moved from
// 38 Hz to 4 Hz (Finding 1, final review), and its ~40 ms time constant
// needs several multiples to settle. At 4096 samples the DC test below
// still read a real but only partially settled -107.5 dBFS; at 16384 it
// reads -148 to -163 dBFS, matching the figure the fix was measured
// against. The alias-floor tests below don't care about the extra length
// beyond a small compute cost -- they were never warmup-sensitive at this
// level of settling either way.
const WARMUP = 16384

function antialiasedFoldedSine(drive: number, symmetry = 0): Float32Array {
  const state = createWavefolderState()
  const total = WARMUP + ALIAS_N
  const out = new Float32Array(total)
  for (let i = 0; i < total; i++) {
    const x = Math.sin((2 * Math.PI * ALIAS_F0 * i) / SR)
    out[i] = wavefolderSample(state, x, drive, symmetry, SR)
  }
  return out.subarray(WARMUP)
}

describe('foldSample', () => {
  it('passes signal through unchanged at unity drive', () => {
    expect(foldSample(0.5, 1)).toBeCloseTo(0.5, 6)
    expect(foldSample(-0.5, 1)).toBeCloseTo(-0.5, 6)
  })

  it('reflects a value that exceeds +1', () => {
    // 1.5 folds back to 2 - 1.5 = 0.5
    expect(foldSample(1.5, 1)).toBeCloseTo(0.5, 6)
  })

  it('reflects a value below -1', () => {
    expect(foldSample(-1.5, 1)).toBeCloseTo(-0.5, 6)
  })

  it('keeps output inside +/-1 even at extreme drive', () => {
    for (let d = 1; d <= 20; d += 0.5) {
      for (let x = -1; x <= 1; x += 0.05) {
        expect(Math.abs(foldSample(x, d))).toBeLessThanOrEqual(1.0001)
      }
    }
  })

  it('adds harmonics as drive rises', () => {
    expect(spectralCentroid(foldedSine(6), SR))
      .toBeGreaterThan(spectralCentroid(foldedSine(1), SR) * 2)
  })
})

// B1: the naive fold (above) has no band-limiting -- measured alias floor
// -45.7 dB at drive 1.5, -31.9 dB at drive 3 (well inside the range a
// player uses), and +6.4 to +6.8 dB at drive 16-20 (alias energy LOUDER
// than the fundamental). wavefolderSample is the antialiased replacement:
// ADAA-1 folding at 4x oversampling, decimated through a 127-tap
// Blackman-windowed-sinc FIR, plus a DC blocker. Bars below are from
// .superpowers/sdd/2026-08-18-phase1a-engine/wavefolder-spec.md section 3,
// measured against the same 1109 Hz / 48 kHz / Blackman-Harris methodology
// the naive-fold numbers above were reproduced with.
describe('wavefolderSample: alias floor', () => {
  it('drive 1.0 stays clean -- regression check, no folding engaged', () => {
    const floor = aliasFloorDb(antialiasedFoldedSine(1.0), SR, ALIAS_F0)
    expect(floor).toBeLessThanOrEqual(-100)
  })

  it('drive 1.5 reaches RELEASE grade', () => {
    const floor = aliasFloorDb(antialiasedFoldedSine(1.5), SR, ALIAS_F0)
    expect(floor).toBeLessThanOrEqual(-90)
  })

  it('drive 3 reaches RELEASE grade', () => {
    const floor = aliasFloorDb(antialiasedFoldedSine(3.0), SR, ALIAS_F0)
    expect(floor).toBeLessThanOrEqual(-80)
  })

  it('drive 8 reaches RELEASE grade', () => {
    const floor = aliasFloorDb(antialiasedFoldedSine(8.0), SR, ALIAS_F0)
    expect(floor).toBeLessThanOrEqual(-60)
  })

  it('drive 20 reaches at least ACCEPTABLE grade, the honest top of the range', () => {
    const floor = aliasFloorDb(antialiasedFoldedSine(20.0), SR, ALIAS_F0)
    expect(floor).toBeLessThanOrEqual(-42)
  })
})

describe('wavefolderSample: DC blocker', () => {
  it('keeps steady-state DC below -100 dBFS at nonzero symmetry', () => {
    // A naive time-domain mean over a window holding a non-integer number
    // of cycles of a ~1109 Hz tone (any window will, since 48000/1109 is
    // irrational-looking to samples) leaks AC energy into the estimate at a
    // level that swamps a genuinely well-blocked DC component -- this
    // measured a fictitious -74 dBFS "DC" against a window of pure AC
    // leakage before this test used the DC (bin 0) magnitude from a
    // Blackman-Harris-windowed FFT instead, whose ~-92 dB sidelobes keep
    // that leakage far out of the way of a real measurement.
    for (const symmetry of [0.3, -0.3]) {
      const out = antialiasedFoldedSine(3.0, symmetry)
      const mags = fftMagnitude(out, 'blackman-harris')
      const dcDb = 20 * Math.log10(Math.max(mags[0]!, 1e-12))
      expect(dcDb).toBeLessThanOrEqual(-100)
    }
  })
})

// Finding 1 (final review): the blocker's corner sat at 38 Hz, inside the
// audible band -- measured through wavefolderSample at drive 1.0, symmetry 0
// (no folding, nothing to block), it cost -6.63 dB at 20 Hz, -2.78 dB at
// 40 Hz, -1.45 dB at 60 Hz and -0.57 dB at 100 Hz. Every signal routed
// through a wavefolder lost real low end whether or not it ever folded.
// Moved to 4 Hz to match ladder.ts's own output blocker, mirroring that
// module's guard test (tests/node/dsp/ladder.test.ts) exactly, including its
// bar: attenuation better than -1 dB at 20/30/50 Hz.
describe('wavefolderSample: low-frequency guard', () => {
  it('leaves 20/30/50 Hz effectively untouched', () => {
    const DC_N = 65536
    for (const freq of [20, 30, 50]) {
      const state = createWavefolderState()
      const input = new Float32Array(DC_N)
      const out = new Float32Array(DC_N)
      for (let i = 0; i < DC_N; i++) {
        input[i] = Math.sin((2 * Math.PI * freq * i) / SR) * 0.5
        out[i] = wavefolderSample(state, input[i]!, 1.0, 0, SR)
      }
      const inRms = rms(input.subarray(DC_N / 2))
      const outRms = rms(out.subarray(DC_N / 2))
      const attenDb = 20 * Math.log10(outRms / inRms)
      expect(attenDb).toBeGreaterThan(-1)
    }
  })
})
