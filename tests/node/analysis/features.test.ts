import { describe, it, expect } from 'vitest'
import {
  peakHz, rms, rmsEnvelope, spectralCentroid, slopeDbPerOctave, aliasFloorDb,
  autocorrelationPitchHz, peakNormalizedEnvelope, attackMs, decayMs, peakRms,
  pitchDropOctaves, brightnessDropOctaves, spectralCentroidMotionOctaves,
} from '../../../src/engine/analysis/features'

const SR = 48000
const N = 8192

function gen(n: number, fn: (i: number) => number): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = fn(i)
  return out
}

const sine = (hz: number) => gen(N, (i) => Math.sin((2 * Math.PI * hz * i) / SR))

/** Band-limited saw built from partials, so it has no aliasing by construction. */
function bandlimitedSaw(hz: number, n: number = N): Float32Array {
  const partials = Math.floor(SR / 2 / hz)
  return gen(n, (i) => {
    let v = 0
    for (let k = 1; k <= partials; k++) v += Math.sin((2 * Math.PI * k * hz * i) / SR) / k
    return (v * 2) / Math.PI
  })
}

describe('peakHz', () => {
  it('finds the fundamental of a sine', () => {
    expect(peakHz(sine(440), SR)).toBeCloseTo(440, -1)
  })
})

describe('rms', () => {
  it('reads 1/sqrt(2) for a unit sine', () => {
    expect(rms(sine(1000))).toBeCloseTo(Math.SQRT1_2, 2)
  })

  it('reads zero for silence', () => {
    expect(rms(new Float32Array(1024))).toBe(0)
  })
})

describe('rmsEnvelope', () => {
  it('tracks a decaying signal downward', () => {
    const decaying = gen(4096, (i) => Math.sin(i * 0.1) * (1 - i / 4096))
    const env = rmsEnvelope(decaying, 256)
    expect(env.length).toBe(16)
    expect(env[0]!).toBeGreaterThan(env[env.length - 1]!)
  })
})

describe('spectralCentroid', () => {
  it('sits near the fundamental for a sine', () => {
    expect(spectralCentroid(sine(1000), SR)).toBeCloseTo(1000, -2)
  })

  it('is higher for a saw than for a sine at the same pitch', () => {
    expect(spectralCentroid(bandlimitedSaw(200), SR))
      .toBeGreaterThan(spectralCentroid(sine(200), SR))
  })
})

describe('slopeDbPerOctave', () => {
  it('measures a steep negative tilt across a saw\'s partials', () => {
    // A saw's partial amplitudes fall as 1/k, an envelope of -6 dB per octave.
    // This estimator fits every bin in the band, and most bins between 400 Hz
    // and 3200 Hz sit between the 100 Hz-spaced harmonics, where the magnitude
    // is Hann leakage floor rather than partial amplitude. That pulls the fit
    // steeper than the envelope -- about -8.8 dB/oct here. Fitting the harmonic
    // peaks alone gives -5.8, confirming the envelope is right.
    const slope = slopeDbPerOctave(bandlimitedSaw(100), SR, 400, 3200)
    expect(slope).toBeGreaterThan(-10)
    expect(slope).toBeLessThan(-4)
  })
})

describe('aliasFloorDb', () => {
  // 2 kHz was dropped as the test frequency: 48000 / 2000 = 24 exactly, so
  // every alias product lands on a harmonic and is excluded along with it --
  // that is how this metric used to read a fictitious -71 dB here. 1109 Hz
  // is not a small-integer divisor of 48000, so aliases actually show up.
  it('reports a very low floor for a band-limited saw', () => {
    // Measured: -96.7 dB. Margin to -85 leaves ~11 dB of headroom.
    expect(aliasFloorDb(bandlimitedSaw(1109), SR, 1109)).toBeLessThan(-85)
  })

  it('reports a high floor for a naive saw', () => {
    // A naive saw at 1109 Hz folds partials back below the fundamental.
    // Measured: -26.6 dB.
    const naive = gen(N, (i) => 2 * (((i * 1109) / SR) % 1) - 1)
    expect(aliasFloorDb(naive, SR, 1109)).toBeGreaterThan(-32)
  })
})

// ---- additions for the academy's constrained-challenge mode
// (src/engine/analysis/rubric.ts) -- 1-second synthetic buffers, long
// enough for the early/late drift windows these grade against. ----

const N2 = SR // 1 second

describe('autocorrelationPitchHz', () => {
  it('finds the fundamental of a sine', () => {
    expect(autocorrelationPitchHz(sine(220), SR)).toBeCloseTo(220, -1)
  })

  it('finds the fundamental of a saw, unmoved by its own rich harmonics', () => {
    // peakHz can lock onto a harmonic instead of the fundamental on a
    // harmonic-rich waveform; autocorrelation should not.
    expect(autocorrelationPitchHz(bandlimitedSaw(220), SR)).toBeCloseTo(220, -1)
  })

  it('reads 0 for silence', () => {
    expect(autocorrelationPitchHz(new Float32Array(4096), SR)).toBe(0)
  })
})

