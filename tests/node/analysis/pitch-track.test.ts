import { describe, it, expect } from 'vitest'
import { trackPitch, dominantPitchHz } from '../../../src/engine/analysis/pitch-track'
import { peakHz } from '../../../src/engine/analysis/features'

const SR = 48000

function gen(n: number, fn: (i: number) => number): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = fn(i)
  return out
}

// Deterministic PRNG (mulberry32) rather than Math.random(), so a noise
// test never flakes from one run to the next.
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function voicedHz(frames: ReturnType<typeof trackPitch>): number[] {
  return frames.filter((f) => f.hz !== undefined).map((f) => f.hz!)
}

describe('trackPitch: steady tone', () => {
  // 246.9 Hz -- not a small-integer divisor of 48000
  // (48000 / 246.9 = 194.4...), per this project's own "never test at a
  // frequency where sampleRate / f0 is near an integer" rule.
  const F0 = 246.9
  const samples = gen(SR * 1.5, (i) => Math.sin((2 * Math.PI * F0 * i) / SR))
  const frames = trackPitch(samples, SR)

  it('reports frames', () => {
    expect(frames.length).toBeGreaterThan(5)
  })

  it('reports the fundamental, not a harmonic or subharmonic, in every voiced frame', () => {
    const hz = voicedHz(frames)
    expect(hz.length).toBeGreaterThan(frames.length * 0.8)
    for (const h of hz) expect(h).toBeCloseTo(F0, 0)
  })

  it('reports high confidence for a clean periodic tone', () => {
    const voiced = frames.filter((f) => f.hz !== undefined)
    const meanConfidence = voiced.reduce((a, f) => a + f.confidence, 0) / voiced.length
    expect(meanConfidence).toBeGreaterThan(0.8)
  })

  it('dominantPitchHz summarizes the steady tone correctly', () => {
    expect(dominantPitchHz(frames)).toBeCloseTo(F0, 0)
  })
})

describe('trackPitch: a linear glide', () => {
  // Closed-form phase for a linear frequency sweep f(t) = f0 + (f1-f0)*t/T,
  // so the signal is phase-continuous rather than drifting from summing
  // per-sample frequency increments.
  const F0 = 220
  const F1 = 440
  const DURATION_S = 1.0
  const N = Math.floor(SR * DURATION_S)
  const samples = gen(N, (i) => {
    const t = i / SR
    const phase = 2 * Math.PI * (F0 * t + ((F1 - F0) * t * t) / (2 * DURATION_S))
    return Math.sin(phase)
  })
  const frames = trackPitch(samples, SR, { hopSize: 256 })

  it('traces frequency rising from near F0 to near F1', () => {
    const voiced = frames.filter((f) => f.hz !== undefined)
    expect(voiced.length).toBeGreaterThan(frames.length * 0.5)
    const first = voiced[0]!
    const last = voiced[voiced.length - 1]!
    expect(first.hz!).toBeLessThan(260)
    expect(last.hz!).toBeGreaterThan(400)
  })

  it('is mostly monotonically increasing across the sweep', () => {
    const voiced = frames.filter((f) => f.hz !== undefined)
    let increases = 0
    for (let i = 1; i < voiced.length; i++) {
      if (voiced[i]!.hz! >= voiced[i - 1]!.hz! - 5) increases++
    }
    expect(increases / (voiced.length - 1)).toBeGreaterThan(0.85)
  })
})

describe('trackPitch: a saw with a louder second harmonic than fundamental', () => {
  // The exact trap the task warns about: an FFT-peak method reports the
  // loudest bin, which here is the second harmonic (2*F0), not F0 itself.
  // 220 Hz is not a small-integer divisor of 48000 (48000/220 = 218.18...).
  const F0 = 220
  const samples = gen(SR * 1.0, (i) => {
    const t = (2 * Math.PI * i) / SR
    return (
      0.3 * Math.sin(F0 * t) +
      1.0 * Math.sin(2 * F0 * t) + // louder than the fundamental
      0.2 * Math.sin(3 * F0 * t) +
      0.1 * Math.sin(4 * F0 * t)
    )
  })

  it('confirms the trap: naive peakHz reports an octave high', () => {
    // Documents the failure mode this test exists to avoid, rather than
    // asserting it as a requirement -- if a future FFT windowing change
    // happens to dodge it, that's fine; the point is trackPitch below.
    expect(peakHz(samples, SR)).toBeCloseTo(2 * F0, -1)
  })

  it('still reports the true fundamental, not the octave above', () => {
    const frames = trackPitch(samples, SR)
    const voiced = frames.filter((f) => f.hz !== undefined)
    expect(voiced.length).toBeGreaterThan(frames.length * 0.5)
    for (const f of voiced) {
      // Must land near F0 (220), not near 2*F0 (440).
      expect(f.hz!).toBeCloseTo(F0, 0)
    }
  })

  it('dominantPitchHz reports the fundamental', () => {
    const frames = trackPitch(samples, SR)
    const dominant = dominantPitchHz(frames)
    expect(dominant).toBeDefined()
    expect(dominant!).toBeCloseTo(F0, 0)
    expect(Math.abs(dominant! - 2 * F0)).toBeGreaterThan(50)
  })
})

describe('trackPitch: silence', () => {
  it('reports no pitch and zero confidence for every frame', () => {
    const samples = new Float32Array(SR)
    const frames = trackPitch(samples, SR)
    expect(frames.length).toBeGreaterThan(0)
    for (const f of frames) {
      expect(f.hz).toBeUndefined()
      expect(f.confidence).toBe(0)
    }
  })

  it('dominantPitchHz is undefined for pure silence', () => {
    const samples = new Float32Array(SR)
    expect(dominantPitchHz(trackPitch(samples, SR))).toBeUndefined()
  })
})

describe('trackPitch: a noise burst has no fundamental', () => {
  it('marks nearly every frame unvoiced rather than inventing a pitch', () => {
    const rand = mulberry32(12345)
    const samples = gen(SR, () => rand() * 2 - 1)
    const frames = trackPitch(samples, SR)
    const voicedFraction = frames.filter((f) => f.hz !== undefined).length / frames.length
    expect(voicedFraction).toBeLessThan(0.2)
  })
})
