import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'
import { DIVISION_LABELS } from '../dsp/clock-sync'

export const lfoDescriptor: ModuleDescriptor = {
  type: 'lfo',
  name: 'LFO',
  // 8 HP, the plain Eurorack LFO figure. `shape` (a switch, not a knob) now
  // shares its row with `rate` and sits above `depth` rather than beside
  // it -- the previous single-row layout put the SHAPE switch's widest
  // readout text ("TRIANGLE") directly against DEPTH's column, which is
  // exactly the collision reported live; stacking removes the adjacency.
  // `division` shares depth's row for the same reason -- its widest label
  // ('1/16.', 5 characters) is the same order as SHAPE's abbreviated
  // 'Pulse', so it fits the same column that fix already proved out.
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
      // 'Triangle' clipped to "TRIAN…" in the switch readout at this
      // column's width (reported live); 'Tri' is the standard synth
      // abbreviation, matching Saw/Pulse/Sine's own brevity.
      labels: ['Saw', 'Pulse', 'Tri', 'Sine'],
    },
    { id: 'depth', label: 'Depth', min: 0, max: 1, default: 1, curve: 'lin', unit: '' },
    {
      id: 'division',
      label: 'Div',
      min: 0,
      max: DIVISION_LABELS.length - 1,
      default: 0,
      curve: 'lin',
      unit: '',
      // Index 0 ('Free') is today's plain behavior, unchanged: the Rate
      // knob's raw Hz value, sync hard-resets phase on every rising edge.
      // Any other position locks the rate to the incoming clock's measured
      // pulse period instead -- see dsp/clock-sync.ts's module doc comment
      // for the tempo-inference math and how a first pulse, a stopped
      // clock, and a tempo change are each handled without a glitch.
      labels: DIVISION_LABELS,
    },
  ],
  layout: [
    { kind: 'knob', ref: 'rate', x: 0, y: 0 },
    { kind: 'knob', ref: 'shape', x: 1, y: 0 },
    { kind: 'knob', ref: 'depth', x: 0, y: 1 },
    { kind: 'knob', ref: 'division', x: 1, y: 1 },
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
      // rate and depth are continuous and smooth. shape and division both
      // index a fixed table/branch in the worklet (SHAPES[Math.round(shape)],
      // DIVISION_MULTIPLIERS[Math.round(division)]) -- a value between two
      // positions is meaningless for either, so both stay instant. B3.
      setParam(id, value, atTime) {
        const param = node.parameters.get(id)
        if (!param) return
        if (id === 'shape' || id === 'division') param.value = value
        else scheduleParam(param, value, ctx, atTime)
      },
      dispose() {
        node.disconnect()
        syncIn.disconnect()
      },
    }
  },
}
