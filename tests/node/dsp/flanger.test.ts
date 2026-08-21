import { describe, it, expect } from 'vitest'
import {
  createFlangerState,
  flangerSample,
  MAX_FEEDBACK,
  type FlangerParams,
} from '../../../src/engine/dsp/flanger'
import { fftMagnitude } from '../../../src/engine/analysis/fft'
import { db } from '../../../src/engine/analysis/features'

const SAMPLE_RATE = 48000
const IR_LENGTH = 32768

const params = (over: Partial<FlangerParams> = {}): FlangerParams => ({
  manual: 0.001,
  rate: 0.1,
  depth: 0, // frozen: an LTI system, so its impulse response means something
  feedback: 0,
  mix: 0.5,
  ...over,
})

/**
 * Impulse response. With `depth: 0` the flanger is linear and
 * time-invariant, so its IR *is* its transfer function -- exact and
 * deterministic, with none of the stochastic variance a noise-driven
 * measurement carries.
 */
function impulseResponse(p: FlangerParams, length = IR_LENGTH): Float32Array {
  const state = createFlangerState(SAMPLE_RATE)
  const out = new Float32Array(length)
  for (let n = 0; n < length; n++) {
    out[n] = flangerSample(state, n === 0 ? 1 : 0, p, SAMPLE_RATE)
  }
  return out
}

/** |H(f)| evaluated at an exact frequency by direct DFT, so a notch can be
 *  probed where it actually is rather than at the nearest FFT bin. */
function magAt(ir: Float32Array, hz: number): number {
  let re = 0
  let im = 0
  for (let n = 0; n < ir.length; n++) {
    const v = ir[n]!
    if (v === 0) continue
    const w = (-2 * Math.PI * hz * n) / SAMPLE_RATE
    re += v * Math.cos(w)
    im += v * Math.sin(w)
  }
  return Math.hypot(re, im)
}

const notchHz = (d: number, k: number): number => (2 * k + 1) / (2 * d)
const peakHz = (d: number, k: number): number => k / d

describe('flangerSample: the comb', () => {
  it('nulls exactly where the delay predicts, deeply enough to be a real null', () => {
    const d = 0.001
    const ir = impulseResponse(params({ manual: d }))
    const peak = (magAt(ir, peakHz(d, 1)) + magAt(ir, peakHz(d, 2))) / 2

    const depths = [0, 1, 2, 3].map((k) => db(magAt(ir, notchHz(d, k)) / peak))
    // eslint-disable-next-line no-console
    console.log(
      'flanger notch depths @1ms: ' +
        [0, 1, 2, 3].map((k, i) => `${notchHz(d, k)}Hz ${depths[i]!.toFixed(1)}dB`).join(', '),
    )
    // Dry and wet cancel exactly at these frequencies. Anything shallower
    // than -60 dB means the fractional read is smearing the cancellation.
    for (const dep of depths) expect(dep).toBeLessThan(-60)
  })

  it('keeps the nulls deep at deliberately fractional delays, which is what the cubic read buys', () => {
    // 47.5 samples: the worst case for an interpolator, exactly between two
    // stored samples. A whole-sample delay would flatter any interpolator,
    // including a bad one.
    const d = 47.5 / SAMPLE_RATE
    const ir = impulseResponse(params({ manual: d }))
    const peak = (magAt(ir, peakHz(d, 1)) + magAt(ir, peakHz(d, 2))) / 2
    const first = db(magAt(ir, notchHz(d, 0)) / peak)
    // eslint-disable-next-line no-console
    console.log(`flanger fractional (47.5 samples): first null ${first.toFixed(1)} dB`)
    expect(first).toBeLessThan(-40)
  })

  it('passes the input untouched at mix 0', () => {
    const ir = impulseResponse(params({ mix: 0, feedback: 0.5 }))
    expect(ir[0]).toBeCloseTo(1, 10)
    for (let n = 1; n < 4000; n++) expect(ir[n]).toBe(0)
  })
})

