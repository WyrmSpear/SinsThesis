import {
  createEnvState, envSample, createSampleHoldState, sampleHold,
  createSequencerState, sequencerStep,
} from '../dsp/segment'
import { createOscState, getWavetableSet, oscSample, hardSync, type OscShape } from '../dsp/wavetable'

// Built once, at module top level -- see the identical comment in
// vco.worklet.ts (A1). The LFO processor below is the other consumer of
// dsp/wavetable's per-sample generation, so it needs the same hoist.
const wavetableSet = getWavetableSet(sampleRate)

/** Thin shell. All the math lives in dsp/segment and dsp/wavetable, which
 *  Node tests directly. One bundle registers all four processors because
 *  they share the segment core and change together. */
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
      out[i] = oscSample(this.state, shape, rate, sampleRate, wavetableSet) * depth
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
  // Last step index posted to the main thread. -1 (the state's own
  // "never clocked" sentinel) so the very first process() block, which
  // reports the clamped display index of 0, is recognized as a change and
  // gets its one initial message -- a UI listening from module creation
  // should see step 0 highlighted immediately, not only after the first
  // clock edge.
  private lastReportedIndex = -1

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

    // Playhead reporting: pure instrumentation, not DSP -- `this.state.index`
    // is read after `sequencerStep` (dsp/segment.ts) has already advanced it,
    // never computed here. Posted only on change, at most once per render
    // quantum, so an idle sequencer costs nothing extra on the message port.
    const displayIndex = this.state.index < 0 ? 0 : this.state.index
    if (displayIndex !== this.lastReportedIndex) {
      this.lastReportedIndex = displayIndex
      this.port.postMessage({ step: displayIndex })
    }
    return true
  }
}

registerProcessor('adsr', AdsrProcessor)
registerProcessor('lfo', LfoProcessor)
registerProcessor('sample-hold', SampleHoldProcessor)
registerProcessor('sequencer', SequencerProcessor)
