import { describe, it, expect } from 'vitest'
import {
  createCompressorState,
  compressorSample,
  gainComputerDb,
  type CompressorParams,
} from '../../../src/engine/dsp/compressor'

const SAMPLE_RATE = 48000
const dbOf = (linear: number): number => 20 * Math.log10(Math.abs(linear))

const params = (over: Partial<CompressorParams> = {}): CompressorParams => ({
  thresholdDb: -20,
  ratio: 4,
  attackMs: 1,
  releaseMs: 100,
  kneeDb: 0,
  makeupDb: 0,
  ...over,
})

/** Run a constant level in until the reduction has settled, then report the
 *  steady-state output level in dB. DC rather than a sine on purpose: a
 *  peak detector fed a sine sees a level that oscillates with the waveform,
 *  which is correct behaviour but blurs a measurement of the *static* curve.
 *  The sine case is exercised separately below. */
function steadyStateOutputDb(inputDb: number, p: CompressorParams): number {
  const state = createCompressorState()
  const input = Math.pow(10, inputDb / 20)
  let out = 0
  // A full second is many time constants at any setting the panel allows.
  for (let n = 0; n < SAMPLE_RATE; n++) out = compressorSample(state, input, input, p, SAMPLE_RATE)
  return dbOf(out)
}

describe('gainComputerDb: the ratio law', () => {
  it('leaves anything below the threshold completely alone', () => {
    for (const levelDb of [-60, -40, -30, -25, -20.001]) {
      expect(gainComputerDb(levelDb, -20, 4, 0)).toBe(0)
    }
  })

  it('reproduces the definition of ratio above the threshold', () => {
    // The identity: outputDb == threshold + (inputDb - threshold) / ratio.
    for (const ratio of [2, 4, 8, 20]) {
      for (const levelDb of [-18, -12, -6, 0]) {
        const outputDb = levelDb + gainComputerDb(levelDb, -20, ratio, 0)
        expect(outputDb).toBeCloseTo(-20 + (levelDb - -20) / ratio, 10)
      }
    }
  })

  it('is a bypass at ratio 1', () => {
    for (const levelDb of [-40, -20, -10, 0]) {
      expect(gainComputerDb(levelDb, -20, 1, 0)).toBeCloseTo(0, 12)
    }
  })

  it('never boosts -- reduction is always zero or negative', () => {
    for (let levelDb = -80; levelDb <= 6; levelDb += 0.5) {
      for (const knee of [0, 6, 24]) {
        expect(gainComputerDb(levelDb, -20, 4, knee)).toBeLessThanOrEqual(1e-12)
      }
    }
  })
})

describe('gainComputerDb: the knee', () => {
  it('joins both straight segments continuously -- a knee that does not join is a click', () => {
    const knee = 12
    const threshold = -20
    const ratio = 4

    // Lower join: the knee must reach exactly zero where compression starts.
    const lower = gainComputerDb(threshold - knee / 2, threshold, ratio, knee)
    expect(lower).toBeCloseTo(0, 10)

    // Upper join: the knee must equal what the straight segment gives there.
    const upper = gainComputerDb(threshold + knee / 2, threshold, ratio, knee)
    const straight = (1 / ratio - 1) * (knee / 2)
    expect(upper).toBeCloseTo(straight, 10)
  })

  it('stays continuous across the whole knee, with no step anywhere', () => {
    const knee = 12
    let previous = gainComputerDb(-40, -20, 4, knee)
    for (let levelDb = -40; levelDb <= 6; levelDb += 0.05) {
      const value = gainComputerDb(levelDb, -20, 4, knee)
      // 0.05 dB of input can never move the reduction more than 0.05 dB,
      // since the steepest the curve ever gets is the 1:1 asymptote.
      expect(Math.abs(value - previous)).toBeLessThan(0.06)
      previous = value
    }
  })

  it('is monotonically decreasing -- more input never earns less reduction', () => {
    let previous = 0
    for (let levelDb = -60; levelDb <= 6; levelDb += 0.1) {
      const value = gainComputerDb(levelDb, -20, 4, 12)
      expect(value).toBeLessThanOrEqual(previous + 1e-12)
      previous = value
    }
  })

  it('matches the hard-knee curve well outside the knee', () => {
    for (const levelDb of [-40, -30, 0, 6]) {
      const soft = gainComputerDb(levelDb, -20, 4, 6)
      const hard = gainComputerDb(levelDb, -20, 4, 0)
      expect(soft).toBeCloseTo(hard, 10)
    }
  })
})

