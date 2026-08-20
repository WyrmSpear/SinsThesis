import { describe, it, expect, beforeEach } from 'vitest'
import { renderGraph } from '../../../src/engine/render'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { vcoDescriptor } from '../../../src/engine/modules/vco'
import { svfDescriptor } from '../../../src/engine/modules/svf'
import { rms, peakHz, slopeDbPerOctave } from '../../../src/engine/analysis/features'

const SR = 48000

beforeEach(() => {
  clearRegistry()
  registerModule(vcoDescriptor)
  registerModule(svfDescriptor)
})

describe('SVF module', () => {
  it('produces sound on its lowpass output', async () => {
    const out = await renderGraph(0.4, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const svf = g.addModule('svf', 'svf')
      g.setParam(svf, 'cutoff', 2000)
      g.connect([osc, 'out'], [svf, 'in'])
      return [svf, 'lp']
    })
    expect(rms(out)).toBeGreaterThan(0.05)
  })

  it('all four outputs carry signal and genuinely differ from each other', async () => {
    // The whole point of this module over a mode switch: patch two outputs
    // at once and get two different signals, not the same one twice.
    const render = (port: 'lp' | 'bp' | 'hp' | 'notch') =>
      renderGraph(0.3, (_ctx, g) => {
        const osc = g.addModule('vco', 'osc')
        const svf = g.addModule('svf', 'svf')
        g.setParam(osc, 'tune', -24) // low saw, dense harmonics
        g.setParam(svf, 'cutoff', 1000)
        g.connect([osc, 'out'], [svf, 'in'])
        return [svf, port]
      })
    const [lp, bp, hp, notch] = await Promise.all([render('lp'), render('bp'), render('hp'), render('notch')])

    for (const out of [lp, bp, hp, notch]) expect(rms(out)).toBeGreaterThan(0.001)

    // A crude but decisive "these are not the same signal" check: sample
    // correlation would work too, but a simple sum-of-absolute-difference
    // against each other pair is enough to prove the four outputs diverge.
    function differs(a: Float32Array, b: Float32Array): boolean {
      let diff = 0
      for (let i = 0; i < a.length; i++) diff += Math.abs(a[i]! - b[i]!)
      return diff / a.length > 0.001
    }
    expect(differs(lp, bp)).toBe(true)
    expect(differs(lp, hp)).toBe(true)
    expect(differs(lp, notch)).toBe(true)
    expect(differs(bp, hp)).toBe(true)
    expect(differs(bp, notch)).toBe(true)
    expect(differs(hp, notch)).toBe(true)
  })

  it('bandpass output rejects both a low tone and a high tone relative to one at cutoff', async () => {
    const renderTone = (toneHz: number) =>
      renderGraph(0.3, (_ctx, g) => {
        const osc = g.addModule('vco', 'osc')
        const svf = g.addModule('svf', 'svf')
        // tune in semitones from A4 (440 Hz); pick the octave/semitone
        // offset that lands the fundamental at toneHz.
        g.setParam(osc, 'shape', 3) // sine, so there is exactly one tone to reject or pass
        g.setParam(osc, 'tune', 12 * Math.log2(toneHz / 440))
        g.setParam(svf, 'cutoff', 1000)
        g.setParam(svf, 'resonance', 0.6)
        g.connect([osc, 'out'], [svf, 'in'])
        return [svf, 'bp']
      })
    const [low, center, high] = await Promise.all([
      renderTone(110), // two octaves below cutoff
      renderTone(1000), // at cutoff
      renderTone(9000), // well above cutoff (avoids an integer sampleRate/f ratio)
    ])
    const settle = 2000
    const lowRms = rms(low.subarray(settle))
    const centerRms = rms(center.subarray(settle))
    const highRms = rms(high.subarray(settle))
    // Both rejected tones should sit well below the passed one -- this is
    // the property a mode-switched filter can show for one side but never
    // both at once, since a plain lowpass or highpass only rejects one side.
    expect(lowRms).toBeLessThan(centerRms * 0.5)
    expect(highRms).toBeLessThan(centerRms * 0.5)
  })

  it('two-pole rolloff: shallower than the ladder\'s four-pole slope', async () => {
    const out = await renderGraph(0.4, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const svf = g.addModule('svf', 'svf')
      g.setParam(osc, 'tune', -24) // low saw, dense harmonics
      g.setParam(svf, 'cutoff', 500)
      g.setParam(svf, 'resonance', 0)
      g.connect([osc, 'out'], [svf, 'in'])
      return [svf, 'lp']
    })
    // Measured 4x-8x above cutoff, same band vcf.test.ts uses for the
    // ladder, where this project has already documented that a wider band
    // averages a shallow knee against a steep near-Nyquist region into a
    // number that proves nothing (see this project's own trap #7).
    const slope = slopeDbPerOctave(out, SR, 2000, 4000)
    expect(slope).toBeLessThan(-8)
    expect(slope).toBeGreaterThan(-16) // clearly two-pole -- the ladder's own test asserts < -16 here
  })

  it('resonance raises the bandpass peak and tracks cutoff', async () => {
    const render = (resonance: number) =>
      renderGraph(0.3, (_ctx, g) => {
        const osc = g.addModule('vco', 'osc')
        const svf = g.addModule('svf', 'svf')
        g.setParam(osc, 'shape', 3)
        g.setParam(osc, 'tune', 12 * Math.log2(1000 / 440))
        g.setParam(svf, 'cutoff', 1000)
        g.setParam(svf, 'resonance', resonance)
        g.connect([osc, 'out'], [svf, 'in'])
        return [svf, 'bp']
      })
    const [flat, resonant] = await Promise.all([render(0), render(1)])
    expect(rms(resonant.subarray(2000))).toBeGreaterThan(rms(flat.subarray(2000)) * 2)
    expect(peakHz(resonant.subarray(2000), SR)).toBeCloseTo(1000, -2)
  })
})
