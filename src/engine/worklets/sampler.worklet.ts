import { createSamplerState, sampleAt, EMPTY_SAMPLER_BUFFER, type SamplerBuffer, type SamplerMode } from '../dsp/sampler'

const MODES: SamplerMode[] = ['oneshot', 'loop']

interface LoadMessage {
  type: 'load'
  mips: Float32Array[]
  sourceSampleRate: number
  frames: number
}
interface ClearMessage {
  type: 'clear'
}

/**
 * Thin shell. All the math -- the mip build, cubic interpolation and the
 * loop-crossfade wrap -- lives in dsp/sampler, which Node tests directly.
 * The one thing this file owns that no other worklet in this project needs:
 * receiving the loaded buffer itself, which arrives over `this.port` as a
 * message from `modules/sampler.ts` (built on the main thread, off this
 * processor's audio-rate path entirely) rather than as an `AudioParam` --
 * there is no such thing as an AudioParam that carries a Float32Array.
 *
 * `tune`, `start` and `end` are a-rate (continuous); `mode` and `reverse`
 * are k-rate (discrete/switch-like) -- the same split every other worklet
 * in this codebase applies to its own params (see e.g. vco.worklet.ts's
 * `tune`/`shape`).
 */
class SamplerProcessor extends AudioWorkletProcessor {
  private readonly state = createSamplerState()
  private buffer: SamplerBuffer = EMPTY_SAMPLER_BUFFER

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<LoadMessage | ClearMessage>): void => {
      const msg = event.data
      if (msg.type === 'load') {
        this.buffer = { mips: msg.mips, sourceSampleRate: msg.sourceSampleRate, frames: msg.frames }
      } else {
        this.buffer = EMPTY_SAMPLER_BUFFER
      }
      // A new buffer invalidates any in-flight read position -- starting
      // silent and waiting for the next gate edge is correct regardless of
      // whether a note was mid-playback when the load landed.
      this.state.pos = 0
      this.state.active = false
    }
  }

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'tune', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'a-rate' },
      { name: 'start', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'end', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'mode', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'reverse', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
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
    const gateIn = inputs[1]?.[0]
    const tuneArr = params.tune!
    const startArr = params.start!
    const endArr = params.end!
    const mode = MODES[Math.round(params.mode![0]!)] ?? 'oneshot'
    const reverse = params.reverse![0]! >= 0.5

    for (let i = 0; i < out.length; i++) {
      // a-rate params arrive as length 1 (constant this block) or length
      // out.length (one value per sample) -- same convention vco.worklet.ts's
      // tune/pulseWidth use.
      const tune = tuneArr.length > 1 ? tuneArr[i]! : tuneArr[0]!
      const start = startArr.length > 1 ? startArr[i]! : startArr[0]!
      const end = endArr.length > 1 ? endArr[i]! : endArr[0]!
      const gate = gateIn?.[i] ?? 0
      const cv = pitchCv?.[i] ?? 0
      out[i] = sampleAt(this.state, this.buffer, gate, cv, { tune, start, end, mode, reverse }, sampleRate)
    }
    return true
  }
}

registerProcessor('sampler', SamplerProcessor)
