import { describe, it, expect } from 'vitest'
import { createPingPongState, pingPongSample, type PingPongOutput } from '../../../src/engine/dsp/pingpong'

const SR = 48000

function runImpulse(delaySamples: number, feedback: number, mix: number, totalSamples: number) {
  const state = createPingPongState(2, SR)
  const left = new Float32Array(totalSamples)
  const right = new Float32Array(totalSamples)
  const out: PingPongOutput = { left: 0, right: 0 }
  for (let n = 0; n < totalSamples; n++) {
    const input = n === 0 ? 1 : 0
    pingPongSample(state, input, delaySamples, feedback, mix, out)
    left[n] = out.left
    right[n] = out.right
  }
  return { left, right }
}

describe('pingPongSample', () => {
  it('crosses channels: the first echo lands on L, the second on R, alternating every delay period', () => {
    const delaySamples = 100
    const feedback = 0.5
    const { left, right } = runImpulse(delaySamples, feedback, /* mix */ 1, 5 * delaySamples)

    // Echo 1 (n=100): full-strength, left only.
    expect(left[delaySamples]!).toBeCloseTo(1, 3)
    expect(right[delaySamples]!).toBeCloseTo(0, 3)

    // Echo 2 (n=200): one feedback attenuation, right only.
    expect(right[2 * delaySamples]!).toBeCloseTo(feedback, 3)
    expect(left[2 * delaySamples]!).toBeCloseTo(0, 3)

    // Echo 3 (n=300): two attenuations, back on left.
    expect(left[3 * delaySamples]!).toBeCloseTo(feedback ** 2, 3)
    expect(right[3 * delaySamples]!).toBeCloseTo(0, 3)

    // Echo 4 (n=400): three attenuations, right again.
    expect(right[4 * delaySamples]!).toBeCloseTo(feedback ** 3, 3)
    expect(left[4 * delaySamples]!).toBeCloseTo(0, 3)
  })

  it('decays geometrically by the feedback amount on every bounce', () => {
    const delaySamples = 64
    const feedback = 0.6
    const { left, right } = runImpulse(delaySamples, feedback, 1, 6 * delaySamples)
    const peaks = [1, 2, 3, 4, 5].map((k) => (k % 2 === 1 ? left : right)[k * delaySamples]!)
    for (let k = 1; k < peaks.length; k++) {
      expect(peaks[k]! / peaks[k - 1]!).toBeCloseTo(feedback, 2)
    }
  })

  it('never cancels in a mono sum -- each echo appears in exactly one channel, so L+R always carries it', () => {
    const delaySamples = 80
    const feedback = 0.45
    const { left, right } = runImpulse(delaySamples, feedback, 1, 5 * delaySamples)
    for (const k of [1, 2, 3, 4]) {
      const n = k * delaySamples
      const mono = left[n]! + right[n]!
      expect(mono).toBeCloseTo(feedback ** (k - 1), 3)
      expect(mono).toBeGreaterThan(0.001) // audible, not hollowed out
    }
  })

  it('the dry path is panned center, so a mix of 0 leaves both channels identical and equal to the input', () => {
    const state = createPingPongState(2, SR)
    const out: PingPongOutput = { left: 0, right: 0 }
    for (let n = 0; n < 10; n++) {
      pingPongSample(state, 0.3, 50, 0.5, /* mix */ 0, out)
      expect(out.left).toBeCloseTo(0.3, 6)
      expect(out.right).toBeCloseTo(0.3, 6)
    }
  })

  it('is stable (no runaway) at the maximum feedback a module would expose', () => {
    const { left, right } = runImpulse(30, 0.95, 1, 30 * 30)
    for (let i = 0; i < left.length; i++) {
      expect(Number.isFinite(left[i])).toBe(true)
      expect(Number.isFinite(right[i])).toBe(true)
      expect(Math.abs(left[i]!)).toBeLessThan(2)
      expect(Math.abs(right[i]!)).toBeLessThan(2)
    }
  })
})
