import { createLadderState, ladderSample } from '../dsp/ladder'

/** Thin shell. All the math lives in dsp/ladder, which Node tests directly. */
class LadderProcessor extends AudioWorkletProcessor {
  private readonly state = createLadderState()
  private seeded = false

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'cutoff', defaultValue: 1000, minValue: 20, maxValue: 20000, automationRate: 'k-rate' },
      { name: 'resonance', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'cutoffCvAmount', defaultValue: 0, minValue: -8, maxValue: 8, automationRate: 'k-rate' },
      { name: 'drive', defaultValue: 1, minValue: 0.1, maxValue: 8, automationRate: 'k-rate' },
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
    const cv = inputs[1]?.[0]

    const cutoff = params.cutoff![0]!
    const resonance = params.resonance![0]!
    const cvAmount = params.cutoffCvAmount![0]!
    const drive = params.drive![0]!

    for (let i = 0; i < out.length; i++) {
      // CV is 1.0 per octave, matching the pitch convention everywhere else.
      const fc = cutoff * Math.pow(2, (cv?.[i] ?? 0) * cvAmount)
      // At full resonance the closed loop sits at an unstable fixed point:
      // with an exactly-zero input the pure recursion in ladderSample never
      // perturbs itself and stays at exactly zero forever, unlike a real
      // ladder circuit, which has a thermal noise floor to ring it up into
      // self-oscillation. A single-sample, inaudible seed on the very first
      // process() call reproduces that floor without touching the DSP core:
      // it nudges the loop off zero once, and the loop's own instability at
      // high resonance does the rest.
      const seed = this.seeded ? 0 : 1e-4
      this.seeded = true
      out[i] = ladderSample(this.state, (audio?.[i] ?? 0) * drive + seed, fc, resonance, sampleRate)
    }
    return true
  }
}

registerProcessor('ladder', LadderProcessor)
