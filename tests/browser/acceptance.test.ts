import { describe, it, expect, beforeEach } from 'vitest'
import { renderGraph, ensureWorklets } from '../../src/engine/render'
import { clearRegistry, listModules } from '../../src/engine/registry'
import { registerAllModules, ALL_DESCRIPTORS } from '../../src/engine/modules'
import { serializePatch, loadPatch } from '../../src/engine/patch'
import { PatchGraph } from '../../src/engine/graph'
import { peakHz, rms, slopeDbPerOctave, aliasFloorDb } from '../../src/engine/analysis/features'

const SR = 48000

beforeEach(() => {
  clearRegistry()
  registerAllModules()
})

describe('Phase 1 acceptance', () => {
  it('registers every module in the set', () => {
    expect(listModules()).toHaveLength(ALL_DESCRIPTORS.length)
    // Fifteen from Phase 1 plus Phase 2's scope.
    expect(ALL_DESCRIPTORS.length).toBe(16)
  })

  it('renders the classic voice: VCO into VCF into VCA into Output', async () => {
    const out = await renderGraph(0.4, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const vcf = g.addModule('vcf', 'vcf')
      const vca = g.addModule('vca', 'vca')
      const output = g.addModule('output', 'out')
      g.setParam(vcf, 'cutoff', 1200)
      g.connect([osc, 'out'], [vcf, 'in'])
      g.connect([vcf, 'out'], [vca, 'in'])
      g.connect([vca, 'out'], [output, 'in'])
      return output
    })
    expect(rms(out)).toBeGreaterThan(0.05)
    expect(peakHz(out, SR)).toBeCloseTo(440, -1)
  })

  it('proves the spec\'s four numeric claims', async () => {
    // Alias floor: 48000 / 440 = 109.09..., not near an integer, so
    // aliasing genuinely shows up as non-harmonic energy instead of folding
    // onto a harmonic and vanishing from the measurement (see aliasFloorDb's
    // doc comment). But a short, un-bin-aligned render also fails honestly:
    // the Blackman-Harris window's own sidelobe smears an off-bin fundamental
    // into neighboring bins and the metric reads that smear, not the
    // oscillator (this is documented at length in
    // tests/browser/modules/vco.test.ts, which measures -143.7 dB with this
    // same technique). Nudge the tuning by a fraction of a cent so the
    // fundamental lands exactly on an FFT bin for this render length, the
    // same fix used there.
    const N = 65536
    const binSpacing = SR / N
    const alignedHz = Math.round(440 / binSpacing) * binSpacing
    const tune = 12 * Math.log2(alignedHz / 440)
    const osc = await renderGraph(N / SR, (_ctx, g) => {
      const id = g.addModule('vco', 'osc')
      g.setParam(id, 'tune', tune)
      return id
    })
    // The oscillator is now a band-limited mipmapped wavetable, which
    // measures around -143 dB here -- far below the old PolyBLEP
    // oscillator's -60 dB bar. Assert the reality (<= -120 dB, a healthy
    // margin below the measured figure for render jitter) rather than the
    // stale number.
    expect(aliasFloorDb(osc, SR, peakHz(osc, SR))).toBeLessThanOrEqual(-120)

    const tuned = await renderGraph(0.3, (_ctx, g) => g.addModule('vco', 'osc'))
    expect(peakHz(tuned, SR)).toBeCloseTo(440, -1)

    // Filter slope: measure in a band four to eight times the cutoff, where
    // the ladder's response is genuinely in its asymptotic rolloff rather
    // than averaging a shallow near-cutoff knee against a steep near-Nyquist
    // region (which is what a 2x-16x band does).
    const filtered = await renderGraph(0.4, (_ctx, g) => {
      const o = g.addModule('vco', 'osc')
      const f = g.addModule('vcf', 'vcf')
      g.setParam(o, 'tune', -24)
      g.setParam(f, 'cutoff', 500)
      g.connect([o, 'out'], [f, 'in'])
      return f
    })
    expect(slopeDbPerOctave(filtered, SR, 2000, 4000)).toBeLessThan(-16)

    const ringing = await renderGraph(0.5, (_ctx, g) => {
      const f = g.addModule('vcf', 'vcf')
      g.setParam(f, 'cutoff', 800)
      g.setParam(f, 'resonance', 1)
      return f
    })
    expect(peakHz(ringing.subarray(ringing.length >> 1), SR)).toBeCloseTo(800, -2)
  })

  it('round-trips a saved patch through the file format', async () => {
    const ctx = new OfflineAudioContext(1, 128, SR)
    await ensureWorklets(ctx)
    const graph = new PatchGraph(ctx)
    const osc = graph.addModule('vco', 'osc')
    const vcf = graph.addModule('vcf', 'vcf')
    graph.setParam(vcf, 'cutoff', 1234)
    graph.connect([osc, 'out'], [vcf, 'in'])

    const file = serializePatch(graph, { name: 'Acceptance' })
    const { graph: restored, ghosts } = loadPatch(ctx, file)
    expect(ghosts).toEqual([])
    expect(restored.getParams('vcf').cutoff).toBe(1234)
    expect(restored.cables).toHaveLength(1)
  })
})
