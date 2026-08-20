import { describe, it, expect } from 'vitest'
import {
  createBinauralState, binauralSample, deriveChannelFreqs,
} from '../../../src/engine/dsp/binaural'

const SR = 48000

/** Average period of a signal's own rising zero crossings, sub-sample
 *  accurate via linear interpolation between the bounding samples -- the
 *  same technique tests/browser/modules/lfo-sync.test.ts uses and for the
 *  same reason: an FFT bin's resolution is far too coarse to measure a
 *  sub-hertz frequency to the precision this module claims. Works equally
 *  well at 220 Hz and at 0.1 Hz -- the technique has no frequency floor,
 *  only a "at least two crossings" floor. */
function measuredFreqHz(samples: Float32Array, sampleRate: number, skipSamples: number): number {
  const crossings: number[] = []
  for (let i = Math.max(1, skipSamples); i < samples.length; i++) {
    const prev = samples[i - 1]!
    const cur = samples[i]!
    if (prev < 0 && cur >= 0) {
      const frac = -prev / (cur - prev)
      crossings.push((i - 1 + frac) / sampleRate)
    }
  }
  if (crossings.length < 2) return 0
  const periodSeconds = (crossings[crossings.length - 1]! - crossings[0]!) / (crossings.length - 1)
  return 1 / periodSeconds
}

/** Runs binauralSample for `seconds` at SR, in pure JS -- no AudioContext,
 *  no worklet -- and returns both channels as plain arrays for the zero-
 *  crossing measurement above. This is the "over minutes, not seconds"
 *  verification the task calls for: a real multi-minute run of the exact
 *  per-sample function the worklet calls, not a short proxy for one. */
function render(carrierHz: number, beatHz: number, seconds: number): { left: Float32Array; right: Float32Array } {
  const n = Math.round(seconds * SR)
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  const state = createBinauralState()
  for (let i = 0; i < n; i++) {
    const s = binauralSample(state, carrierHz, beatHz, SR)
    left[i] = s.left
    right[i] = s.right
  }
  return { left, right }
}

describe('deriveChannelFreqs', () => {
  it('splits carrier +/- beat/2, so right - left is exactly beat', () => {
    const { left, right } = deriveChannelFreqs(220, 4)
    expect(left).toBe(218)
    expect(right).toBe(222)
    expect(right - left).toBe(4)
  })

  it('is exact for a sub-hertz beat too -- no rounding lost in the split', () => {
    const { left, right } = deriveChannelFreqs(220, 0.3)
    expect(right - left).toBeCloseTo(0.3, 12)
  })

  it('clamps a channel to 0 rather than going negative when beat overshoots 2x carrier', () => {
    const { left, right } = deriveChannelFreqs(5, 20) // beat/2 = 10 > carrier
    expect(left).toBe(0)
    expect(right).toBe(15)
  })
})

describe('binauralSample: measured accuracy at ordinary rates', () => {
  it('each channel lands on its derived frequency, measured by zero-crossing, not merely computed', () => {
    // 220 Hz carrier: 48000/220 = 218.18... -- not near an integer, so this
    // avoids the aliasing-onto-a-harmonic trap (docs/CONTINUATION.md trap 1),
    // though it barely matters here since a bare sine has nothing to alias.
    const { left, right } = render(220, 4, 3)
    const skip = Math.round(0.2 * SR)
    const leftHz = measuredFreqHz(left, SR, skip)
    const rightHz = measuredFreqHz(right, SR, skip)
    console.log(`binaural @carrier=220 beat=4: measured left=${leftHz.toFixed(6)} Hz, right=${rightHz.toFixed(6)} Hz, beat=${(rightHz - leftHz).toFixed(6)} Hz`)
    expect(leftHz).toBeCloseTo(218, 3)
    expect(rightHz).toBeCloseTo(222, 3)
    expect(rightHz - leftHz).toBeCloseTo(4, 3)
  })
})