describe('compressorSample: the static curve, end to end', () => {
  it('lands on the ratio law at steady state', () => {
    const rows: string[] = []
    for (const ratio of [2, 4, 8]) {
      for (const inputDb of [-30, -20, -10, -3]) {
        const measured = steadyStateOutputDb(inputDb, params({ ratio }))
        const expected = inputDb <= -20 ? inputDb : -20 + (inputDb - -20) / ratio
        rows.push(`${ratio}:1 in ${inputDb} -> ${measured.toFixed(2)} (want ${expected.toFixed(2)})`)
        expect(measured).toBeCloseTo(expected, 4)
      }
    }
    // eslint-disable-next-line no-console
    console.log('compressor static curve: ' + rows.join('; '))
  })

  it('applies makeup gain exactly', () => {
    const without = steadyStateOutputDb(-10, params({ makeupDb: 0 }))
    const with12 = steadyStateOutputDb(-10, params({ makeupDb: 12 }))
    // eslint-disable-next-line no-console
    console.log(`compressor makeup: ${without.toFixed(2)} -> ${with12.toFixed(2)} dB`)
    expect(with12 - without).toBeCloseTo(12, 6)
  })

  it('passes signal through untouched at ratio 1', () => {
    for (const inputDb of [-30, -10, 0]) {
      expect(steadyStateOutputDb(inputDb, params({ ratio: 1 }))).toBeCloseTo(inputDb, 6)
    }
  })
})

describe('compressorSample: attack and release are real time constants', () => {
  /** The knob is a time constant, so after exactly that long the reduction
   *  must have covered 63.2% of its distance to the target. Anything else
   *  means the smoothing is on the wrong quantity. */
  const measureCoverageAfter = (
    p: CompressorParams,
    milliseconds: number,
    drive: (n: number) => number,
    settleWith?: number,
  ): number => {
    const state = createCompressorState()
    if (settleWith !== undefined) {
      for (let n = 0; n < SAMPLE_RATE; n++) compressorSample(state, settleWith, settleWith, p, SAMPLE_RATE)
    }
    const start = state.reductionDb
    const samples = Math.round((milliseconds / 1000) * SAMPLE_RATE)
    for (let n = 0; n < samples; n++) {
      const v = drive(n)
      compressorSample(state, v, v, p, SAMPLE_RATE)
    }
    const afterOneConstant = state.reductionDb
    // Run far longer to find the asymptote.
    for (let n = 0; n < SAMPLE_RATE; n++) {
      const v = drive(n)
      compressorSample(state, v, v, p, SAMPLE_RATE)
    }
    const settled = state.reductionDb
    return (afterOneConstant - start) / (settled - start)
  }

  it('covers 63.2% of the attack in exactly one attack time', () => {
    const loud = Math.pow(10, -3 / 20)
    for (const attackMs of [1, 10, 50]) {
      const coverage = measureCoverageAfter(params({ attackMs }), attackMs, () => loud)
      // eslint-disable-next-line no-console
      console.log(`compressor attack ${attackMs} ms: covered ${(coverage * 100).toFixed(1)}% (want 63.2%)`)
      expect(coverage).toBeCloseTo(0.632, 2)
    }
  })

  it('covers 63.2% of the release in exactly one release time', () => {
    const loud = Math.pow(10, -3 / 20)
    const quiet = Math.pow(10, -40 / 20)
    for (const releaseMs of [50, 200]) {
      const coverage = measureCoverageAfter(params({ releaseMs }), releaseMs, () => quiet, loud)
      // eslint-disable-next-line no-console
      console.log(`compressor release ${releaseMs} ms: covered ${(coverage * 100).toFixed(1)}% (want 63.2%)`)
      expect(coverage).toBeCloseTo(0.632, 2)
    }
  })

  it('keeps the attack time independent of how far over the threshold the signal is', () => {
    // The classic mistake is smoothing the detected level instead of the
    // gain reduction, which makes this coverage figure drift with input
    // level and the knob stop meaning what it says.
    const coverages = [-12, -6, -3, 0].map((inputDb) =>
      measureCoverageAfter(params({ attackMs: 10 }), 10, () => Math.pow(10, inputDb / 20)),
    )
    // eslint-disable-next-line no-console
    console.log(`compressor attack vs level: ${coverages.map((c) => (c * 100).toFixed(1) + '%').join(', ')}`)
    for (const c of coverages) expect(c).toBeCloseTo(0.632, 2)
  })
})

