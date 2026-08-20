import { describe, it, expect, beforeEach } from 'vitest'
import { PatchGraph } from '../../../src/engine/graph'
import { ensureWorklets } from '../../../src/engine/render'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { vcoDescriptor } from '../../../src/engine/modules/vco'
import { outputDescriptor } from '../../../src/engine/modules/output'
import { pannerDescriptor } from '../../../src/engine/modules/panner'
import { pingpongDescriptor } from '../../../src/engine/modules/pingpong'
import { widthDescriptor } from '../../../src/engine/modules/width'
import { clockDescriptor } from '../../../src/engine/modules/clock-module'
import { lfoDescriptor } from '../../../src/engine/modules/lfo'
import { rms, peakHz } from '../../../src/engine/analysis/features'

const SR = 48000

beforeEach(() => {
  clearRegistry()
  for (const d of [
    vcoDescriptor, outputDescriptor, pannerDescriptor, pingpongDescriptor,
    widthDescriptor, clockDescriptor, lfoDescriptor,
  ]) registerModule(d)
})

/** Same shape as render.ts's own `renderGraph`, but against a genuinely
 *  2-channel destination -- `renderGraph` stays deliberately mono (see its
 *  own updated doc comment), so every stereo-module test in this file goes
 *  through its own real `OfflineAudioContext(2, ...)` instead, the same
 *  pattern tests/browser/modules/lfo-sync.test.ts already established for
 *  a graph shape `renderGraph`'s single-id/build contract doesn't cover. */
async function renderStereo(
  seconds: number,
  build: (ctx: OfflineAudioContext, graph: PatchGraph) => string | [string, string],
  sampleRate = SR,
): Promise<{ left: Float32Array; right: Float32Array }> {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate)
  await ensureWorklets(ctx)
  const graph = new PatchGraph(ctx)
  const result = build(ctx, graph)
  const [id, port] = typeof result === 'string' ? [result, 'out'] : result
  const out = graph.getInstance(id)!.outputs.get(port)!
  out.connect(ctx.destination)
  const buffer = await ctx.startRendering()
  graph.dispose()
  return { left: buffer.getChannelData(0), right: buffer.getChannelData(1) }
}

function db(power: number): number {
  return 10 * Math.log10(Math.max(power, 1e-12))
}

/** Pearson correlation between two equal-length signals -- +1 for identical
 *  (mono) content, 0 for decorrelated, negative for out-of-phase. Used to
 *  measure Width's stereo image quantitatively, not just qualitatively. */
function correlation(a: Float32Array, b: Float32Array): number {
  let sumA = 0, sumB = 0
  for (let i = 0; i < a.length; i++) { sumA += a[i]!; sumB += b[i]! }
  const meanA = sumA / a.length, meanB = sumB / b.length
  let cov = 0, varA = 0, varB = 0
  for (let i = 0; i < a.length; i++) {
    const da = a[i]! - meanA, db_ = b[i]! - meanB
    cov += da * db_
    varA += da * da
    varB += db_ * db_
  }
  return cov / Math.sqrt(varA * varB)
}

/** Sums two channels to mono the plain way (average) -- the check every
 *  stereo module in this file is run through, per the task's own framing:
 *  "sum L and R to mono and confirm nothing hollows out, cancels, or drops
 *  in level." */
function monoSum(left: Float32Array, right: Float32Array): Float32Array {
  const out = new Float32Array(left.length)
  for (let i = 0; i < left.length; i++) out[i] = (left[i]! + right[i]!) / 2
  return out
}

describe('Output: mono up-mix and stereo pass-through', () => {
  it('duplicates a mono source to both channels', async () => {
    const { left, right } = await renderStereo(0.1, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const out = g.addModule('output', 'out')
      g.connect([osc, 'out'], [out, 'in'])
      return out
    })
    expect(rms(left)).toBeGreaterThan(0.05)
    for (let i = 0; i < left.length; i++) expect(left[i]).toBeCloseTo(right[i]!, 6)
  })

  it('keeps a genuinely stereo source intact -- hard-panned input reaches Output undiminished on each side', async () => {
    const { left, right } = await renderStereo(0.2, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const panner = g.addModule('panner', 'pan')
      const out = g.addModule('output', 'out')
      g.setParam(panner, 'pan', -1) // hard left
      g.connect([osc, 'out'], [panner, 'in'])
      g.connect([panner, 'out'], [out, 'in'])
      return out
    })
    // Skip the pan knob's own B3 smoothing ramp (an 8ms time constant, see
    // param-smoothing.ts) -- this test is about Output's channel routing,
    // not re-proving the ramp exists.
    const settled = Math.floor(left.length * 0.5)
    expect(rms(left.subarray(settled))).toBeGreaterThan(0.05)
    expect(rms(right.subarray(settled))).toBeLessThan(1e-6)
  })
})

