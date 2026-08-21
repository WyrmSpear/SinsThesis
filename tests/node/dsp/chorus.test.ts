import { describe, it, expect } from 'vitest'
import {
  VOICE_PHASES,
  BASE_DELAY_SECONDS,
  SPREAD_OFFSETS,
  voiceDelaySeconds,
  sinePhaseCoefficients,
} from '../../../src/engine/dsp/chorus'

describe('chorus voice geometry', () => {
  it('spreads the three voices evenly around a full cycle', () => {
    expect(VOICE_PHASES).toHaveLength(3)
    const degrees = VOICE_PHASES.map((p) => (p * 180) / Math.PI)
    expect(degrees[0]).toBeCloseTo(0, 6)
    expect(degrees[1]).toBeCloseTo(120, 6)
    expect(degrees[2]).toBeCloseTo(240, 6)
  })

  it('collapses every voice onto the centre delay at spread 0', () => {
    for (let i = 0; i < VOICE_PHASES.length; i++) {
      expect(voiceDelaySeconds(i, 0)).toBeCloseTo(BASE_DELAY_SECONDS, 12)
    }
  })

  it('puts the voices at 12, 20 and 28 ms at full spread', () => {
    const ms = [0, 1, 2].map((i) => voiceDelaySeconds(i, 1) * 1000)
    expect(ms[0]).toBeCloseTo(12, 9)
    expect(ms[1]).toBeCloseTo(20, 9)
    expect(ms[2]).toBeCloseTo(28, 9)
  })

  it('keeps every voice clear of zero delay even at the sweep extreme', () => {
    // The shortest voice minus the full sweep half-width must stay well
    // positive, or a delay line would be asked to read the future.
    const shortest = Math.min(...[0, 1, 2].map((i) => voiceDelaySeconds(i, 1)))
    expect(shortest - 0.005).toBeGreaterThan(0.005)
  })

  it('clamps spread rather than extrapolating past the panel range', () => {
    expect(voiceDelaySeconds(0, 5)).toBeCloseTo(voiceDelaySeconds(0, 1), 12)
    expect(voiceDelaySeconds(0, -3)).toBeCloseTo(voiceDelaySeconds(0, 0), 12)
  })

  it('keeps the spread offsets symmetric, so the centre voice really is the centre', () => {
    expect(SPREAD_OFFSETS[0]! + SPREAD_OFFSETS[2]!).toBeCloseTo(0, 12)
    expect(SPREAD_OFFSETS[1]).toBe(0)
  })
})

describe('sinePhaseCoefficients', () => {
  it('reproduces the built-in sine at phase 0', () => {
    // Web Audio's own 'sine' type is real = [0, 0], imag = [0, 1].
    const { real, imag } = sinePhaseCoefficients(0)
    expect(real[0]).toBe(0)
    expect(real[1]).toBeCloseTo(0, 12)
    expect(imag[0]).toBe(0)
    expect(imag[1]).toBeCloseTo(1, 12)
  })

  // These coefficients live in Float32Arrays because that is what
  // `createPeriodicWave` requires, so ~1e-7 is the precision floor here, not
  // a slack bar. Asserting to six places checks the math without asserting
  // that float32 is float64.
  const FLOAT32_PLACES = 6

  it('encodes phase as (sin, cos), which is what makes the offset survive a rate change', () => {
    for (const phase of VOICE_PHASES) {
      const { real, imag } = sinePhaseCoefficients(phase)
      expect(real[1]).toBeCloseTo(Math.sin(phase), FLOAT32_PLACES)
      expect(imag[1]).toBeCloseTo(Math.cos(phase), FLOAT32_PLACES)
    }
  })

  it('describes a unit-amplitude wave at every phase', () => {
    // real[1]^2 + imag[1]^2 == 1 for a single harmonic of unit amplitude.
    // If this drifted, a phase offset would smuggle in a depth difference.
    for (let p = 0; p < 2 * Math.PI; p += Math.PI / 8) {
      const { real, imag } = sinePhaseCoefficients(p)
      expect(Math.hypot(real[1]!, imag[1]!)).toBeCloseTo(1, FLOAT32_PLACES)
    }
  })

  it('reconstructs the intended waveform when evaluated the way Web Audio does', () => {
    // x(t) = real[1] * cos(wt) + imag[1] * sin(wt) must equal sin(wt + p).
    for (const phase of VOICE_PHASES) {
      const { real, imag } = sinePhaseCoefficients(phase)
      for (let wt = 0; wt < 2 * Math.PI; wt += Math.PI / 16) {
        const synthesised = real[1]! * Math.cos(wt) + imag[1]! * Math.sin(wt)
        expect(synthesised).toBeCloseTo(Math.sin(wt + phase), FLOAT32_PLACES)
      }
    }
  })
})
