/**
 * Test-only instrumentation for tests/browser/startup-thump.test.ts.
 *
 * Not imported by index.html / dev/main.ts and has no effect on the real
 * dev harness -- Playwright loads this file directly via
 * `page.addScriptTag({ url: '/dev/thump-harness.ts' })` against the same
 * Vite dev server that serves the real page, so it goes through the same
 * on-the-fly TS transform `dev/main.ts` does.
 *
 * It replicates the exact module-construction and cable order
 * `dev/main.ts`'s `start()` uses to build the VCO -> VCF -> VCA voice --
 * the same order that produces the power-on thump this test exists to
 * catch -- but wires an `AudioWorkletNode` peak-tap onto the VCA's output
 * before any of that construction happens, so it captures every sample
 * from the moment the graph exists, on the audio thread itself. Polling
 * from the main thread (a `ScriptProcessorNode`, or reading an
 * `AnalyserNode` on a `requestAnimationFrame` cadence) is exactly what the
 * investigation this fixes found unreliable for a transient this short
 * (2/42 boots vs. 30/30 with an audio-thread tap).
 */
import { PatchGraph } from '../src/engine/graph'
import { registerAllModules } from '../src/engine/modules'
import { getModule } from '../src/engine/registry'
import { ensureWorklets } from '../src/engine/render'

export interface ThumpResult {
  /** Peak absolute sample value across the whole capture window, in dBFS. */
  peakDb: number
  /** Sample index (0-based) of that peak. */
  peakSampleIndex: number
  /** Index of the last sample whose magnitude exceeds SILENCE_THRESHOLD --
   *  i.e. how long the transient takes to become inaudible. -1 if the
   *  capture never exceeds the threshold at all. */
  lastLoudSampleIndex: number
  /** lastLoudSampleIndex converted to milliseconds from graph construction. */
  durationMs: number
  totalSamples: number
  sampleRate: number
  /** Reassembly diagnostics. The tap posts one message per render quantum;
   *  the fields below make a dropped message visible instead of letting the
   *  naive concatenation below splice two non-adjacent quanta into a fake
   *  discontinuity. See the consuming test for why this is kept. */
  diag?: {
    chunkCount: number
    gaps: { concatIndex: number; missing: number }[]
    peakNeighborhood: number[]
    peakFrame: number | null
  }
}

const SILENCE_THRESHOLD = 0.001 // -60 dBFS, same floor tests/browser/dev-page.test.ts uses

function dbfs(x: number): number {
  return 20 * Math.log10(Math.max(x, 1e-12))
}

/**
 * Runs the boot repro once and resolves with the measured peak. Must be
 * called from inside a real, trusted user-gesture handler (a synthetic
 * `dispatchEvent` click leaves the AudioContext suspended and this never
 * produces samples) -- see the test file for how the click is delivered.
 */
async function runThumpBoot(captureMs = 300): Promise<ThumpResult> {
  if (!getModule('vco')) registerAllModules()

  const ctx = new AudioContext()
  await ensureWorklets(ctx)
  if (ctx.state === 'suspended') await ctx.resume()

  // The tap is wired up before a single module exists, so it is listening
  // for the entire lifetime of the graph below.
  const tap = new AudioWorkletNode(ctx, 'peak-tap', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  })
  const mute = ctx.createGain()
  mute.gain.value = 0 // silent passthrough -- this test must never make real sound
  tap.connect(mute)
  mute.connect(ctx.destination)

  const chunks: { frame: number; samples: Float32Array }[] = []
  tap.port.onmessage = (e: MessageEvent<{ frame: number; samples: Float32Array }>) => {
    chunks.push(e.data)
  }

  const graph = new PatchGraph(ctx)
  const vco = graph.addModule('vco', 'vco')
  const vcf = graph.addModule('vcf', 'vcf')
  const vca = graph.addModule('vca', 'vca')
  const adsr = graph.addModule('adsr', 'adsr')

  // Tap the VCA's output from construction, exactly like the real voice's
  // "out" port would feed the output module.
  graph.getInstance(vca)!.outputs.get('out')!.connect(tap)

  // From here down: the same module-build and cable order as
  // dev/main.ts's start(), for the subset of the voice that matters to the
  // thump (VCO -> VCF -> VCA, ADSR gating the VCA's CV). Nothing here
  // plays a note -- no gate is ever opened -- matching "before you play a
  // note".
  graph.connect([vco, 'out'], [vcf, 'in'])
  graph.connect([adsr, 'out'], [vca, 'cv'])
  // The ADSR gates the VCA entirely through CV: base level 0, CV amount 1,
  // so the envelope (0..1) is the gain, not an offset added to a fader.
  // `atTime` snaps this in place -- it is the voice's starting point, not
  // a live knob turn -- exactly matching dev/main.ts's real boot. See that
  // file's comment on the identical calls for why it matters.
  graph.setParam(vca, 'level', 0, ctx.currentTime)
  graph.setParam(vca, 'cvAmount', 1, ctx.currentTime)
  // The signal path's last cable, exactly as dev/main.ts's
  // rebuildSignalPath() makes it the last thing wired in.
  graph.connect([vcf, 'out'], [vca, 'in'])

  await new Promise((resolve) => setTimeout(resolve, captureMs))
  await ctx.close()

  chunks.sort((a, b) => a.frame - b.frame)
  const total = chunks.reduce((n, c) => n + c.samples.length, 0)
  const samples = new Float32Array(total)
  let i = 0
  for (const c of chunks) {
    samples.set(c.samples, i)
    i += c.samples.length
  }

  let peak = 0
  let peakSampleIndex = -1
  let lastLoudSampleIndex = -1
  for (let n = 0; n < samples.length; n++) {
    const abs = Math.abs(samples[n]!)
    if (abs > peak) {
      peak = abs
      peakSampleIndex = n
    }
    if (abs > SILENCE_THRESHOLD) lastLoudSampleIndex = n
  }

  const gaps: { concatIndex: number; missing: number }[] = []
  for (let k = 1; k < chunks.length; k++) {
    const expected = chunks[k - 1]!.frame + chunks[k - 1]!.samples.length
    if (chunks[k]!.frame !== expected)
      gaps.push({ concatIndex: k * 128, missing: chunks[k]!.frame - expected })
  }
  let peakFrame: number | null = null
  if (peakSampleIndex >= 0) {
    let acc = 0
    for (const c of chunks) {
      if (peakSampleIndex < acc + c.samples.length) {
        peakFrame = c.frame + (peakSampleIndex - acc)
        break
      }
      acc += c.samples.length
    }
  }

  return {
    diag: {
      chunkCount: chunks.length,
      gaps,
      peakNeighborhood:
        peakSampleIndex < 0
          ? []
          : Array.from(samples.slice(Math.max(0, peakSampleIndex - 3), peakSampleIndex + 4)),
      peakFrame,
    },
    peakDb: dbfs(peak),
    peakSampleIndex,
    lastLoudSampleIndex,
    durationMs: lastLoudSampleIndex < 0 ? 0 : (lastLoudSampleIndex / ctx.sampleRate) * 1000,
    totalSamples: samples.length,
    sampleRate: ctx.sampleRate,
  }
}

declare global {
  interface Window {
    __runThumpBoot: typeof runThumpBoot
  }
}
window.__runThumpBoot = runThumpBoot
