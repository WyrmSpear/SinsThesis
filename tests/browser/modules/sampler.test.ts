import { describe, it, expect, beforeEach } from 'vitest'
import { PatchGraph } from '../../../src/engine/graph'
import { ensureWorklets } from '../../../src/engine/render'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { samplerDescriptor, type SamplerInstance } from '../../../src/engine/modules/sampler'
import { peakHz, rms } from '../../../src/engine/analysis/features'
import { encodeWav } from '../../../src/engine/wav'
import { bytesToBase64 } from '../../../src/engine/base64'

const SR = 48000

function sineChannel(frames: number, f0: number, sampleRate = SR, amp = 0.8): Float32Array {
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) out[i] = amp * Math.sin((2 * Math.PI * f0 * i) / sampleRate)
  return out
}

/**
 * `SamplerInstance.loadBuffer` hands the built mip set to the worklet over
 * `node.port.postMessage` -- a genuinely different delivery path from
 * every other module's params (which travel as ordinary `AudioParam`
 * automation, already in-order with the render). A posted message crosses
 * to the audio-rendering thread asynchronously, so this waits a real tick
 * before starting an offline render -- `renderGraph` itself has no such
 * wait built in (nothing else in this codebase's module set needed one),
 * which is why this suite doesn't reuse it directly.
 */
async function renderWithSample(
  seconds: number,
  build: (ctx: OfflineAudioContext, graph: PatchGraph) => { outputId: string; sampler: SamplerInstance },
  sampleRate = SR,
): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * sampleRate), sampleRate)
  await ensureWorklets(ctx)
  const graph = new PatchGraph(ctx)
  const { outputId, sampler } = build(ctx, graph)
  // Let the posted 'load' message actually reach the worklet thread before
  // rendering starts consuming it.
  await new Promise((resolve) => setTimeout(resolve, 50))
  void sampler
  const out = graph.getInstance(outputId)!.outputs.get('out')!
  out.connect(ctx.destination)
  const buffer = await ctx.startRendering()
  return buffer.getChannelData(0)
}

function gateOn(ctx: OfflineAudioContext, target: AudioNode | AudioParam): void {
  const src = ctx.createConstantSource()
  src.offset.value = 1
  src.start()
  src.connect(target as AudioNode)
}

function constantCv(ctx: OfflineAudioContext, target: AudioNode | AudioParam, value: number): void {
  const src = ctx.createConstantSource()
  src.offset.value = value
  src.start()
  src.connect(target as AudioNode)
}

