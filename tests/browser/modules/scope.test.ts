import { describe, it, expect, beforeEach } from 'vitest'
import { renderGraph, ensureWorklets } from '../../../src/engine/render'
import { PatchGraph } from '../../../src/engine/graph'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { vcoDescriptor } from '../../../src/engine/modules/vco'
import { scopeDescriptor, type ScopeInstance } from '../../../src/engine/modules/scope'
import { rms } from '../../../src/engine/analysis/features'
import { calibratedDb, SPECTRUM_CALIBRATION_DB } from '../../../rack/scope-panel'

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

/**
 * Audit round two, finding 3: rack/scope-panel.ts's dB axis used to lie --
 * a full-scale bin-centered sine read -13.9 dB, and a known -80 dB tone
 * polled every animation frame drifted rather than settled. These tests
 * poll the real engine module's analyser exactly the way
 * rack/scope-panel.ts's own draw loop does -- `ctx.suspend()` at 1/60s
 * intervals standing in for `requestAnimationFrame`, since `getFloatFrequencyData`'s
 * internal smoothing blends against whatever the *previous call* computed
 * (not against elapsed audio time), so a realistic poll cadence is load-bearing
 * to the result, not incidental.
 */
describe('Scope module: spectrum dB calibration (finding 3)', () => {
  async function pollAtFps(
    instance: ScopeInstance, ctx: OfflineAudioContext, seconds: number,
  ): Promise<number[]> {
    const freqData = new Float32Array(instance.analyser.frequencyBinCount)
    const readings: number[] = []
    const dt = 1 / 60
    const times: number[] = []
    for (let t = dt; t <= seconds; t += dt) times.push(t)
    for (const t of times) {
      ctx.suspend(t).then(() => {
        instance.analyser.getFloatFrequencyData(freqData)
        readings.push(calibratedDb(freqData[189]!)) // bin 189 = 189 * 48000/8192 Hz
        ctx.resume()
      })
    }
    await ctx.startRendering()
    return readings
  }

  it('SPECTRUM_CALIBRATION_DB matches the Blackman coherent-gain-loss derivation', () => {
    // -20*log10(0.42 * 0.5): the Web Audio spec's Blackman a0 (0.42, a
    // -7.54 dB coherent-gain loss) plus the missing single-sided-spectrum
    // x2 factor (-6.02 dB) that getFloatFrequencyData never compensates
    // for. Pinned here so a future edit to the constant has to explain
    // itself against the derivation, not just change a number.
    expect(SPECTRUM_CALIBRATION_DB).toBeCloseTo(13.5556, 3)
  })

  it('a full-scale, bin-centered sine reads within 1 dB of 0 dB, not -13.9 dB', async () => {
    const SR = 48000
    const ctx = new OfflineAudioContext(1, Math.ceil(SR * 0.6), SR)
    await ensureWorklets(ctx)
    const graph = new PatchGraph(ctx)
    const scope = graph.addModule('scope', 'sc')
    const instance = graph.getInstance(scope) as ScopeInstance
    instance.outputs.get('thru')!.connect(ctx.destination)

    const binHz = SR / instance.analyser.fftSize
    const bin = 189
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = bin * binHz
    osc.connect(instance.inputs.get('in') as AudioNode)
    osc.start()

    const readings = await pollAtFps(instance, ctx, 0.5)
    const settled = readings.slice(-5) // last ~80ms, well past the settle time measured for stc=0.15
    for (const db of settled) expect(Math.abs(db)).toBeLessThan(1)
  }, 20000)

  it('a known -80 dB tone settles near -80 dB and stays there -- no drift', async () => {
    const SR = 48000
    const ctx = new OfflineAudioContext(1, Math.ceil(SR * 2.1), SR)
    await ensureWorklets(ctx)
    const graph = new PatchGraph(ctx)
    const scope = graph.addModule('scope', 'sc')
    const instance = graph.getInstance(scope) as ScopeInstance
    instance.outputs.get('thru')!.connect(ctx.destination)

    const binHz = SR / instance.analyser.fftSize
    const fundBin = 189
    const aliasBin = 449
    const osc1 = ctx.createOscillator()
    osc1.type = 'sine'
    osc1.frequency.value = fundBin * binHz
    const osc2 = ctx.createOscillator()
    osc2.type = 'sine'
    osc2.frequency.value = aliasBin * binHz
    const g2 = ctx.createGain()
    g2.gain.value = Math.pow(10, -80 / 20)
    osc2.connect(g2)
    const input = instance.inputs.get('in') as AudioNode
    osc1.connect(input)
    g2.connect(input)
    osc1.start()
    osc2.start()

    const freqData = new Float32Array(instance.analyser.frequencyBinCount)
    const readings: { t: number; db: number }[] = []
    const dt = 1 / 60
    const times: number[] = []
    for (let t = dt; t <= 2.0; t += dt) times.push(t)
    for (const t of times) {
      ctx.suspend(t).then(() => {
        instance.analyser.getFloatFrequencyData(freqData)
        readings.push({ t, db: calibratedDb(freqData[aliasBin]!) })
        ctx.resume()
      })
    }
    await ctx.startRendering()

    // Settles (within the first half second) rather than merely "isn't
    // still 24 dB off": every reading from 0.5s onward stays within 1 dB
    // of the injected -80 dB, in both directions -- the old code drifted
    // monotonically further from truth (-84.7 -> -92.0 dB) over exactly
    // this same window.
    const settled = readings.filter((r) => r.t >= 0.5)
    expect(settled.length).toBeGreaterThan(30)
    for (const r of settled) expect(Math.abs(r.db - -80)).toBeLessThan(1)

    // And it isn't still drifting at the end: the last reading is no
    // further from truth than an early-settled one, confirming "settled"
    // rather than "coincidentally passing through -80 on its way past."
    const early = settled[0]!.db
    const late = settled[settled.length - 1]!.db
    expect(Math.abs(late - -80)).toBeLessThanOrEqual(Math.abs(early - -80) + 0.5)
  }, 20000)
})
