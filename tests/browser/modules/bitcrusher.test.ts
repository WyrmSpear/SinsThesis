import { describe, it, expect, beforeEach } from 'vitest'
import { renderGraph } from '../../../src/engine/render'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { vcoDescriptor } from '../../../src/engine/modules/vco'
import { bitcrusherDescriptor } from '../../../src/engine/modules/bitcrusher'
import { rms, spectralCentroid } from '../../../src/engine/analysis/features'

const SR = 48000

beforeEach(() => {
  clearRegistry()
  registerModule(vcoDescriptor)
  registerModule(bitcrusherDescriptor)
})

describe('Bitcrusher module (real worklet)', () => {
  it('produces sound', async () => {
    const out = await renderGraph(0.4, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const crush = g.addModule('bitcrusher', 'crush')
      g.connect([osc, 'out'], [crush, 'in'])
      return crush
    })
    expect(rms(out)).toBeGreaterThan(0.05)
  })

  it('at default (bypass) settings, passes the signal through with the level essentially unchanged', async () => {
    const render = (throughCrusher: boolean) => renderGraph(0.3, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      if (!throughCrusher) return osc
      const crush = g.addModule('bitcrusher', 'crush')
      g.connect([osc, 'out'], [crush, 'in'])
      return crush
    })
    const [direct, crushed] = await Promise.all([render(false), render(true)])
    const ratio = rms(crushed) / rms(direct)
    expect(ratio).toBeGreaterThan(0.95)
    expect(ratio).toBeLessThan(1.05)
  })

  it('a low bit depth measurably brightens/roughens a tone (adds broadband content)', async () => {
    const render = (bits: number) => renderGraph(0.4, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const crush = g.addModule('bitcrusher', 'crush')
      g.setParam(osc, 'tune', -12)
      g.setParam(crush, 'bits', bits)
      g.connect([osc, 'out'], [crush, 'in'])
      return crush
    })
    const [clean, crushed] = await Promise.all([render(16), render(2)])
    expect(spectralCentroid(crushed, SR)).toBeGreaterThan(spectralCentroid(clean, SR) * 1.3)
  })

  it('a low decimation rate measurably brightens/roughens a tone (imaging content)', async () => {
    const render = (rate: number) => renderGraph(0.4, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const crush = g.addModule('bitcrusher', 'crush')
      g.setParam(osc, 'tune', -12)
      g.setParam(crush, 'rate', rate)
      g.connect([osc, 'out'], [crush, 'in'])
      return crush
    })
    const [clean, crushed] = await Promise.all([render(48000), render(2000)])
    expect(spectralCentroid(crushed, SR)).toBeGreaterThan(spectralCentroid(clean, SR) * 1.3)
  })

  it('bitsCv modulates bit depth: a constant CV plus a nonzero amount audibly crushes the tone', async () => {
    const render = (cvAmount: number) => renderGraph(0.4, (ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const crush = g.addModule('bitcrusher', 'crush')
      g.setParam(osc, 'tune', -12)
      g.setParam(crush, 'bits', 8)
      g.setParam(crush, 'bitsCvAmount', cvAmount)
      g.connect([osc, 'out'], [crush, 'in'])
      const cvSource = ctx.createConstantSource()
      cvSource.offset.value = -1 // pulls bits down when cvAmount > 0
      cvSource.start()
      cvSource.connect(g.getInstance(crush)!.inputs.get('bitsCv') as AudioNode)
      return crush
    })
    const [unmodulated, modulated] = await Promise.all([render(0), render(6)])
    expect(spectralCentroid(modulated, SR)).toBeGreaterThan(spectralCentroid(unmodulated, SR) * 1.1)
  })

  it('rateCv modulates the decimation rate: a constant CV plus a nonzero amount audibly crushes the tone', async () => {
    const render = (cvAmount: number) => renderGraph(0.4, (ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const crush = g.addModule('bitcrusher', 'crush')
      g.setParam(osc, 'tune', -12)
      g.setParam(crush, 'rate', 20000)
      g.setParam(crush, 'rateCvAmount', cvAmount)
      g.connect([osc, 'out'], [crush, 'in'])
      const cvSource = ctx.createConstantSource()
      cvSource.offset.value = -1 // pulls the rate down when cvAmount > 0
      cvSource.start()
      cvSource.connect(g.getInstance(crush)!.inputs.get('rateCv') as AudioNode)
      return crush
    })
    const [unmodulated, modulated] = await Promise.all([render(0), render(15000)])
    expect(spectralCentroid(modulated, SR)).toBeGreaterThan(spectralCentroid(unmodulated, SR) * 1.1)
  })

  it('bend introduces audible repetition without silencing the signal', async () => {
    const out = await renderGraph(1.0, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const crush = g.addModule('bitcrusher', 'crush')
      g.setParam(crush, 'bend', 0.9)
      g.connect([osc, 'out'], [crush, 'in'])
      return crush
    })
    expect(rms(out)).toBeGreaterThan(0.05)
  })

  it('stays finite and produces sound at the harshest crush settings simultaneously', async () => {
    const out = await renderGraph(0.5, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const crush = g.addModule('bitcrusher', 'crush')
      g.setParam(crush, 'bits', 1)
      g.setParam(crush, 'rate', 100)
      g.setParam(crush, 'bend', 1)
      g.connect([osc, 'out'], [crush, 'in'])
      return crush
    })
    for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i])).toBe(true)
    expect(rms(out)).toBeGreaterThan(0.01)
  })
})
