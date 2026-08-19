import type { ModuleDescriptor, ModuleInstance } from '../types'

/**
 * The scope module's own instance, widened with the `AnalyserNode` it
 * builds internally -- the same pattern `OutputInstance` uses (see
 * output.ts's doc comment for why `ModuleInstance` itself has no room for a
 * module-specific extra handle). `rack/scope-panel.ts`, the `customPanel`
 * this descriptor registers, narrows `PatchGraph.getInstance()`'s return to
 * this type to reach it.
 */
export interface ScopeInstance extends ModuleInstance {
  readonly analyser: AnalyserNode
}

/**
 * A patchable oscilloscope: in hardware you patch a signal *into* a scope,
 * so it is a rack module with `in`/`thru` jacks, not a floating panel. No
 * worklet -- like `output.ts`, this is built entirely from a native
 * `AnalyserNode`, which already does everything a display needs (time and
 * frequency domain data) without a custom DSP core.
 *
 * `timebase` and `view` are both display-only: nothing in the audio graph
 * reads them. `rack/scope-panel.ts`'s draw loop reads their current values
 * straight off `PatchGraph.getParams` every animation frame instead, so
 * `setParam` below has nothing to forward either of them to.
 */
export const scopeDescriptor: ModuleDescriptor = {
  type: 'scope',
  name: 'Scope',
  // 20 HP -- enough width for a legible waveform/spectrum display; two
  // jacks and two controls stay a single row each above it (see
  // rack/scope-panel.ts's doc comment for the panel-height accounting this
  // was measured against).
  hp: 20,
  group: 'utility',
  customPanel: 'scope',
  ports: [
    { id: 'in', dir: 'in', signal: 'audio', label: 'In', pos: [0, 1] },
    { id: 'thru', dir: 'out', signal: 'audio', label: 'Thru', pos: [1, 1] },
  ],
  params: [
    { id: 'timebase', label: 'Time', min: 2, max: 40, default: 10, curve: 'exp', unit: 'ms' },
    {
      id: 'view', label: 'View', min: 0, max: 1, default: 0, curve: 'lin', unit: '',
      labels: ['Wave', 'Spectrum'],
    },
  ],
  layout: [
    { kind: 'knob', ref: 'timebase', x: 0, y: 0 },
    { kind: 'knob', ref: 'view', x: 1, y: 0 },
    { kind: 'jack', ref: 'in', x: 0, y: 1 },
    { kind: 'jack', ref: 'thru', x: 1, y: 1 },
  ],
  create(ctx): ScopeInstance {
    // Patched *into* the signal path (in -> thru), the way a hardware
    // scope inserts mid-patch -- so `thru` must carry the identical
    // signal, not a re-derived copy. Both ports expose the *same*
    // unity-gain `GainNode` (the same convention output.ts's `level` node
    // uses for its `in`/`out`), and the `AnalyserNode` taps it in
    // parallel with a plain `connect()`, which changes nothing about what
    // reaches any of the node's other destinations -- a fan-out, not a
    // detour.
    const pass = ctx.createGain()
    pass.gain.value = 1

    const analyser = ctx.createAnalyser()
    // Matches the dev harness's scope (dev/scope.ts): 8192 for spectrum
    // resolution fine enough to read an alias floor, 0.7 smoothing so the
    // spectrum reads as a settled curve, and an explicit dB window sized
    // for the same floors documented in docs/CONTINUATION.md.
    analyser.fftSize = 8192
    analyser.smoothingTimeConstant = 0.7
    analyser.minDecibels = -100
    analyser.maxDecibels = 0
    pass.connect(analyser)

    return {
      inputs: new Map<string, AudioNode | AudioParam>([['in', pass]]),
      outputs: new Map([['thru', pass as AudioNode]]),
      analyser,
      setParam() {
        // timebase/view are UI-only (see the doc comment above) -- nothing
        // here to schedule onto an AudioParam or a worklet message.
      },
      dispose() {
        pass.disconnect()
        analyser.disconnect()
      },
    }
  },
}
