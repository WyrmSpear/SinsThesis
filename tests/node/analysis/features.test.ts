import { describe, it, expect } from 'vitest'
import {
  peakHz, rms, rmsEnvelope, spectralCentroid, slopeDbPerOctave, aliasFloorDb,
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
function bandlimitedSaw(hz: number): Float32Array {
  const partials = Math.floor(SR / 2 / hz)
  return gen(N, (i) => {
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
  it('reports a very low floor for a band-limited saw', () => {
    expect(aliasFloorDb(bandlimitedSaw(2000), SR, 2000)).toBeLessThan(-60)
  })

  it('reports a high floor for a naive saw', () => {
    // A naive saw at 2 kHz folds partials back below the fundamental.
    const naive = gen(N, (i) => 2 * (((i * 2000) / SR) % 1) - 1)
    expect(aliasFloorDb(naive, SR, 2000)).toBeGreaterThan(-40)
  })
})
