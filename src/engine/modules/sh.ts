import type { ModuleDescriptor, ModuleInstance } from '../types'
import { tryCreateWorkletNode, buildFailedInstance } from './worklet-fallback'

export const shDescriptor: ModuleDescriptor = {
  type: 'sh',
  name: 'S&H',
  // 6 HP -- no knobs at all, just three jacks; a single stacked column
  // rather than spread across a wide strip.
  hp: 6,
  group: 'modulation',
  ports: [
    { id: 'in', dir: 'in', signal: 'cv', label: 'In', pos: [0, 0] },
    { id: 'trigger', dir: 'in', signal: 'gate', label: 'Trig', pos: [0, 1] },
    { id: 'out', dir: 'out', signal: 'cv', label: 'Out', pos: [0, 2] },
  ],
  params: [],
  layout: [
    { kind: 'jack', ref: 'in', x: 0, y: 0 },
    { kind: 'jack', ref: 'trigger', x: 0, y: 1 },
    { kind: 'jack', ref: 'out', x: 0, y: 2 },
  ],
  create(ctx): ModuleInstance {
    const node = tryCreateWorkletNode(ctx, 'sample-hold', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    // Same "no honest native equivalent" reasoning as adsr.ts: holding a CV
    // value exactly at a trigger edge until the next one is per-sample
    // state, and nothing in WebAudio's native node set reproduces it.
    if (!node) {
      return buildFailedInstance(
        ctx,
        shDescriptor.ports,
        "The Sample & Hold worklet didn't load, so this module outputs no signal. No native fallback exists for it.",
      )
    }

    const fronts = ['in', 'trigger'].map((_, index) => {
      const gain = ctx.createGain()
      gain.connect(node, 0, index)
      return gain
    })

    return {
      inputs: new Map<string, AudioNode | AudioParam>([
        ['in', fronts[0]!],
        ['trigger', fronts[1]!],
      ]),
      outputs: new Map([['out', node as AudioNode]]),
      setParam(id, value, atTime) {
        const param = node.parameters.get(id)
        if (!param) return
        if (atTime === undefined) param.value = value
        else param.setValueAtTime(value, atTime)
      },
      dispose() {
        node.disconnect()
        for (const gain of fronts) gain.disconnect()
      },
    }
  },
}
