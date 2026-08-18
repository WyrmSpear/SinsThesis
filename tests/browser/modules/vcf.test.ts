import { describe, it, expect, beforeEach } from 'vitest'
import { renderGraph } from '../../../src/engine/render'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { vcoDescriptor } from '../../../src/engine/modules/vco'
import { vcfDescriptor } from '../../../src/engine/modules/vcf'
import { wavefolderDescriptor } from '../../../src/engine/modules/wavefolder'
import { slopeDbPerOctave, peakHz, rms, spectralCentroid } from '../../../src/engine/analysis/features'

const SR = 48000

beforeEach(() => {
  clearRegistry()
  registerModule(vcoDescriptor)
  registerModule(vcfDescriptor)
  registerModule(wavefolderDescriptor)
})

describe('VCF module', () => {
  it('rolls off about -24 dB per octave above cutoff', async () => {
    const out = await renderGraph(0.4, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const vcf = g.addModule('vcf', 'vcf')
      g.setParam(osc, 'tune', -24) // low saw, dense harmonics
      g.setParam(vcf, 'cutoff', 500)
      g.setParam(vcf, 'resonance', 0)
      g.connect([osc, 'out'], [vcf, 'in'])
      return vcf
    })
    // Measured across 1000-8000 Hz (2x-16x cutoff), a wide band averages a
    // shallow near-knee region against a steep near-Nyquist one and lands in
    // range by cancellation rather than by measuring a four-pole asymptote:
    // the local slope ramps from about -18 dB/oct just above the knee to
    // about -68 dB/oct approaching Nyquist. Measuring 4x-8x cutoff instead
    // (2000-4000 Hz), same as the ladder DSP test at 1000 Hz cutoff, lands in
    // the asymptotic region where four poles actually holds.
    const slope = slopeDbPerOctave(out, SR, 2000, 4000)
    expect(slope).toBeLessThan(-16)
    expect(slope).toBeGreaterThan(-32)
  })

  it('self-oscillates at cutoff with no input patched', async () => {
    const out = await renderGraph(0.5, (_ctx, g) => {
      const vcf = g.addModule('vcf', 'vcf')
      g.setParam(vcf, 'cutoff', 800)
      g.setParam(vcf, 'resonance', 1)
      return vcf
    })
    const tail = out.subarray(out.length >> 1)
    expect(rms(tail)).toBeGreaterThan(0.005)
    expect(peakHz(tail, SR)).toBeCloseTo(800, -2)
  })
})

describe('Wavefolder module', () => {
  it('brightens the signal as drive rises', async () => {
    const render = (drive: number) =>
      renderGraph(0.3, (_ctx, g) => {
        const osc = g.addModule('vco', 'osc')
        const fold = g.addModule('wavefolder', 'fold')
        g.setParam(osc, 'shape', 3) // sine in, so every harmonic out comes from folding
        g.setParam(fold, 'drive', drive)
        g.connect([osc, 'out'], [fold, 'in'])
        return fold
      })
    const [plain, driven] = await Promise.all([render(1), render(6)])
    expect(spectralCentroid(driven, SR)).toBeGreaterThan(spectralCentroid(plain, SR) * 1.5)
  })
})
