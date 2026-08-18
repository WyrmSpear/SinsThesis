import { foldSample } from '../dsp/wavefolder'

/** Thin shell. All the math lives in dsp/wavefolder, which Node tests directly. */
class WavefolderProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'drive', defaultValue: 1, minValue: 0.1, maxValue: 20, automationRate: 'k-rate' },
      { name: 'symmetry', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' },
      { name: 'foldCvAmount', defaultValue: 0, minValue: 0, maxValue: 10, automationRate: 'k-rate' },
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
    const drive = params.drive![0]!
    const symmetry = params.symmetry![0]!
    const cvAmount = params.foldCvAmount![0]!

    for (let i = 0; i < out.length; i++) {
      const d = Math.max(drive + (cv?.[i] ?? 0) * cvAmount, 0.1)
      out[i] = foldSample(audio?.[i] ?? 0, d, symmetry)
    }
    return true
  }
}

registerProcessor('wavefolder', WavefolderProcessor)
