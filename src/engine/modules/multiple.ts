import type { ModuleDescriptor, ModuleInstance } from '../types'

export const multipleDescriptor: ModuleDescriptor = {
  type: 'multiple',
  name: 'Mult',
  // 4 HP -- a real passive multiple is just a vertical column of jacks
  // wired together, so that is exactly how this one lays out: one column,
  // one row per jack, narrower than anything with a knob on it. Clamped up
  // to panel.ts's MIN_PANEL_PX floor regardless, same as every other
  // knob-less module here.
  hp: 4,
  group: 'utility',
  ports: [
    { id: 'in', dir: 'in', signal: 'audio', label: 'In', pos: [0, 0] },
    { id: 'out1', dir: 'out', signal: 'audio', label: 'Out 1', pos: [0, 1] },
    { id: 'out2', dir: 'out', signal: 'audio', label: 'Out 2', pos: [0, 2] },
    { id: 'out3', dir: 'out', signal: 'audio', label: 'Out 3', pos: [0, 3] },
    { id: 'out4', dir: 'out', signal: 'audio', label: 'Out 4', pos: [0, 4] },
  ],
  params: [],
  layout: [
    { kind: 'jack', ref: 'in', x: 0, y: 0 },
    { kind: 'jack', ref: 'out1', x: 0, y: 1 },
    { kind: 'jack', ref: 'out2', x: 0, y: 2 },
    { kind: 'jack', ref: 'out3', x: 0, y: 3 },
    { kind: 'jack', ref: 'out4', x: 0, y: 4 },
  ],
  create(ctx): ModuleInstance {
    // A single unity-gain node: every output port is the same node, so
    // fanning out costs nothing beyond the extra connect() calls the graph
    // makes when cables land on out2, out3, out4.
    const node = ctx.createGain()
    node.gain.value = 1

    return {
      inputs: new Map<string, AudioNode | AudioParam>([['in', node]]),
      outputs: new Map([
        ['out1', node as AudioNode],
        ['out2', node as AudioNode],
        ['out3', node as AudioNode],
        ['out4', node as AudioNode],
      ]),
      setParam() {
        // No params.
      },
      dispose() {
        node.disconnect()
      },
    }
  },
}
