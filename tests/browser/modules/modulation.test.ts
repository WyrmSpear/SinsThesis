import { describe, it, expect, beforeEach } from 'vitest'
import { renderGraph } from '../../../src/engine/render'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { adsrDescriptor } from '../../../src/engine/modules/adsr'
import { lfoDescriptor } from '../../../src/engine/modules/lfo'
import { rmsEnvelope, peakHz, rms } from '../../../src/engine/analysis/features'

const SR = 48000

beforeEach(() => {
  clearRegistry()
  registerModule(adsrDescriptor)
  registerModule(lfoDescriptor)
})

describe('ADSR module', () => {
  it('stays silent with no gate patched', async () => {
    const out = await renderGraph(0.2, (_ctx, g) => g.addModule('adsr', 'env'))
    expect(rms(out)).toBeLessThan(1e-6)
  })

  it('rises then settles at sustain when its gate is held', async () => {
    // A constant source stands in for a held gate.
    const out = await renderGraph(0.5, (ctx, g) => {
      const env = g.addModule('adsr', 'env')
      g.setParam(env, 'attack', 0.05)
      g.setParam(env, 'decay', 0.05)
      g.setParam(env, 'sustain', 0.5)
      const source = ctx.createConstantSource()
      source.offset.value = 1
      source.start()
      source.connect(g.getInstance(env)!.inputs.get('gate') as AudioNode)
      return env
    })
    const env = rmsEnvelope(out, 2400) // 50 ms windows
    expect(env[0]!).toBeLessThan(env[2]!)          // rising through attack
    expect(env[env.length - 1]!).toBeCloseTo(0.5, 1) // holding at sustain
  })
})

describe('LFO module', () => {
  it('runs at its rate param', async () => {
    const out = await renderGraph(4, (_ctx, g) => {
      const lfo = g.addModule('lfo', 'lfo')
      g.setParam(lfo, 'rate', 8)
      g.setParam(lfo, 'shape', 3) // sine, so the peak bin is unambiguous
      return lfo
    })
    expect(peakHz(out, SR)).toBeCloseTo(8, 0)
  })

  it('scales its output with depth', async () => {
    const at = (depth: number) =>
      renderGraph(1, (_ctx, g) => {
        const lfo = g.addModule('lfo', 'lfo')
        g.setParam(lfo, 'rate', 10)
        g.setParam(lfo, 'depth', depth)
        return lfo
      })
    const [half, full] = await Promise.all([at(0.5), at(1)])
    expect(rms(full)).toBeGreaterThan(rms(half) * 1.5)
  })
})
