import type { ModuleDescriptor, ModuleInstance } from '../types'

export const vcfDescriptor: ModuleDescriptor = {
  type: 'vcf',
  name: 'Ladder VCF',
  hp: 12,
  ports: [
    { id: 'in', dir: 'in', signal: 'audio', label: 'In', pos: [0, 3] },
    { id: 'cutoffCv', dir: 'in', signal: 'cv', label: 'Cutoff CV', pos: [1, 3] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [3, 3] },
  ],
  params: [
    { id: 'cutoff', label: 'Cutoff', min: 20, max: 20000, default: 1000, curve: 'exp', unit: 'Hz' },
    { id: 'resonance', label: 'Res', min: 0, max: 1, default: 0, curve: 'lin', unit: '' },
    { id: 'cutoffCvAmount', label: 'CV Amt', min: -8, max: 8, default: 0, curve: 'lin', unit: 'oct' },
    { id: 'drive', label: 'Drive', min: 0.1, max: 8, default: 1, curve: 'exp', unit: '' },
  ],
  layout: [
    { kind: 'knob', ref: 'cutoff', x: 0, y: 0 },
    { kind: 'knob', ref: 'resonance', x: 1, y: 0 },
    { kind: 'knob', ref: 'cutoffCvAmount', x: 0, y: 1 },
    { kind: 'knob', ref: 'drive', x: 1, y: 1 },
    { kind: 'jack', ref: 'in', x: 0, y: 3 },
    { kind: 'jack', ref: 'cutoffCv', x: 1, y: 3 },
    { kind: 'jack', ref: 'out', x: 3, y: 3 },
  ],
  create(ctx): ModuleInstance {
    const node = new AudioWorkletNode(ctx, 'ladder', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    const audioIn = ctx.createGain()
    const cvIn = ctx.createGain()
    audioIn.connect(node, 0, 0)
    cvIn.connect(node, 0, 1)

    return {
      inputs: new Map<string, AudioNode | AudioParam>([['in', audioIn], ['cutoffCv', cvIn]]),
      outputs: new Map([['out', node as AudioNode]]),
      setParam(id, value, atTime) {
        const param = node.parameters.get(id)
        if (!param) return
        if (atTime === undefined) param.value = value
        else param.setValueAtTime(value, atTime)
      },
      dispose() {
        node.disconnect()
        audioIn.disconnect()
        cvIn.disconnect()
      },
    }
  },
}
