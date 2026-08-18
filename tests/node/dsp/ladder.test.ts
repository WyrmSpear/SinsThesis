import { describe, it, expect } from 'vitest'
import { createLadderState, ladderSample } from '../../../src/engine/dsp/ladder'
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

function filter(input: Float32Array, cutoff: number, res: number): Float32Array {
  const state = createLadderState()
  const out = new Float32Array(input.length)
  for (let i = 0; i < input.length; i++) {
    out[i] = ladderSample(state, input[i]!, cutoff, res, SR)
  }
  return out
}

describe('ladder response', () => {
  it('reaches a four-pole asymptotic slope well above cutoff', () => {
    // Measured in a band far enough above the knee to be asymptotic but below
    // the region where bilinear prewarp steepens the response near Nyquist.
    // The local slope is not uniform: it ramps from about -8 dB/oct just above
    // the knee to about -38 dB/oct approaching Nyquist. Four poles is the
    // figure in between, and this band is where it actually holds.
    const slope = slopeDbPerOctave(filter(noise(N), 1000, 0), SR, 4000, 8000)
    expect(slope).toBeLessThan(-22)
    expect(slope).toBeGreaterThan(-28)
  })

  it('passes low frequencies close to unity', () => {
    const input = new Float32Array(N)
    for (let i = 0; i < N; i++) input[i] = Math.sin((2 * Math.PI * 100 * i) / SR) * 0.5
    const out = filter(input, 8000, 0)
    // Skip the first 1000 samples so the filter has settled.
    expect(rms(out.subarray(1000))).toBeGreaterThan(rms(input.subarray(1000)) * 0.8)
  })

  it('attenuates a tone an octave above cutoff', () => {
    const input = new Float32Array(N)
    for (let i = 0; i < N; i++) input[i] = Math.sin((2 * Math.PI * 2000 * i) / SR) * 0.5
    const out = filter(input, 1000, 0)
    expect(rms(out.subarray(1000))).toBeLessThan(rms(input) * 0.2)
  })
})

describe('resonance', () => {
  it('self-oscillates at the cutoff frequency when driven to the limit', () => {
    // A brief noise burst starts it; the rest is silence, so any remaining
    // signal is the filter ringing on its own.
    const input = new Float32Array(N)
    input.set(noise(256, 0.5))
    const out = filter(input, 1000, 1)
    const tail = out.subarray(N / 2)
    expect(rms(tail)).toBeGreaterThan(0.01)
    expect(peakHz(tail, SR)).toBeCloseTo(1000, -2)
  })

  it('does not self-oscillate with resonance at zero', () => {
    const input = new Float32Array(N)
    input.set(noise(256, 0.5))
    const out = filter(input, 1000, 0)
    expect(rms(out.subarray(N / 2))).toBeLessThan(0.001)
  })

  it('stays bounded when driven hard at full resonance', () => {
    const out = filter(noise(N, 4), 2000, 1)
    for (const v of out) expect(Number.isFinite(v) && Math.abs(v) < 4).toBe(true)
  })
})

describe('calibration', () => {
  it('self-oscillates at the dialled cutoff across the range', () => {
    // The knob's contract: this is the frequency it rings at, so a resonant
    // ladder tracks 1V/oct and plays in tune.
    for (const cutoff of [200, 1000, 5000]) {
      const input = new Float32Array(N)
      input.set(noise(256, 0.5))
      const out = filter(input, cutoff, 1)
      const measured = peakHz(out.subarray(N / 2), SR)
      expect(Math.abs(measured - cutoff) / cutoff).toBeLessThan(0.02)
    }
  })

  it('holds unity passband as resonance opens', () => {
    // Without makeup gain the closed loop's 1/(1+k) DC gain costs nearly 10 dB
    // at full resonance, and the patch thins out as the player opens it up.
    const tone = new Float32Array(N)
    for (let i = 0; i < N; i++) tone[i] = Math.sin((2 * Math.PI * 100 * i) / SR) * 0.5
    const reference = rms(tone.subarray(1000))
    for (const res of [0, 0.5, 1]) {
      const gain = rms(filter(tone, 2000, res).subarray(1000)) / reference
      expect(20 * Math.log10(gain)).toBeGreaterThan(-1.5)
      expect(20 * Math.log10(gain)).toBeLessThan(1.5)
    }
  })
})
