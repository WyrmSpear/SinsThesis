import { describe, it, expect, beforeEach } from 'vitest'
import { PatchGraph } from '../../../src/engine/graph'
import { ensureWorklets } from '../../../src/engine/render'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { isochronicDescriptor } from '../../../src/engine/modules/isochronic'
import { outputDescriptor } from '../../../src/engine/modules/output'
import { clockDescriptor } from '../../../src/engine/modules/clock-module'
import { stepDuration } from '../../../src/engine/clock'
import { DIVISION_MULTIPLIERS } from '../../../src/engine/dsp/clock-sync'
import { rms } from '../../../src/engine/analysis/features'

const SR = 48000

beforeEach(() => {
  clearRegistry()
  for (const d of [isochronicDescriptor, outputDescriptor, clockDescriptor]) registerModule(d)
})

async function renderMono(
  seconds: number,
  build: (ctx: OfflineAudioContext, graph: PatchGraph) => string | [string, string],
): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * SR), SR)
  await ensureWorklets(ctx)
  const graph = new PatchGraph(ctx)
  const result = build(ctx, graph)
  const [id, port] = typeof result === 'string' ? [result, 'out'] : result
  const out = graph.getInstance(id)!.outputs.get(port)!
  out.connect(ctx.destination)
  const buffer = await ctx.startRendering()
  graph.dispose()
  return buffer.getChannelData(0)
}

/** Gate on-edges found from the rendered audio itself: an edge is where the
 *  envelope crosses upward through half its steady-state amplitude. Works
 *  without knowing the carrier's own phase because it looks at the
 *  amplitude envelope (a short RMS window), not the raw waveform. */
function envelopeOnEdges(samples: Float32Array, sampleRate: number, windowMs: number): number[] {
  const windowSamples = Math.max(1, Math.round((windowMs / 1000) * sampleRate))
  const env: number[] = []
  for (let start = 0; start + windowSamples <= samples.length; start += windowSamples) {
    let sumSq = 0
    for (let i = start; i < start + windowSamples; i++) sumSq += samples[i]! * samples[i]!
    env.push(Math.sqrt(sumSq / windowSamples))
  }
  const peak = Math.max(...env)
  const threshold = peak * 0.5
  const edges: number[] = []
  for (let i = 1; i < env.length; i++) {
    if (env[i - 1]! < threshold && env[i]! >= threshold) {
      edges.push((i * windowSamples) / sampleRate)
    }
  }
  return edges
}

describe('Isochronic: through the real worklet', () => {
  it('gates a carrier at the requested rate, measured from the real rendered envelope', async () => {
    const rateHz = 6
    const out = await renderMono(3, (_ctx, g) => {
      const iso = g.addModule('isochronic', 'iso')
      g.setParam(iso, 'carrier', 300)
      g.setParam(iso, 'rate', rateHz)
      g.setParam(iso, 'duty', 0.5)
      g.setParam(iso, 'edge', 5)
      return iso
    })
    const edges = envelopeOnEdges(out, SR, 2)
    const periods: number[] = []
    for (let i = 2; i < edges.length; i++) periods.push(edges[i]! - edges[i - 1]!) // skip first cycle (settling)
    const meanPeriod = periods.reduce((a, b) => a + b, 0) / periods.length
    const measuredHz = 1 / meanPeriod
    console.log(`isochronic worklet gate rate=${rateHz}: measured=${measuredHz.toFixed(4)} Hz over ${periods.length} cycles`)
    expect(measuredHz).toBeCloseTo(rateHz, 1)
  })

  it('measured full-output worst-case adjacent-sample discontinuity clears a sane bar through the real worklet, not just the pure DSP model', async () => {
    const out = await renderMono(2, (_ctx, g) => {
      const iso = g.addModule('isochronic', 'iso')
      g.setParam(iso, 'carrier', 197.3) // non-commensurate with the rate, see dsp test's own reasoning
      g.setParam(iso, 'rate', 8.1)
      g.setParam(iso, 'duty', 0.5)
      g.setParam(iso, 'edge', 8)
      return iso
    })
    let worst = 0
    for (let i = 1; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i]! - out[i - 1]!))
    console.log(`isochronic worklet full output: worst adjacent-sample delta = ${worst.toFixed(6)}`)
    expect(worst).toBeLessThan(0.05)
  })

  it('a duty knob change genuinely changes the fraction of each cycle spent open', async () => {
    const measure = async (duty: number): Promise<number> => {
      const out = await renderMono(2, (_ctx, g) => {
        const iso = g.addModule('isochronic', 'iso')
        g.setParam(iso, 'carrier', 300)
        g.setParam(iso, 'rate', 10)
        g.setParam(iso, 'duty', duty)
        g.setParam(iso, 'edge', 2)
        return iso
      })
      const settled = out.subarray(Math.floor(out.length * 0.2))
      const windowSamples = Math.round(0.001 * SR)
      let onWindows = 0
      let totalWindows = 0
      const peak = Math.max(...Array.from(settled).map(Math.abs))
      for (let start = 0; start + windowSamples <= settled.length; start += windowSamples) {
        let sumSq = 0
        for (let i = start; i < start + windowSamples; i++) sumSq += settled[i]! * settled[i]!
        const localRms = Math.sqrt(sumSq / windowSamples)
        if (localRms > peak * 0.35) onWindows++
        totalWindows++
      }
      return onWindows / totalWindows
    }
    const lowDuty = await measure(0.15)
    const highDuty = await measure(0.85)
    console.log(`isochronic duty knob: measured on-fraction at duty=0.15 -> ${lowDuty.toFixed(3)}, duty=0.85 -> ${highDuty.toFixed(3)}`)
    expect(highDuty).toBeGreaterThan(lowDuty)
  })
})

