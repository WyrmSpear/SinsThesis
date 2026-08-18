import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'

const MAX_DELAY_SECONDS = 2

export const delayDescriptor: ModuleDescriptor = {
  type: 'delay',
  name: 'Delay',
  hp: 10,
  ports: [
    { id: 'in', dir: 'in', signal: 'audio', label: 'In', pos: [0, 3] },
    { id: 'timeCv', dir: 'in', signal: 'cv', label: 'Time CV', pos: [1, 3] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [3, 3] },
  ],
  params: [
    { id: 'time', label: 'Time', min: 0.001, max: MAX_DELAY_SECONDS, default: 0.3, curve: 'exp', unit: 's' },
    { id: 'feedback', label: 'Feedback', min: 0, max: 0.95, default: 0.3, curve: 'lin', unit: '' },
    { id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.3, curve: 'lin', unit: '' },
  ],
  layout: [
    { kind: 'knob', ref: 'time', x: 0, y: 0 },
    { kind: 'knob', ref: 'feedback', x: 1, y: 0 },
    { kind: 'knob', ref: 'mix', x: 2, y: 0 },
    { kind: 'jack', ref: 'in', x: 0, y: 3 },
    { kind: 'jack', ref: 'timeCv', x: 1, y: 3 },
    { kind: 'jack', ref: 'out', x: 3, y: 3 },
  ],
  create(ctx): ModuleInstance {
    const input = ctx.createGain()
    input.gain.value = 1

    const delay = ctx.createDelay(MAX_DELAY_SECONDS)
    delay.delayTime.value = 0.3
    input.connect(delay)

    // Time CV rides on top of the time knob, same additive pattern as the
    // VCA's cv input riding on its level param.
    const timeCvFront = ctx.createGain()
    timeCvFront.gain.value = 1
    timeCvFront.connect(delay.delayTime)

    const feedback = ctx.createGain()
    feedback.gain.value = 0.3
    delay.connect(feedback)
    feedback.connect(delay)

    const dry = ctx.createGain()
    dry.gain.value = 0.7
    input.connect(dry)

    const wet = ctx.createGain()
    wet.gain.value = 0.3
    delay.connect(wet)

    const out = ctx.createGain()
    out.gain.value = 1
    dry.connect(out)
    wet.connect(out)

    return {
      inputs: new Map<string, AudioNode | AudioParam>([['in', input], ['timeCv', timeCvFront]]),
      outputs: new Map([['out', out as AudioNode]]),
      // time, feedback and mix are all continuous -- no discrete param on
      // this module -- so every one smooths. B3.
      setParam(id, value, atTime) {
        if (id === 'time') scheduleParam(delay.delayTime, value, ctx, atTime)
        else if (id === 'feedback') scheduleParam(feedback.gain, value, ctx, atTime)
        else if (id === 'mix') {
          scheduleParam(wet.gain, value, ctx, atTime)
          scheduleParam(dry.gain, 1 - value, ctx, atTime)
        }
      },
      dispose() {
        input.disconnect()
        delay.disconnect()
        timeCvFront.disconnect()
        feedback.disconnect()
        dry.disconnect()
        wet.disconnect()
        out.disconnect()
      },
    }
  },
}
