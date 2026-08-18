import { createOscState, hardSync, oscSample, pitchToFreq, type OscShape } from '../dsp/wavetable'

const SHAPES: OscShape[] = ['saw', 'pulse', 'tri', 'sine']

/** Thin shell. All the math lives in dsp/wavetable, which Node tests directly. */
class VcoProcessor extends AudioWorkletProcessor {
  private readonly state = createOscState()
  private lastSync = 0

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'tune', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'k-rate' },
      { name: 'octave', defaultValue: 0, minValue: -4, maxValue: 4, automationRate: 'k-rate' },
      { name: 'shape', defaultValue: 0, minValue: 0, maxValue: 3, automationRate: 'k-rate' },
      { name: 'pulseWidth', defaultValue: 0.5, minValue: 0.01, maxValue: 0.99, automationRate: 'k-rate' },
      { name: 'fmAmount', defaultValue: 0, minValue: 0, maxValue: 4, automationRate: 'k-rate' },
    ]
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0]
    if (!out) return true

    const pitchCv = inputs[0]?.[0]
    const fmCv = inputs[1]?.[0]
    const syncGate = inputs[2]?.[0]

    const tune = params.tune![0]!
    const octave = params.octave![0]!
    const shape = SHAPES[Math.round(params.shape![0]!)] ?? 'saw'
    const pw = params.pulseWidth![0]!
    const fmAmount = params.fmAmount![0]!

    // A4 = 440 Hz; pitch CV is 1.0 per octave, tune is in semitones.
    const base = 440 * Math.pow(2, octave + tune / 12)

    for (let i = 0; i < out.length; i++) {
      const sync = syncGate?.[i] ?? 0
      if (sync >= 0.5 && this.lastSync < 0.5) hardSync(this.state)
      this.lastSync = sync

      const cv = (pitchCv?.[i] ?? 0) + (fmCv?.[i] ?? 0) * fmAmount
      const freq = pitchToFreq(base, cv, sampleRate)
      out[i] = oscSample(this.state, shape, freq, sampleRate, pw)
    }
    return true
  }
}

registerProcessor('vco', VcoProcessor)
