import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'

export const vcaDescriptor: ModuleDescriptor = {
  type: 'vca',
  name: 'VCA',
  hp: 6,
  group: 'shaping',
  ports: [
    { id: 'in', dir: 'in', signal: 'audio', label: 'In', pos: [0, 3] },
    { id: 'cv', dir: 'in', signal: 'cv', label: 'CV', pos: [1, 3] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [2, 3] },
  ],
  params: [
    { id: 'level', label: 'Level', min: 0, max: 1, default: 1, curve: 'lin', unit: '' },
    { id: 'cvAmount', label: 'CV Amt', min: 0, max: 1, default: 0, curve: 'lin', unit: '' },
  ],
  layout: [
    { kind: 'knob', ref: 'level', x: 0, y: 0 },
    { kind: 'knob', ref: 'cvAmount', x: 1, y: 0 },
    { kind: 'jack', ref: 'in', x: 0, y: 3 },
    { kind: 'jack', ref: 'cv', x: 1, y: 3 },
    { kind: 'jack', ref: 'out', x: 2, y: 3 },
  ],
  create(ctx): ModuleInstance {
    const vca = ctx.createGain()
    // Closed by construction: a freshly built VCA with nothing patched into
    // its CV should pass no signal, matching real hardware. `addModule`
    // (graph.ts) immediately applies this descriptor's default (1, open --
    // a VCA used as a plain unity gain stage, no envelope involved, is a
    // legitimate and common patch) as its very next step, snapped rather
    // than ramped (B4; see graph.ts), so this 0 is never audible on its
    // own. It matters for whatever constructs a `ModuleInstance` without
    // immediately reapplying every default, and it is the correct resting
    // state regardless.
    vca.gain.value = 0
    // CV rides on top of the level knob: the depth stage scales incoming CV
    // before it sums into the same gain param.
    const cvDepth = ctx.createGain()
    cvDepth.gain.value = 0
    cvDepth.connect(vca.gain)

    return {
      inputs: new Map<string, AudioNode | AudioParam>([['in', vca], ['cv', cvDepth]]),
      outputs: new Map([['out', vca as AudioNode]]),
      // Both level and cvAmount are continuous. B3.
      setParam(id, value, atTime) {
        if (id === 'level') scheduleParam(vca.gain, value, ctx, atTime)
        else if (id === 'cvAmount') scheduleParam(cvDepth.gain, value, ctx, atTime)
      },
      dispose() {
        vca.disconnect()
        cvDepth.disconnect()
      },
    }
  },
}