describe('compressorSample: the key input', () => {
  it('ducks the input according to a separate key signal, not its own level', () => {
    const p = params({ ratio: 8, attackMs: 1, releaseMs: 50 })
    const quietInput = Math.pow(10, -30 / 20)
    const loudKey = Math.pow(10, -3 / 20)

    const state = createCompressorState()
    let out = 0
    for (let n = 0; n < SAMPLE_RATE; n++) {
      out = compressorSample(state, quietInput, loudKey, p, SAMPLE_RATE)
    }
    // eslint-disable-next-line no-console
    console.log(
      `compressor sidechain: -30 dB input keyed by -3 dB -> ${dbOf(out).toFixed(2)} dB ` +
        `(reduction ${state.reductionDb.toFixed(2)} dB)`,
    )

    // A quiet signal, far below threshold, is nonetheless ducked -- because
    // the key is loud. Self-keyed it would have been untouched.
    const expectedReduction = (1 / 8 - 1) * (dbOf(loudKey) - -20)
    expect(state.reductionDb).toBeCloseTo(expectedReduction, 4)
    expect(dbOf(out)).toBeCloseTo(-30 + expectedReduction, 4)
  })

  it('leaves the input alone when the key is silent, however loud the input is', () => {
    const p = params()
    const state = createCompressorState()
    let out = 0
    for (let n = 0; n < SAMPLE_RATE; n++) out = compressorSample(state, 1, 0, p, SAMPLE_RATE)
    expect(state.reductionDb).toBeCloseTo(0, 6)
    expect(out).toBeCloseTo(1, 6)
  })
})

describe('compressorSample: robustness', () => {
  it('stays finite and bounded across every panel extreme', () => {
    const extremes: CompressorParams[] = []
    for (const thresholdDb of [-60, 0]) {
      for (const ratio of [1, 20]) {
        for (const attackMs of [0.1, 100]) {
          for (const releaseMs of [10, 1000]) {
            for (const kneeDb of [0, 24]) {
              for (const makeupDb of [0, 24]) {
                extremes.push({ thresholdDb, ratio, attackMs, releaseMs, kneeDb, makeupDb })
              }
            }
          }
        }
      }
    }
    let seed = 31337
    for (const p of extremes) {
      const state = createCompressorState()
      for (let n = 0; n < 4800; n++) {
        seed = (seed * 1664525 + 1013904223) >>> 0
        const v = (seed / 0x100000000) * 2 - 1
        const out = compressorSample(state, v, v, p, SAMPLE_RATE)
        expect(Number.isFinite(out)).toBe(true)
      }
      expect(Number.isFinite(state.reductionDb)).toBe(true)
      expect(state.reductionDb).toBeLessThanOrEqual(1e-9)
    }
    // eslint-disable-next-line no-console
    console.log(`compressor extremes: ${extremes.length} param combinations, all finite`)
  })

  it('handles digital silence without producing a NaN through the log', () => {
    const state = createCompressorState()
    for (let n = 0; n < 1000; n++) {
      const out = compressorSample(state, 0, 0, params(), SAMPLE_RATE)
      expect(Number.isFinite(out)).toBe(true)
    }
    expect(Number.isFinite(state.reductionDb)).toBe(true)
  })
})
