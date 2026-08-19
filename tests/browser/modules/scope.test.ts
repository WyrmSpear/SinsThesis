import { describe, it, expect, beforeEach } from 'vitest'
import { renderGraph, ensureWorklets } from '../../../src/engine/render'
import { PatchGraph } from '../../../src/engine/graph'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { vcoDescriptor } from '../../../src/engine/modules/vco'
import { scopeDescriptor, type ScopeInstance } from '../../../src/engine/modules/scope'
import { rms } from '../../../src/engine/analysis/features'

beforeEach(() => {
  clearRegistry()
  registerModule(vcoDescriptor)
  registerModule(scopeDescriptor)
})

describe('Scope module', () => {
  it('passes its input through `thru` unchanged', async () => {
    // Two independent renders of the same deterministic VCO configuration
    // -- one straight to the destination, one detoured through the scope's
    // `in` -> `thru` -- should be sample-for-sample identical: `thru` is
    // literally the same unity-gain node as `in`, tapped in parallel by
    // the analyser, never processed in series (see scope.ts's doc
    // comment). This is the module-level counterpart to "insert a scope
    // mid-patch without breaking it."
    const direct = await renderGraph(0.1, (_ctx, g) => g.addModule('vco', 'osc'))
    const throughScope = await renderGraph(0.1, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const scope = g.addModule('scope', 'sc')
      g.connect([osc, 'out'], [scope, 'in'])
      return [scope, 'thru']
    })

    expect(throughScope.length).toBe(direct.length)
    let maxDiff = 0
    for (let i = 0; i < direct.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(direct[i]! - throughScope[i]!))
    }
    expect(maxDiff).toBeLessThan(1e-6)
  })

  it("its analyser reports non-zero data for a live signal", async () => {
    const ctx = new OfflineAudioContext(1, 4800, 48000)
    await ensureWorklets(ctx)
    const graph = new PatchGraph(ctx)
    const osc = graph.addModule('vco', 'osc')
    const scope = graph.addModule('scope', 'sc')
    graph.connect([osc, 'out'], [scope, 'in'])
    const instance = graph.getInstance(scope) as ScopeInstance
    // `thru` still has to reach the destination for the offline context to
    // render any samples through the graph at all -- an unconnected
    // subgraph renders nothing, which would leave the analyser starved of
    // real audio-thread data rather than proving anything about it.
    instance.outputs.get('thru')!.connect(ctx.destination)

    await ctx.startRendering()

    const data = new Float32Array(instance.analyser.fftSize)
    instance.analyser.getFloatTimeDomainData(data)
    expect(rms(data)).toBeGreaterThan(0.1)
  })

  it('an unpatched (silent) scope reports flat analyser data', async () => {
    const ctx = new OfflineAudioContext(1, 4800, 48000)
    await ensureWorklets(ctx)
    const graph = new PatchGraph(ctx)
    const scope = graph.addModule('scope', 'sc')
    const instance = graph.getInstance(scope) as ScopeInstance
    instance.outputs.get('thru')!.connect(ctx.destination)

    await ctx.startRendering()

    const data = new Float32Array(instance.analyser.fftSize)
    instance.analyser.getFloatTimeDomainData(data)
    expect(rms(data)).toBe(0)
  })
})
