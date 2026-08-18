import type { ModuleDescriptor, ModuleInstance } from '../types'

export const noiseDescriptor: ModuleDescriptor = {
  type: 'noise',
  name: 'Noise',
  hp: 4,
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
      setParam(id, value) {
        if (id === 'color') tilt.frequency.value = value > 0.5 ? 1200 : 20000
      },
      dispose() {
        source.stop()
        source.disconnect()
        tilt.disconnect()
      },
    }
  },
}
