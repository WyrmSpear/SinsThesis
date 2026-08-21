import {
  createCompressorState,
  compressorSample,
  MIN_THRESHOLD_DB,
  MAX_THRESHOLD_DB,
  MIN_RATIO,
  MAX_RATIO,
  MIN_ATTACK_MS,
  MAX_ATTACK_MS,
  MIN_RELEASE_MS,
  MAX_RELEASE_MS,
  MAX_KNEE_DB,
  MAX_MAKEUP_DB,
} from '../dsp/compressor'

/**
 * Thin shell. All the math -- the gain computer, the quadratic knee and the
 * attack/release smoothing applied to gain reduction rather than to the
 * detected level -- lives in dsp/compressor.ts, which the Node tests drive
 * directly. Read that file's doc comment first, including why this is not a
 * wrapped `DynamicsCompressorNode`.
 *
 * Two inputs (audio, key) and two outputs: the compressed audio, and the
 * gain reduction in dB as a CV signal for metering or for patching onward.
 */
class CompressorProcessor extends AudioWorkletProcessor {
  private readonly state = createCompressorState()

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      {
        name: 'threshold',
        defaultValue: -20,
        minValue: MIN_THRESHOLD_DB,
        maxValue: MAX_THRESHOLD_DB,
        automationRate: 'a-rate',
      },
      { name: 'ratio', defaultValue: 4, minValue: MIN_RATIO, maxValue: MAX_RATIO, automationRate: 'a-rate' },
      {
        name: 'attack',
        defaultValue: 5,
        minValue: MIN_ATTACK_MS,
        maxValue: MAX_ATTACK_MS,
        automationRate: 'a-rate',
      },
      {
        name: 'release',
        defaultValue: 100,
        minValue: MIN_RELEASE_MS,
        maxValue: MAX_RELEASE_MS,
        automationRate: 'a-rate',
      },
      { name: 'knee', defaultValue: 6, minValue: 0, maxValue: MAX_KNEE_DB, automationRate: 'a-rate' },
      { name: 'makeup', defaultValue: 0, minValue: 0, maxValue: MAX_MAKEUP_DB, automationRate: 'a-rate' },
      // Discrete: 0 = key from the input itself, 1 = key from the Key jack.
      // k-rate because a switch does not sweep -- the same treatment every
      // other switch-like param in this codebase gets (B3).
      { name: 'keySource', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ]
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0]
    if (!out) return true
    const reductionOut = outputs[1]?.[0]

    const audio = inputs[0]?.[0]
    const key = inputs[1]?.[0]
    const thresholdArr = params.threshold!
    const ratioArr = params.ratio!
    const attackArr = params.attack!
    const releaseArr = params.release!
    const kneeArr = params.knee!
    const makeupArr = params.makeup!
    const external = Math.round(params.keySource![0] ?? 0) === 1

    for (let i = 0; i < out.length; i++) {
      // a-rate params arrive as length 1 (constant this block) or length
      // out.length -- the same convention every other a-rate worklet uses.
      const thresholdDb = thresholdArr.length > 1 ? thresholdArr[i]! : thresholdArr[0]!
      const ratio = ratioArr.length > 1 ? ratioArr[i]! : ratioArr[0]!
      const attackMs = attackArr.length > 1 ? attackArr[i]! : attackArr[0]!
      const releaseMs = releaseArr.length > 1 ? releaseArr[i]! : releaseArr[0]!
      const kneeDb = kneeArr.length > 1 ? kneeArr[i]! : kneeArr[0]!
      const makeupDb = makeupArr.length > 1 ? makeupArr[i]! : makeupArr[0]!

      const sample = audio?.[i] ?? 0
      out[i] = compressorSample(
        this.state,
        sample,
        external ? (key?.[i] ?? 0) : sample,
        { thresholdDb, ratio, attackMs, releaseMs, kneeDb, makeupDb },
        sampleRate,
      )
      // Gain reduction in dB, negative while compressing. Left in dB rather
      // than normalised to some arbitrary full-scale: it is a real unit, and
      // every CV destination in this codebase has its own amount knob to
      // scale it with.
      if (reductionOut) reductionOut[i] = this.state.reductionDb
    }
    return true
  }
}

registerProcessor('compressor', CompressorProcessor)
