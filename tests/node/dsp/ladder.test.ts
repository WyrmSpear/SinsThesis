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
  it('rolls off about -24 dB per octave above cutoff', () => {
    const slope = slopeDbPerOctave(filter(noise(N), 1000, 0), SR, 2000, 12000)
    expect(slope).toBeLessThan(-18)
    expect(slope).toBeGreaterThan(-30)
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
