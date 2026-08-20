import { describe, it, expect, beforeEach } from 'vitest'
import { PatchGraph } from '../../../src/engine/graph'
import { ensureWorklets } from '../../../src/engine/render'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { clockDescriptor } from '../../../src/engine/modules/clock-module'
import { lfoDescriptor } from '../../../src/engine/modules/lfo'
import { vcoDescriptor } from '../../../src/engine/modules/vco'
import { vcfDescriptor } from '../../../src/engine/modules/vcf'
import { stepDuration } from '../../../src/engine/clock'
import { DIVISION_MULTIPLIERS } from '../../../src/engine/dsp/clock-sync'
import { rms, spectralCentroid } from '../../../src/engine/analysis/features'

const SR = 48000

beforeEach(() => {
  clearRegistry()
  registerModule(clockDescriptor)
  registerModule(lfoDescriptor)
  registerModule(vcoDescriptor)
  registerModule(vcfDescriptor)
})

/**
 * Average period of a sine-shape LFO's own zero crossings, sub-sample
 * accurate via linear interpolation between the bounding samples. Used
 * instead of `peakHz` (an FFT bin peak) because these rates are well under
 * 10 Hz: even an 8-second render's largest power-of-two FFT prefix has a
 * bin spacing around 0.18 Hz, multiple percent of the frequency itself --
 * coarse enough to swamp the sub-1% accuracy this suite is trying to
 * measure. Zero-crossing interpolation has no such floor; its precision is
 * limited by sample rate and interpolation error, not FFT resolution.
 */
function measuredPeriodSeconds(samples: Float32Array, sampleRate: number, skipSeconds: number): number {
  const skip = Math.max(1, Math.floor(skipSeconds * sampleRate))
  const crossings: number[] = []
  for (let i = skip; i < samples.length; i++) {
    const prev = samples[i - 1]!
    const cur = samples[i]!
    if (prev < 0 && cur >= 0) {
      const frac = -prev / (cur - prev)
      crossings.push((i - 1 + frac) / sampleRate)
    }
  }
  if (crossings.length < 2) return 0
  return (crossings[crossings.length - 1]! - crossings[0]!) / (crossings.length - 1)
}

async function renderClockedLfo(bpm: number, divisionIndex: number, seconds: number): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * SR), SR)
  await ensureWorklets(ctx)
  const graph = new PatchGraph(ctx)
  const clock = graph.addModule('clock', 'clk')
  const lfo = graph.addModule('lfo', 'lfo')
  graph.setParam(clock, 'bpm', bpm)
  graph.setParam(clock, 'division', 1) // one pulse per quarter note
  graph.setParam(lfo, 'shape', 3) // sine -- clean zero crossings
  graph.setParam(lfo, 'division', divisionIndex)
  graph.connect([clock, 'gate'], [lfo, 'sync'])

  const out = graph.getInstance(lfo)!.outputs.get('out')!
  out.connect(ctx.destination)

  const buffer = await ctx.startRendering()
  graph.dispose()
  return buffer.getChannelData(0)
}

// The quality bar: verify the locked rate actually matches the division
// against a real Clock module -> real LFO worklet, through a real cable,
// at several tempos spanning the genres this exists for.
describe('LFO clock-division lock: measured rate accuracy', () => {
  const CASES: Array<{ bpm: number; divisionIndex: number; label: string }> = [
    { bpm: 90, divisionIndex: 7, label: '1/4' },
    { bpm: 120, divisionIndex: 10, label: '1/8' },
    { bpm: 140, divisionIndex: 7, label: '1/4' }, // dubstep/trap/grime tempo
    { bpm: 140, divisionIndex: 12, label: '1/8.' }, // the classic dotted-eighth wobble feel
    { bpm: 174, divisionIndex: 4, label: '1/2' },
  ]

  for (const { bpm, divisionIndex, label } of CASES) {
    it(`${bpm} BPM, division ${label}: measured period matches the clock within 0.1%`, async () => {
      const quarterPeriod = stepDuration(bpm, 1)
      const expectedPeriod = quarterPeriod * DIVISION_MULTIPLIERS[divisionIndex]!
      // Render several expected cycles plus a settling margin, capped so
      // the suite stays fast; at least 4 seconds so even the slowest case
      // here (1/2 at 174 BPM, ~0.69s period) gets several cycles measured.
      const seconds = Math.max(4, expectedPeriod * 10)

      const out = await renderClockedLfo(bpm, divisionIndex, seconds)
      // Skip the first two quarter-note periods: lock acquires on the
      // second pulse (see dsp/clock-sync.ts), so this clears the
      // unlocked-Hz-rate prefix before the sine's own crossings are
      // measured.
      const measured = measuredPeriodSeconds(out, SR, quarterPeriod * 2.5)
      expect(measured).toBeGreaterThan(0)

      const errorPct = Math.abs(measured - expectedPeriod) / expectedPeriod * 100
      // eslint-disable-next-line no-console
      console.log(
        `${bpm} BPM / ${label}: expected ${expectedPeriod.toFixed(5)}s, `
        + `measured ${measured.toFixed(5)}s, error ${errorPct.toFixed(4)}%`,
      )
      // Measured across all five cases: 0.003-0.006%. 0.1% is a bound with
      // real margin above that, not the tightest number that happens to
      // pass -- an offline render has no jitter of its own, so this is
      // close to the arithmetic precision floor, not a claim that a live
      // context would measure the same.
      expect(errorPct).toBeLessThan(0.1)
    })
  }
})

