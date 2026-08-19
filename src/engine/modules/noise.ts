import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'

export const noiseDescriptor: ModuleDescriptor = {
  type: 'noise',
  name: 'Noise',
  hp: 4,
  group: 'source',
  ports: [{ id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [0, 3] }],
  params: [{ id: 'color', label: 'Color', min: 0, max: 1, default: 0, curve: 'lin', unit: '' }],
  layout: [
    { kind: 'knob', ref: 'color', x: 0, y: 0 },
    { kind: 'jack', ref: 'out', x: 0, y: 3 },
  ],
  create(ctx): ModuleInstance {
    const seconds = 2
    const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.loop = true
    source.start()

    // Pink-ish tilt: a gentle lowpass, bypassed by leaving color at 0.
    const tilt = ctx.createBiquadFilter()
    tilt.type = 'lowpass'
    tilt.frequency.value = 20000
    source.connect(tilt)

    return {
      inputs: new Map(),
      outputs: new Map([['out', tilt as AudioNode]]),
      // `color`'s knob is continuous-looking but the mapping underneath is
      // a hard 0.5 threshold onto one of two frequencies (a known,
      // separately tracked issue -- see docs/CONTINUATION.md -- not this
      // module's B3 fix). What B3 does fix: the AudioParam write at that
      // threshold used to be a bare `.value =` snap, audible as a click
      // exactly at the midpoint; scheduleParam smooths the jump between
      // the two frequencies instead, without changing which two values
      // color ever resolves to.
      setParam(id, value, atTime) {
        if (id === 'color') scheduleParam(tilt.frequency, value > 0.5 ? 1200 : 20000, ctx, atTime)
      },
      dispose() {
        source.stop()
        source.disconnect()
        tilt.disconnect()
      },
    }
  },
}