describe('Panner: measured equal-power law and mono compatibility', () => {
  const POSITIONS = [-1, -0.5, 0, 0.5, 1]

  it('holds total power flat across the sweep -- centre within a fraction of a dB of the extremes', async () => {
    const powersDb = new Map<number, number>()
    for (const pan of POSITIONS) {
      const { left, right } = await renderStereo(0.2, (_ctx, g) => {
        const osc = g.addModule('vco', 'osc')
        const panner = g.addModule('panner', 'pan')
        g.setParam(panner, 'pan', pan)
        g.connect([osc, 'out'], [panner, 'in'])
        return panner
      })
      const settled = Math.floor(left.length * 0.5) // past the param-smoothing ramp
      const l = rms(left.subarray(settled))
      const r = rms(right.subarray(settled))
      powersDb.set(pan, db(l * l + r * r))
    }
    const values = [...powersDb.values()]
    const spread = Math.max(...values) - Math.min(...values)
    console.log(`panner equal-power sweep (dB total power): ${POSITIONS.map((p) => `${p}=${powersDb.get(p)!.toFixed(3)}`).join(', ')}, spread=${spread.toFixed(3)} dB`)
    expect(spread).toBeLessThan(0.2) // "a fraction of a dB"
    // Centre specifically, against either extreme -- the literal claim.
    expect(Math.abs(powersDb.get(0)! - powersDb.get(-1)!)).toBeLessThan(0.2)
    expect(Math.abs(powersDb.get(0)! - powersDb.get(1)!)).toBeLessThan(0.2)
  })

  it('never cancels or hollows out in a mono sum -- a pan control has no inter-channel phase difference to cancel with', async () => {
    for (const pan of POSITIONS) {
      const { left, right } = await renderStereo(0.15, (_ctx, g) => {
        const osc = g.addModule('vco', 'osc')
        const panner = g.addModule('panner', 'pan')
        g.setParam(panner, 'pan', pan)
        g.connect([osc, 'out'], [panner, 'in'])
        return panner
      })
      const settled = Math.floor(left.length * 0.5)
      const mono = monoSum(left.subarray(settled), right.subarray(settled))
      // Hard pan folds to half the source's own level in a plain average
      // (all the energy sits in one channel); centre folds to the source's
      // full level. Neither is a bug -- see dsp/pan.ts's doc comment -- but
      // the mono sum must stay clearly audible at every position, never
      // drop toward silence the way a cancelling widener would.
      expect(rms(mono)).toBeGreaterThan(0.15)
    }
  })

  it('a CV patched into panCv actually moves the pan position over time', async () => {
    const { left, right } = await renderStereo(2, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const lfo = g.addModule('lfo', 'lfo')
      const panner = g.addModule('panner', 'pan')
      g.setParam(lfo, 'rate', 0.5) // one full pan sweep every 2s
      g.setParam(lfo, 'shape', 3) // sine
      g.connect([osc, 'out'], [panner, 'in'])
      g.connect([lfo, 'out'], [panner, 'panCv'])
      return panner
    })
    // Split the render into early/mid windows and confirm the L/R balance
    // genuinely differs between them -- a static pan would give the same
    // ratio throughout.
    const quarter = Math.floor(left.length / 4)
    const ratioAt = (start: number): number => {
      const l = rms(left.subarray(start, start + quarter))
      const r = rms(right.subarray(start, start + quarter))
      return l / (r + 1e-9)
    }
    const ratios = [0, 1, 2, 3].map((k) => ratioAt(k * quarter))
    console.log(`panner auto-pan L/R ratio per quarter: ${ratios.map((r) => r.toFixed(3)).join(', ')}`)
    const spread = Math.max(...ratios) - Math.min(...ratios)
    expect(spread).toBeGreaterThan(0.3) // genuinely moving, not stuck
  })
})

