import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'
import {
  buildSamplerBuffer, downmixToMono, computeWaveformPeaks, type SamplerBuffer,
} from '../dsp/sampler'
import { encodeWav, decodeWav } from '../wav'
import { bytesToBase64, base64ToBytes } from '../base64'

/** Number of columns `getWaveform()` downsamples to for the panel's canvas
 *  -- fixed and generous enough for any panel width the rack draws this
 *  module at; `rack/sampler-panel.ts` decides how many of them to actually
 *  paint. Computed once per load, not per animation frame (computeWaveformPeaks's own doc comment). */
const WAVEFORM_BUCKETS = 600

export interface SamplerWaveform {
  min: Float32Array
  max: Float32Array
  fileName: string
  durationSeconds: number
}

/** Widened the same way `ScopeInstance`/`OutputInstance` are (see
 *  scope.ts's own doc comment for why `ModuleInstance` itself has no room
 *  for a module-specific extra handle): `rack/sampler-panel.ts`, the
 *  `customPanel` this descriptor registers, narrows `PatchGraph.
 *  getInstance()`'s return to this type to reach the load/waveform surface
 *  no generic `ParamSpec` can express. */
export interface SamplerInstance extends ModuleInstance {
  /** Downmixes, builds the antialiasing mip set (see dsp/sampler.ts) and
   *  hands it to the worklet. `sampleRate` is the buffer's own recorded
   *  rate (`AudioBuffer.sampleRate`), not the live context's. */
  loadBuffer(channels: readonly Float32Array[], sampleRate: number, fileName: string): void
  clearBuffer(): void
  /** `undefined` when nothing is loaded -- the panel's empty state. */
  getWaveform(): SamplerWaveform | undefined
}

/**
 * A pitch-shifted, gate-triggered sample player -- the missing primitive
 * for the whole recorded-instrument half of synthesis history (the
 * Mellotron, the Fairlight, hip-hop and jungle sampling -- see
 * docs/history-of-synthesis-research.md's "not reachable with what
 * exists" list, which named this module by name). Everything about *why*
 * it's built the way it is -- the mipmapped antialiasing architecture, the
 * cubic interpolation, the loop-crossfade math -- lives in dsp/sampler.ts;
 * this file is the module contract, the worklet wiring, and the one
 * genuinely new problem a stateful module raises: **what happens to the
 * loaded audio when the patch is saved.**
 *
 * **Persistence decision.** `.sinp` is plain JSON, and every other module's
 * entire state already fits `Record<string, number>` -- this is the first
 * module in the set whose state doesn't. Three options, all real:
 * (1) embed the audio in the file: inaudibly lossy and portable (the saved
 * patch really is everything needed to reproduce the sound, matching this
 * project's own "a solution and a preset can be one file" precedent for
 * the academy) at the cost of file size; (2) reference a file path: stays
 * small, but a browser has no persistent handle to an arbitrary local file
 * across sessions, so this would either silently break the moment the
 * patch is reopened somewhere else or need a whole file-handle-permission
 * subsystem this task didn't ask for; (3) drop the audio, keep the knobs:
 * simplest, and explicitly named in this task's brief as the worst option
 * -- a player who saves, reloads, and gets silence with no explanation.
 * **This module embeds** (option 1) via `serializeState`/`restoreState`
 * (the generic hook `types.ts`'s `ModuleInstance` gained for exactly this),
 * storing the original downmixed audio as base64-encoded 16-bit PCM WAV
 * (`wav.ts`'s existing encoder/decoder -- already this project's own choice
 * for "half the size, noise below this engine's own DSP floor," reused
 * rather than re-litigated) plus the file name for the panel to display.
 * "Inaudibly lossy," not "lossless": PCM16 quantization measures about
 * -96 dBFS error against the original float32, matching the bitcrusher's
 * own independently-measured bits=16 step -- real, but far below this
 * engine's own DSP noise floor.
 *
 * **A hot sample (peak above unity) does not get silently clipped.**
 * `encodeWav`'s own PCM16 path clamps every sample to [-1, 1] before
 * quantizing (see its doc comment) -- with nothing else done, a sample
 * loaded above unity (plausible from a normalized-above-0 source file, or
 * from anything recorded through this engine's own hot patches) would have
 * its peaks silently and irreversibly shaved off the moment a patch is
 * saved and reloaded, with no warning anywhere. That is exactly the "player
 * saves, reloads, and the sample is quietly different" failure this module
 * chose to embed audio (rather than reference a file path) to avoid.
 * `serializeState` normalises a hot buffer down to unity before encoding
 * and records the one gain number needed to restore the original level;
 * `restoreState` multiplies back up by it. The round trip is exactly as
 * lossy as an already-unity sample's always was (PCM16 quantisation, now
 * scaled by the recorded gain) and never clips. The alternative of storing
 * float32 instead (removing quantisation loss too) was rejected on file
 * size: it would roughly double every embedded sample, and the shipped
 * `sampler-chop.sinp` preset is already 141 KB, nearly all audio. A gain
 * number costs a few bytes; a doubled file costs tens of kilobytes on a
 * preset that already ships. `gain` is omitted from the saved state
 * entirely when the sample was never hot (the overwhelmingly common case),
 * so an ordinary patch's file size is unchanged, and its absence on load
 * (every `.sinp` written before this fix, including the shipped presets and
 * every academy level solution) means "no normalisation was applied" --
 * the old behavior for a sample that was never hot in the first place.
 *
 * The mip set itself is never serialized -- it's rebuilt from the restored
 * mono audio on load, the same as it is on a fresh file drop, since it's
 * cheap relative to the file and storing it would multiply the size by
 * `SAMPLER_MIP_LEVELS` for no benefit.
 *
 * **The honest trade-off, stated plainly rather than discovered:** a patch
 * with a ten-second sample embeds roughly a megabyte of base64 text in its
 * `.sinp`. That is real bloat, and it is the price of the alternative never
 * silently failing -- every other module's patch stays exactly as small as
 * it always was (`state` is omitted entirely when `serializeState` returns
 * `undefined`, see `patch.ts`), so nothing about a sampler-free patch
 * changes. Autosave (`rack/patch-io.ts`'s `saveAutosave`) already treats a
 * `localStorage` write failure as best-effort or a large embedded sample
 * pushes a session over quota, that failure is silent by *that* function's
 * own long-standing design (explicit Save/Load is the durable path there),
 * not a new gap this module introduces.
 */
