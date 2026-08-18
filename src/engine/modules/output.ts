import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'

/**
 * The output module's own instance, widened with the `AnalyserNode` it
 * builds internally. `ModuleInstance` has no room for a module-specific
 * extra handle (see `KeyboardMidiInstance` for the same pattern with
 * `handleKey`), so a caller that wants to feed a scope or spectrum display
 * -- there is exactly one such caller today, the dev harness -- narrows
 * `PatchGraph.getInstance()`'s return to this type itself.
 */
export interface OutputInstance extends ModuleInstance {
  readonly analyser: AnalyserNode
}

export const outputDescriptor: ModuleDescriptor = {
  type: 'output',
  name: 'Output',
  hp: 6,
  ports: [
    { id: 'in', dir: 'in', signal: 'audio', label: 'In', pos: [0, 3] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [2, 3] },
  ],
  params: [{ id: 'level', label: 'Level', min: 0, max: 1, default: 1, curve: 'lin', unit: '' }],
  layout: [
    { kind: 'knob', ref: 'level', x: 0, y: 0 },
    { kind: 'jack', ref: 'in', x: 0, y: 3 },
    { kind: 'jack', ref: 'out', x: 2, y: 3 },
  ],
  create(ctx): OutputInstance {
    const level = ctx.createGain()
    level.gain.value = 1

    // A tap for Phase 2's meter; the post-level signal itself is exposed
    // directly as the "out" port so the render harness (and any downstream
    // jack) reads the real output regardless of whether anything is
    // listening to the analyser.
    const analyser = ctx.createAnalyser()
    level.connect(analyser)

    return {
      inputs: new Map<string, AudioNode | AudioParam>([['in', level]]),
      outputs: new Map([['out', level as AudioNode]]),
      analyser,
      // The only param, level, is a continuous master fader. B3.
      setParam(id, value, atTime) {
        if (id === 'level') scheduleParam(level.gain, value, ctx, atTime)
      },
      dispose() {
        level.disconnect()
        analyser.disconnect()
      },
    }
  },
}
