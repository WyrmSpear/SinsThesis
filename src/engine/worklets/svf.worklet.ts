import { createSvfState, createSvfOutputs, svfSample } from '../dsp/svf'

/** Thin shell. All the math lives in dsp/svf, which Node tests directly. */
class SvfProcessor extends AudioWorkletProcessor {
  private readonly state = createSvfState()
  private readonly out = createSvfOutputs()
  // Seed for the dither generator below, matching ladder.worklet.ts's own
  // approach -- any fixed nonzero seed keeps the sequence (and anything
  // measuring it) deterministic.
  private noiseState = 0x2f6e2b1

  /** One step of a cheap linear-congruential generator, returning a value in
   *  (-1, 1). Deliberately not Math.random() -- see ladder.worklet.ts. */
  private nextNoise(): number {
    this.noiseState = (this.noiseState * 1103515245 + 12345) & 0x7fffffff
    return (this.noiseState / 0x7fffffff) * 2 - 1
  }

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      // cutoff and resonance are a-rate: an LFO sweeping the cutoff is
      // exactly the case a-rate exists for (see ladder.worklet.ts's own
      // comment on the block-staircase artifact k-rate would produce).
      // cutoffCvAmount is discrete-feeling in the same way the ladder's
      // is -- a per-block constant a player turns, not something modulated
      // sample-by-sample -- so it stays k-rate.
      { name: 'cutoff', defaultValue: 1000, minValue: 20, maxValue: 20000, automationRate: 'a-rate' },
      { name: 'resonance', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'cutoffCvAmount', defaultValue: 0, minValue: -8, maxValue: 8, automationRate: 'k-rate' },
    ]
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean {
    const lpOut = outputs[0]?.[0]
    const bpOut = outputs[1]?.[0]
    const hpOut = outputs[2]?.[0]
    const notchOut = outputs[3]?.[0]
    if (!lpOut) return true

    const audio = inputs[0]?.[0]
    const cv = inputs[1]?.[0]

    const cutoffArr = params.cutoff!
    const resonanceArr = params.resonance!
    const cvAmount = params.cutoffCvAmount![0]!

    for (let i = 0; i < lpOut.length; i++) {
      // a-rate params arrive as length 1 (constant this block) or length
      // `lpOut.length` (one value per sample) -- see ladder.worklet.ts.
      const cutoff = cutoffArr.length > 1 ? cutoffArr[i]! : cutoffArr[0]!
      const resonance = resonanceArr.length > 1 ? resonanceArr[i]! : resonanceArr[0]!
      // CV is 1.0 per octave, matching the pitch convention everywhere else.
      const fc = cutoff * Math.pow(2, (cv?.[i] ?? 0) * cvAmount)
      // Zero is an exact fixed point of svfSample's recursion (see
      // createSvfState's doc comment): fed pure silence, the loop never
      // perturbs itself, so at high resonance with nothing patched into
      // `in` it can never start ringing on its own. The same continuous,
      // ~-100 dBFS dither ladder.worklet.ts uses stands in for the thermal
      // noise floor a real resonant circuit always has.
      const dither = this.nextNoise() * 1e-5
      svfSample(this.state, (audio?.[i] ?? 0) + dither, fc, resonance, sampleRate, this.out)
      lpOut[i] = this.out.lp
      if (bpOut) bpOut[i] = this.out.bp
      if (hpOut) hpOut[i] = this.out.hp
      if (notchOut) notchOut[i] = this.out.notch
    }
    return true
  }
}

registerProcessor('svf', SvfProcessor)
