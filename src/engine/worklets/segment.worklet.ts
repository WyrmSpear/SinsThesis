import {
  createEnvState, envSample, createSampleHoldState, sampleHold,
  createSequencerState, sequencerStep,
} from '../dsp/segment'
import { createOscState, getWavetableSet, oscSample, hardSync, type OscShape } from '../dsp/wavetable'
import { createSyncState, updateSync, isSyncLocked, lockedRateHz } from '../dsp/clock-sync'

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
  // Edge tracking for Free mode (division === 0), preserved bit-for-bit
  // from the original sync behavior: hard-reset phase on every rising edge.
  private lastSync = 0
  // Edge/period tracking for clock-division mode. Kept separate from
  // `lastSync` above and only advanced while a division is selected (see
  // process() below), so switching between Free and a division starts the
  // lock fresh rather than reusing a stale measurement from a different mode.
  private readonly sync = createSyncState()

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'rate', defaultValue: 2, minValue: 0.01, maxValue: 200, automationRate: 'k-rate' },
      { name: 'shape', defaultValue: 2, minValue: 0, maxValue: 3, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      // Discrete, like shape -- see dsp/clock-sync.ts's DIVISION_LABELS and
      // the module doc comment on lfo.ts's `division` param.
      { name: 'division', defaultValue: 0, minValue: 0, maxValue: 15, automationRate: 'k-rate' },
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
    const divisionIndex = Math.round(params.division![0]!)

    for (let i = 0; i < out.length; i++) {
      const s = sync?.[i] ?? 0
      let effectiveRate = rate

      if (divisionIndex === 0) {
        // Free: exactly the original behavior. Hz rate, hard reset on
        // every rising edge (a no-op when nothing is patched, since `s`
        // never crosses the threshold).
        if (s >= 0.5 && this.lastSync < 0.5) hardSync(this.state)
      } else {
        // Clock-division: track the pulse period continuously (so the
        // lock doesn't need to "warm up" again after a mode switch mid-
        // patch) and only derive a rate from it while locked. Phase is
        // hard-reset only on the sample where lock is *first acquired* --
        // covers both the very first lock (second-ever pulse) and a
        // relock after the clock stopped -- not on every subsequent pulse,
        // which is what keeps a division other than 1x from being
        // truncated back to the clock's own pulse rate every beat (see
        // dsp/clock-sync.ts's module doc comment, "a tempo change
        // mid-note").
        const wasLocked = isSyncLocked(this.sync, sampleRate)
        updateSync(this.sync, s, sampleRate)
        const isLocked = isSyncLocked(this.sync, sampleRate)
        if (!wasLocked && isLocked) hardSync(this.state)
        if (isLocked) effectiveRate = lockedRateHz(this.sync, divisionIndex)
      }

      this.lastSync = s
      out[i] = oscSample(this.state, shape, effectiveRate, sampleRate, wavetableSet) * depth
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
