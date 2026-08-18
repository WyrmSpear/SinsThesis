import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * A1: `getWavetableSet` builds 24 band-limited tables (millions of trig
 * calls) the first time a non-sine shape is asked for. That's fine offline
 * -- it runs faster than real time -- but on a live AudioContext, doing it
 * inside `process()` blocks the audio thread on the first note and drops
 * out.
 *
 * The fix is to build the set once, at worklet *module* load (top-level
 * code in a worklet runs during `audioWorklet.addModule()`, before any node
 * exists), and thread the already-built set into the per-sample function
 * instead of having it fetch (and potentially build) its own copy.
 *
 * This test imports the real worklet source files, not a simulation of
 * them: AudioWorkletGlobalScope's `AudioWorkletProcessor`, `registerProcessor`
 * and `sampleRate` are stubbed onto `globalThis` (the same three names
 * `audioworklet-globals.d.ts` declares ambiently for the type checker), so
 * the actual module-evaluation order of vco.worklet.ts / segment.worklet.ts
 * runs exactly as it would in a browser.
 *
 * `vi.resetModules()` between tests gives dsp/wavetable.ts a fresh
 * `wavetableCache` and build counter each time, so "already ran at module
 * load" and "never runs again during process()" are each observed from a
 * cold cache rather than riding on another test's warm one.
 */

class FakeAudioWorkletProcessor {
  readonly port = {} as MessagePort
}

function installWorkletGlobals(): { registerProcessor: ReturnType<typeof vi.fn> } {
  const registerProcessor = vi.fn()
  Object.assign(globalThis, {
    sampleRate: 48000,
    currentFrame: 0,
    currentTime: 0,
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    registerProcessor,
  })
  return { registerProcessor }
}

function uninstallWorkletGlobals(): void {
  for (const name of ['sampleRate', 'currentFrame', 'currentTime', 'AudioWorkletProcessor', 'registerProcessor']) {
    delete (globalThis as Record<string, unknown>)[name]
  }
}

type ProcessorCtor = new () => { process(...args: unknown[]): boolean }

function findProcessor(
  registerProcessor: ReturnType<typeof vi.fn>,
  name: string,
): ProcessorCtor {
  const call = registerProcessor.mock.calls.find((c) => c[0] === name)
  if (!call) throw new Error(`registerProcessor was never called with "${name}"`)
  return call[1] as ProcessorCtor
}

describe('A1: wavetable generation timing', () => {
  beforeEach(() => {
    vi.resetModules()
    installWorkletGlobals()
  })

  afterEach(() => {
    uninstallWorkletGlobals()
  })

  it('builds the wavetable set as a side effect of loading vco.worklet.ts, before any processor is constructed', async () => {
    const wavetable = await import('../../../src/engine/dsp/wavetable')
    expect(wavetable.debugWavetableBuildCount()).toBe(0)

    await import('../../../src/engine/worklets/vco.worklet')

    // Nothing has been rendered yet -- no processor even constructed -- so
    // any build that already happened had to come from module top level.
    expect(wavetable.debugWavetableBuildCount()).toBeGreaterThan(0)
  })

  it('never builds a wavetable while the VCO is generating samples', async () => {
    const wavetable = await import('../../../src/engine/dsp/wavetable')
    const { registerProcessor } = installWorkletGlobals()
    await import('../../../src/engine/worklets/vco.worklet')

    const before = wavetable.debugWavetableBuildCount()
    expect(before).toBeGreaterThan(0) // sanity: the set exists before we render anything

    const Vco = findProcessor(registerProcessor, 'vco')
    const proc = new Vco()
    const out = [new Float32Array(128)]
    const params = {
      tune: new Float32Array([0]),
      octave: new Float32Array([0]),
      shape: new Float32Array([0]), // 'saw' -- the shape that used to trigger the build
      pulseWidth: new Float32Array([0.5]),
      fmAmount: new Float32Array([0]),
    }

    // 50 render quanta -- comfortably past "the first non-sine sample".
    for (let block = 0; block < 50; block++) {
      proc.process([[], [], []], [out], params)
    }

    expect(wavetable.debugWavetableBuildCount()).toBe(before)
  })

  it('builds the wavetable set as a side effect of loading segment.worklet.ts (the LFO), before any processor is constructed', async () => {
    const wavetable = await import('../../../src/engine/dsp/wavetable')
    expect(wavetable.debugWavetableBuildCount()).toBe(0)

    await import('../../../src/engine/worklets/segment.worklet')

    expect(wavetable.debugWavetableBuildCount()).toBeGreaterThan(0)
  })

  it('never builds a wavetable while the LFO is generating samples', async () => {
    const wavetable = await import('../../../src/engine/dsp/wavetable')
    const { registerProcessor } = installWorkletGlobals()
    await import('../../../src/engine/worklets/segment.worklet')

    const before = wavetable.debugWavetableBuildCount()
    expect(before).toBeGreaterThan(0)

    const Lfo = findProcessor(registerProcessor, 'lfo')
    const proc = new Lfo()
    const out = [new Float32Array(128)]
    const params = {
      rate: new Float32Array([2]),
      shape: new Float32Array([0]), // 'saw'
      depth: new Float32Array([1]),
    }

    for (let block = 0; block < 50; block++) {
      proc.process([[]], [out], params)
    }

    expect(wavetable.debugWavetableBuildCount()).toBe(before)
  })
})
