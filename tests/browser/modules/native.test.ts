import { describe, it, expect, beforeEach } from 'vitest'
import { renderGraph } from '../../../src/engine/render'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { noiseDescriptor } from '../../../src/engine/modules/noise'
import { vcaDescriptor } from '../../../src/engine/modules/vca'
import { mixerDescriptor } from '../../../src/engine/modules/mixer'
import { multipleDescriptor } from '../../../src/engine/modules/multiple'
import { delayDescriptor } from '../../../src/engine/modules/delay'
import { outputDescriptor } from '../../../src/engine/modules/output'
import { vcoDescriptor } from '../../../src/engine/modules/vco'
import { rms, rmsEnvelope } from '../../../src/engine/analysis/features'

beforeEach(() => {
  clearRegistry()
  for (const d of [
    noiseDescriptor, vcaDescriptor, mixerDescriptor,
    multipleDescriptor, delayDescriptor, outputDescriptor, vcoDescriptor,
  ]) registerModule(d)
})

describe('native modules', () => {
  it('Noise produces broadband signal', async () => {
    const out = await renderGraph(0.2, (_ctx, g) => g.addModule('noise', 'n'))
    expect(rms(out)).toBeGreaterThan(0.1)
  })

  it('VCA at zero level silences its input', async () => {
    const out = await renderGraph(0.2, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const vca = g.addModule('vca', 'vca')
      g.setParam(vca, 'level', 0)
      g.connect([osc, 'out'], [vca, 'in'])
      return vca
    })
    // B3: level is a continuous param, so setParam now ramps it down via
    // setTargetAtTime (8 ms time constant) instead of snapping to 0 at
    // sample 0 -- the fix this whole file is otherwise unaware of. That
    // ramp asymptotically approaches but never exactly reaches 0, and it
    // starts from full level (the VCA's own default), so the render's
    // first ~100 ms (well over 10 time constants) carries real, decaying
    // signal that used to not exist. Measuring the whole buffer for
    // near-silence -- which is what this test asserted before B3 -- would
    // now be asserting the old snapping behavior, so it measures the
    // settled tail instead, same as this project's other ramp-aware tests
    // (e.g. ladder.test.ts's DC-offset tests skip their own settling
    // time). 120 ms in is >15 time constants (e^-15 ~ 3e-7), comfortably
    // past the ramp.
    const settled = out.subarray(Math.floor(out.length * 0.6))
    expect(rms(settled)).toBeLessThan(1e-5)
  })

  it('VCA passes its input at full level', async () => {
    const out = await renderGraph(0.2, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const vca = g.addModule('vca', 'vca')
      g.setParam(vca, 'level', 1)
      g.connect([osc, 'out'], [vca, 'in'])
      return vca
    })
    expect(rms(out)).toBeGreaterThan(0.3)
  })

  it('Mixer sums two inputs louder than one', async () => {
    const build = (both: boolean) =>
      renderGraph(0.2, (_ctx, g) => {
        const a = g.addModule('vco', 'a')
        const b = g.addModule('vco', 'b')
        const mix = g.addModule('mixer', 'mix')
        g.setParam(b, 'tune', 7)
        g.connect([a, 'out'], [mix, 'in1'])
        if (both) g.connect([b, 'out'], [mix, 'in2'])
        return mix
      })
    const [one, two] = await Promise.all([build(false), build(true)])
    expect(rms(two)).toBeGreaterThan(rms(one) * 1.2)
  })

  it('Multiple copies its input to every output', async () => {
    const out = await renderGraph(0.2, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const mult = g.addModule('multiple', 'mult')
      const mix = g.addModule('mixer', 'mix')
      g.connect([osc, 'out'], [mult, 'in'])
      g.connect([mult, 'out1'], [mix, 'in1'])
      g.connect([mult, 'out2'], [mix, 'in2'])
      return mix
    })
    expect(rms(out)).toBeGreaterThan(0.3)
  })

  it('Delay produces audible repeats after the dry signal stops', async () => {
    const out = await renderGraph(1.0, (ctx, g) => {
      const noise = g.addModule('noise', 'n')
      const vca = g.addModule('vca', 'vca')
      const delay = g.addModule('delay', 'd')
      g.setParam(vca, 'level', 0)
      g.setParam(vca, 'cvAmount', 1)
      g.setParam(delay, 'time', 0.25)
      g.setParam(delay, 'feedback', 0.6)
      g.setParam(delay, 'mix', 1)
      // A 50 ms burst at the start, then silence.
      const burst = ctx.createConstantSource()
      burst.offset.setValueAtTime(1, 0)
      burst.offset.setValueAtTime(0, 0.05)
      burst.start()
      burst.connect(g.getInstance(vca)!.inputs.get('cv') as AudioNode)
      g.connect([noise, 'out'], [vca, 'in'])
      g.connect([vca, 'out'], [delay, 'in'])
      return delay
    })
    const env = rmsEnvelope(out, 4800) // 100 ms windows
    // Window 0 holds the burst; window 2 or 3 should hold its first repeat.
    expect(Math.max(env[2]!, env[3]!)).toBeGreaterThan(0.01)
  })

  it('Output attenuates according to its level', async () => {
    const at = (level: number) =>
      renderGraph(0.2, (_ctx, g) => {
        const osc = g.addModule('vco', 'osc')
        const out = g.addModule('output', 'out')
        g.setParam(out, 'level', level)
        g.connect([osc, 'out'], [out, 'in'])
        return out
      })
    const [quiet, loud] = await Promise.all([at(0.25), at(1)])
    expect(rms(loud)).toBeGreaterThan(rms(quiet) * 2)
  })
})
