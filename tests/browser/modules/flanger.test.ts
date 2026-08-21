import { describe, it, expect, beforeEach } from 'vitest'
import { renderGraph } from '../../../src/engine/render'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { flangerDescriptor } from '../../../src/engine/modules/flanger'
import { db } from '../../../src/engine/analysis/features'
import type { PatchGraph } from '../../../src/engine/graph'

const SAMPLE_RATE = 48000
/** Fire the impulse well past scheduleParam's 8 ms ramp (B3), so every knob
 *  has settled before the measurement starts. */
const IMPULSE_AT = 9600 // 0.2 s
const IR_LENGTH = 32768

beforeEach(() => {
  clearRegistry()
  registerModule(flangerDescriptor)
})

/**
 * The precise DSP measurements live in `tests/node/dsp/flanger.test.ts`,
 * which drives `flangerSample` directly. These are the integration
 * counterparts: they prove the descriptor's params actually reach the
 * worklet through a real graph, and -- for the feedback case -- that a real
 * browser's AudioWorklet genuinely escapes the render-quantum-in-a-cycle
 * behaviour that a native DelayNode flanger cannot (see dsp/flanger.ts).
 *
 * With `depth: 0` the module is linear and time-invariant, so an impulse
 * response is its exact transfer function -- deterministic, with none of the
 * variance a noise-driven measurement carries.
 */
function impulseResponse(setup: (graph: PatchGraph, id: string) => void): Promise<Float32Array> {
  return renderGraph(1.0, (ctx, g) => {
    const fl = g.addModule('flanger', 'fl')
    const buffer = ctx.createBuffer(1, SAMPLE_RATE, SAMPLE_RATE)
    buffer.getChannelData(0)[IMPULSE_AT] = 1
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.start()
    source.connect(g.getInstance(fl)!.inputs.get('in') as AudioNode)
    setup(g, fl)
    return fl
  }).then((out) => new Float32Array(out.subarray(IMPULSE_AT, IMPULSE_AT + IR_LENGTH)))
}

/** |H(f)| at an exact frequency by direct DFT, so a notch is probed where it
 *  actually is rather than at the nearest FFT bin. */
function magAt(ir: Float32Array, hz: number): number {
  let re = 0
  let im = 0
  for (let n = 0; n < ir.length; n++) {
    const v = ir[n]!
    if (v === 0) continue
    const w = (-2 * Math.PI * hz * n) / SAMPLE_RATE
    re += v * Math.cos(w)
    im += v * Math.sin(w)
  }
  return Math.hypot(re, im)
}

const notchHz = (d: number, k: number): number => (2 * k + 1) / (2 * d)
const peakHz = (d: number, k: number): number => k / d

const staticComb = (manual: number, feedback = 0, mix = 0.5) => (g: PatchGraph, id: string) => {
  g.setParam(id, 'manual', manual)
  g.setParam(id, 'depth', 0)
  g.setParam(id, 'rate', 0.1)
  g.setParam(id, 'feedback', feedback)
  g.setParam(id, 'mix', mix)
}

describe('Flanger (integration)', () => {
  it('combs at the frequencies its Manual knob predicts, through a real graph', async () => {
    const d = 0.001
    const ir = await impulseResponse(staticComb(d))
    const peak = (magAt(ir, peakHz(d, 1)) + magAt(ir, peakHz(d, 2))) / 2
    const depths = [0, 1, 2].map((k) => db(magAt(ir, notchHz(d, k)) / peak))

    // eslint-disable-next-line no-console
    console.log(
      'flanger integration @1ms: ' +
        [0, 1, 2].map((k, i) => `${notchHz(d, k)}Hz ${depths[i]!.toFixed(1)}dB`).join(', '),
    )
    for (const dep of depths) expect(dep).toBeLessThan(-40)
  })

  it('moves those notches in inverse proportion when Manual changes', async () => {
    const d = 0.002 // notches at 250, 750; 500 becomes a peak
    const ir = await impulseResponse(staticComb(d))
    const at500 = magAt(ir, 500)
    // eslint-disable-next-line no-console
    console.log(
      `flanger integration @2ms: 250Hz ${db(magAt(ir, 250) / at500).toFixed(1)}dB, ` +
        `750Hz ${db(magAt(ir, 750) / at500).toFixed(1)}dB`,
    )
    expect(db(magAt(ir, 250) / at500)).toBeLessThan(-40)
    expect(db(magAt(ir, 750) / at500)).toBeLessThan(-40)
  })

  /**
   * The end-to-end guard on the reason this module is a worklet. A native
   * DelayNode flanger measured 250-280 Hz resonance spacing here where the
   * delay predicts 1000, because Web Audio inserts a render quantum into
   * any graph cycle. Running the delay line inside the worklet escapes
   * that, and the equal-and-opposite tilt below is only possible if it did.
   */
  it('resonates on its own comb in a real browser, so the sign of Feedback means something', async () => {
    const d = 0.001
    const [pos, neg] = await Promise.all([
      impulseResponse(staticComb(d, 0.8, 1)),
      impulseResponse(staticComb(d, -0.8, 1)),
    ])
    const posTilt = db(magAt(pos, 1000) / magAt(pos, 500))
    const negTilt = db(magAt(neg, 1000) / magAt(neg, 500))
    // eslint-disable-next-line no-console
    console.log(`flanger integration feedback: +0.8 ${posTilt.toFixed(1)} dB, -0.8 ${negTilt.toFixed(1)} dB`)

    expect(posTilt).toBeGreaterThan(15)
    expect(negTilt).toBeLessThan(-15)
    // Equal and opposite to within a dB -- the symmetry the quantum destroys.
    expect(Math.abs(posTilt + negTilt)).toBeLessThan(2)
  })

  it('passes the input untouched at mix 0, even with feedback up', async () => {
    const ir = await impulseResponse(staticComb(0.001, 0.5, 0))
    expect(ir[0]).toBeCloseTo(1, 4)
    let tail = 0
    for (let n = 1; n < 4000; n++) tail = Math.max(tail, Math.abs(ir[n]!))
    // eslint-disable-next-line no-console
    console.log(`flanger integration mix=0: impulse ${ir[0]!.toFixed(5)}, largest tail ${tail.toExponential(2)}`)
    expect(tail).toBeLessThan(1e-4)
  })
})
