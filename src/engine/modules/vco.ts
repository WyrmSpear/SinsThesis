import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'

/**
 * Every input port is fronted by its own GainNode, so the graph connects with
 * a plain two-argument connect() and never needs to know that the worklet has
 * three numbered inputs.
 */
export const vcoDescriptor: ModuleDescriptor = {
  type: 'vco',
  name: 'VCO',
  hp: 12,
  ports: [
    { id: 'pitch', dir: 'in', signal: 'cv', label: '1V/Oct', pos: [0, 3] },
    { id: 'fm', dir: 'in', signal: 'cv', label: 'FM', pos: [1, 3] },
    { id: 'sync', dir: 'in', signal: 'gate', label: 'Sync', pos: [2, 3] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [3, 3] },
  ],
  params: [
    { id: 'tune', label: 'Tune', min: -24, max: 24, default: 0, curve: 'lin', unit: 'st' },
    { id: 'octave', label: 'Octave', min: -4, max: 4, default: 0, curve: 'lin', unit: '' },
    { id: 'shape', label: 'Shape', min: 0, max: 3, default: 0, curve: 'lin', unit: '' },
    { id: 'pulseWidth', label: 'Width', min: 0.01, max: 0.99, default: 0.5, curve: 'lin', unit: '' },
    { id: 'fmAmount', label: 'FM', min: 0, max: 4, default: 0, curve: 'lin', unit: '' },
  ],
  layout: [
    { kind: 'knob', ref: 'tune', x: 0, y: 0 },
    { kind: 'knob', ref: 'octave', x: 1, y: 0 },
    { kind: 'knob', ref: 'shape', x: 2, y: 0 },
    { kind: 'knob', ref: 'pulseWidth', x: 0, y: 1 },
    { kind: 'knob', ref: 'fmAmount', x: 1, y: 1 },
    { kind: 'jack', ref: 'pitch', x: 0, y: 3 },
    { kind: 'jack', ref: 'fm', x: 1, y: 3 },
    { kind: 'jack', ref: 'sync', x: 2, y: 3 },
    { kind: 'jack', ref: 'out', x: 3, y: 3 },
  ],
  create(ctx): ModuleInstance {
    const node = new AudioWorkletNode(ctx, 'vco', {
      numberOfInputs: 3,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })

    const fronts = ['pitch', 'fm', 'sync'].map((_, index) => {
      const gain = ctx.createGain()
      gain.connect(node, 0, index)
      return gain
    })

    return {
      inputs: new Map<string, AudioNode | AudioParam>([
        ['pitch', fronts[0]!],
        ['fm', fronts[1]!],
        ['sync', fronts[2]!],
      ]),
      outputs: new Map([['out', node as AudioNode]]),
      // tune, octave, pulseWidth and fmAmount all feed continuous math in
      // the worklet (octave in particular is never rounded -- see
      // vco.worklet.ts -- so fractional values already glide the pitch
      // correctly), and all smooth. shape indexes a fixed waveform table
      // (SHAPES[Math.round(shape)]) -- a value between two shapes is
      // meaningless -- so it stays instant. B3.
      setParam(id, value, atTime) {
        const param = node.parameters.get(id)
        if (!param) return
        if (id === 'shape') param.value = value
        else scheduleParam(param, value, ctx, atTime)
      },
      dispose() {
        node.disconnect()
        for (const gain of fronts) gain.disconnect()
      },
    }
  },
}
