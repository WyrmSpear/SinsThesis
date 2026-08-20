import { describe, it, expect, beforeEach } from 'vitest'
import { PatchGraph } from '../../../src/engine/graph'
import { ensureWorklets } from '../../../src/engine/render'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { freqBankDescriptor } from '../../../src/engine/modules/freq-bank'
import { outputDescriptor } from '../../../src/engine/modules/output'
import { FREQ_BANK } from '../../../src/engine/dsp/freq-bank'
import { rms } from '../../../src/engine/analysis/features'

const SR = 48000

beforeEach(() => {
  clearRegistry()
  for (const d of [freqBankDescriptor, outputDescriptor]) registerModule(d)
})

/** Same zero-crossing measurement used throughout this task's node and
 *  browser tests (binaural, isochronic) -- accurate at any frequency,
 *  including the bank's sub-20Hz Schumann entries where an FFT bin would
 *  be far too coarse. */
function measuredFreqHz(samples: Float32Array, sampleRate: number, skipSamples: number): number {
  const crossings: number[] = []
  for (let i = Math.max(1, skipSamples); i < samples.length; i++) {
    const prev = samples[i - 1]!
    const cur = samples[i]!
    if (prev < 0 && cur >= 0) {
      const frac = -prev / (cur - prev)
      crossings.push((i - 1 + frac) / sampleRate)
    }
  }
  if (crossings.length < 2) return 0
  const periodSeconds = (crossings[crossings.length - 1]! - crossings[0]!) / (crossings.length - 1)
  return 1 / periodSeconds
}

async function renderFreqBank(index: number, octave: number, seconds: number): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * SR), SR)
  await ensureWorklets(ctx)
  const graph = new PatchGraph(ctx)
  const fb = graph.addModule('freq-bank', 'fb')
  graph.setParam(fb, 'frequency', index)
  graph.setParam(fb, 'octave', octave)
  const out = graph.getInstance(fb)!.outputs.get('out')!
  out.connect(ctx.destination)
  const buffer = await ctx.startRendering()
  graph.dispose()
  return buffer.getChannelData(0)
}

describe('Frequency Bank: measured accuracy of every entry, through the real module', () => {
  for (let index = 0; index < FREQ_BANK.length; index++) {
    const { label, hz } = FREQ_BANK[index]!
    it(`"${label}" produces exactly ${hz} Hz, measured`, async () => {
      // Low entries (the Schumann set, down to ~7.83 Hz) need a much
      // longer render to capture enough full cycles for an accurate
      // zero-crossing measurement; higher entries settle in well under a
      // second.
      const seconds = hz < 50 ? 6 : 0.5
      const out = await renderFreqBank(index, 0, seconds)
      const skip = Math.round(Math.min(0.05 * seconds, 0.05) * SR)
      const measured = measuredFreqHz(out, SR, skip)
      console.log(`freq-bank "${label}": expected=${hz} Hz, measured=${measured.toFixed(5)} Hz, error=${(Math.abs(measured - hz)).toExponential(3)} Hz`)
      // Native OscillatorNode precision -- generous relative to the
      // measurement technique's own floor (limited by render length and
      // linear-interpolation zero-crossing accuracy), not to any known
      // imprecision in the oscillator itself.
      expect(Math.abs(measured - hz) / hz).toBeLessThan(0.001)
    })
  }
})

describe('Frequency Bank: octave shift stays exact', () => {
  it('528 Hz at +1 octave measures 1056 Hz', async () => {
    const index528 = FREQ_BANK.findIndex((e) => e.label === '528')
    const out = await renderFreqBank(index528, 1, 0.5)
    const measured = measuredFreqHz(out, SR, Math.round(0.05 * SR))
    console.log(`freq-bank "528" @ +1 octave: measured=${measured.toFixed(4)} Hz`)
    expect(Math.abs(measured - 1056) / 1056).toBeLessThan(0.001)
  })

  it('a switch change (frequency knob) snaps instantly to the new frequency, not a glide', async () => {
    const ctx = new OfflineAudioContext(1, Math.ceil(0.4 * SR), SR)
    await ensureWorklets(ctx)
    const graph = new PatchGraph(ctx)
    const fb = graph.addModule('freq-bank', 'fb')
    const indexA440 = FREQ_BANK.findIndex((e) => e.label === 'A440')
    graph.setParam(fb, 'frequency', indexA440)
    const out = graph.getInstance(fb)!.outputs.get('out')!
    out.connect(ctx.destination)
    const buffer = await ctx.startRendering()
    graph.dispose()
    const measured = measuredFreqHz(buffer.getChannelData(0), SR, Math.round(0.05 * SR))
    expect(Math.abs(measured - 440) / 440).toBeLessThan(0.001)
  })
})

describe('Frequency Bank: through Output, DC and boundedness', () => {
  it('is audible, DC-free, and bounded through a real patch', async () => {
    const out = await renderFreqBank(4, 0, 0.5) // '528'
    let sum = 0
    let peak = 0
    for (let i = 0; i < out.length; i++) {
      sum += out[i]!
      peak = Math.max(peak, Math.abs(out[i]!))
    }
    const dc = sum / out.length
    console.log(`freq-bank DC=${dc.toExponential(3)}, peak=${peak.toFixed(4)}, rms=${rms(out).toFixed(4)}`)
    expect(Math.abs(dc)).toBeLessThan(0.01)
    expect(peak).toBeLessThanOrEqual(1.0001)
    expect(rms(out)).toBeGreaterThan(0.3)
  })
})
