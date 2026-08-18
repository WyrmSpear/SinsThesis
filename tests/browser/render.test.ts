import { describe, it, expect } from 'vitest'
import { renderGraph, ensureWorklets } from '../../src/engine/render'
import { registerModule, clearRegistry } from '../../src/engine/registry'
import type { ModuleDescriptor, ModuleInstance } from '../../src/engine/types'

/** A 440 Hz sine built from native nodes, used to prove the harness works. */
const toneDescriptor: ModuleDescriptor = {
  type: 'test-tone',
  name: 'Test Tone',
  hp: 4,
  ports: [{ id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [0, 0] }],
  params: [{ id: 'freq', label: 'Freq', min: 20, max: 20000, default: 440, curve: 'exp', unit: 'Hz' }],
  layout: [],
  create(ctx): ModuleInstance {
    const osc = ctx.createOscillator()
    osc.frequency.value = 440
    osc.start()
    return {
      inputs: new Map(),
      outputs: new Map([['out', osc as AudioNode]]),
      setParam: (id, value) => { if (id === 'freq') osc.frequency.value = value },
      dispose: () => osc.disconnect(),
    }
  },
}

describe('render harness', () => {
  it('loads every worklet module without error', async () => {
    const ctx = new OfflineAudioContext(1, 128, 48000)
    await expect(ensureWorklets(ctx)).resolves.toBeUndefined()
  })

  it('renders a graph to a buffer', async () => {
    clearRegistry()
    registerModule(toneDescriptor)
    const samples = await renderGraph(0.1, (_ctx, graph) => graph.addModule('test-tone', 'tone'))
    expect(samples.length).toBe(4800)
    const peak = Math.max(...samples)
    expect(peak).toBeGreaterThan(0.9)
  })

  it('addresses a named port when the build returns a tuple', async () => {
    clearRegistry()
    registerModule(toneDescriptor)
    const samples = await renderGraph(0.1, (_ctx, graph) => {
      graph.addModule('test-tone', 'tone')
      return ['tone', 'out'] as [string, string]
    })
    expect(Math.max(...samples)).toBeGreaterThan(0.9)
  })
})