export const samplerDescriptor: ModuleDescriptor = {
  type: 'sampler',
  name: 'Sampler',
  // 24 HP -- five knob/switch columns (tune, start, end, mode, reverse)
  // need real width per column once the mode/reverse switches' label text
  // is accounted for; the customPanel's waveform display below benefits
  // from the same width. See rack/sampler-panel.ts's own doc comment for
  // the vertical budget this has to fit inside the fixed 3U panel height.
  hp: 24,
  group: 'source',
  customPanel: 'sampler',
  ports: [
    { id: 'pitch', dir: 'in', signal: 'cv', label: '1V/Oct', pos: [0, 1] },
    { id: 'gate', dir: 'in', signal: 'gate', label: 'Gate', pos: [1, 1] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [2, 1] },
  ],
  params: [
    { id: 'tune', label: 'Tune', min: -24, max: 24, default: 0, curve: 'lin', unit: 'st' },
    { id: 'start', label: 'Start', min: 0, max: 1, default: 0, curve: 'lin', unit: '' },
    { id: 'end', label: 'End', min: 0, max: 1, default: 1, curve: 'lin', unit: '' },
    {
      id: 'mode', label: 'Mode', min: 0, max: 1, default: 0, curve: 'lin', unit: '',
      labels: ['One-Shot', 'Loop'],
    },
    {
      id: 'reverse', label: 'Rev', min: 0, max: 1, default: 0, curve: 'lin', unit: '',
      labels: ['Fwd', 'Rev'],
    },
  ],
  layout: [
    { kind: 'knob', ref: 'tune', x: 0, y: 0 },
    { kind: 'knob', ref: 'start', x: 1, y: 0 },
    { kind: 'knob', ref: 'end', x: 2, y: 0 },
    { kind: 'switch', ref: 'mode', x: 3, y: 0 },
    { kind: 'switch', ref: 'reverse', x: 4, y: 0 },
    { kind: 'jack', ref: 'pitch', x: 0, y: 1 },
    { kind: 'jack', ref: 'gate', x: 1, y: 1 },
    { kind: 'jack', ref: 'out', x: 2, y: 1 },
  ],
  create(ctx): SamplerInstance {
    const node = new AudioWorkletNode(ctx, 'sampler', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    const fronts = ['pitch', 'gate'].map((_, index) => {
      const gain = ctx.createGain()
      gain.connect(node, 0, index)
      return gain
    })

    // The module's own copy of the currently loaded mono audio -- kept
    // here, not just inside the worklet, because `serializeState` needs to
    // read it on every save and a worklet's internal state isn't
    // observable from the main thread at all (there is no synchronous
    // "ask the AudioWorkletProcessor what it's holding"). `fileName` and
    // the waveform display's downsampled peaks are derived from the same
    // source, cached alongside it rather than recomputed per animation
    // frame.
    let currentMono: Float32Array | undefined
    let currentSourceSampleRate = ctx.sampleRate
    let currentFileName = ''
    let currentWaveform: SamplerWaveform | undefined

    /** Largest absolute sample value -- how far a buffer sits above (or below)
 *  unity. Used only by `serializeState`/`restoreState` to decide whether a
 *  save needs to normalise before handing samples to `encodeWav`'s PCM16
 *  path, which clamps to [-1, 1] (see this file's own doc comment). */
function peakAbs(mono: Float32Array): number {
  let peak = 0
  for (let i = 0; i < mono.length; i++) {
    const a = Math.abs(mono[i]!)
    if (a > peak) peak = a
  }
  return peak
}

/** `mono` scaled by `factor`, or `mono` itself unchanged when `factor` is 1
 *  -- the identity case is the overwhelmingly common one (no hot sample
 *  loaded), so it skips the allocation and copy entirely. */
function scaledBy(mono: Float32Array, factor: number): Float32Array {
  if (factor === 1) return mono
  const out = new Float32Array(mono.length)
  for (let i = 0; i < mono.length; i++) out[i] = mono[i]! * factor
  return out
}

function postBuffer(buf: SamplerBuffer): void {
      node.port.postMessage({
        type: 'load', mips: buf.mips, sourceSampleRate: buf.sourceSampleRate, frames: buf.frames,
      })
    }

    return {
      inputs: new Map<string, AudioNode | AudioParam>([['pitch', fronts[0]!], ['gate', fronts[1]!]]),
      outputs: new Map([['out', node as AudioNode]]),
      // tune/start/end are continuous (a-rate in the worklet) and smooth
      // through scheduleParam, same as every other continuous param in
      // this codebase (B3). mode/reverse are discrete/switch-like (k-rate)
      // -- a value between One-Shot and Loop, or between Fwd and Rev, is
      // meaningless -- so they snap instantly, the same convention vco.ts's
      // `shape` uses.
      setParam(id, value, atTime) {
        const param = node.parameters.get(id)
        if (!param) return
        if (id === 'mode' || id === 'reverse') param.value = value
        else scheduleParam(param, value, ctx, atTime)
      },
      loadBuffer(channels, sampleRate, fileName) {
        const mono = downmixToMono(channels)
        const buf = buildSamplerBuffer(mono, sampleRate)
        currentMono = mono
        currentSourceSampleRate = sampleRate
        currentFileName = fileName
        currentWaveform = {
          ...computeWaveformPeaks(mono, WAVEFORM_BUCKETS),
          fileName,
          durationSeconds: mono.length / sampleRate,
        }
        postBuffer(buf)
      },
      clearBuffer() {
        currentMono = undefined
        currentFileName = ''
        currentWaveform = undefined
        node.port.postMessage({ type: 'clear' })
      },
      getWaveform() {
        return currentWaveform
      },
      serializeState() {
        if (!currentMono) return undefined
        // A hot sample (peak > 1) would otherwise be hard-clipped by
        // encodeWav's own PCM16 clamp -- normalise it down to unity before
        // encoding and record the gain needed to undo that on restore. See
        // this module's own doc comment ("A hot sample... does not get
        // silently clipped") for why this over storing float32 or clipping
        // with a warning.
        const peak = peakAbs(currentMono)
        const gain = peak > 1 ? peak : 1
        const toEncode = scaledBy(currentMono, 1 / gain)
        const wavBytes = new Uint8Array(encodeWav([toEncode], currentSourceSampleRate, 'pcm16'))
        const state: { fileName: string; wavBase64: string; gain?: number } = {
          fileName: currentFileName,
          wavBase64: bytesToBase64(wavBytes),
        }
        // Omitted (not written as 1) for the overwhelmingly common
        // never-hot case, matching `patch.ts`'s own "no field written for
        // the ordinary case" convention for `state` itself -- an ordinary
        // patch's file size and byte content are unaffected by this fix.
        if (gain > 1) state.gain = gain
        return state
      },
      restoreState(data) {
        if (!data || typeof data !== 'object') return
        const { fileName, wavBase64, gain } = data as { fileName?: unknown; wavBase64?: unknown; gain?: unknown }
        if (typeof wavBase64 !== 'string') return
        const wav = decodeWav(base64ToBytes(wavBase64).buffer as ArrayBuffer)
        // `gain` is absent on every file saved before this fix -- including
        // the shipped presets and every academy level solution -- and
        // absence means "no normalisation was applied," so this reproduces
        // the pre-fix behavior exactly for a sample that was never hot.
        const restoreGain = typeof gain === 'number' && Number.isFinite(gain) && gain > 1 ? gain : 1
        const mono = scaledBy(downmixToMono(wav.channels), restoreGain)
        const buf = buildSamplerBuffer(mono, wav.sampleRate)
        currentMono = mono
        currentSourceSampleRate = wav.sampleRate
        currentFileName = typeof fileName === 'string' ? fileName : ''
        currentWaveform = {
          ...computeWaveformPeaks(mono, WAVEFORM_BUCKETS),
          fileName: currentFileName,
          durationSeconds: mono.length / wav.sampleRate,
        }
        postBuffer(buf)
      },
      dispose() {
        node.disconnect()
        for (const gain of fronts) gain.disconnect()
      },
    }
  },
}