describe('LFO clock-division lock: tempo change mid-note', () => {
  it('does not lurch -- worst single-sample delta stays in the smooth range, and the rate settles onto the new tempo', async () => {
    const beforeBpm = 120
    const afterBpm = 174
    const divisionIndex = 7 // 1/4 -- 1:1 with the clock's own pulse rate
    const switchAtSeconds = 3 // several pulses in, well past initial lock
    const totalSeconds = 8

    const ctx = new OfflineAudioContext(1, Math.ceil(totalSeconds * SR), SR)
    await ensureWorklets(ctx)
    const graph = new PatchGraph(ctx)
    const clock = graph.addModule('clock', 'clk')
    const lfo = graph.addModule('lfo', 'lfo')
    graph.setParam(clock, 'bpm', beforeBpm)
    graph.setParam(clock, 'division', 1)
    graph.setParam(lfo, 'shape', 3)
    graph.setParam(lfo, 'division', divisionIndex)
    graph.connect([clock, 'gate'], [lfo, 'sync'])
    const out = graph.getInstance(lfo)!.outputs.get('out')!
    out.connect(ctx.destination)

    ctx.suspend(switchAtSeconds).then(() => {
      graph.setParam(clock, 'bpm', afterBpm)
      void ctx.resume()
    }).catch(() => {})

    const buffer = await ctx.startRendering()
    graph.dispose()
    const samples = buffer.getChannelData(0)

    // No lurch: a phase-continuous oscillator changing rate produces no
    // discontinuity in the waveform itself (only the LFO module's own
    // hard-sync, which this mode deliberately does not fire on every
    // pulse -- see segment.worklet.ts -- would cause one). At depth 1 a
    // sine's own per-sample delta near its own zero crossing can reach
    // 2*pi*f/sampleRate; bound generously above that for the fastest rate
    // in play here (post-switch quarter note at 174 BPM = 2.9 Hz).
    let worstDelta = 0
    const switchSample = Math.round(switchAtSeconds * SR)
    const window = samples.subarray(switchSample - 100, switchSample + Math.round(0.3 * SR))
    for (let i = 1; i < window.length; i++) {
      worstDelta = Math.max(worstDelta, Math.abs(window[i]! - window[i - 1]!))
    }
    expect(worstDelta).toBeLessThan(0.01)

    // Settles onto the new tempo: measure the period from a window well
    // after the switch (past the ~8-pulse settling curve measured in
    // tests/node/dsp/clock-sync.test.ts) and compare to the new BPM's
    // quarter-note period.
    const tailStart = switchAtSeconds + stepDuration(afterBpm, 1) * 9
    const tail = samples.subarray(Math.round(tailStart * SR))
    const measured = measuredPeriodSeconds(tail, SR, 0)
    const expected = stepDuration(afterBpm, 1)
    const errorPct = Math.abs(measured - expected) / expected * 100
    expect(errorPct).toBeLessThan(2)
  })
})

describe('LFO clock-division lock: an actual wobble bass modulation', () => {
  it('a clock-locked LFO sweeping a filter cutoff audibly changes the tone over time, at the clock-derived rate', async () => {
    const bpm = 140
    const seconds = 4
    const ctx = new OfflineAudioContext(1, Math.ceil(seconds * SR), SR)
    await ensureWorklets(ctx)
    const graph = new PatchGraph(ctx)

    const clock = graph.addModule('clock', 'clk')
    const lfo = graph.addModule('lfo', 'lfo')
    const osc = graph.addModule('vco', 'osc')
    const vcf = graph.addModule('vcf', 'vcf')

    graph.setParam(clock, 'bpm', bpm)
    graph.setParam(clock, 'division', 1)
    graph.setParam(lfo, 'shape', 3)
    graph.setParam(lfo, 'division', 10) // 1/8 -- a fast, audible wobble
    graph.setParam(lfo, 'depth', 1)
    graph.setParam(osc, 'tune', -24) // low bass note, dense harmonics for the filter to carve
    graph.setParam(vcf, 'cutoff', 1500)
    graph.setParam(vcf, 'resonance', 0.3)
    graph.setParam(vcf, 'cutoffCvAmount', 5) // octaves of sweep from the LFO

    graph.connect([clock, 'gate'], [lfo, 'sync'])
    graph.connect([osc, 'out'], [vcf, 'in'])
    const lfoOut = graph.getInstance(lfo)!.outputs.get('out')! as AudioNode
    const cutoffCv = graph.getInstance(vcf)!.inputs.get('cutoffCv')! as AudioNode
    lfoOut.connect(cutoffCv)

    const out = graph.getInstance(vcf)!.outputs.get('out')!
    out.connect(ctx.destination)

    const buffer = await ctx.startRendering()
    graph.dispose()
    const samples = buffer.getChannelData(0)

    expect(rms(samples)).toBeGreaterThan(0.01) // makes sound at all

    // The filter sweeping should visibly change the tone's brightness
    // across a window: compare spectral centroid in consecutive quarter-
    // wobble-cycle-ish slices and confirm real variation, not a static tone.
    const sliceSamples = Math.round(0.2 * SR)
    const centroids: number[] = []
    for (let start = Math.round(1 * SR); start + sliceSamples <= samples.length; start += sliceSamples) {
      centroids.push(spectralCentroid(samples.subarray(start, start + sliceSamples), SR))
    }
    expect(centroids.length).toBeGreaterThan(4)
    const min = Math.min(...centroids)
    const max = Math.max(...centroids)
    // A static (unmodulated) filter would show only measurement noise
    // between slices; a real sweep at 1/8 note (140 BPM -> ~4.67 Hz, well
    // within one 0.2s slice) swings brightness by well more than that.
    expect(max / Math.max(min, 1)).toBeGreaterThan(1.3)
  })
})