describe('Isochronic: clock-sync locks the gate rate to a division', () => {
  it('a quarter note at 120 BPM measures 0.5s, driven by a real Clock module', async () => {
    const bpm = 120
    const divisionIndex = 7 // '1/4' -- see dsp/clock-sync.ts's DIVISION_LABELS
    const out = await renderMono(4, (_ctx, g) => {
      const clock = g.addModule('clock', 'clk')
      const iso = g.addModule('isochronic', 'iso')
      g.setParam(clock, 'bpm', bpm)
      g.setParam(clock, 'division', 1)
      g.setParam(iso, 'carrier', 300)
      g.setParam(iso, 'division', divisionIndex)
      g.setParam(iso, 'duty', 0.5)
      g.setParam(iso, 'edge', 5)
      g.connect([clock, 'gate'], [iso, 'sync'])
      return iso
    })
    const expectedPeriod = stepDuration(bpm, 1) * DIVISION_MULTIPLIERS[divisionIndex]!
    const edges = envelopeOnEdges(out, SR, 2)
    // Before lock (acquired on the clock's second pulse, at one quarter-note
    // period in), the gate free-runs at its own default `rate` knob (8 Hz,
    // a much shorter period), so the raw edge list starts with several
    // free-running cycles before settling onto the locked division. Only
    // keep consecutive gaps close to the expected locked period, rather
    // than a fixed "skip N edges" count that has to know how many
    // free-running cycles preceded lock.
    const allPeriods: number[] = []
    for (let i = 1; i < edges.length; i++) allPeriods.push(edges[i]! - edges[i - 1]!)
    const lockedPeriods = allPeriods.filter((p) => Math.abs(p - expectedPeriod) / expectedPeriod < 0.2)
    console.log(`isochronic clock-sync: all gaps=${allPeriods.map((p) => p.toFixed(3)).join(',')}; locked gaps=${lockedPeriods.map((p) => p.toFixed(3)).join(',')}`)
    expect(lockedPeriods.length).toBeGreaterThan(2) // genuinely settled onto the division, not a fluke
    const measuredPeriod = lockedPeriods.reduce((a, b) => a + b, 0) / lockedPeriods.length
    console.log(`isochronic clock-locked '1/4' @ ${bpm}BPM: expected=${expectedPeriod}s measured=${measuredPeriod.toFixed(4)}s`)
    expect(Math.abs(measuredPeriod - expectedPeriod)).toBeLessThan(0.02)
  })
})

describe('Isochronic: through Output', () => {
  it('is audible end to end', async () => {
    const out = await renderMono(0.5, (_ctx, g) => {
      const iso = g.addModule('isochronic', 'iso')
      const output = g.addModule('output', 'out')
      g.connect([iso, 'out'], [output, 'in'])
      return output
    })
    expect(rms(out)).toBeGreaterThan(0.05)
  })
})