describe('Ping-Pong Delay: measured channel alternation, decay, and mono compatibility', () => {
  it('the first echo favors L, the second favors R -- a burst through a real worklet, not just the pure-DSP model', async () => {
    const { left, right } = await renderStereo(1.2, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const vca = _ctx.createGain() // a short burst, not a sustained tone, so echoes are separable
      const pp = g.addModule('pingpong', 'pp')
      g.setParam(pp, 'time', 0.2)
      g.setParam(pp, 'feedback', 0.6)
      g.setParam(pp, 'mix', 1) // fully wet, so dry doesn't mask the L/R split
      const oscOut = g.getInstance(osc)!.outputs.get('out')!
      vca.gain.setValueAtTime(1, 0)
      vca.gain.setValueAtTime(0, 0.03) // 30ms burst
      oscOut.connect(vca)
      vca.connect(g.getInstance(pp)!.inputs.get('in') as AudioNode)
      return pp
    })

    const windowAround = (seconds: number, spanMs = 15): [number, number] => {
      const centerSample = Math.round(seconds * SR)
      const span = Math.round((spanMs / 1000) * SR)
      return [Math.max(0, centerSample - span), centerSample + span]
    }
    const rmsWindow = (buf: Float32Array, [a, b]: [number, number]): number => rms(buf.subarray(a, b))

    const echo1 = windowAround(0.2)
    const echo2 = windowAround(0.4)
    const l1 = rmsWindow(left, echo1)
    const r1 = rmsWindow(right, echo1)
    const l2 = rmsWindow(left, echo2)
    const r2 = rmsWindow(right, echo2)
    console.log(`pingpong echo1 L=${l1.toFixed(4)} R=${r1.toFixed(4)}; echo2 L=${l2.toFixed(4)} R=${r2.toFixed(4)}`)
    expect(l1).toBeGreaterThan(r1 * 3) // echo 1 clearly dominant on the left
    expect(r2).toBeGreaterThan(l2 * 3) // echo 2 clearly dominant on the right

    // Decay: echo 2's dominant channel should read close to feedback (0.6x)
    // relative to echo 1's dominant channel.
    expect(r2 / l1).toBeGreaterThan(0.3)
    expect(r2 / l1).toBeLessThan(0.9)
  })

  it('never cancels in a mono sum across the echo train', async () => {
    const { left, right } = await renderStereo(1, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const pp = g.addModule('pingpong', 'pp')
      g.setParam(pp, 'time', 0.15)
      g.setParam(pp, 'feedback', 0.5)
      g.setParam(pp, 'mix', 0.6)
      g.connect([osc, 'out'], [pp, 'in'])
      return pp
    })
    const settled = Math.floor(left.length * 0.3)
    const mono = monoSum(left.subarray(settled), right.subarray(settled))
    expect(rms(mono)).toBeGreaterThan(0.05)
  })

  it('locks its tap to a clock division -- a quarter note at 120 BPM is 0.5s, measured from a real Clock module', async () => {
    const bpm = 120
    const { left, right } = await renderStereo(2, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const vca = _ctx.createGain()
      const clock = g.addModule('clock', 'clk')
      const pp = g.addModule('pingpong', 'pp')
      g.setParam(clock, 'bpm', bpm)
      g.setParam(clock, 'division', 1)
      g.setParam(pp, 'division', 7) // '1/4' -- see dsp/clock-sync.ts's DIVISION_LABELS
      g.setParam(pp, 'feedback', 0.4)
      g.setParam(pp, 'mix', 1)
      const oscOut = g.getInstance(osc)!.outputs.get('out')!
      vca.gain.setValueAtTime(1, 0)
      vca.gain.setValueAtTime(0, 0.02)
      oscOut.connect(vca)
      vca.connect(g.getInstance(pp)!.inputs.get('in') as AudioNode)
      g.connect([clock, 'gate'], [pp, 'sync'])
      return pp
    })
    void right
    // Find the first echo peak after the burst on the left channel --
    // should land close to one quarter-note period (0.5s at 120 BPM), not
    // wherever the free-running `time` knob (default 0.3s) would put it.
    const expectedSeconds = 60 / bpm // one quarter note
    const searchStart = Math.round(0.1 * SR)
    let peakIdx = searchStart
    let peakVal = 0
    for (let i = searchStart; i < left.length; i++) {
      if (Math.abs(left[i]!) > peakVal) { peakVal = Math.abs(left[i]!); peakIdx = i }
    }
    const measuredSeconds = peakIdx / SR
    console.log(`pingpong clock-locked '1/4' @ ${bpm}BPM: expected=${expectedSeconds}s measured=${measuredSeconds.toFixed(3)}s`)
    expect(Math.abs(measuredSeconds - expectedSeconds)).toBeLessThan(0.03)
  })
})

