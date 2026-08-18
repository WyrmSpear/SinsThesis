import {
  createEnvState, envSample, createSampleHoldState, sampleHold,
  createSequencerState, sequencerStep,
} from '../dsp/segment'
import { createOscState, oscSample, hardSync, type OscShape } from '../dsp/polyblep'

/** Thin shell. All the math lives in dsp/segment and dsp/polyblep, which Node
 *  tests directly. One bundle registers all four processors because they
 *  share the segment core and change together. */
class AdsrProcessor extends AudioWorkletProcessor {
  private readonly state = createEnvState()

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'attack', defaultValue: 0.01, minValue: 0.001, maxValue: 10, automationRate: 'k-rate' },
      { name: 'decay', defaultValue: 0.1, minValue: 0.001, maxValue: 10, automationRate: 'k-rate' },
      { name: 'sustain', defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.2, minValue: 0.001, maxValue: 10, automationRate: 'k-rate' },
    ]
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0]
    if (!out) return true
    const gate = inputs[0]?.[0]
    const p = {
      attack: params.attack![0]!,
      decay: params.decay![0]!,
      sustain: params.sustain![0]!,
      release: params.release![0]!,
    }
    for (let i = 0; i < out.length; i++) {
      out[i] = envSample(this.state, gate?.[i] ?? 0, p, sampleRate)
    }
    return true
  }
}

const SHAPES: OscShape[] = ['saw', 'pulse', 'tri', 'sine']

class LfoProcessor extends AudioWorkletProcessor {
  private readonly state = createOscState()
  private lastSync = 0

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'rate', defaultValue: 2, minValue: 0.01, maxValue: 200, automationRate: 'k-rate' },
      { name: 'shape', defaultValue: 2, minValue: 0, maxValue: 3, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ]
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0]
    if (!out) return true
    const sync = inputs[0]?.[0]
    const rate = params.rate![0]!
    const shape = SHAPES[Math.round(params.shape![0]!)] ?? 'tri'
    const depth = params.depth![0]!

    for (let i = 0; i < out.length; i++) {
      const s = sync?.[i] ?? 0
      if (s >= 0.5 && this.lastSync < 0.5) hardSync(this.state)
      this.lastSync = s
      out[i] = oscSample(this.state, shape, rate, sampleRate) * depth
    }
    return true
  }
}

class SampleHoldProcessor extends AudioWorkletProcessor {
  private readonly state = createSampleHoldState()

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0]
    if (!out) return true
    const signal = inputs[0]?.[0]
    const trigger = inputs[1]?.[0]
    for (let i = 0; i < out.length; i++) {
      out[i] = sampleHold(this.state, signal?.[i] ?? 0, trigger?.[i] ?? 0)
    }
    return true
  }
}

const STEP_PARAM_NAMES = Array.from({ length: 16 }, (_, i) => `step${i + 1}`)

class SequencerProcessor extends AudioWorkletProcessor {
  private readonly state = createSequencerState()

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'steps', defaultValue: 8, minValue: 1, maxValue: 16, automationRate: 'k-rate' },
      ...STEP_PARAM_NAMES.map((name) => ({
        name, defaultValue: 0, minValue: -2, maxValue: 2, automationRate: 'k-rate' as const,
      })),
    ]
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean {
    const cvOut = outputs[0]?.[0]
    const gateOut = outputs[1]?.[0]
    if (!cvOut || !gateOut) return true

    const clock = inputs[0]?.[0]
    const reset = inputs[1]?.[0]
    const steps = params.steps![0]!
    const values = STEP_PARAM_NAMES.map((name) => params[name]![0]!)

    for (let i = 0; i < cvOut.length; i++) {
      const { cv, gate } = sequencerStep(
        this.state, clock?.[i] ?? 0, reset?.[i] ?? 0, steps, values,
      )
      cvOut[i] = cv
      gateOut[i] = gate
    }
    return true
  }
}

registerProcessor('adsr', AdsrProcessor)
registerProcessor('lfo', LfoProcessor)
registerProcessor('sample-hold', SampleHoldProcessor)
registerProcessor('sequencer', SequencerProcessor)