describe('binauralSample: sub-hertz beat precision and drift over minutes', () => {
  it('holds a 0.3 Hz beat accurate to a small fraction of a millihertz over 3 minutes, with no drift between the first and last minute', () => {
    const carrierHz = 220
    const beatHz = 0.3
    const seconds = 180
    const { left, right } = render(carrierHz, beatHz, seconds)

    const windowSamples = 60 * SR
    const earlyLeft = measuredFreqHz(left.subarray(0, windowSamples), SR, 0)
    const earlyRight = measuredFreqHz(right.subarray(0, windowSamples), SR, 0)
    const lateLeft = measuredFreqHz(left.subarray(left.length - windowSamples), SR, 0)
    const lateRight = measuredFreqHz(right.subarray(right.length - windowSamples), SR, 0)

    const expectedLeft = carrierHz - beatHz / 2
    const expectedRight = carrierHz + beatHz / 2

    console.log(
      `binaural sub-hertz drift check: expected left=${expectedLeft} right=${expectedRight}; ` +
      `early(0-60s) left=${earlyLeft.toFixed(6)} right=${earlyRight.toFixed(6)} beat=${(earlyRight - earlyLeft).toFixed(6)}; ` +
      `late(120-180s) left=${lateLeft.toFixed(6)} right=${lateRight.toFixed(6)} beat=${(lateRight - lateLeft).toFixed(6)}`,
    )

    // Absolute accuracy: each channel within 1 mHz of its nominal frequency,
    // in both the early and the late window.
    expect(Math.abs(earlyLeft - expectedLeft)).toBeLessThan(0.001)
    expect(Math.abs(earlyRight - expectedRight)).toBeLessThan(0.001)
    expect(Math.abs(lateLeft - expectedLeft)).toBeLessThan(0.001)
    expect(Math.abs(lateRight - expectedRight)).toBeLessThan(0.001)

    // Stability: the early-window and late-window measurements of the same
    // nominally-constant frequency must agree with each other far more
    // tightly than either agrees with the nominal value alone -- this is
    // what actually proves "no drift over minutes" rather than "happened to
    // be accurate twice independently."
    expect(Math.abs(earlyLeft - lateLeft)).toBeLessThan(0.0005)
    expect(Math.abs(earlyRight - lateRight)).toBeLessThan(0.0005)

    // The beat itself, derived by subtraction of two independently
    // zero-crossing-measured channels (so its own error is the sum of
    // both), still resolves to within a few mHz of the nominal 0.3 Hz.
    expect(Math.abs((earlyRight - earlyLeft) - beatHz)).toBeLessThan(0.002)
    expect(Math.abs((lateRight - lateLeft) - beatHz)).toBeLessThan(0.002)
  }, 20000)

  it('a beat below 0.1 Hz still resolves distinctly from a beat of 0 -- genuinely sub-hertz, not rounded away', () => {
    const seconds = 60
    const { left: l0, right: r0 } = render(220, 0, seconds)
    const { left: l1, right: r1 } = render(220, 0.05, seconds)
    const skip = Math.round(5 * SR)
    const beat0 = measuredFreqHz(r0, SR, skip) - measuredFreqHz(l0, SR, skip)
    const beat1 = measuredFreqHz(r1, SR, skip) - measuredFreqHz(l1, SR, skip)
    console.log(`binaural near-zero beat resolution: beat=0 measured=${beat0.toFixed(6)}, beat=0.05 measured=${beat1.toFixed(6)}`)
    expect(Math.abs(beat0)).toBeLessThan(0.0005)
    expect(Math.abs(beat1 - 0.05)).toBeLessThan(0.0005)
  }, 20000)
})

describe('binauralSample: DC offset and boundedness under extreme settings', () => {
  it('stays DC-free and within [-1, 1] at the beat range extremes', () => {
    for (const beat of [0.01, 40]) {
      const { left, right } = render(220, beat, 2)
      let sumL = 0, sumR = 0, peak = 0
      for (let i = 0; i < left.length; i++) {
        sumL += left[i]!
        sumR += right[i]!
        peak = Math.max(peak, Math.abs(left[i]!), Math.abs(right[i]!))
      }
      const dcL = sumL / left.length
      const dcR = sumR / right.length
      console.log(`binaural extreme beat=${beat}: DC left=${dcL.toExponential(3)}, right=${dcR.toExponential(3)}, peak=${peak.toFixed(4)}`)
      expect(Math.abs(dcL)).toBeLessThan(0.01)
      expect(Math.abs(dcR)).toBeLessThan(0.01)
      expect(peak).toBeLessThanOrEqual(1.0001)
    }
  })

  it('carrier at the low and high ends of the panel range stays well-behaved', () => {
    for (const carrier of [20, 2000]) {
      const { left, right } = render(carrier, 4, 0.5)
      for (let i = 0; i < left.length; i++) {
        expect(Math.abs(left[i]!)).toBeLessThanOrEqual(1.0001)
        expect(Math.abs(right[i]!)).toBeLessThanOrEqual(1.0001)
      }
    }
  })
})