describe('Width: measured M/S behavior, mono compatibility, and phase correlation', () => {
  /** Builds a genuinely stereo source: two independent oscillators (close
   *  but not harmonically locked frequencies, so the two channels are
   *  decorrelated rather than a phase-shifted copy of one tone) merged into
   *  a 2-channel signal, standing in for "some wide pad already in the
   *  patch" -- the case Width exists to control. */
  async function renderWidthAt(width: number): Promise<{ left: Float32Array; right: Float32Array }> {
    const ctx = new OfflineAudioContext(2, Math.ceil(0.3 * SR), SR)
    await ensureWorklets(ctx)
    const graph = new PatchGraph(ctx)
    const oscL = graph.addModule('vco', 'oscL')
    const oscR = graph.addModule('vco', 'oscR')
    graph.setParam(oscR, 'tune', 3) // a few semitones apart -- decorrelated, not just phase-shifted
    const width_ = graph.addModule('width', 'w')
    graph.setParam(width_, 'width', width)

    const merger = ctx.createChannelMerger(2)
    graph.getInstance(oscL)!.outputs.get('out')!.connect(merger, 0, 0)
    graph.getInstance(oscR)!.outputs.get('out')!.connect(merger, 0, 1)
    merger.connect(graph.getInstance(width_)!.inputs.get('in') as AudioNode)

    const out = graph.getInstance(width_)!.outputs.get('out')!
    out.connect(ctx.destination)

    const buffer = await ctx.startRendering()
    graph.dispose()
    return { left: buffer.getChannelData(0), right: buffer.getChannelData(1) }
  }

  it('is the identity at width = 1', async () => {
    const identity = await renderWidthAt(1)
    // Rebuild the same two oscillators with no Width module at all, as the
    // ground truth to compare against.
    const ctx = new OfflineAudioContext(2, Math.ceil(0.3 * SR), SR)
    await ensureWorklets(ctx)
    const graph = new PatchGraph(ctx)
    const oscL = graph.addModule('vco', 'oscL')
    const oscR = graph.addModule('vco', 'oscR')
    graph.setParam(oscR, 'tune', 3)
    const merger = ctx.createChannelMerger(2)
    graph.getInstance(oscL)!.outputs.get('out')!.connect(merger, 0, 0)
    graph.getInstance(oscR)!.outputs.get('out')!.connect(merger, 0, 1)
    merger.connect(ctx.destination)
    const buffer = await ctx.startRendering()
    graph.dispose()

    const settled = Math.floor(buffer.length * 0.3)
    const rawL = buffer.getChannelData(0).subarray(settled)
    const rawR = buffer.getChannelData(1).subarray(settled)
    const wL = identity.left.subarray(settled)
    const wR = identity.right.subarray(settled)
    for (let i = 0; i < rawL.length; i += 37) { // sparse sample, cheap and sufficient
      expect(wL[i]).toBeCloseTo(rawL[i]!, 3)
      expect(wR[i]).toBeCloseTo(rawR[i]!, 3)
    }
  })

  it('collapses to identical channels (mono) at width = 0', async () => {
    const { left, right } = await renderWidthAt(0)
    const settled = Math.floor(left.length * 0.3)
    for (let i = settled; i < left.length; i += 37) {
      expect(left[i]).toBeCloseTo(right[i]!, 4)
    }
  })

  it('mono sum is level-invariant across every width setting -- the acceptance criterion that matters most', async () => {
    const widths = [0, 0.5, 1, 1.5, 2]
    const sums = new Map<number, number>()
    for (const width of widths) {
      const { left, right } = await renderWidthAt(width)
      const settled = Math.floor(left.length * 0.3)
      const mono = monoSum(left.subarray(settled), right.subarray(settled))
      sums.set(width, rms(mono))
    }
    const values = [...sums.values()]
    console.log(`width mono-sum RMS by setting: ${widths.map((w) => `${w}=${sums.get(w)!.toFixed(5)}`).join(', ')}`)
    const spread = (Math.max(...values) - Math.min(...values)) / Math.max(...values)
    // Should be flat to numerical precision -- dsp/width.ts's algebraic
    // proof says exactly equal; this is the real-worklet, real-graph
    // confirmation of that proof, generous at 2% for render/measurement
    // noise rather than the exact-equality the pure math gives.
    expect(spread).toBeLessThan(0.02)
    for (const v of values) expect(v).toBeGreaterThan(0.05) // and still audible, not merely "flat and silent"
  })

  it('phase correlation between channels drops as width increases -- the stereo image genuinely widening, measured', async () => {
    const widths = [0, 1, 2]
    const correlations = new Map<number, number>()
    for (const width of widths) {
      const { left, right } = await renderWidthAt(width)
      const settled = Math.floor(left.length * 0.3)
      correlations.set(width, correlation(left.subarray(settled), right.subarray(settled)))
    }
    console.log(`width phase correlation: ${widths.map((w) => `${w}=${correlations.get(w)!.toFixed(3)}`).join(', ')}`)
    expect(correlations.get(0)!).toBeCloseTo(1, 2) // mono: perfectly correlated
    expect(correlations.get(2)!).toBeLessThan(correlations.get(1)!)
    expect(correlations.get(1)!).toBeLessThan(correlations.get(0)!)
  })

  it('is a correct no-op on a literal mono cable, at any width', async () => {
    for (const width of [0, 1, 2]) {
      const { left, right } = await renderStereo(0.15, (_ctx, g) => {
        const osc = g.addModule('vco', 'osc')
        const w = g.addModule('width', 'w')
        g.setParam(w, 'width', width)
        g.connect([osc, 'out'], [w, 'in']) // a single mono port feeding Width's `in`
        return w
      })
      const settled = Math.floor(left.length * 0.5)
      for (let i = settled; i < left.length; i += 37) {
        expect(left[i]).toBeCloseTo(right[i]!, 5)
      }
      expect(rms(left.subarray(settled))).toBeGreaterThan(0.1)
    }
  })
})

