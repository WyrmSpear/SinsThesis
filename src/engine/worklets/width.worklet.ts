import { widthSample } from '../dsp/width'

/** Thin shell. All the math lives in dsp/width, which Node tests directly,
 *  including the algebraic mono-invariance proof this module exists to
 *  guarantee. */
class WidthProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      // Continuous -- 0 (mono) through 1 (unchanged) to 2 (double the
      // stereo difference) -- so it stays a-rate like every other
      // continuously-turned knob in this codebase.
      { name: 'width', defaultValue: 1, minValue: 0, maxValue: 2, automationRate: 'a-rate' },
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

    const input = inputs[0]
    // channelCountMode 'explicit'/channelCount 2 on this node's own input
    // (set in width.ts's module descriptor) up-mixes a mono cable to two
    // identical channels before this ever runs -- see output.ts's doc
    // comment on the same trick -- so `inL`/`inR` are always both present,
    // and a mono source simply has `inL === inR` (side = 0 already, width
    // is a no-op on it, correctly).
    const inL = input?.[0]
    const inR = input?.[1]

    const widthArr = params.width!

    for (let i = 0; i < outL.length; i++) {
      const width = widthArr.length > 1 ? widthArr[i]! : widthArr[0]!
      const { left, right } = widthSample(inL?.[i] ?? 0, inR?.[i] ?? 0, width)
      outL[i] = left
      outR[i] = right
    }
    return true
  }
}

registerProcessor('width', WidthProcessor)
