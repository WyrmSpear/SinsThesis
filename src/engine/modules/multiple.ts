import type { ModuleDescriptor, ModuleInstance } from '../types'

export const multipleDescriptor: ModuleDescriptor = {
  type: 'multiple',
  name: 'Mult',
  hp: 4,
  ports: [
    { id: 'in', dir: 'in', signal: 'audio', label: 'In', pos: [0, 3] },
    { id: 'out1', dir: 'out', signal: 'audio', label: 'Out 1', pos: [0, 4] },
    { id: 'out2', dir: 'out', signal: 'audio', label: 'Out 2', pos: [1, 4] },
    { id: 'out3', dir: 'out', signal: 'audio', label: 'Out 3', pos: [2, 4] },
    { id: 'out4', dir: 'out', signal: 'audio', label: 'Out 4', pos: [3, 4] },
  ],
  params: [],
  layout: [
    { kind: 'jack', ref: 'in', x: 0, y: 3 },
    { kind: 'jack', ref: 'out1', x: 0, y: 4 },
    { kind: 'jack', ref: 'out2', x: 1, y: 4 },
    { kind: 'jack', ref: 'out3', x: 2, y: 4 },
    { kind: 'jack', ref: 'out4', x: 3, y: 4 },
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