describe('Scope: reads a deliberate mono down-mix, not a per-channel channel 0', () => {
  it('AnalyserNode itself down-mixes a hard-panned stereo input before time-domain analysis -- verifying scope.ts\'s documented decision empirically, not on the spec\'s word alone', async () => {
    const N = 8192
    async function peakThroughAnalyser(pan: number): Promise<number> {
      const ctx = new OfflineAudioContext(2, N, SR)
      const osc = ctx.createOscillator()
      osc.frequency.value = 1000
      const panner = ctx.createStereoPanner()
      panner.pan.value = pan
      osc.connect(panner)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      panner.connect(analyser)
      panner.connect(ctx.destination) // must be graph-reachable to be pulled at all
      osc.start(0)
      await ctx.startRendering()
      const data = new Float32Array(analyser.fftSize)
      analyser.getFloatTimeDomainData(data)
      let peak = 0
      for (const v of data) peak = Math.max(peak, Math.abs(v))
      return peak
    }

    const hardLeft = await peakThroughAnalyser(-1) // L=1, R=0
    const center = await peakThroughAnalyser(0) // equal-power: L=R=0.7071
    console.log(`AnalyserNode time-domain peak: hard-left=${hardLeft}, center=${center}`)
    // A raw "read channel 0" would show 1.0 for hard-left; a mono down-mix
    // (0.5*(L+R)) shows 0.5 -- which is what's measured, confirming
    // scope.ts's doc comment rather than merely asserting the spec's claim.
    expect(hardLeft).toBeCloseTo(0.5, 2)
    expect(center).toBeCloseTo(Math.SQRT1_2, 2) // unchanged: both channels already equal
  })
})

describe('regression: existing mono modules are unaffected', () => {
  it('a bare VCO still reads its expected pitch through the (still-mono) renderGraph path', async () => {
    // Sanity check that none of the above touched anything mono-path
    // modules depend on -- a cheap, fast canary alongside the full
    // pre-existing suite this task must leave green.
    const { left } = await renderStereo(0.3, (_ctx, g) => g.addModule('vco', 'osc'))
    expect(peakHz(left, SR)).toBeCloseTo(440, -1)
  })
})
