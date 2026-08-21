/**
 * Compressor DSP: a feedforward peak compressor with a soft knee, separate
 * attack and release, and a key (sidechain) input.
 *
 * **Why this is not a wrapped `DynamicsCompressorNode`.** Web Audio ships a
 * compressor, and using it would have been most of a day cheaper. It was
 * rejected on the same grounds this codebase rejects any unmeasurable
 * component: its knee shape and its detector are not specified in a way you
 * can predict, it applies its own undisclosed lookahead latency, and its
 * `reduction` read-back is the only window into what it did. A module here
 * is expected to state a number its own test reproduces -- "ratio 4:1 gives
 * exactly 4:1 above threshold" is that number, and it is only assertable if
 * the gain law is ours.
 *
 * **The gain law, in closed form.** Above the knee the reduction is
 * `(1/ratio - 1) * (levelDb - thresholdDb)`, which makes the output level
 * `thresholdDb + (levelDb - thresholdDb) / ratio` -- the ratio definition
 * itself, rearranged. `tests/node/dsp/compressor.test.ts` asserts that
 * identity at several levels and ratios rather than checking that the
 * output merely got quieter.
 *
 * **The knee is quadratic and joins the two segments continuously.** Inside
 * `+/- kneeDb/2` of the threshold the reduction is
 * `(1/ratio - 1) * x^2 / (2 * kneeDb)` with `x = over + kneeDb/2`. At the
 * lower edge `x = 0` so it meets the uncompressed segment at zero; at the
 * upper edge `x = kneeDb` so it equals `(1/ratio - 1) * kneeDb / 2`, which
 * is exactly what the straight segment gives at `over = kneeDb/2`. Both
 * joins are checked by test, because a knee that does not join is a click.
 *
 * **Attack and release smooth the gain reduction, not the level.** Smoothing
 * the detector instead is the classic mistake: it makes the attack time
 * depend on how far above the threshold the signal is, so the knob stops
 * meaning what it says. Here the coefficient is
 * `1 - exp(-1 / (time * sampleRate))`, so the knob is a true time constant
 * -- after exactly `attackMs` the reduction has covered 63.2% of its way to
 * the target, and the tests measure that rather than assuming it.
 */

export const MIN_THRESHOLD_DB = -60
export const MAX_THRESHOLD_DB = 0
export const MIN_RATIO = 1
export const MAX_RATIO = 20
export const MIN_ATTACK_MS = 0.1
export const MAX_ATTACK_MS = 100
export const MIN_RELEASE_MS = 10
export const MAX_RELEASE_MS = 1000
export const MAX_KNEE_DB = 24
export const MAX_MAKEUP_DB = 24

/** Detector floor. -180 dB is below anything float32 audio carries, so it
 *  only ever stands in for digital silence. */
const LEVEL_FLOOR = 1e-9

export interface CompressorState {
  /** Smoothed gain reduction in dB, always <= 0. Read this after each
   *  `compressorSample` call for a gain-reduction meter or CV output --
   *  returning it would mean allocating a pair every sample. */
  reductionDb: number
}

export interface CompressorParams {
  thresholdDb: number
  ratio: number
  attackMs: number
  releaseMs: number
  kneeDb: number
  makeupDb: number
}

export function createCompressorState(): CompressorState {
  return { reductionDb: 0 }
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)

/**
 * The static gain computer: how much reduction, in dB, a given input level
 * earns -- before any attack/release smoothing. Pure, and the piece the
 * ratio and knee claims are asserted against directly.
 *
 * Returns 0 or a negative number.
 */
export function gainComputerDb(
  levelDb: number,
  thresholdDb: number,
  ratio: number,
  kneeDb: number,
): number {
  const r = clamp(ratio, MIN_RATIO, MAX_RATIO)
  const knee = clamp(kneeDb, 0, MAX_KNEE_DB)
  const slope = 1 / r - 1 // <= 0
  const over = levelDb - thresholdDb

  if (knee > 0 && over > -knee / 2 && over < knee / 2) {
    const x = over + knee / 2
    return (slope * x * x) / (2 * knee)
  }
  if (over <= -knee / 2) return 0
  return slope * over
}

/**
 * One sample through the compressor.
 *
 * `key` is what the detector listens to -- the input itself for ordinary
 * compression, or a separate signal for sidechain ducking. Writes the
 * smoothed reduction into `state.reductionDb` and returns the compressed
 * sample.
 */
export function compressorSample(
  state: CompressorState,
  input: number,
  key: number,
  params: CompressorParams,
  sampleRate: number,
): number {
  const attackMs = clamp(params.attackMs, MIN_ATTACK_MS, MAX_ATTACK_MS)
  const releaseMs = clamp(params.releaseMs, MIN_RELEASE_MS, MAX_RELEASE_MS)
  const makeupDb = clamp(params.makeupDb, 0, MAX_MAKEUP_DB)

  const levelDb = 20 * Math.log10(Math.max(Math.abs(key), LEVEL_FLOOR))
  const target = gainComputerDb(levelDb, params.thresholdDb, params.ratio, params.kneeDb)

  // More reduction than we currently have is an attack; less is a release.
  const timeSeconds = (target < state.reductionDb ? attackMs : releaseMs) / 1000
  const coeff = 1 - Math.exp(-1 / Math.max(timeSeconds * sampleRate, 1))
  state.reductionDb += (target - state.reductionDb) * coeff

  return input * Math.pow(10, (state.reductionDb + makeupDb) / 20)
}