describe('peakNormalizedEnvelope / attackMs / decayMs', () => {
  function envelopeSignal(attackS: number, decayS: number, n: number): Float32Array {
    return gen(n, (i) => {
      const t = i / SR
      const env = t < attackS ? t / attackS : Math.exp(-(t - attackS) / decayS)
      return Math.sin((2 * Math.PI * 300 * i) / SR) * env
    })
  }

  it('attackMs is larger for a slower attack', () => {
    const fast = peakNormalizedEnvelope(envelopeSignal(0.002, 0.3, N2), SR, 20)
    const slow = peakNormalizedEnvelope(envelopeSignal(0.08, 0.3, N2), SR, 20)
    expect(attackMs(slow, 20)).toBeGreaterThan(attackMs(fast, 20))
  })

  it('decayMs is larger for a slower decay', () => {
    const fast = peakNormalizedEnvelope(envelopeSignal(0.002, 0.05, N2), SR, 20)
    const slow = peakNormalizedEnvelope(envelopeSignal(0.002, 0.5, N2), SR, 20)
    expect(decayMs(slow, 20)).toBeGreaterThan(decayMs(fast, 20))
  })

  it('decayMs is Infinity for a signal that never decays within the buffer', () => {
    const sustained = gen(N2, (i) => Math.sin((2 * Math.PI * 300 * i) / SR))
    const env = peakNormalizedEnvelope(sustained, SR, 20)
    expect(decayMs(env, 20)).toBe(Infinity)
  })
})

describe('peakRms', () => {
  it('reads the loudest window, not diluted by a long silent tail', () => {
    const loudFor = Math.round(0.05 * SR)
    const sig = gen(N2, (i) => (i < loudFor ? Math.sin((2 * Math.PI * 300 * i) / SR) : 0))
    expect(peakRms(sig, SR, 20)).toBeGreaterThan(rms(sig) * 3)
  })
})

describe('pitchDropOctaves', () => {
  /** Frequency exponentially relaxes from f0 toward f1 with time constant
   *  tau -- most of the drop happens in the first few tau, mirroring an
   *  envelope-driven pitch sweep (a kick's FM). */
  function pitchEnvelopeTone(f0: number, f1: number, tau: number, n: number): Float32Array {
    let phase = 0
    return gen(n, (i) => {
      const t = i / SR
      const f = f1 + (f0 - f1) * Math.exp(-t / tau)
      phase += (2 * Math.PI * f) / SR
      return Math.sin(phase)
    })
  }

  it('reads a clear positive drop when pitch falls between the early and late windows', () => {
    const sig = pitchEnvelopeTone(400, 100, 0.03, N2)
    expect(pitchDropOctaves(sig, SR, 15, 100, 60)).toBeGreaterThan(0.3)
  })

  it('reads ~0 for a fixed-pitch tone', () => {
    const sig = gen(N2, (i) => Math.sin((2 * Math.PI * 150 * i) / SR))
    expect(Math.abs(pitchDropOctaves(sig, SR, 15, 100, 60))).toBeLessThan(0.05)
  })

  it('reads negative when pitch rises instead of falling', () => {
    const sig = pitchEnvelopeTone(100, 400, 0.03, N2)
    expect(pitchDropOctaves(sig, SR, 15, 100, 60)).toBeLessThan(-0.2)
  })
})

describe('brightnessDropOctaves', () => {
  /** Crossfades a harmonic-rich saw into a bare sine as `w(t)` decays --
   *  the timbre darkens over time with the fundamental held fixed, the
   *  same shape a wavefolder's drive fading with an envelope produces. */
  function darkeningTone(f0: number, tau: number, n: number): Float32Array {
    const saw = bandlimitedSaw(f0, n)
    return gen(n, (i) => {
      const t = i / SR
      const w = Math.exp(-t / tau)
      const s = Math.sin((2 * Math.PI * f0 * i) / SR)
      return w * saw[i]! + (1 - w) * s
    })
  }

  it('reads a clear positive drop when timbre darkens between the two windows', () => {
    const sig = darkeningTone(150, 0.03, N2)
    expect(brightnessDropOctaves(sig, SR, 15, 100, 50)).toBeGreaterThan(0.3)
  })

  it('reads ~0 for a static waveform (fixed timbre, decaying level only)', () => {
    const saw = bandlimitedSaw(150, N2)
    const sig = gen(N2, (i) => saw[i]! * Math.exp(-(i / SR) / 0.3)) // uniform decay, same shape throughout
    expect(Math.abs(brightnessDropOctaves(sig, SR, 15, 100, 50))).toBeLessThan(0.3)
  })
})

describe('spectralCentroidMotionOctaves', () => {
  it('reads high for a tone with a swept fundamental', () => {
    let phase = 0
    const swept = gen(N2, (i) => {
      const t = i / N2
      const f = 200 * Math.pow(4, Math.sin(2 * Math.PI * 0.5 * t)) // sweeps roughly 50-800 Hz
      phase += (2 * Math.PI * f) / SR
      return Math.sin(phase)
    })
    const flat = gen(N2, (i) => Math.sin((2 * Math.PI * 300 * i) / SR))
    expect(spectralCentroidMotionOctaves(swept, SR)).toBeGreaterThan(1)
    expect(spectralCentroidMotionOctaves(flat, SR)).toBeLessThan(0.2)
  })
})
