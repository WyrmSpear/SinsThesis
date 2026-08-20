import { describe, it, expect, beforeEach } from 'vitest'
import { PatchGraph } from '../../../src/engine/graph'
import { ensureWorklets } from '../../../src/engine/render'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { binauralDescriptor } from '../../../src/engine/modules/binaural'
import { outputDescriptor } from '../../../src/engine/modules/output'
import { lfoDescriptor } from '../../../src/engine/modules/lfo'
import { rms } from '../../../src/engine/analysis/features'

const SR = 48000

beforeEach(() => {
  clearRegistry()
  for (const d of [binauralDescriptor, outputDescriptor, lfoDescriptor]) registerModule(d)
})

async function renderStereo(
  seconds: number,
  build: (ctx: OfflineAudioContext, graph: PatchGraph) => string | [string, string],
): Promise<{ left: Float32Array; right: Float32Array }> {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SR), SR)
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

/** Same zero-crossing measurement as tests/node/dsp/binaural.test.ts and
 *  tests/browser/modules/lfo-sync.test.ts, run here against the real
 *  worklet's actual rendered output rather than the pure DSP function
 *  directly. */
function measuredFreqHz(samples: Float32Array, sampleRate: number, skipSamples: number): number {
  const crossings: number[] = []
  for (let i = Math.max(1, skipSamples); i < samples.length; i++) {
    const prev = samples[i - 1]!
    const cur = samples[i]!
    if (prev < 0 && cur >= 0) {
      const frac = -prev / (cur - prev)
      crossings.push((i - 1 + frac) / sampleRate)
    }
  }
  if (crossings.length < 2) return 0
  const periodSeconds = (crossings[crossings.length - 1]! - crossings[0]!) / (crossings.length - 1)
  return 1 / periodSeconds
}

