import { describe, it, expect } from 'vitest'
import { equalPowerGains, equalPowerPanSample } from '../../../src/engine/dsp/pan'

function powerDb(left: number, right: number): number {
  return 10 * Math.log10(left * left + right * right)
}

describe('equalPowerGains', () => {
  it('is unity power at both hard extremes', () => {
    const hardLeft = equalPowerGains(-1)
    expect(hardLeft.left).toBeCloseTo(1, 6)
    expect(hardLeft.right).toBeCloseTo(0, 6)
    const hardRight = equalPowerGains(1)
    expect(hardRight.left).toBeCloseTo(0, 6)
    expect(hardRight.right).toBeCloseTo(1, 6)
  })

  it('splits evenly at center, each channel down 3.01 dB', () => {
    const center = equalPowerGains(0)
    expect(center.left).toBeCloseTo(center.right, 6)
    expect(20 * Math.log10(center.left)).toBeCloseTo(-3.01, 1)
  })

  it('holds total power flat across the sweep -- the whole reason for this law over a linear crossfade', () => {
    const extremeDb = powerDb(...([equalPowerGains(-1).left, equalPowerGains(-1).right] as [number, number]))
    const positions = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1]
    for (const pan of positions) {
      const { left, right } = equalPowerGains(pan)
      const db = powerDb(left, right)
      // "a fraction of a dB of the extremes" -- the task's own acceptance
      // wording. Floating point puts every position within a hundredth of a
      // dB of the others; 0.1 dB is a generous, still-meaningful bound.
      expect(Math.abs(db - extremeDb)).toBeLessThan(0.1)
    }
  })

  it('a linear crossfade, by contrast, really does sag 3 dB in the centre -- the defect this law fixes', () => {
    // Not equalPowerGains -- this is the rejected alternative, reconstructed
    // here only to prove the claim in this file's own doc comment rather
    // than assert it on faith.
    type PanGains = { left: number; right: number }
    const linear = (pan: number): PanGains => {
      const t = (pan + 1) / 2
      return { left: 1 - t, right: t }
    }
    const extreme = powerDb(1, 0)
    const center = linear(0)
    const centerDb = powerDb(center.left, center.right)
    expect(extreme - centerDb).toBeCloseTo(3.01, 1)
  })

  it('clamps CV overshoot beyond [-1, 1] instead of throwing or extrapolating', () => {
    expect(equalPowerGains(-5)).toEqual(equalPowerGains(-1))
    expect(equalPowerGains(5)).toEqual(equalPowerGains(1))
  })
})

describe('equalPowerPanSample', () => {
  it('scales a mono sample into two channels', () => {
    const { left, right } = equalPowerPanSample(0.5, 0)
    expect(left).toBeCloseTo(0.5 * Math.SQRT1_2, 6)
    expect(right).toBeCloseTo(0.5 * Math.SQRT1_2, 6)
  })
})
