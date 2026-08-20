import { describe, it, expect, beforeEach } from 'vitest'
import { renderGraph } from '../../../src/engine/render'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { vcoDescriptor } from '../../../src/engine/modules/vco'
import { driveDescriptor } from '../../../src/engine/modules/drive'
import { rms, spectralCentroid } from '../../../src/engine/analysis/features'

const SR = 48000

beforeEach(() => {
  clearRegistry()
  registerModule(vcoDescriptor)
  registerModule(driveDescriptor)
})

describe('Drive module (real worklet)', () => {
  it('produces sound', async () => {
    const out = await renderGraph(0.4, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const drive = g.addModule('drive', 'drive')
      g.connect([osc, 'out'], [drive, 'in'])
      return drive
    })
    expect(rms(out)).toBeGreaterThan(0.05)
  })

  it('audibly changes a signal: high drive measurably brightens a tone versus low drive', async () => {
    const render = (driveAmount: number) => renderGraph(0.4, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const drive = g.addModule('drive', 'drive')
      g.setParam(osc, 'tune', -24) // a low, dense tone gives the curve real harmonics to add to
      g.setParam(drive, 'drive', driveAmount)
      g.connect([osc, 'out'], [drive, 'in'])
      return drive
    })
    const [low, high] = await Promise.all([render(0.5), render(15)])
    // Driving harder adds high-frequency harmonic content -- the spectral
    // centroid should rise measurably, the same signature the wavefolder's
    // own "adds harmonics as drive rises" test uses.
    expect(spectralCentroid(high, SR)).toBeGreaterThan(spectralCentroid(low, SR) * 1.5)
  })

  it('the two curves genuinely differ, not just in level', async () => {
    const render = (curve: 0 | 1) => renderGraph(0.4, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const drive = g.addModule('drive', 'drive')
      g.setParam(osc, 'tune', -12)
      g.setParam(drive, 'drive', 10)
      g.setParam(drive, 'curve', curve)
      g.connect([osc, 'out'], [drive, 'in'])
      return drive
    })
    const [soft, hard] = await Promise.all([render(0), render(1)])
    function differs(a: Float32Array, b: Float32Array): boolean {
      let diff = 0
      for (let i = 0; i < Math.min(a.length, b.length); i++) diff += Math.abs(a[i]! - b[i]!)
      return diff / a.length > 0.01
    }
    expect(differs(soft, hard)).toBe(true)
  })

  it('Tone measurably darkens the output at a low cutoff versus a high one', async () => {
    const render = (toneHz: number) => renderGraph(0.4, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const drive = g.addModule('drive', 'drive')
      g.setParam(osc, 'tune', -12)
      g.setParam(drive, 'drive', 8) // real harmonic content for Tone to remove
      g.setParam(drive, 'tone', toneHz)
      g.connect([osc, 'out'], [drive, 'in'])
      return drive
    })
    const [dark, bright] = await Promise.all([render(300), render(18000)])
    expect(spectralCentroid(dark, SR)).toBeLessThan(spectralCentroid(bright, SR) * 0.7)
  })

  it('Level scales output loudness', async () => {
    const render = (level: number) => renderGraph(0.4, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const drive = g.addModule('drive', 'drive')
      g.setParam(drive, 'level', level)
      g.connect([osc, 'out'], [drive, 'in'])
      return drive
    })
    const [half, full] = await Promise.all([render(0.5), render(1)])
    expect(rms(full)).toBeGreaterThan(rms(half) * 1.5)
  })

  it('driveCv modulates the drive amount: a constant CV plus a nonzero amount brightens the tone', async () => {
    const render = (cvAmount: number) => renderGraph(0.4, (ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const drive = g.addModule('drive', 'drive')
      g.setParam(osc, 'tune', -24)
      g.setParam(drive, 'drive', 0.5) // low base drive, so the CV's contribution dominates
      g.setParam(drive, 'driveCvAmount', cvAmount)
      g.connect([osc, 'out'], [drive, 'in'])
      const cvSource = ctx.createConstantSource()
      cvSource.offset.value = 1
      cvSource.start()
      cvSource.connect(g.getInstance(drive)!.inputs.get('driveCv') as AudioNode)
      return drive
    })
    const [unmodulated, modulated] = await Promise.all([render(0), render(8)])
    expect(spectralCentroid(modulated, SR)).toBeGreaterThan(spectralCentroid(unmodulated, SR) * 1.2)
  })
})
