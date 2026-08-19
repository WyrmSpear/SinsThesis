import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'

export const adsrDescriptor: ModuleDescriptor = {
  type: 'adsr',
  name: 'ADSR',
  hp: 26,
  group: 'modulation',
  ports: [
    { id: 'gate', dir: 'in', signal: 'gate', label: 'Gate', pos: [0, 3] },
    { id: 'out', dir: 'out', signal: 'cv', label: 'Out', pos: [3, 3] },
  ],
  params: [
    { id: 'attack', label: 'Attack', min: 0.001, max: 10, default: 0.01, curve: 'exp', unit: 's' },
    { id: 'decay', label: 'Decay', min: 0.001, max: 10, default: 0.1, curve: 'exp', unit: 's' },
    { id: 'sustain', label: 'Sustain', min: 0, max: 1, default: 0.7, curve: 'lin', unit: '' },
    { id: 'release', label: 'Release', min: 0.001, max: 10, default: 0.2, curve: 'exp', unit: 's' },
  ],
  layout: [
    { kind: 'knob', ref: 'attack', x: 0, y: 0 },
    { kind: 'knob', ref: 'decay', x: 1, y: 0 },
    { kind: 'knob', ref: 'sustain', x: 2, y: 0 },
    { kind: 'knob', ref: 'release', x: 3, y: 0 },
    { kind: 'jack', ref: 'gate', x: 0, y: 3 },
    { kind: 'jack', ref: 'out', x: 3, y: 3 },
  ],
  create(ctx): ModuleInstance {
    const node = new AudioWorkletNode(ctx, 'adsr', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    const gateIn = ctx.createGain()
    gateIn.connect(node, 0, 0)

    return {
      inputs: new Map<string, AudioNode | AudioParam>([['gate', gateIn]]),
      outputs: new Map([['out', node as AudioNode]]),
      // All four params (attack/decay/sustain/release) are continuous --
      // times and a level, none of them a discrete switch -- so every one
      // of them smooths through scheduleParam. B3.
      setParam(id, value, atTime) {
        const param = node.parameters.get(id)
        if (!param) return
        scheduleParam(param, value, ctx, atTime)
      },
      dispose() {
        node.disconnect()
        gateIn.disconnect()
      },
    }
  },
}
