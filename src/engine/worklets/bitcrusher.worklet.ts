import { createBitcrusherState, bitcrusherSample, MIN_BITS, MAX_BITS, MIN_RATE_HZ, MAX_RATE_HZ } from '../dsp/bitcrusher'

/**
 * Thin shell. All the math -- decimation, quantization and the bend
 * stutter, all deliberately unfiltered (see dsp/bitcrusher.ts's own doc
 * comment) -- lives in dsp/bitcrusher, which Node tests directly. `bits`,
 * `rate`, `bend`, `bitsCvAmount` and `rateCvAmount` are all continuous, so
 * all five are a-rate -- this module has no discrete/switch-like param at
 * all, unlike most of this codebase's other worklets.
 */
class BitcrusherProcessor extends AudioWorkletProcessor {
  private readonly state = createBitcrusherState()

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'bits', defaultValue: MAX_BITS, minValue: MIN_BITS, maxValue: MAX_BITS, automationRate: 'a-rate' },
      { name: 'rate', defaultValue: MAX_RATE_HZ, minValue: MIN_RATE_HZ, maxValue: MAX_RATE_HZ, automationRate: 'a-rate' },
      { name: 'bend', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'bitsCvAmount', defaultValue: 0, minValue: 0, maxValue: MAX_BITS, automationRate: 'a-rate' },
      { name: 'rateCvAmount', defaultValue: 0, minValue: 0, maxValue: MAX_RATE_HZ, automationRate: 'a-rate' },
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
    const bitsCv = inputs[1]?.[0]
    const rateCv = inputs[2]?.[0]
    const bitsArr = params.bits!
    const rateArr = params.rate!
    const bendArr = params.bend!
    const bitsCvAmountArr = params.bitsCvAmount!
    const rateCvAmountArr = params.rateCvAmount!

    for (let i = 0; i < out.length; i++) {
      // a-rate params arrive as length 1 (constant this block) or length
      // out.length (one value per sample) -- same convention every other
      // a-rate worklet in this codebase uses.
      const bitsAt = bitsArr.length > 1 ? bitsArr[i]! : bitsArr[0]!
      const rateAt = rateArr.length > 1 ? rateArr[i]! : rateArr[0]!
      const bendAt = bendArr.length > 1 ? bendArr[i]! : bendArr[0]!
      const bitsCvAmountAt = bitsCvAmountArr.length > 1 ? bitsCvAmountArr[i]! : bitsCvAmountArr[0]!
      const rateCvAmountAt = rateCvAmountArr.length > 1 ? rateCvAmountArr[i]! : rateCvAmountArr[0]!

      const bits = bitsAt + (bitsCv?.[i] ?? 0) * bitsCvAmountAt
      const rate = rateAt + (rateCv?.[i] ?? 0) * rateCvAmountAt

      out[i] = bitcrusherSample(this.state, audio?.[i] ?? 0, { bits, rate, bend: bendAt }, sampleRate)
    }
    return true
  }
}

registerProcessor('bitcrusher', BitcrusherProcessor)
