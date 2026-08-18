import { describe, it, expect, beforeEach } from 'vitest'
import { PatchGraph } from '../../src/engine/graph'
import { ensureWorklets } from '../../src/engine/render'
import { registerModule, clearRegistry } from '../../src/engine/registry'
import { vcoDescriptor } from '../../src/engine/modules/vco'
import { vcaDescriptor } from '../../src/engine/modules/vca'
import { vcfDescriptor } from '../../src/engine/modules/vcf'
import { createLadderState, ladderSample } from '../../src/engine/dsp/ladder'

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
 * Final review Finding 2 moved the VCF's cutoff, resonance and drive, and
 * the VCO's tune and pulseWidth, from k-rate to a-rate: at k-rate a worklet
 * reads `params.foo![0]` once per 128-sample render quantum, so even a real,
 * continuous `setTargetAtTime`/ramp automation on the AudioParam only ever
 * reached the DSP as a staircase of block-sized steps.
 *
 * The click test written alongside that change (now `VCF cutoff a-rate: a
 * case where it provably does not matter`, below) measured a worst
 * single-sample delta of 0.0843 for a saw through the ladder, cutoff swept
 * 1000 -> 2000 Hz over 0.4 s -- identical to four decimal places whether
 * cutoff was read a-rate or k-rate -- and concluded from that one case that
 * the ladder's IIR recursion generally absorbs block-quantized coefficient
 * changes, so a-rate mattered only formally. **That conclusion does not
 * generalize and was audited and reversed.** It is true only for that
 * specific slow, narrow glide. A wide, fast sweep at high resonance, and
 * continuous PWM, both show a-rate is measurably necessary -- exactly the
 * LFO-to-cutoff and PWM patches a player builds, and exactly what a
 * mouse-dragged knob produces once there is a UI. The two tests below
 * replace the misleading generalization with cases that actually
 * discriminate a-rate from k-rate, each verified by temporarily reverting
 * the relevant `automationRate` back to `'k-rate'`, rebuilding the worklet
 * bundle, and confirming the assertion below fails (numbers recorded in each
 * test's own comment, and in
 * `.superpowers/sdd/2026-08-18-phase1a-engine/a-rate-test-report.md`).
 *
 * Why the two tests below use different metrics: a plain "worst
 * consecutive-sample delta of the rendered output" -- the metric the
 * original (misleading) test used -- turns out not to discriminate for the
 * VCF at all, in any configuration measured (fast/slow sweeps, resonance
 * 0 to 1, single ramps and repeating LFO modulation): the filter's own
 * transient response to *any* cutoff change dominates that metric
 * regardless of how finely the coefficient is read, exactly as the original
 * test found, just true far more broadly than it claimed. What *does*
 * discriminate is comparing the worklet's actual output against an
 * independently computed reference that uses the exact, continuous,
 * per-sample cutoff curve (see the VCF test below) -- i.e. does the filter
 * track the automation curve it was actually given, not just "is there an
 * audible click". For the VCO's pulseWidth, by contrast, the plain
 * consecutive-sample-delta metric discriminates directly and dramatically
 * (0.65 a-rate vs 1.97 k-rate, see the PWM test below) because `pulseWidth`
 * sets the read *position* in the pulse waveform's table
 * (`pulseSample`'s `wrap01(t - w)` in dsp/wavetable.ts), and a stale,
 * block-held `w` can put that read on the wrong side of the underlying
 * saw table's own sharp discontinuity for up to 127 samples -- a real,
 * audible glitch, not just a differently-shaped transient.
 *
 * `tune` also moved to a-rate but is not covered by a dedicated
 * discriminating test here: unlike `cutoff`/`pulseWidth`, `tune` only sets
 * the oscillator's phase *increment* (`dt` in vco.worklet.ts's `process`) --
 * an integrator input, not a value read directly into the output sample --
 * so a block-quantized `tune` only staircases the *rate* of phase advance, a
 * smooth (if very slightly wrong) FM rather than a value-domain
 * discontinuity. Measured separately (6 Hz vibrato, +-2 semitones): worst
 * delta 0.0029, essentially noise. `tune` stays a-rate anyway because it is
 * nearly free once the same worklet's `pulseWidth` already forces a
 * per-sample param read loop -- not because it fixes an audible problem of
 * its own.
 */
describe('VCF cutoff a-rate: a case where it provably does not matter (slow glide)', () => {
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

  it('a slow (1000->2000 Hz over 0.4s) cutoff glide produces no discontinuity above the stated threshold, and this is true regardless of a-rate/k-rate -- see the module doc comment above; this is a documented boundary, not evidence the fix is unnecessary', async () => {
    const { out, switchSample } = await renderWithMidRenderCutoffChange()
    // Measured worst single-sample delta: 0.0843, identical whether cutoff
    // is read a-rate (shipped) or k-rate (temporarily reverted and
    // rebuilt to check). 0.15 leaves real margin above the measured figure.
    expect(worstDelta(windowAroundSwitch(out, switchSample))).toBeLessThan(0.15)
  })
})

