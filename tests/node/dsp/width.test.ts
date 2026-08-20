import { describe, it, expect } from 'vitest'
import { msEncode, msDecode, widthSample } from '../../../src/engine/dsp/width'

describe('msEncode / msDecode round trip', () => {
  it('width = 1 is the identity', () => {
    for (const [l, r] of [[0.7, 0.2], [-0.5, 0.9], [0.3, 0.3], [-0.4, -0.4], [1, -1]] as const) {
      const { mid, side } = msEncode(l, r)
      const { left, right } = msDecode(mid, side, 1)
      expect(left).toBeCloseTo(l, 10)
      expect(right).toBeCloseTo(r, 10)
    }
  })

  it('width = 0 collapses both channels to mid -- full mono', () => {
    const { mid, side } = msEncode(0.8, 0.2)
    const { left, right } = msDecode(mid, side, 0)
    expect(left).toBeCloseTo(mid, 10)
    expect(right).toBeCloseTo(mid, 10)
    expect(left).toBeCloseTo(right, 10)
  })

  it('a mono input (l === r) is unaffected by any width setting -- side is already zero', () => {
    const { mid, side } = msEncode(0.55, 0.55)
    expect(side).toBeCloseTo(0, 10)
    for (const width of [0, 0.5, 1, 1.5, 2]) {
      const { left, right } = msDecode(mid, side, width)
      expect(left).toBeCloseTo(0.55, 10)
      expect(right).toBeCloseTo(0.55, 10)
    }
  })
})

describe('widthSample mono compatibility -- the acceptance criterion that matters most', () => {
  it('left + right is exactly left0 + right0 for every width, algebraically not approximately', () => {
    const inputs: [number, number][] = [[0.9, -0.3], [0.1, 0.05], [-0.6, 0.6], [0.7, 0.71], [1, 0]]
    const widths = [0, 0.25, 0.5, 1, 1.5, 2, 3]
    for (const [l, r] of inputs) {
      const expectedSum = l + r
      for (const width of widths) {
        const { left, right } = widthSample(l, r, width)
        expect(left + right).toBeCloseTo(expectedSum, 10)
      }
    }
  })

  it('never drops the mono-summed level to (near) zero for a source that was audible before widening', () => {
    // A correlated stereo source -- both channels carry the same signal at
    // slightly different levels, the common "wide pad" case -- summed to
    // mono at several widths should stay near its original level, not
    // hollow out the way a comb-filtered (Haas-delay) widener would.
    const l = 0.6
    const r = 0.5
    const monoBefore = Math.abs(l + r)
    for (const width of [0, 0.5, 1, 1.5, 2]) {
      const { left, right } = widthSample(l, r, width)
      expect(Math.abs(left + right)).toBeCloseTo(monoBefore, 10)
    }
  })
})
