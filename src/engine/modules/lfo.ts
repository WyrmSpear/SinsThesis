import type { ModuleDescriptor, ModuleInstance } from '../types'

export const lfoDescriptor: ModuleDescriptor = {
  type: 'lfo',
  name: 'LFO',
  hp: 8,
  ports: [
    { id: 'sync', dir: 'in', signal: 'gate', label: 'Sync', pos: [0, 3] },
    { id: 'out', dir: 'out', signal: 'cv', label: 'Out', pos: [3, 3] },
  ],
  params: [
    { id: 'rate', label: 'Rate', min: 0.01, max: 200, default: 2, curve: 'exp', unit: 'Hz' },
    { id: 'shape', label: 'Shape', min: 0, max: 3, default: 2, curve: 'lin', unit: '' },
    { id: 'depth', label: 'Depth', min: 0, max: 1, default: 1, curve: 'lin', unit: '' },
  ],
  layout: [
    { kind: 'knob', ref: 'rate', x: 0, y: 0 },
    { kind: 'knob', ref: 'shape', x: 1, y: 0 },
    { kind: 'knob', ref: 'depth', x: 2, y: 0 },
    { kind: 'jack', ref: 'sync', x: 0, y: 3 },
    { kind: 'jack', ref: 'out', x: 3, y: 3 },
  ],
  create(ctx): ModuleInstance {
    const node = new AudioWorkletNode(ctx, 'lfo', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    const syncIn = ctx.createGain()
    syncIn.connect(node, 0, 0)

    return {
      inputs: new Map<string, AudioNode | AudioParam>([['sync', syncIn]]),
      outputs: new Map([['out', node as AudioNode]]),
      setParam(id, value, atTime) {
        const param = node.parameters.get(id)
        if (!param) return
        if (atTime === undefined) param.value = value
        else param.setValueAtTime(value, atTime)
      },
      dispose() {
        node.disconnect()
        syncIn.disconnect()
      },
    }
  },
}
