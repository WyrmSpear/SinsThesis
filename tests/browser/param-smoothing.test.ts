import { describe, it, expect, beforeEach } from 'vitest'
import { PatchGraph } from '../../src/engine/graph'
import { ensureWorklets } from '../../src/engine/render'
import { registerModule, clearRegistry } from '../../src/engine/registry'
import { vcoDescriptor } from '../../src/engine/modules/vco'
import { vcaDescriptor } from '../../src/engine/modules/vca'

/**
 * B3's own click test: spec acceptance criterion 3 ("turn knobs and hear
 * the change without clicks or zipper noise") demands one, and none
 * existed. `renderGraph` (src/engine/render.ts) can't express "mid-render"
 * on its own -- an `OfflineAudioContext` doesn't run on wall-clock time, so
 * a plain callback fired during graph setup lands at t=0 regardless of any
 * requested delay (the same limitation tests/browser/modules/vcf.test.ts's
 * "self-oscillates when resonance is raised..." test documents). What
 * genuinely reaches a nonzero point in an offline render's own timeline is
 * `ctx.suspend(time)`: it pauses rendering there, with `ctx.currentTime`
 * legitimately equal to that time, runs a callback, then resumes -- which
 * is exactly what a live knob turn partway through playback needs, and
 * exactly what `scheduleParam`'s "no atTime" branch (param-smoothing.ts)
 * reads `ctx.currentTime` from.
 */

const SR = 48000

beforeEach(() => {
  clearRegistry()
  registerModule(vcoDescriptor)
  registerModule(vcaDescriptor)
})

/**
 * Builds osc -> vca -> (returned buffer), turns the VCA's level knob from
 * 0.2 to 1.0 partway through a 0.4 s render, and returns the rendered
 * buffer. `applyChange` decides how that turn reaches the AudioParam:
 * the current, fixed `graph.setParam` (smoothed), or a direct `.value =`
 * write on the same node reaching around it (the pre-B3 behavior, for
 * comparison -- nothing in the shipped code writes `.value` directly
 * anymore, so this is how "before" gets measured honestly rather than
 * asserted from memory).
 */
async function renderWithMidRenderLevelChange(
  applyChange: (graph: PatchGraph, vcaId: string, newLevel: number) => void,
): Promise<{ out: Float32Array; switchSample: number }> {
  const seconds = 0.4
  const suspendAt = 0.2
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * SR), SR)
  await ensureWorklets(ctx)

  const graph = new PatchGraph(ctx)
  const osc = graph.addModule('vco', 'osc')
  const vca = graph.addModule('vca', 'vca')
  graph.setParam(osc, 'tune', -12) // 220 Hz, comfortably below any mip concern
  graph.setParam(osc, 'shape', 3) // sine: smooth, no wrap discontinuity of its own
  graph.setParam(vca, 'level', 0.2)
  graph.connect([osc, 'out'], [vca, 'in'])

  const out = graph.getInstance(vca)!.outputs.get('out')!
  out.connect(ctx.destination)

  ctx.suspend(suspendAt).then(() => {
    applyChange(graph, vca, 1.0)
    void ctx.resume()
  }).catch(() => {})

  const buffer = await ctx.startRendering()
  return { out: buffer.getChannelData(0), switchSample: Math.round(suspendAt * SR) }
}

function worstDelta(samples: Float32Array): number {
  let worst = 0
  for (let i = 1; i < samples.length; i++) {
    worst = Math.max(worst, Math.abs(samples[i]! - samples[i - 1]!))
  }
  return worst
}

// A window around the mid-render switch, not the whole buffer: the render's
// own first ~40 ms already has a (harmless, ordinary) transient of its own
// -- the sine ramping up from phase 0 while the VCA's initial 1 -> 0.2
// default-then-explicit setParam sequence is still settling -- and that
// transient's own worst delta (measured: ~0.057, larger than the smoothed
// switch itself) has nothing to do with the mid-render knob turn this test
// is about. Starting 100 samples before the switch and running 100 ms past
// it covers the full setTargetAtTime ramp (>10 time constants) while
// staying well clear of that unrelated startup transient.
function windowAroundSwitch(samples: Float32Array, switchSample: number): Float32Array {
  return samples.subarray(switchSample - 100, switchSample + Math.round(0.1 * SR))
}

describe('param smoothing (B3)', () => {
  it('a live knob turn (no atTime) produces no discontinuity above the stated threshold', async () => {
    const { out, switchSample } = await renderWithMidRenderLevelChange((graph, vca, level) => {
      graph.setParam(vca, 'level', level) // no atTime: the ordinary, smoothed path
    })
    // Measured worst single-sample delta around the switch: 0.029 fixed,
    // versus 0.775 for the identical jump applied as a direct .value=
    // write (see the sibling test below) -- about a 27x (28.6 dB)
    // reduction for this particular jump size (level 0.2 -> 1.0). 0.05 is
    // a bound with real margin above the measured 0.029, comfortably
    // below anything read as a click.
    expect(worstDelta(windowAroundSwitch(out, switchSample))).toBeLessThan(0.05)
  })

  it('proves the test can fail: a direct .value= write (the pre-B3 behavior) blows past the threshold', async () => {
    const { out, switchSample } = await renderWithMidRenderLevelChange((graph, vcaId, level) => {
      // Reaches around scheduleParam entirely, the same way every native
      // module's setParam used to, to measure what B3 actually fixed.
      const vcaNode = graph.getInstance(vcaId)!.inputs.get('in') as GainNode
      vcaNode.gain.value = level
    })
    expect(worstDelta(windowAroundSwitch(out, switchSample))).toBeGreaterThan(0.3)
  })
})
