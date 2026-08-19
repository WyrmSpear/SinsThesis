import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'

export const lfoDescriptor: ModuleDescriptor = {
  type: 'lfo',
  name: 'LFO',
  // 8 HP, the plain Eurorack LFO figure. `shape` (a switch, not a knob) now
  // shares its row with `rate` and sits above `depth` rather than beside
  // it -- the previous single-row layout put the SHAPE switch's widest
  // readout text ("TRIANGLE") directly against DEPTH's column, which is
  // exactly the collision reported live; stacking removes the adjacency.
  hp: 8,
  group: 'modulation',
  ports: [
    { id: 'sync', dir: 'in', signal: 'gate', label: 'Sync', pos: [0, 3] },
    { id: 'out', dir: 'out', signal: 'cv', label: 'Out', pos: [1, 3] },
  ],
  params: [
    { id: 'rate', label: 'Rate', min: 0.01, max: 200, default: 2, curve: 'exp', unit: 'Hz' },
    {
      id: 'shape',
      label: 'Shape',
      min: 0,
      max: 3,
      default: 2,
      curve: 'lin',
      unit: '',
      labels: ['Saw', 'Pulse', 'Triangle', 'Sine'],
    },
    { id: 'depth', label: 'Depth', min: 0, max: 1, default: 1, curve: 'lin', unit: '' },
  ],
  layout: [
    { kind: 'knob', ref: 'rate', x: 0, y: 0 },
    { kind: 'knob', ref: 'shape', x: 1, y: 0 },
    { kind: 'knob', ref: 'depth', x: 0, y: 1 },
    { kind: 'jack', ref: 'sync', x: 0, y: 3 },
    { kind: 'jack', ref: 'out', x: 1, y: 3 },
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
      // rate and depth are continuous and smooth. shape indexes a fixed
      // waveform table in the worklet (SHAPES[Math.round(shape)]) -- a
      // value between two shapes is meaningless, so it stays instant. B3.
      setParam(id, value, atTime) {
        const param = node.parameters.get(id)
        if (!param) return
        if (id === 'shape') param.value = value
        else scheduleParam(param, value, ctx, atTime)
      },
      dispose() {
        node.disconnect()
        syncIn.disconnect()
      },
    }
  },
}
