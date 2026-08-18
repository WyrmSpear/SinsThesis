import { describe, it, expect } from 'vitest'
import { fftMagnitude } from '../../../src/engine/analysis/fft'

function sine(freq: number, sampleRate: number, n: number): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate)
  return out
}

describe('fftMagnitude', () => {
  it('rejects non-power-of-two input', () => {
    expect(() => fftMagnitude(new Float32Array(1000))).toThrow(/power of two/)
  })

  it('returns n/2 bins', () => {
    expect(fftMagnitude(new Float32Array(1024)).length).toBe(512)
  })

  it('puts a 1 kHz sine in the 1 kHz bin', () => {
    const sr = 48000
    const n = 4096
    const mags = fftMagnitude(sine(1000, sr, n))
    let peak = 0
    for (let i = 1; i < mags.length; i++) if (mags[i]! > mags[peak]!) peak = i
    const peakHz = (peak * sr) / n
    expect(peakHz).toBeCloseTo(1000, -1)
  })

  it('normalizes a full-scale sine to about 1.0', () => {
    const mags = fftMagnitude(sine(1000, 48000, 4096))
    const peak = Math.max(...mags)
    expect(peak).toBeGreaterThan(0.9)
    expect(peak).toBeLessThan(1.1)
  })

  it('reports near-zero energy for silence', () => {
    const mags = fftMagnitude(new Float32Array(1024))
    expect(Math.max(...mags)).toBeLessThan(1e-9)
  })
})
