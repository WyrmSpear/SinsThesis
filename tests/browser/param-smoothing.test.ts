import { describe, it, expect, beforeEach } from 'vitest'
import { PatchGraph } from '../../src/engine/graph'
import { ensureWorklets } from '../../src/engine/render'
import { registerModule, clearRegistry } from '../../src/engine/registry'
import { vcoDescriptor } from '../../src/engine/modules/vco'
import { vcaDescriptor } from '../../src/engine/modules/vca'
import { vcfDescriptor } from '../../src/engine/modules/vcf'

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
  registerModule(vcfDescriptor)
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
// `ctx.suspend(t)` actually pauses at the start of whichever 128-sample
// render quantum contains `t`, not at `t` itself -- so the switch's real
// sample index is always a multiple of 128, and it's that index's phase
// against the 220 Hz (osc tune -12) oscillator that matters, not the
// continuous-time target. 0.2s happens to be sample 9600 = 75*128, an
// exact 44.0-cycle point -- a zero crossing, sine's steepest slope, where
// even a small phase offset swings the sampled value a lot. That mattered
// as of Finding 2 (final review): tune moved to a-rate, so the oscillator's
// own setTargetAtTime startup glide from 0 to -12 semitones is now
// integrated per-sample instead of once per 128-sample block, which shifts
// the total accumulated phase by a small but real, permanent amount (not a
// decaying transient) -- enough to move this test's own measured numbers
// for reasons that have nothing to do with what it's testing (the VCA's
// level jump). Sample 9216 = 72*128 = 0.192s lands at 220*0.192 = 42.24
// cycles instead, 0.24 of a cycle past the last zero crossing -- close to
// a quarter cycle (a peak, sine's flattest point, first-order insensitive
// to phase offset) -- so the switch point is robust to exactly how the
// oscillator's setup transient is read.
const SUSPEND_AT = 9216 / SR

async function renderWithMidRenderLevelChange(
  applyChange: (graph: PatchGraph, vcaId: string, newLevel: number) => void,
): Promise<{ out: Float32Array; switchSample: number }> {
  const seconds = 0.4
  const suspendAt = SUSPEND_AT
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
    // versus 0.783 for the identical jump applied as a direct .value=
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

/**
 * Final review Finding 2: B3's own click test above measures a `GainNode.gain`,
 * which is a-rate by construction -- it never exercised the actual defect,
 * which lives in worklet params. Every worklet param in this project declared
 * `automationRate: 'k-rate'` and was read once per 128-sample render quantum
 * as `params.foo![0]`, so even though `scheduleParam` (param-smoothing.ts)
 * was already handing the AudioParam a real, continuous `setTargetAtTime`
 * ramp, the worklet itself only ever saw that ramp's value at each block's
 * first sample -- a staircase of block-sized steps standing in for a glide.
 * With `PARAM_SMOOTH_TIME_CONSTANT = 0.008`, a k-rate param moves
 * `1 - e^(-128/48000/0.008)` = 28.4% of the jump in the first block alone --
 * about 11 dB better than snapping outright, not the 28.6 dB the GainNode
 * test demonstrates.
 *
 * The five params most exposed to this -- read continuously during a note
 * rather than at note-on -- are the VCF's cutoff, resonance and drive, and
 * the VCO's pulseWidth and tune; all five were moved to a-rate. This test
 * covers the VCF's cutoff, the param a player is most likely to sweep live.
 *
 * Honest result, not the dramatic before/after B3's own test shows: for a
 * saw (220 Hz) through the ladder, cutoff swept 1000 Hz -> 2000 Hz (a
 * realistic knob turn) with no atTime, the worst single-sample delta around
 * the mid-render switch measures 0.0843 -- identical to four decimal places
 * whether cutoff is read a-rate (shipped) or k-rate (reproduced by
 * temporarily reverting ladder.worklet.ts's cutoff to k-rate for this
 * measurement). Confirmed not a measurement bug: instrumenting the worklet
 * directly shows `params.cutoff!.length` genuinely alternating between 1
 * (steady) and 128 (mid-ramp) as a-rate should, and reverting to k-rate
 * genuinely changes the worklet's compiled bundle (verified with a
 * deliberately wrong multiplier, which does move this test's numbers).
 * The reason a-rate vs k-rate doesn't show up here: unlike a `GainNode`,
 * where output[n] = input[n] * gain[n] so a stale gain read directly steps
 * the output, the ladder is a stateful IIR recursion -- its output at any
 * sample already depends on its own previous output, so a block-quantized
 * coefficient change doesn't inject a discontinuity, only a (harmless)
 * change in the filter's forward trajectory; the filter's own transient
 * response to *any* cutoff change dominates the worst-sample-delta metric
 * regardless of how finely the coefficient itself is read. (`drive`, which
 * scales the input before the recursion and so looked like the multiply
 * case, shows the same non-result for the same reason: the multiplied
 * value still only reaches the output through the stateful recursion.)
 * a-rate is still the correct fix -- it matches how every other a-rate
 * param in Web Audio is meant to be read, removes a real block-quantization
 * error confirmed present on the AudioParam's own values, and this test
 * still stands as the regression guard Finding 2 asks for: it fails loudly
 * if a future change reintroduces an actual output-level discontinuity.
 */
describe('VCF cutoff a-rate click test (Finding 2)', () => {
  async function renderWithMidRenderCutoffChange(): Promise<{ out: Float32Array; switchSample: number }> {
    const seconds = 0.4
    const suspendAt = 0.2
    const ctx = new OfflineAudioContext(1, Math.ceil(seconds * SR), SR)
    await ensureWorklets(ctx)

    const graph = new PatchGraph(ctx)
    const osc = graph.addModule('vco', 'osc')
    const vcf = graph.addModule('vcf', 'vcf')
    graph.setParam(osc, 'tune', -12) // 220 Hz saw: dense harmonics for the filter to act on
    graph.setParam(vcf, 'cutoff', 1000)
    graph.setParam(vcf, 'resonance', 0)
    graph.connect([osc, 'out'], [vcf, 'in'])

    const out = graph.getInstance(vcf)!.outputs.get('out')!
    out.connect(ctx.destination)

    ctx.suspend(suspendAt).then(() => {
      graph.setParam(vcf, 'cutoff', 2000) // no atTime: the ordinary, smoothed path
      void ctx.resume()
    }).catch(() => {})

    const buffer = await ctx.startRendering()
    return { out: buffer.getChannelData(0), switchSample: Math.round(suspendAt * SR) }
  }

  it('a live cutoff sweep produces no discontinuity above the stated threshold', async () => {
    const { out, switchSample } = await renderWithMidRenderCutoffChange()
    // Measured worst single-sample delta: 0.0843 (see the doc comment above
    // for why this doesn't move between a-rate and k-rate for this DSP).
    // 0.15 leaves real margin above the measured figure.
    expect(worstDelta(windowAroundSwitch(out, switchSample))).toBeLessThan(0.15)
  })
})
