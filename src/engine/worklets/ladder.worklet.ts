import { createLadderState, ladderSample } from '../dsp/ladder'

/** Thin shell. All the math lives in dsp/ladder, which Node tests directly. */
class LadderProcessor extends AudioWorkletProcessor {
  private readonly state = createLadderState()
  // Seed for the dither generator below. Any fixed nonzero seed keeps the
  // sequence -- and therefore tests built on it -- deterministic.
  private noiseState = 0x2f6e2b1

  /**
   * One step of a cheap linear-congruential generator, returning a value in
   * (-1, 1). Deliberately not Math.random(): a fixed seed keeps the dither
   * (and anything measuring it) reproducible from run to run.
   */
  private nextNoise(): number {
    this.noiseState = (this.noiseState * 1103515245 + 12345) & 0x7fffffff
    return (this.noiseState / 0x7fffffff) * 2 - 1
  }

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
      // Zero is an exact fixed point of ladderSample's recursion (see the
      // doc comment on createLadderState): fed pure silence, the loop never
      // perturbs itself and stays at exactly zero forever, so at high
      // resonance it can never self-start. A real ladder circuit has a
      // thermal noise floor for that; this emulates it as a continuous,
      // ~-100 dBFS dither rather than a one-shot startup kick, because the
      // real noise floor is always there -- a player can leave the input
      // unpatched and crank resonance up at any moment, not only in the
      // first render quantum, and the loop's own instability at high
      // resonance does the rest regardless of when it's perturbed. Added
      // after drive scaling so drive cannot amplify it.
      const dither = this.nextNoise() * 1e-5
      out[i] = ladderSample(this.state, (audio?.[i] ?? 0) * drive + dither, fc, resonance, sampleRate)
    }
    return true
  }
}

registerProcessor('ladder', LadderProcessor)