describe('flangerSample: regeneration', () => {
  /**
   * The regression test for this module being a worklet at all.
   *
   * A native `DelayNode` flanger cannot pass this. Web Audio must insert a
   * render quantum (128 samples) into any graph cycle, so its regeneration
   * resonates at `1/(d + 0.002667)` = 273 Hz spacing for a 1 ms delay, not
   * at `1/d` = 1000 Hz. That was measured on the native version before this
   * file existed -- peaks came out spaced 250-280 Hz. If this test ever
   * starts reading ~273 Hz, someone has reverted the delay line back to a
   * DelayNode in a cycle.
   */
  it('resonates on the same comb the dry/wet notch uses, not one a render quantum wider', () => {
    const d = 0.001
    const ir = impulseResponse(params({ manual: d, feedback: 0.9, mix: 1 }))
    const mags = fftMagnitude(ir, 'blackman-harris')
    const perBin = SAMPLE_RATE / IR_LENGTH

    // Relative threshold: fftMagnitude normalises a full-scale *sine* to 1.0,
    // which says nothing about the scale of an impulse response, so an
    // absolute cutoff here would be arbitrary.
    const limit = Math.floor(4000 / perBin)
    let strongest = 0
    for (let i = 2; i < limit; i++) strongest = Math.max(strongest, mags[i]!)

    const peaks: number[] = []
    for (let i = 2; i < limit; i++) {
      if (mags[i]! > mags[i - 1]! && mags[i]! > mags[i + 1]! && mags[i]! > 0.3 * strongest) {
        const hz = i * perBin
        if (peaks.length === 0 || hz - peaks[peaks.length - 1]! > 200) peaks.push(hz)
      }
    }
    const spacings = peaks.slice(1).map((p, i) => p - peaks[i]!)
    const meanSpacing = spacings.reduce((a, b) => a + b, 0) / Math.max(spacings.length, 1)

    // eslint-disable-next-line no-console
    console.log(
      `flanger regeneration: peaks at ${peaks.map((p) => p.toFixed(0)).join(', ')} Hz; ` +
        `mean spacing ${meanSpacing.toFixed(1)} Hz (want 1000, native-DelayNode failure mode is 273)`,
    )

    expect(spacings.length).toBeGreaterThanOrEqual(2)
    expect(meanSpacing).toBeGreaterThan(950)
    expect(meanSpacing).toBeLessThan(1050)
  })

  it('gives positive and negative feedback opposite comb tilts, so the sign is a real control', () => {
    const d = 0.001
    const tilt = (feedback: number): number => {
      const ir = impulseResponse(params({ manual: d, feedback, mix: 1 }))
      return db(magAt(ir, 1000) / magAt(ir, 500))
    }
    const pos = tilt(0.8)
    const neg = tilt(-0.8)
    // eslint-disable-next-line no-console
    console.log(`flanger feedback tilt: +0.8 ${pos.toFixed(1)} dB, -0.8 ${neg.toFixed(1)} dB`)

    // Positive regeneration resonates the even series (1000 Hz); negative
    // resonates the odd one (500 Hz). Equal and opposite, not merely
    // different -- that symmetry is what makes the sign meaningful.
    expect(pos).toBeGreaterThan(15)
    expect(neg).toBeLessThan(-15)
  })

  it('stays bounded at both feedback extremes over a long run', () => {
    for (const feedback of [MAX_FEEDBACK, -MAX_FEEDBACK]) {
      const state = createFlangerState(SAMPLE_RATE)
      const p = params({ manual: 0.001, feedback, depth: 1, rate: 5, mix: 0.5 })
      let peak = 0
      // Ten seconds of full-scale noise, sweeping -- far past any transient.
      let seed = 99
      for (let n = 0; n < SAMPLE_RATE * 10; n++) {
        seed = (seed * 1664525 + 1013904223) >>> 0
        const input = (seed / 0x100000000) * 2 - 1
        const out = flangerSample(state, input, p, SAMPLE_RATE)
        expect(Number.isFinite(out)).toBe(true)
        peak = Math.max(peak, Math.abs(out))
      }
      // eslint-disable-next-line no-console
      console.log(`flanger stability @feedback ${feedback}: peak ${peak.toFixed(3)}`)
      // 1/(1-0.95) = 20 is the worst-case steady-state gain of the recursion;
      // this only has to prove it does not run away.
      expect(peak).toBeLessThan(25)
    }
  })
})

describe('flangerSample: the sweep', () => {
  it('moves the delay when depth is up, and holds it still when depth is 0', () => {
    const measureFirstNull = (depth: number, atSample: number): number => {
      const state = createFlangerState(SAMPLE_RATE)
      const p = params({ manual: 0.002, depth, rate: 2, feedback: 0, mix: 0.5 })
      // Run to the instant of interest, then capture a short window and find
      // where its first null sits.
      for (let n = 0; n < atSample; n++) flangerSample(state, 0, p, SAMPLE_RATE)
      const win = new Float32Array(2048)
      let seed = 7
      for (let n = 0; n < win.length; n++) {
        seed = (seed * 1664525 + 1013904223) >>> 0
        win[n] = flangerSample(state, (seed / 0x100000000) * 2 - 1, p, SAMPLE_RATE)
      }
      const mags = fftMagnitude(win, 'hann')
      const perBin = SAMPLE_RATE / win.length
      let minBin = 2
      let minVal = Infinity
      for (let i = 2; i < Math.floor(600 / perBin); i++) {
        if (mags[i]! < minVal) {
          minVal = mags[i]!
          minBin = i
        }
      }
      return minBin * perBin
    }

    // A quarter of a 2 Hz cycle apart.
    const swept = [measureFirstNull(1, 6000), measureFirstNull(1, 12000)]
    const still = [measureFirstNull(0, 6000), measureFirstNull(0, 12000)]
    // eslint-disable-next-line no-console
    console.log(
      `flanger sweep: depth=1 null ${swept[0]!.toFixed(0)} -> ${swept[1]!.toFixed(0)} Hz, ` +
        `depth=0 null ${still[0]!.toFixed(0)} -> ${still[1]!.toFixed(0)} Hz`,
    )

    expect(Math.abs(swept[1]! - swept[0]!)).toBeGreaterThan(20)
    expect(Math.abs(still[1]! - still[0]!)).toBeLessThan(15)
  })
})
