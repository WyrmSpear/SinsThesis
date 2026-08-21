import {
  createFlangerState,
  flangerSample,
  MIN_MANUAL_SECONDS,
  MAX_MANUAL_SECONDS,
  MIN_RATE_HZ,
  MAX_RATE_HZ,
  MAX_FEEDBACK,
} from '../dsp/flanger'

/**
 * Thin shell. All the math -- the owned delay line, the Catmull-Rom
 * fractional read, and the regeneration that is the whole reason this is a
 * worklet rather than a `DelayNode` -- lives in dsp/flanger.ts, which the
 * Node tests drive directly. Read that file's doc comment first.
 *
 * Every param is continuous, so all five are a-rate. `rateCv` arrives as a
 * second input and sums into `rate` in Hz, the same way delay.ts's `timeCv`
 * rides its time knob.
 */
class FlangerProcessor extends AudioWorkletProcessor {
  private readonly state = createFlangerState(sampleRate)

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      {
        name: 'manual',
        defaultValue: 0.002,
        minValue: MIN_MANUAL_SECONDS,
        maxValue: MAX_MANUAL_SECONDS,
        automationRate: 'a-rate',
      },
      { name: 'rate', defaultValue: 0.3, minValue: MIN_RATE_HZ, maxValue: MAX_RATE_HZ, automationRate: 'a-rate' },
      { name: 'depth', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      {
        name: 'feedback',
        defaultValue: 0.3,
        minValue: -MAX_FEEDBACK,
        maxValue: MAX_FEEDBACK,
        automationRate: 'a-rate',
      },
      { name: 'mix', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
    ]
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0]
    if (!out) return true

    const audio = inputs[0]?.[0]
    const rateCv = inputs[1]?.[0]
    const manualArr = params.manual!
    const rateArr = params.rate!
    const depthArr = params.depth!
    const feedbackArr = params.feedback!
    const mixArr = params.mix!

    for (let i = 0; i < out.length; i++) {
      // a-rate params arrive as length 1 (constant this block) or length
      // out.length -- the same convention every other a-rate worklet here
      // uses.
      const manual = manualArr.length > 1 ? manualArr[i]! : manualArr[0]!
      const rateBase = rateArr.length > 1 ? rateArr[i]! : rateArr[0]!
      const depth = depthArr.length > 1 ? depthArr[i]! : depthArr[0]!
      const feedback = feedbackArr.length > 1 ? feedbackArr[i]! : feedbackArr[0]!
      const mix = mixArr.length > 1 ? mixArr[i]! : mixArr[0]!

      out[i] = flangerSample(
        this.state,
        audio?.[i] ?? 0,
        { manual, rate: rateBase + (rateCv?.[i] ?? 0), depth, feedback, mix },
        sampleRate,
      )
    }
    return true
  }
}

registerProcessor('flanger', FlangerProcessor)
