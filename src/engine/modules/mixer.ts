import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'

const CHANNELS = [1, 2, 3, 4] as const

export const mixerDescriptor: ModuleDescriptor = {
  type: 'mixer',
  name: 'Mixer',
  // 8 HP -- matches small Eurorack mixers (e.g. Doepfer A-138). The 2x2
  // knob grid was already right; only the jack rows needed to stop
  // spreading across four columns of an 8 HP-wide panel.
  hp: 8,
  group: 'utility',
  ports: [
    { id: 'in1', dir: 'in', signal: 'audio', label: 'In 1', pos: [0, 3] },
    { id: 'in2', dir: 'in', signal: 'audio', label: 'In 2', pos: [1, 3] },
    { id: 'in3', dir: 'in', signal: 'audio', label: 'In 3', pos: [0, 4] },
    { id: 'in4', dir: 'in', signal: 'audio', label: 'In 4', pos: [1, 4] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [0, 5] },
  ],
  params: CHANNELS.map((n) => ({
    id: `level${n}`,
    label: `Level ${n}`,
    min: -1,
    max: 1,
    // Attenuverters: unity by default, so patching a cable in is audible
    // without touching a knob first.
    default: 1,
    curve: 'lin' as const,
    unit: '',
  })),
  layout: [
    { kind: 'knob', ref: 'level1', x: 0, y: 0 },
    { kind: 'knob', ref: 'level2', x: 1, y: 0 },
    { kind: 'knob', ref: 'level3', x: 0, y: 1 },
    { kind: 'knob', ref: 'level4', x: 1, y: 1 },
    { kind: 'jack', ref: 'in1', x: 0, y: 3 },
    { kind: 'jack', ref: 'in2', x: 1, y: 3 },
    { kind: 'jack', ref: 'in3', x: 0, y: 4 },
    { kind: 'jack', ref: 'in4', x: 1, y: 4 },
    { kind: 'jack', ref: 'out', x: 0, y: 5 },
  ],
  create(ctx): ModuleInstance {
    const sum = ctx.createGain()
    sum.gain.value = 1

    const inputs = CHANNELS.map((n) => {
      const gain = ctx.createGain()
      gain.gain.value = 1
      gain.connect(sum)
      return { id: `in${n}`, gain }
    })

    return {
      inputs: new Map<string, AudioNode | AudioParam>(
        inputs.map(({ id, gain }) => [id, gain]),
      ),
      outputs: new Map([['out', sum as AudioNode]]),
      // All four channel levels are continuous attenuverters. B3.
      setParam(id, value, atTime) {
        const match = /^level([1-4])$/.exec(id)
        if (!match) return
        const channel = inputs[Number(match[1]) - 1]
        if (channel) scheduleParam(channel.gain.gain, value, ctx, atTime)
      },
      dispose() {
        sum.disconnect()
        for (const { gain } of inputs) gain.disconnect()
      },
    }
  },
}
