import { createBinauralState, binauralSample } from '../dsp/binaural'

/** Thin shell. All the math lives in dsp/binaural, which Node tests
 *  directly, including the multi-minute sub-hertz drift measurement. */
class BinauralProcessor extends AudioWorkletProcessor {
  private readonly state = createBinauralState()

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      // Both a-rate: `beat` in particular has to be able to glide smoothly
      // through sub-hertz values under CV sweep (the module's whole
      // reason to exist), which needs the browser's own per-sample ramp,
      // not a k-rate staircase of block-sized steps -- the same reasoning
      // vco.worklet.ts's `tune` documents.
      { name: 'carrier', defaultValue: 220, minValue: 20, maxValue: 2000, automationRate: 'a-rate' },
      { name: 'beat', defaultValue: 4, minValue: 0.01, maxValue: 40, automationRate: 'a-rate' },
      // Hz of beat swing per unit of beatCv, the same "amount" convention
      // as svf.worklet.ts's cutoffCvAmount and drive.worklet.ts's
      // driveCvAmount.
      { name: 'beatCvAmount', defaultValue: 0, minValue: 0, maxValue: 20, automationRate: 'a-rate' },
    ]
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]
    const outL = out?.[0]
    const outR = out?.[1]
    if (!outL || !outR) return true

    const beatCv = inputs[0]?.[0]
    const carrierArr = params.carrier!
    const beatArr = params.beat!
    const cvAmountArr = params.beatCvAmount!

    for (let i = 0; i < outL.length; i++) {
      const carrier = carrierArr.length > 1 ? carrierArr[i]! : carrierArr[0]!
      const beatBase = beatArr.length > 1 ? beatArr[i]! : beatArr[0]!
      const cvAmount = cvAmountArr.length > 1 ? cvAmountArr[i]! : cvAmountArr[0]!
      const beat = Math.max(beatBase + (beatCv?.[i] ?? 0) * cvAmount, 0)
      const { left, right } = binauralSample(this.state, carrier, beat, sampleRate)
      outL[i] = left
      outR[i] = right
    }
    return true
  }
}

registerProcessor('binaural', BinauralProcessor)