describe('VCF cutoff a-rate: fast sweep at high resonance discriminates a-rate from k-rate', () => {
  /** Value of a linear ramp from (t0, v0) to (t1, v1) at time t, held flat
   *  outside [t0, t1] -- matches how `setValueAtTime` +
   *  `linearRampToValueAtTime` actually behaves on the real AudioParam. */
  function rampValueAt(t: number, t0: number, v0: number, t1: number, v1: number): number {
    if (t <= t0) return v0
    if (t >= t1) return v1
    return v0 + (v1 - v0) * ((t - t0) / (t1 - t0))
  }

  function worstAbsDiff(a: Float32Array, b: Float32Array): number {
    let worst = 0
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!))
    return worst
  }

  it('tracks an independently-computed continuous-coefficient reference through a 200->8000 Hz sweep in 5ms at resonance 0.99', async () => {
    // A plain "worst consecutive-sample delta of the output" does not
    // discriminate a-rate from k-rate for this filter (see the module doc
    // comment above) -- measured identical (0.431) under both. What does
    // discriminate: whether the worklet's actual output tracks the exact,
    // continuous cutoff curve it was scheduled with, computed independently
    // here via the same pure `ladderSample` the worklet calls internally,
    // driven by a known sine (not the VCO, to keep the reference exact and
    // simple) and the identical cutoff/resonance schedule applied directly
    // to the real AudioParams (bypassing scheduleParam's resonance ramp, so
    // the reference's constant resonance matches exactly).
    const seconds = 0.15
    const t0 = 0.05
    const t1 = t0 + 0.005
    const cutoffLo = 200
    const cutoffHi = 8000
    const resonance = 0.99
    const freq = 220 // 48000/220 is not near-integer -- safe per project convention

    const N = Math.ceil(seconds * SR)
    const sine = new Float32Array(N)
    for (let i = 0; i < N; i++) sine[i] = Math.sin((2 * Math.PI * freq * i) / SR) * 0.8

    const refState = createLadderState()
    const reference = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      const cutoff = rampValueAt(i / SR, t0, cutoffLo, t1, cutoffHi)
      reference[i] = ladderSample(refState, sine[i]!, cutoff, resonance, SR)
    }

    const ctx = new OfflineAudioContext(1, N, SR)
    await ensureWorklets(ctx)
    const graph = new PatchGraph(ctx)
    const vcf = graph.addModule('vcf', 'vcf')
    const vcfNode = graph.getInstance(vcf)!.outputs.get('out') as AudioWorkletNode

    const srcBuffer = ctx.createBuffer(1, N, SR)
    srcBuffer.copyToChannel(sine, 0)
    const src = ctx.createBufferSource()
    src.buffer = srcBuffer
    const audioIn = graph.getInstance(vcf)!.inputs.get('in') as AudioNode
    src.connect(audioIn)
    src.start(0)

    vcfNode.parameters.get('resonance')!.setValueAtTime(resonance, 0)
    vcfNode.parameters.get('cutoff')!.setValueAtTime(cutoffLo, 0)
    vcfNode.parameters.get('cutoff')!.setValueAtTime(cutoffLo, t0)
    vcfNode.parameters.get('cutoff')!.linearRampToValueAtTime(cutoffHi, t1)

    const out = graph.getInstance(vcf)!.outputs.get('out')!
    out.connect(ctx.destination)

    const buffer = await ctx.startRendering()
    const actual = buffer.getChannelData(0)

    // Measured worst deviation from the reference: 0.0000658 (float32
    // rounding noise) with cutoff a-rate as shipped, 0.6506 -- about 9900x
    // larger -- with cutoff temporarily reverted to k-rate and the worklet
    // bundle rebuilt. 0.05 sits comfortably above the a-rate noise floor and
    // more than 10x below the k-rate failure.
    expect(worstAbsDiff(actual, reference)).toBeLessThan(0.05)
  })
})

describe('VCO pulseWidth a-rate: continuous PWM discriminates a-rate from k-rate', () => {
  it('an 8 Hz PWM sweep (pulseWidth 0.2-0.8) produces no discontinuity above the stated threshold', async () => {
    const seconds = 0.3
    const ctx = new OfflineAudioContext(1, Math.ceil(seconds * SR), SR)
    await ensureWorklets(ctx)

    const graph = new PatchGraph(ctx)
    const osc = graph.addModule('vco', 'osc')
    graph.setParam(osc, 'tune', -12) // 220 Hz: 48000/220 is not near-integer
    graph.setParam(osc, 'shape', 1) // pulse
    const out = graph.getInstance(osc)!.outputs.get('out')!
    out.connect(ctx.destination)

    // Continuous PWM the way a patch actually produces it: an LFO connected
    // straight to the AudioParam, not a scripted step -- pulseWidth's
    // default (0.5) is the param's own intrinsic value, so the connected
    // signal simply adds to it, giving 0.5 +- 0.3 = 0.2..0.8.
    const vcoNode = out as AudioWorkletNode
    const pwParam = vcoNode.parameters.get('pulseWidth')!
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 8
    lfo.type = 'sine'
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = 0.3
    lfo.connect(lfoGain)
    lfoGain.connect(pwParam)
    lfo.start(0)

    const buffer = await ctx.startRendering()
    const data = buffer.getChannelData(0)

    // Measured worst single-sample delta: 0.649 with pulseWidth a-rate as
    // shipped, 1.975 -- essentially full scale, out of a max possible 2.0 --
    // with pulseWidth temporarily reverted to k-rate and the worklet bundle
    // rebuilt. 1.0 sits with real margin on both sides.
    expect(worstDelta(data.subarray(10))).toBeLessThan(1.0)
  })
})
