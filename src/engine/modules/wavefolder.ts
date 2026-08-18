import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'

export const wavefolderDescriptor: ModuleDescriptor = {
  type: 'wavefolder',
  name: 'Wavefolder',
  hp: 8,
  ports: [
    { id: 'in', dir: 'in', signal: 'audio', label: 'In', pos: [0, 3] },
    { id: 'foldCv', dir: 'in', signal: 'cv', label: 'Fold CV', pos: [1, 3] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [3, 3] },
  ],
  params: [
    { id: 'drive', label: 'Drive', min: 0.1, max: 20, default: 1, curve: 'exp', unit: '' },
    { id: 'symmetry', label: 'Sym', min: -1, max: 1, default: 0, curve: 'lin', unit: '' },
    { id: 'foldCvAmount', label: 'CV Amt', min: 0, max: 10, default: 0, curve: 'lin', unit: '' },
  ],
  layout: [
    { kind: 'knob', ref: 'drive', x: 0, y: 0 },
    { kind: 'knob', ref: 'symmetry', x: 1, y: 0 },
    { kind: 'knob', ref: 'foldCvAmount', x: 0, y: 1 },
    { kind: 'jack', ref: 'in', x: 0, y: 3 },
    { kind: 'jack', ref: 'foldCv', x: 1, y: 3 },
    { kind: 'jack', ref: 'out', x: 3, y: 3 },
  ],
  create(ctx): ModuleInstance {
    const node = new AudioWorkletNode(ctx, 'wavefolder', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    const audioIn = ctx.createGain()
    const cvIn = ctx.createGain()
    audioIn.connect(node, 0, 0)
    cvIn.connect(node, 0, 1)

    return {
      inputs: new Map<string, AudioNode | AudioParam>([['in', audioIn], ['foldCv', cvIn]]),
      outputs: new Map([['out', node as AudioNode]]),
      // drive, symmetry and foldCvAmount are all continuous -- no
      // discrete/switch param on this module -- so every one smooths, same
      // as every other module with a scheduleParam-eligible param set (B3).
      // This module previously wrote `.value` directly instead, the one
      // module in the set that did: found live, turning the drive knob
      // fast produced an audible step at every animation frame instead of
      // the ramp every other continuous param gets.
      setParam(id, value, atTime) {
        const param = node.parameters.get(id)
        if (!param) return
        scheduleParam(param, value, ctx, atTime)
      },
      dispose() {
        node.disconnect()
        audioIn.disconnect()
        cvIn.disconnect()
      },
    }
  },
}