describe('Sampler module (real worklet)', () => {
  beforeEach(() => {
    clearRegistry()
    registerModule(samplerDescriptor)
  })

  it('is silent with nothing loaded, even when gated', async () => {
    const out = await renderWithSample(0.2, (ctx, g) => {
      const id = g.addModule('sampler', 'sampler')
      const sampler = g.getInstance(id) as SamplerInstance
      gateOn(ctx, sampler.inputs.get('gate')!)
      return { outputId: id, sampler }
    })
    expect(rms(out)).toBe(0)
  })

  it('loading a buffer and gating it produces real audio -- hearing a loaded sample', async () => {
    const out = await renderWithSample(0.3, (ctx, g) => {
      const id = g.addModule('sampler', 'sampler')
      const sampler = g.getInstance(id) as SamplerInstance
      sampler.loadBuffer([sineChannel(SR, 441)], SR, 'test-tone.wav')
      g.setParam(id, 'mode', 1) // loop, so it sustains for the whole render
      gateOn(ctx, sampler.inputs.get('gate')!)
      return { outputId: id, sampler }
    })
    expect(rms(out)).toBeGreaterThan(0.1)
  })

  it('plays at the recorded pitch with no pitch CV and no tune offset', async () => {
    const out = await renderWithSample(0.3, (ctx, g) => {
      const id = g.addModule('sampler', 'sampler')
      const sampler = g.getInstance(id) as SamplerInstance
      sampler.loadBuffer([sineChannel(SR, 441)], SR, 'a4.wav')
      g.setParam(id, 'mode', 1)
      gateOn(ctx, sampler.inputs.get('gate')!)
      return { outputId: id, sampler }
    })
    expect(peakHz(out.subarray(4000), SR)).toBeCloseTo(441, -1)
  })

  it('1V/octave pitch CV doubles the played pitch per volt, exactly like the VCO', async () => {
    const out = await renderWithSample(0.3, (ctx, g) => {
      const id = g.addModule('sampler', 'sampler')
      const sampler = g.getInstance(id) as SamplerInstance
      sampler.loadBuffer([sineChannel(SR, 220)], SR, 'low.wav')
      g.setParam(id, 'mode', 1)
      gateOn(ctx, sampler.inputs.get('gate')!)
      constantCv(ctx, sampler.inputs.get('pitch')!, 1) // +1 octave
      return { outputId: id, sampler }
    })
    expect(peakHz(out.subarray(4000), SR)).toBeCloseTo(440, -1)
  })

  it('the tune param transposes in semitones', async () => {
    const out = await renderWithSample(0.3, (ctx, g) => {
      const id = g.addModule('sampler', 'sampler')
      const sampler = g.getInstance(id) as SamplerInstance
      sampler.loadBuffer([sineChannel(SR, 220)], SR, 'low.wav')
      g.setParam(id, 'mode', 1)
      g.setParam(id, 'tune', 12) // +1 octave
      gateOn(ctx, sampler.inputs.get('gate')!)
      return { outputId: id, sampler }
    })
    expect(peakHz(out.subarray(4000), SR)).toBeCloseTo(440, -1)
  })

  it('a played-down pitch (negative CV) is audibly lower', async () => {
    // Sequential, not Promise.all: two OfflineAudioContexts rendering
    // concurrently contend for the same render thread, and this module's
    // buffer load is delivered over `postMessage` (see renderWithSample's
    // own doc comment) -- concurrent renders were measured to occasionally
    // race that delivery against the render start. Every other module's
    // own test suite parallelizes safely because its params travel as
    // ordinary AudioParam automation instead.
    const ref = await renderWithSample(0.4, (ctx, g) => {
      const id = g.addModule('sampler', 'sampler')
      const sampler = g.getInstance(id) as SamplerInstance
      sampler.loadBuffer([sineChannel(SR, 440)], SR, 'ref.wav')
      g.setParam(id, 'mode', 1)
      gateOn(ctx, sampler.inputs.get('gate')!)
      return { outputId: id, sampler }
    })
    const low = await renderWithSample(0.4, (ctx, g) => {
      const id = g.addModule('sampler', 'sampler')
      const sampler = g.getInstance(id) as SamplerInstance
      sampler.loadBuffer([sineChannel(SR, 440)], SR, 'ref.wav')
      g.setParam(id, 'mode', 1)
      gateOn(ctx, sampler.inputs.get('gate')!)
      constantCv(ctx, sampler.inputs.get('pitch')!, -1)
      return { outputId: id, sampler }
    })
    expect(peakHz(low.subarray(4000), SR)).toBeCloseTo(220, -1)
    expect(peakHz(ref.subarray(4000), SR)).toBeCloseTo(440, -1)
  })

  it('one-shot mode plays once and goes silent, ignoring a gate held open', async () => {
    const oneShotFrames = Math.round(SR * 0.15) // a short, finite sample
    const out = await renderWithSample(0.5, (ctx, g) => {
      const id = g.addModule('sampler', 'sampler')
      const sampler = g.getInstance(id) as SamplerInstance
      sampler.loadBuffer([sineChannel(oneShotFrames, 300)], SR, 'shot.wav')
      g.setParam(id, 'mode', 0) // one-shot
      gateOn(ctx, sampler.inputs.get('gate')!) // held open for the whole render
      return { outputId: id, sampler }
    })
    // Loud in the first ~150ms, silent well after the sample's own length.
    const early = out.subarray(2000, 6000)
    const late = out.subarray(Math.round(SR * 0.3))
    expect(rms(early)).toBeGreaterThan(0.1)
    expect(rms(late)).toBeLessThan(0.001)
  })

  it('loop mode sustains well past the buffer\'s own natural length', async () => {
    const shortFrames = Math.round(SR * 0.05) // 50ms buffer
    const out = await renderWithSample(0.5, (ctx, g) => {
      const id = g.addModule('sampler', 'sampler')
      const sampler = g.getInstance(id) as SamplerInstance
      sampler.loadBuffer([sineChannel(shortFrames, 300)], SR, 'loop.wav')
      g.setParam(id, 'mode', 1) // loop
      gateOn(ctx, sampler.inputs.get('gate')!)
      return { outputId: id, sampler }
    })
    // Still sounding well past the 50ms the raw buffer would have covered.
    expect(rms(out.subarray(Math.round(SR * 0.4)))).toBeGreaterThan(0.1)
  })

  it('start/end trims which part of the buffer plays', async () => {
    // First half of the buffer at 300 Hz, second half at 900 Hz.
    const half = SR * 0.25
    const mono = new Float32Array(half * 2)
    mono.set(sineChannel(half, 300), 0)
    mono.set(sineChannel(half, 900), half)

    const out = await renderWithSample(0.3, (ctx, g) => {
      const id = g.addModule('sampler', 'sampler')
      const sampler = g.getInstance(id) as SamplerInstance
      sampler.loadBuffer([mono], SR, 'split.wav')
      g.setParam(id, 'mode', 1)
      // Explicit atTime: `start` is a continuous, smoothed param like every
      // other continuous param in this codebase (B3) -- with no atTime it
      // glides from its 0 default rather than snapping, and the gate below
      // fires in the very same instant, so the trigger would read `start`
      // mid-glide instead of at its target. A real preset load applies
      // saved values the same explicit way (patch.ts's loadPatch), which
      // this mirrors -- this is a test-setup ordering fix, not a workaround
      // for a DSP bug.
      g.setParam(id, 'start', 0.5, ctx.currentTime) // only the 900 Hz half
      gateOn(ctx, sampler.inputs.get('gate')!)
      return { outputId: id, sampler }
    })
    expect(peakHz(out.subarray(4000), SR)).toBeCloseTo(900, -1)
  })

  it('reverse plays the loaded region back to front', async () => {
    // First half silent, second half a loud tone -- forward one-shot
    // should be quiet-then-loud; reverse should be loud-then-quiet.
    const half = Math.round(SR * 0.1)
    const mono = new Float32Array(half * 2)
    mono.set(sineChannel(half, 500), half) // tone only in the second half

    const forward = await renderWithSample(0.25, (ctx, g) => {
      const id = g.addModule('sampler', 'sampler')
      const sampler = g.getInstance(id) as SamplerInstance
      sampler.loadBuffer([mono], SR, 'half.wav')
      g.setParam(id, 'mode', 0)
      gateOn(ctx, sampler.inputs.get('gate')!)
      return { outputId: id, sampler }
    })
    const reverse = await renderWithSample(0.25, (ctx, g) => {
      const id = g.addModule('sampler', 'sampler')
      const sampler = g.getInstance(id) as SamplerInstance
      sampler.loadBuffer([mono], SR, 'half.wav')
      g.setParam(id, 'mode', 0)
      g.setParam(id, 'reverse', 1)
      gateOn(ctx, sampler.inputs.get('gate')!)
      return { outputId: id, sampler }
    })

    const forwardFirstHalf = rms(forward.subarray(2000, half - 2000))
    const forwardSecondHalf = rms(forward.subarray(half + 2000, half * 2 - 2000))
    const reverseFirstHalf = rms(reverse.subarray(2000, half - 2000))
    const reverseSecondHalf = rms(reverse.subarray(half + 2000, half * 2 - 2000))

    expect(forwardSecondHalf).toBeGreaterThan(forwardFirstHalf * 5)
    expect(reverseFirstHalf).toBeGreaterThan(reverseSecondHalf * 5)
  })

  it('exposes a waveform after loading and loses it after clearing', async () => {
    const ctx = new OfflineAudioContext(1, 128, SR)
    await ensureWorklets(ctx)
    const instance = samplerDescriptor.create(ctx) as SamplerInstance
    expect(instance.getWaveform()).toBeUndefined()

    instance.loadBuffer([sineChannel(4800, 220)], SR, 'demo.wav')
    const waveform = instance.getWaveform()
    expect(waveform).toBeDefined()
    expect(waveform!.fileName).toBe('demo.wav')
    expect(waveform!.durationSeconds).toBeCloseTo(0.1, 2)
    expect(waveform!.min.length).toBeGreaterThan(0)

    instance.clearBuffer()
    expect(instance.getWaveform()).toBeUndefined()
    instance.dispose()
  })

  it('serializeState/restoreState round-trip through the real module (metadata)', async () => {
    const ctx = new OfflineAudioContext(1, 128, SR)
    await ensureWorklets(ctx)
    const instance = samplerDescriptor.create(ctx) as SamplerInstance
    expect(instance.serializeState!()).toBeUndefined() // nothing loaded yet

    instance.loadBuffer([sineChannel(4800, 220)], SR, 'roundtrip.wav')
    const state = instance.serializeState!()
    expect(state).toBeDefined()

    const restored = samplerDescriptor.create(ctx) as SamplerInstance
    expect(restored.getWaveform()).toBeUndefined()
    restored.restoreState!(state)
    const waveform = restored.getWaveform()
    expect(waveform!.fileName).toBe('roundtrip.wav')
    expect(waveform!.durationSeconds).toBeCloseTo(0.1, 2)

    instance.dispose()
    restored.dispose()
  })

  // ---- the round trip actually carries the audio, not just metadata ------
  //
  // The suite above only ever checked `fileName`/`durationSeconds` -- it
  // would pass identically if `restoreState` produced silence, white noise,
  // or a hot sample silently clipped to unity. These tests instead render a
  // known buffer straight through the real worklet (mode='One-Shot',
  // tune=0, rate 1, forward, the same "reproduces the source almost
  // exactly" configuration `tests/node/dsp/sampler.test.ts`'s own
  // interpolation-sanity test uses) both before and after a save/reload,
  // and diff the two renders sample by sample. Because both renders go
  // through the identical worklet/DSP path, any difference is attributable
  // only to the persistence round trip (PCM16 quantisation, plus the
  // hot-sample gain fix below) -- not to interpolation or alignment
  // artifacts the DSP layer already has its own tests for.

  /** Loads `mono` into a throwaway, unconnected instance purely to produce
   *  the same `serializeState()` a real Save would write -- mirrors a
   *  genuine save/reload using a *different* module instance than the one
   *  that plays the restored audio back, the same way loading a `.sinp` in
   *  a fresh session does. */
  async function savedState(
    mono: Float32Array, sampleRate: number, fileName: string,
  ): Promise<ReturnType<NonNullable<SamplerInstance['serializeState']>>> {
    const ctx = new OfflineAudioContext(1, 128, sampleRate)
    await ensureWorklets(ctx)
    const instance = samplerDescriptor.create(ctx) as SamplerInstance
    instance.loadBuffer([mono], sampleRate, fileName)
    const state = instance.serializeState!()
    instance.dispose()
    return state
  }

  /** Renders a one-shot, rate-1, forward playthrough of whatever `configure`
   *  loads -- the DSP-level round-trip config `tests/node/dsp/sampler.test.ts`
   *  already measures as reproducing its source almost exactly, so any
   *  post-configure difference between two such renders is the persistence
   *  path's own error, not this shape of playback's. */
  function renderOneShotThrough(
    seconds: number, configure: (ctx: OfflineAudioContext, g: PatchGraph, sampler: SamplerInstance) => void,
  ): Promise<Float32Array> {
    return renderWithSample(seconds, (ctx, g) => {
      const id = g.addModule('sampler', 'sampler')
      const sampler = g.getInstance(id) as SamplerInstance
      configure(ctx, g, sampler)
      g.setParam(id, 'mode', 0) // one-shot -- plays the whole loaded region once, forward
      gateOn(ctx, sampler.inputs.get('gate')!)
      return { outputId: id, sampler }
    })
  }

  /** Max absolute per-sample difference, and its dBFS-style figure
   *  (`20*log10`, same convention the audit used for "max error 1.526e-5
   *  (~-96 dBFS)") -- compared over the loaded region's own length; both
   *  renders go silent identically beyond it, so comparing further adds no
   *  information. */
  function maxErrorDb(a: Float32Array, b: Float32Array, frames: number): { maxErr: number; db: number } {
    let maxErr = 0
    for (let i = 0; i < frames; i++) maxErr = Math.max(maxErr, Math.abs(a[i]! - b[i]!))
    return { maxErr, db: 20 * Math.log10(Math.max(maxErr, 1e-12)) }
  }

  // The tolerance asserted below is -80 dBFS: the audit's own direct
  // (encoder-only) measurement of this exact PCM16 path was ~-96 dBFS: with
  // 20 dB of margin above the measured figure to absorb this test's extra
  // worklet/render-graph plumbing (a real AudioWorkletNode round trip, not
  // a bare function call) without being so loose it would miss a real
  // regression -- and it is still far below this engine's own DSP noise
  // floor (docs/CONTINUATION.md's measured-quality table has nothing worse
  // than -45 dB, and most figures are -60 dB or better), i.e. genuinely
  // inaudible.
  const TOLERANCE_DB = -80

  it('a normal (never-hot) sample survives save/reload within the stated PCM16 tolerance', async () => {
    const frames = 4800
    const mono = sineChannel(frames, 220, SR, 0.8)
    const state = await savedState(mono, SR, 'rt.wav')

    const reference = await renderOneShotThrough(0.15, (_ctx, _g, sampler) => {
      sampler.loadBuffer([mono], SR, 'rt.wav')
    })
    const restored = await renderOneShotThrough(0.15, (_ctx, _g, sampler) => {
      sampler.restoreState!(state)
    })

    const { maxErr, db } = maxErrorDb(reference, restored, frames)
    // eslint-disable-next-line no-console
    console.log(`sampler round-trip error: ${maxErr.toExponential(3)} (${db.toFixed(1)} dBFS)`)
    expect(db).toBeLessThanOrEqual(TOLERANCE_DB)
  })

  it('a hot (peak 1.4) sample survives save/reload without being clipped -- the finding-1 regression case', async () => {
    const frames = 4800
    const mono = sineChannel(frames, 220, SR, 1.4) // peaks at 1.4, well above unity
    const state = await savedState(mono, SR, 'hot.wav')

    // Before the fix, `encodeWav`'s PCM16 path clamped every sample to
    // [-1, 1] on save with no warning -- this state's `gain` field is what
    // now lets `restoreState` undo that clamp instead of baking it in
    // permanently.
    expect((state as { gain?: number }).gain).toBeCloseTo(1.4, 1)

    const reference = await renderOneShotThrough(0.15, (_ctx, _g, sampler) => {
      sampler.loadBuffer([mono], SR, 'hot.wav')
    })
    const restored = await renderOneShotThrough(0.15, (_ctx, _g, sampler) => {
      sampler.restoreState!(state)
    })

    let referencePeak = 0
    let restoredPeak = 0
    for (let i = 0; i < frames; i++) {
      referencePeak = Math.max(referencePeak, Math.abs(reference[i]!))
      restoredPeak = Math.max(restoredPeak, Math.abs(restored[i]!))
    }
    // eslint-disable-next-line no-console
    console.log(`hot sample peak: reference ${referencePeak.toFixed(3)}, restored ${restoredPeak.toFixed(3)}`)
    // The regression this catches: pre-fix, `restoredPeak` would have
    // measured ~1.0 -- silently clipped, no error, no warning. It must now
    // reach essentially the same peak the un-persisted reference does.
    expect(restoredPeak).toBeGreaterThan(1.3)

    const { maxErr, db } = maxErrorDb(reference, restored, frames)
    // eslint-disable-next-line no-console
    console.log(`hot sample round-trip error: ${maxErr.toExponential(3)} (${db.toFixed(1)} dBFS)`)
    expect(db).toBeLessThanOrEqual(TOLERANCE_DB)
  })

  it('an old-format saved state (no "gain" field) still loads correctly -- pre-fix compatibility', async () => {
    // Hand-built with the same, unchanged `wav.ts` encoder rather than via
    // today's `serializeState`, so this is byte-faithful to what every
    // `.sinp` written before this fix (including the shipped presets and
    // every academy level solution -- see `tests/browser/analysis/
    // history-rubric-render.test.ts`'s own "history-05-chop" coverage,
    // which loads a real one end to end) actually contains: `{fileName,
    // wavBase64}`, no `gain` key at all.
    const frames = 4800
    const mono = sineChannel(frames, 220, SR, 0.8) // never hot -- pre-fix files never clipped this case
    const wavBytes = new Uint8Array(encodeWav([mono], SR, 'pcm16'))
    const legacyState = { fileName: 'legacy.wav', wavBase64: bytesToBase64(wavBytes) }

    const reference = await renderOneShotThrough(0.15, (_ctx, _g, sampler) => {
      sampler.loadBuffer([mono], SR, 'legacy.wav')
    })
    const restored = await renderOneShotThrough(0.15, (_ctx, _g, sampler) => {
      sampler.restoreState!(legacyState)
    })

    const { db } = maxErrorDb(reference, restored, frames)
    expect(db).toBeLessThanOrEqual(TOLERANCE_DB)
  })
})
