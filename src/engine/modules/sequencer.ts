import type { ModuleDescriptor, ModuleInstance } from '../types'

const STEP_PARAMS = Array.from({ length: 16 }, (_, i) => ({
  id: `step${i + 1}`,
  label: `${i + 1}`,
  min: -2,
  max: 2,
  default: 0,
  curve: 'lin' as const,
  unit: 'oct',
}))

/**
 * Sixteen-step CV/gate sequencer. `cv` and `gate` come off one worklet node
 * with two outputs; each is fronted by its own GainNode so the graph's plain
 * two-argument `connect()` (which always addresses output index 0) cannot
 * collapse them onto the same signal, mirroring the input-fronting
 * convention every other worklet module already uses.
 */
export const sequencerDescriptor: ModuleDescriptor = {
  type: 'seq',
  name: 'Sequencer',
  hp: 24,
  customPanel: 'sequencer',
  ports: [
    { id: 'clock', dir: 'in', signal: 'gate', label: 'Clock', pos: [0, 3] },
    { id: 'reset', dir: 'in', signal: 'gate', label: 'Reset', pos: [1, 3] },
    { id: 'cv', dir: 'out', signal: 'cv', label: 'CV', pos: [2, 3] },
    { id: 'gate', dir: 'out', signal: 'gate', label: 'Gate', pos: [3, 3] },
  ],
  params: [
    { id: 'steps', label: 'Steps', min: 1, max: 16, default: 8, curve: 'lin', unit: '' },
    // Reserved for a future portamento pass between step CVs; the worklet
    // does not yet read it, so it is a no-op today (see task-16-report.md).
    { id: 'glide', label: 'Glide', min: 0, max: 1, default: 0, curve: 'lin', unit: '' },
    ...STEP_PARAMS,
  ],
  layout: [
    { kind: 'knob', ref: 'steps', x: 0, y: 0 },
    { kind: 'knob', ref: 'glide', x: 1, y: 0 },
    { kind: 'jack', ref: 'clock', x: 0, y: 3 },
    { kind: 'jack', ref: 'reset', x: 1, y: 3 },
    { kind: 'jack', ref: 'cv', x: 2, y: 3 },
    { kind: 'jack', ref: 'gate', x: 3, y: 3 },
  ],
  create(ctx): ModuleInstance {
    const node = new AudioWorkletNode(ctx, 'sequencer', {
      numberOfInputs: 2,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    })
    const cvOut = ctx.createGain()
    const gateOut = ctx.createGain()
    node.connect(cvOut, 0)
    node.connect(gateOut, 1)

    const fronts = ['clock', 'reset'].map((_, index) => {
      const gain = ctx.createGain()
      gain.connect(node, 0, index)
      return gain
    })

    return {
      inputs: new Map<string, AudioNode | AudioParam>([
        ['clock', fronts[0]!],
        ['reset', fronts[1]!],
      ]),
      outputs: new Map<string, AudioNode>([
        ['cv', cvOut],
        ['gate', gateOut],
      ]),
      setParam(id, value, atTime) {
        const param = node.parameters.get(id)
        if (!param) return
        if (atTime === undefined) param.value = value
        else param.setValueAtTime(value, atTime)
      },
      dispose() {
        node.disconnect()
        cvOut.disconnect()
        gateOut.disconnect()
        for (const gain of fronts) gain.disconnect()
      },
    }
  },
}
