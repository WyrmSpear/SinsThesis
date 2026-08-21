import { describe, it, expect, beforeEach } from 'vitest'
import { renderGraph } from '../../../src/engine/render'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { compressorDescriptor } from '../../../src/engine/modules/compressor'
import { rms } from '../../../src/engine/analysis/features'
import type { PatchGraph } from '../../../src/engine/graph'

const SAMPLE_RATE = 48000
/** Read well past both scheduleParam's 8 ms ramp (B3) and the compressor's
 *  own release, so every measurement is of a settled state. */
const SETTLED_FROM = 24000 // 0.5 s

beforeEach(() => {
  clearRegistry()
  registerModule(compressorDescriptor)
})

const dbOf = (linear: number): number => 20 * Math.log10(Math.max(linear, 1e-12))

/**
 * The precise gain-law, knee and timing measurements live in
 * `tests/node/dsp/compressor.test.ts`, which drives `compressorSample`
 * directly. These are the integration counterparts: they prove the
 * descriptor's params and both of its jacks actually reach the worklet
 * through a real graph.
 *
 * DC in rather than a sine: a peak detector fed a sine sees a level that
 * oscillates with the waveform, which is correct but blurs a reading of the
 * static curve. The node suite covers the dynamic behaviour.
 */
function renderCompressor(
  inputDb: number,
  setup: (graph: PatchGraph, id: string) => void,
  opts: { keyDb?: number; port?: string } = {},
): Promise<Float32Array> {
  return renderGraph(1.0, (ctx, g) => {
    const comp = g.addModule('compressor', 'comp')

    const signal = ctx.createConstantSource()
    signal.offset.value = Math.pow(10, inputDb / 20)
    signal.start()
    signal.connect(g.getInstance(comp)!.inputs.get('in') as AudioNode)

    if (opts.keyDb !== undefined) {
      const key = ctx.createConstantSource()
      key.offset.value = Math.pow(10, opts.keyDb / 20)
      key.start()
      key.connect(g.getInstance(comp)!.inputs.get('key') as AudioNode)
    }

    setup(g, comp)
    return opts.port ? [comp, opts.port] : comp
  })
}

const settings = (over: Record<string, number> = {}) => (g: PatchGraph, id: string) => {
  const all = { threshold: -20, ratio: 4, attack: 1, release: 50, knee: 0, makeup: 0, keySource: 0, ...over }
  for (const [key, value] of Object.entries(all)) g.setParam(id, key, value)
}

/** Steady-state level of a DC render, in dB. */
const settledDb = (buf: Float32Array): number => dbOf(Math.abs(buf[buf.length - 1]!))

describe('Compressor (integration)', () => {
  it('follows the ratio law through a real graph', async () => {
    const rows: string[] = []
    for (const ratio of [2, 4, 8]) {
      const out = await renderCompressor(-10, settings({ ratio }))
      const measured = settledDb(out)
      const expected = -20 + (-10 - -20) / ratio
      rows.push(`${ratio}:1 -> ${measured.toFixed(2)} (want ${expected.toFixed(2)})`)
      expect(measured).toBeCloseTo(expected, 2)
    }
    // eslint-disable-next-line no-console
    console.log('compressor integration, -10 dB in: ' + rows.join('; '))
  })

  it('leaves a signal below the threshold alone', async () => {
    const out = await renderCompressor(-30, settings())
    // eslint-disable-next-line no-console
    console.log(`compressor integration below threshold: ${settledDb(out).toFixed(2)} dB (want -30)`)
    expect(settledDb(out)).toBeCloseTo(-30, 2)
  })

  it('applies makeup gain exactly', async () => {
    const [plain, boosted] = await Promise.all([
      renderCompressor(-10, settings({ makeup: 0 })),
      renderCompressor(-10, settings({ makeup: 12 })),
    ])
    const delta = settledDb(boosted) - settledDb(plain)
    // eslint-disable-next-line no-console
    console.log(`compressor integration makeup: +${delta.toFixed(3)} dB (want 12)`)
    expect(delta).toBeCloseTo(12, 3)
  })

  it('ducks from the Key jack when the switch says Ext, and ignores it when it says Int', async () => {
    // A quiet signal, far below threshold, keyed by a loud one. Self-keyed
    // it would be untouched -- which is exactly what the Int case asserts.
    const [ext, int] = await Promise.all([
      renderCompressor(-30, settings({ ratio: 8, keySource: 1 }), { keyDb: -3 }),
      renderCompressor(-30, settings({ ratio: 8, keySource: 0 }), { keyDb: -3 }),
    ])
    const expectedReduction = (1 / 8 - 1) * (-3 - -20)
    // eslint-disable-next-line no-console
    console.log(
      `compressor integration sidechain: Ext ${settledDb(ext).toFixed(2)} dB ` +
        `(want ${(-30 + expectedReduction).toFixed(2)}), Int ${settledDb(int).toFixed(2)} dB (want -30)`,
    )
    expect(settledDb(ext)).toBeCloseTo(-30 + expectedReduction, 2)
    expect(settledDb(int)).toBeCloseTo(-30, 2)
  })

  it('reports gain reduction on its GR jack, in dB', async () => {
    const out = await renderCompressor(-10, settings({ ratio: 4 }), { port: 'gr' })
    const reduction = out[out.length - 1]!
    const expected = (1 / 4 - 1) * (-10 - -20)
    // eslint-disable-next-line no-console
    console.log(`compressor GR jack: ${reduction.toFixed(3)} dB (want ${expected.toFixed(3)})`)
    expect(reduction).toBeCloseTo(expected, 2)
  })

  it('holds its GR jack at zero when nothing is being compressed', async () => {
    const out = await renderCompressor(-40, settings(), { port: 'gr' })
    // eslint-disable-next-line no-console
    console.log(`compressor GR jack, quiet input: ${out[out.length - 1]!.toExponential(2)} dB`)
    expect(Math.abs(out[out.length - 1]!)).toBeLessThan(0.01)
  })

  it('passes signal through untouched at ratio 1', async () => {
    const out = await renderCompressor(-6, settings({ ratio: 1 }))
    expect(settledDb(out)).toBeCloseTo(-6, 3)
  })

  it('keeps a loud programme bounded and finite', async () => {
    const out = await renderGraph(1.0, (ctx, g) => {
      const comp = g.addModule('compressor', 'comp')
      const frames = SAMPLE_RATE
      const buffer = ctx.createBuffer(1, frames, SAMPLE_RATE)
      const data = buffer.getChannelData(0)
      let seed = 8675309
      for (let i = 0; i < frames; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0
        data[i] = (seed / 0x100000000) * 2 - 1
      }
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.start()
      src.connect(g.getInstance(comp)!.inputs.get('in') as AudioNode)
      settings({ threshold: -40, ratio: 20, attack: 0.1, release: 10, makeup: 24 })(g, comp)
      return comp
    })
    let peak = 0
    for (const s of out) {
      expect(Number.isFinite(s)).toBe(true)
      peak = Math.max(peak, Math.abs(s))
    }
    // eslint-disable-next-line no-console
    console.log(
      `compressor integration extremes: peak ${peak.toFixed(3)}, rms ${rms(out.subarray(SETTLED_FROM)).toFixed(3)}`,
    )
    expect(peak).toBeLessThan(8)
  })
})
