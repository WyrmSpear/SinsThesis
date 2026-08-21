import { describe, it, expect } from 'vitest'
import { ensureWorklets } from '../../src/engine/render'
import { registerAllModules } from '../../src/engine/modules'
import { getModule } from '../../src/engine/registry'
import { PatchGraph } from '../../src/engine/graph'

/**
 * Section 11's "a worklet fails to load" failure mode, end to end: this is
 * the test the whole item exists to satisfy -- it must fail if the
 * fallback machinery is ever removed. Reverting any of `vco.ts`'s
 * `tryCreateWorkletNode` guard, `adsr.ts`'s equivalent, or `render.ts`'s
 * per-bundle `markWorkletLoaded` tracking back to a bare `new
 * AudioWorkletNode(ctx, name, ...)` makes `PatchGraph.addModule` throw
 * synchronously the moment this file forces that one bundle to fail --
 * which would blow up the whole test (and, in the real app, the whole
 * patch load) rather than landing on a `fallback` assertion.
 *
 * Same guard every other suite that calls `registerAllModules()` uses: it
 * throws on a second call, and vitest can run this file alongside others
 * in the same worker.
 */
if (!getModule('vco')) registerAllModules()

function stubbedContext(failingBundleUrlFragment: string): OfflineAudioContext {
  const ctx = new OfflineAudioContext(1, 48000, 48000)
  const real = ctx.audioWorklet.addModule.bind(ctx.audioWorklet)
  ctx.audioWorklet.addModule = (url: string) =>
    url.includes(failingBundleUrlFragment) ? Promise.reject(new Error('simulated load failure')) : real(url)
  return ctx
}

describe('worklet load failure -> module-level fallback (Section 11)', () => {
  it('a degraded module (VCO) keeps making sound on a native fallback, carries a visible badge state, and the rest of the patch is unaffected', async () => {
    const ctx = stubbedContext('/vco.js')
    await expect(ensureWorklets(ctx)).rejects.toThrow('simulated load failure')

    const graph = new PatchGraph(ctx)
    const vcoId = graph.addModule('vco')
    const outputId = graph.addModule('output')
    graph.connect([vcoId, 'out'], [outputId, 'in'])

    const vco = graph.getInstance(vcoId)!
    expect(vco.fallback?.level).toBe('degraded')
    expect(vco.fallback?.reason.length).toBeGreaterThan(10)

    // A sibling module whose worklet DID load is completely unaffected --
    // the whole point of tracking failure per bundle rather than treating
    // "something failed" as "nothing loaded."
    const ladderId = graph.addModule('vcf')
    expect(graph.getInstance(ladderId)?.fallback).toBeUndefined()

    const out = graph.getInstance(outputId)!.outputs.get('out')
    expect(out).toBeDefined()
    out!.connect(ctx.destination)

    const buffer = await ctx.startRendering()
    const samples = buffer.getChannelData(0)
    let peak = 0
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]!))
    expect(peak, 'the VCO fallback should still produce audible signal').toBeGreaterThan(0.05)
  })

  it('a module with no honest native equivalent (ADSR) fails loudly -- silent, badged, structurally intact -- without breaking the rest of the patch', async () => {
    const ctx = stubbedContext('/segment.js')
    await expect(ensureWorklets(ctx)).rejects.toThrow('simulated load failure')

    const graph = new PatchGraph(ctx)
    const vcoId = graph.addModule('vco')
    const adsrId = graph.addModule('adsr')
    const outputId = graph.addModule('output')
    // Cabling to a fallback's port must not throw -- its ports are real
    // GainNodes even when they carry no signal.
    graph.connect([vcoId, 'out'], [outputId, 'in'])
    graph.connect([adsrId, 'out'], [outputId, 'in'])

    const adsr = graph.getInstance(adsrId)!
    expect(adsr.fallback?.level).toBe('failed')
    expect(adsr.fallback?.reason.length).toBeGreaterThan(10)

    // The VCO, an unrelated bundle, still built and works normally.
    expect(graph.getInstance(vcoId)?.fallback).toBeUndefined()

    const out = graph.getInstance(outputId)!.outputs.get('out')!
    out.connect(ctx.destination)
    const buffer = await ctx.startRendering()
    const samples = buffer.getChannelData(0)
    let peak = 0
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]!))
    expect(peak, 'the VCO feeding the same Output should still be audible').toBeGreaterThan(0.05)
  })

  it('a retry after the failure recovers -- workletAvailable reflects reality, not a poisoned first attempt', async () => {
    const ctx = new OfflineAudioContext(1, 128, 48000)
    const real = ctx.audioWorklet.addModule.bind(ctx.audioWorklet)
    let failing = true
    ctx.audioWorklet.addModule = (url: string) =>
      url.includes('/vco.js') && failing ? Promise.reject(new Error('flaky')) : real(url)

    await expect(ensureWorklets(ctx)).rejects.toThrow('flaky')
    const graphDuringFailure = new PatchGraph(ctx)
    expect(graphDuringFailure.getInstance(graphDuringFailure.addModule('vco'))?.fallback?.level).toBe('degraded')

    failing = false
    await expect(ensureWorklets(ctx)).resolves.toBeUndefined()
    const graphAfterRetry = new PatchGraph(ctx)
    expect(graphAfterRetry.getInstance(graphAfterRetry.addModule('vco'))?.fallback).toBeUndefined()
  })
})
