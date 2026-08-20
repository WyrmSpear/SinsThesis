import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'

export const driveDescriptor: ModuleDescriptor = {
  type: 'drive',
  name: 'Drive',
  // 10 HP -- same width as the SVF (svf.ts), for the same reason: five
  // params (four knobs plus a switch) over three jacks needs a 2x3 knob
  // grid, not the 2x1-and-change wavefolder/VCA panels get by with.
  hp: 10,
  group: 'shaping',
  ports: [
    { id: 'in', dir: 'in', signal: 'audio', label: 'In', pos: [0, 3] },
    // Same 'CV' shortening as wavefolder.ts's foldCv, for the same reason:
    // this module has exactly one CV input, so the bare word is unambiguous.
    { id: 'driveCv', dir: 'in', signal: 'cv', label: 'CV', pos: [1, 3] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [0, 4] },
  ],
  params: [
    { id: 'drive', label: 'Drive', min: 0.1, max: 20, default: 1, curve: 'exp', unit: '' },
    {
      id: 'curve',
      label: 'Curve',
      min: 0,
      max: 1,
      default: 0,
      curve: 'lin',
      unit: '',
      // Soft (tanh) rounds peaks and stays odd-symmetric, no DC of its own.
      // Hard is a fixed, deliberately *asymmetric* clip -- even harmonics
      // and a real DC offset the module's own blocker removes -- a
      // genuinely different, grittier character, not just "more of Soft."
      // See dsp/drive.ts's module doc comment.
      labels: ['Soft', 'Hard'],
    },
    { id: 'tone', label: 'Tone', min: 200, max: 18000, default: 18000, curve: 'exp', unit: 'Hz' },
    { id: 'level', label: 'Level', min: 0, max: 2, default: 1, curve: 'lin', unit: '' },
    // Same 'Amt' shortening as wavefolder.ts's foldCvAmount, for the same
    // reason -- and the same idiom: drive amount is exactly what an
    // envelope sweeps to animate a growl, so it gets a CV input like every
    // other modulatable amount in this codebase.
    { id: 'driveCvAmount', label: 'Amt', min: 0, max: 10, default: 0, curve: 'lin', unit: '' },
  ],
  layout: [
    { kind: 'knob', ref: 'drive', x: 0, y: 0 },
    { kind: 'knob', ref: 'curve', x: 1, y: 0 },
    { kind: 'knob', ref: 'tone', x: 0, y: 1 },
    { kind: 'knob', ref: 'level', x: 1, y: 1 },
    { kind: 'knob', ref: 'driveCvAmount', x: 0, y: 2 },
    { kind: 'jack', ref: 'in', x: 0, y: 3 },
    { kind: 'jack', ref: 'driveCv', x: 1, y: 3 },
    { kind: 'jack', ref: 'out', x: 0, y: 4 },
  ],
  create(ctx): ModuleInstance {
    const node = new AudioWorkletNode(ctx, 'drive', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    const audioIn = ctx.createGain()
    const cvIn = ctx.createGain()
    audioIn.connect(node, 0, 0)
    cvIn.connect(node, 0, 1)

    return {
      inputs: new Map<string, AudioNode | AudioParam>([['in', audioIn], ['driveCv', cvIn]]),
      outputs: new Map([['out', node as AudioNode]]),
      // drive, tone, level and driveCvAmount are all continuous and smooth
      // (B3). curve indexes a fixed branch in the worklet (Soft/Hard) --
      // a value between the two is meaningless, so it stays instant, same
      // convention as the LFO's shape and division switches.
      setParam(id, value, atTime) {
        const param = node.parameters.get(id)
        if (!param) return
        if (id === 'curve') param.value = value
        else scheduleParam(param, value, ctx, atTime)
      },
      dispose() {
        node.disconnect()
        audioIn.disconnect()
        cvIn.disconnect()
      },
    }
  },
}