describe('Binaural: through the real worklet', () => {
  it('produces genuinely different signals on L and R -- a real stereo source, not a mono tone duplicated', async () => {
    const { left, right } = await renderStereo(0.3, (_ctx, g) => {
      const b = g.addModule('binaural', 'b')
      g.setParam(b, 'carrier', 220)
      g.setParam(b, 'beat', 6)
      return b
    })
    const skip = Math.round(0.05 * SR)
    const leftHz = measuredFreqHz(left, SR, skip)
    const rightHz = measuredFreqHz(right, SR, skip)
    console.log(`binaural worklet: left=${leftHz.toFixed(3)} Hz, right=${rightHz.toFixed(3)} Hz`)
    expect(rightHz - leftHz).toBeCloseTo(6, 1)
    expect(leftHz).not.toBeCloseTo(rightHz, 0)

    // Not merely different frequencies -- genuinely uncorrelated waveforms
    // sample-by-sample, the actual "two ears, two different signals" claim.
    let matchingSign = 0
    for (let i = skip; i < left.length; i++) {
      if (Math.sign(left[i]!) === Math.sign(right[i]!)) matchingSign++
    }
    const fraction = matchingSign / (left.length - skip)
    console.log(`binaural worklet: fraction of samples with matching sign L/R = ${fraction.toFixed(3)}`)
    expect(fraction).toBeGreaterThan(0.2)
    expect(fraction).toBeLessThan(0.8) // neither identical nor perfectly inverted
  })

  it('summed to mono, the module is indistinguishable from two plain independent oscillators at the same two frequencies -- nothing dichotic survives losing separate-ear delivery', async () => {
    // The physically accurate claim, verified rather than assumed: summing
    // sin(a) + sin(b) does NOT silence anything at the beat rate -- it is a
    // textbook amplitude-modulated interference pattern
    // (sin(a)+sin(b) = 2*sin((a+b)/2)*cos((a-b)/2)), audible and real. What
    // *is* genuinely gone once summed to one channel is the separate-ear
    // structure itself: this test proves that by showing the module's mono
    // sum is numerically the same signal a bare two-oscillator mix at the
    // derived left/right frequencies would produce, with no "binaural"
    // module involved at all -- see dsp/binaural.ts's and this module's own
    // doc comments for the full reasoning.
    const carrierHz = 220
    const beatHz = 6
    const leftHz = carrierHz - beatHz / 2
    const rightHz = carrierHz + beatHz / 2

    const { left, right } = await renderStereo(1, (_ctx, g) => {
      const b = g.addModule('binaural', 'b')
      g.setParam(b, 'carrier', carrierHz)
      g.setParam(b, 'beat', beatHz)
      return b
    })
    const skip = Math.round(0.05 * SR)
    const binauralMono = new Float32Array(left.length - skip)
    for (let i = skip; i < left.length; i++) binauralMono[i - skip] = (left[i]! + right[i]!) / 2

    // Reference: two bare native oscillators at the exact derived
    // frequencies, mixed directly to a single mono channel -- ordinary
    // two-tone content with nothing "binaural" about how it was built.
    const refCtx = new OfflineAudioContext(1, Math.ceil(1 * SR), SR)
    const oscL = refCtx.createOscillator()
    oscL.type = 'sine'
    oscL.frequency.value = leftHz
    const oscR = refCtx.createOscillator()
    oscR.type = 'sine'
    oscR.frequency.value = rightHz
    const sum = refCtx.createGain()
    sum.gain.value = 0.5 // matches the (left+right)/2 mono down-mix above
    oscL.connect(sum)
    oscR.connect(sum)
    sum.connect(refCtx.destination)
    oscL.start(0)
    oscR.start(0)
    const refBuffer = await refCtx.startRendering()
    const refMono = refBuffer.getChannelData(0).subarray(skip)

    // First, confirm the interference beat is genuinely present and at the
    // right rate: the envelope should dip toward a near-null roughly every
    // 1/(2*beat) seconds (twice per beat cycle), not stay flat.
    let minAbs = Infinity
    let maxAbs = 0
    for (let i = 0; i < binauralMono.length; i++) {
      const a = Math.abs(binauralMono[i]!)
      minAbs = Math.min(minAbs, a)
      maxAbs = Math.max(maxAbs, a)
    }
    // (minAbs alone is a noisy single-sample statistic -- what actually
    // matters is the windowed envelope reaching near-zero periodically,
    // checked via correlation with the reference below instead.)
    console.log(`binaural mono-sum single-sample |x| range: [${minAbs.toExponential(3)}, ${maxAbs.toFixed(3)}]`)

    // The real proof: sample-by-sample, the module's mono sum and the bare
    // two-oscillator reference should agree almost exactly -- both are the
    // same superposition of the same two frequencies starting from the same
    // phase.
    let maxDiff = 0
    let sumSq = 0
    for (let i = 0; i < binauralMono.length; i += 7) { // sparse, cheap and sufficient
      const diff = Math.abs(binauralMono[i]! - refMono[i]!)
      maxDiff = Math.max(maxDiff, diff)
      sumSq += diff * diff
    }
    const rmsDiff = Math.sqrt(sumSq / Math.ceil(binauralMono.length / 7))
    console.log(`binaural mono-sum vs. bare two-oscillator reference: max|diff|=${maxDiff.toFixed(4)}, rms(diff)=${rmsDiff.toFixed(5)}`)
    // Generous tolerance for the two independent DSP paths (a hand-rolled
    // Math.sin phase accumulator running inside an AudioWorkletNode vs. the
    // browser's own native OscillatorNode, which can differ by a handful of
    // samples of processing latency) -- this is not asserting bit-
    // exactness, only that they are the same signal, not two different
    // ones. Measured: max|diff| ~0.05, rms(diff) ~0.03, against a signal
    // whose own peak-to-peak range is about 2 -- a small fraction of the
    // signal itself, consistent with a slight timing offset between two
    // independently-implemented oscillator paths rather than a different
    // waveform.
    expect(maxDiff).toBeLessThan(0.08)
    expect(rmsDiff).toBeLessThan(0.05)

    // And the mono sum is still clearly audible, not cancelled -- summing
    // to mono changes the mechanism, it does not silence the module.
    expect(rms(binauralMono)).toBeGreaterThan(0.1)
  })

  it('a CV patched into beatCv genuinely moves the beat over time, scaled by the Amt knob', async () => {
    const { left, right } = await renderStereo(2, (_ctx, g) => {
      const b = g.addModule('binaural', 'b')
      const lfo = g.addModule('lfo', 'lfo')
      g.setParam(b, 'carrier', 300)
      g.setParam(b, 'beat', 4)
      g.setParam(b, 'beatCvAmount', 10)
      g.setParam(lfo, 'rate', 0.5)
      g.setParam(lfo, 'shape', 1) // pulse -- two clean, distinct beat values per cycle
      g.connect([lfo, 'out'], [b, 'beatCv'])
      return b
    })
    const quarter = Math.floor(left.length / 4)
    const beatAt = (start: number): number => {
      const l = measuredFreqHz(left.subarray(start, start + quarter), SR, 0)
      const r = measuredFreqHz(right.subarray(start, start + quarter), SR, 0)
      return r - l
    }
    const beats = [0, 1, 2, 3].map((k) => beatAt(k * quarter))
    console.log(`binaural CV-swept beat per quarter: ${beats.map((b) => b.toFixed(3)).join(', ')}`)
    const spread = Math.max(...beats) - Math.min(...beats)
    expect(spread).toBeGreaterThan(2) // genuinely moving, not stuck at the knob's own 4 Hz
  })

  it('is a correct no-op difference-wise at beat = 0 -- both ears carry the same frequency', async () => {
    const { left, right } = await renderStereo(0.3, (_ctx, g) => {
      const b = g.addModule('binaural', 'b')
      g.setParam(b, 'carrier', 300)
      g.setParam(b, 'beat', 0.01) // the panel's own floor, effectively zero
      return b
    })
    const skip = Math.round(0.05 * SR)
    const leftHz = measuredFreqHz(left, SR, skip)
    const rightHz = measuredFreqHz(right, SR, skip)
    expect(Math.abs(leftHz - rightHz)).toBeLessThan(0.05)
  })
})

describe('Binaural: through Output, mono-compatible routing', () => {
  it('reaches Output with both channels intact', async () => {
    const { left, right } = await renderStereo(0.3, (_ctx, g) => {
      const b = g.addModule('binaural', 'b')
      const out = g.addModule('output', 'out')
      g.setParam(b, 'carrier', 220)
      g.setParam(b, 'beat', 5)
      g.connect([b, 'out'], [out, 'in'])
      return out
    })
    expect(rms(left)).toBeGreaterThan(0.1)
    expect(rms(right)).toBeGreaterThan(0.1)
  })
})
