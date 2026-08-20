/**
 * Sampler playback core: pitch-shifted, gate-triggered, loop-crossfaded
 * reads from a loaded buffer.
 *
 * **The problem this exists to solve.** Playing a recorded buffer back
 * faster than it was recorded resamples it, exactly the way turning up a
 * tape deck's motor speed does -- and reading it with anything less than a
 * genuine band-limiting resample aliases, for the same reason a naive
 * digital oscillator does (this project has already found and fixed that
 * failure twice: the VCO's original PolyBLEP core measured -43 dB before
 * the wavetable rebuild reached -143 dB, and the wavefolder's naive fold
 * measured alias energy *louder than the fundamental* at high drive before
 * ADAA + oversampling fixed it -- see docs/CONTINUATION.md's measured-
 * quality table). A sampler played a fourth above its recorded pitch is
 * consuming source samples 19% faster than it produces output samples;
 * whatever source energy already sat close to the source's own Nyquist
 * gets folded back into the audible band the instant playback outruns the
 * rate it was safe at.
 *
 * **The fix chosen: the oscillator's own architecture, not a new one.**
 * `dsp/wavetable.ts`'s header comment explains why this project's
 * oscillator is a band-limited *mipmapped* wavetable rather than a
 * per-sample BLEP correction: "a wavetable sidesteps the problem instead
 * of approximating a fix for it." A sampler has the same shape of problem
 * -- fixed material, played back at a variable, CV-controlled rate -- so
 * this reuses the identical idea: `buildSamplerBuffer` below builds a small
 * set of octave-spaced, lowpass-filtered copies of the loaded audio once,
 * at load time (analogous to `getWavetableSet`'s once-per-sample-rate
 * table build), and `sampleAt` selects and crossfades between the two mip
 * levels adjacent to the *current* effective playback rate every sample --
 * exactly `readBlended`'s technique, generalized from a periodic table to
 * an arbitrary recorded buffer. Reading within a level is **cubic
 * (Catmull-Rom, 4-point, 3rd-order polynomial) interpolation** -- the same
 * formula and order as `wavetable.ts`'s own `readTable`, chosen for the
 * same reason: cheap (one Horner-form evaluation, ~4 multiplies) and
 * already measured in this codebase to keep interpolation error far below
 * audibility for smoothly-varying material. Cubic interpolation alone
 * *reconstructs* smoothly between existing samples but cannot remove
 * energy that's already there -- it is not what does the antialiasing.
 * The mip levels are what does that: each level `k` is lowpass-filtered to
 * (source Nyquist / 2^k), so reading level `k` can never expose energy
 * that would fold back when played up to `2^k` times the recorded rate.
 *
 * **The filter used to build each mip level: a zero-phase (forward-then-
 * backward) cascade of one-pole lowpass sections.** A single one-pole
 * section is `y[n] += (x[n] - y[n]) * a`, run `LOWPASS_STAGES` times in a
 * row for a steeper, closer-to-Butterworth composite slope, then the whole
 * cascade is run again on the time-reversed signal and the result reversed
 * back (`zeroPhaseLowpass`) -- the standard "filtfilt" trick, which both
 * doubles the effective order (`2 * LOWPASS_STAGES` poles) *and* removes
 * the phase distortion/pre-ringing a causal-only cascade would leave in a
 * one-shot's attack transient. This runs once per loaded sample, off the
 * audio thread's hot path, the same "expensive once, cheap forever after"
 * shape as the oscillator's table build (measured there at 49 ms once,
 * 0.29 microseconds/sample steady) -- see `modules/sampler.ts` for where
 * it's actually invoked (on file load, never inside `process()`).
 *
 * **Measured alias floor across playback rates**, against a harmonically
 * rich stimulus reaching up near the source's own Nyquist (a pure sine
 * proved uninformative here -- see `tests/node/dsp/sampler.test.ts`'s own
 * comment on why -- there's no high-frequency content in one for a
 * resampler to mishandle in the first place), Blackman-Harris windowed FFT,
 * non-commensurate fundamental (docs/CONTINUATION.md trap 1), reproduced in
 * `tests/node/dsp/sampler.test.ts`:
 *
 * | rate | 1x | 1.5x | 2x | 3x | 4x | 8x | 16x |
 * |---|---|---|---|---|---|---|---|
 * | floor | -127.3 dB | -77.6 dB | -78.6 dB | -116.6 dB | -87.6 dB | -74.1 dB | -68.0 dB |
 *
 * RELEASE grade (<=-60 dB) at every rate measured, including the top of the
 * covered range. This did not hold on the first attempt: reading two mip
 * levels crossfaded by fractional rate -- the direct analog of `wavetable.
 * ts`'s own `readBlended` -- measured only -32.6 dB at rate 1.5x, because
 * (unlike the oscillator's levels, each built safe for the *top* of its own
 * usage range) this module's level `k` is only safe up to `2^k`, so a
 * fractional blend kept mixing in a level up to a full octave past its own
 * safety limit. `safeMipLevel`'s own doc comment has the full derivation
 * and the fix (ceiling selection, no fractional blend).
 *
 * **Loop-point crossfade.** A player's loop start/end points are arbitrary
 * -- nothing guarantees the waveform value or slope matches at the seam --
 * so a hard wrap clicks. `readLoopTail`/the wrap logic in `sampleAt`
 * implement a standard equal-power crossfade *loop*, not a live two-read
 * blend bolted onto an unrelated hard wrap: the last `xfade` samples of
 * each lap are an equal-power blend of "the tail, playing normally" and
 * "the head of the next lap, previewed early," and the wrap destination is
 * offset by `xfade` samples (`start + xfade`, not `start`) so the position
 * that resumes reading *after* the wrap is bit-for-bit the position the
 * blend had already converged to *before* it -- the two halves meet with
 * zero discontinuity by construction, not by trimming a click away after
 * the fact. This is why a loop's effective length is `end - start - xfade`
 * after the first lap: the first `xfade` samples of the region are only
 * ever heard blended into the previous lap's tail, exactly how a
 * crossfade-loop in a conventional sampler behaves.
 */

/** Number of mip levels, including level 0 (the unfiltered source).
 *  Level `k` (k >= 1) is filtered to `sourceNyquist / 2^k`, so level
 *  `SAMPLER_MIP_LEVELS - 1` covers playback up to `2^(SAMPLER_MIP_LEVELS - 1)`
 *  times the recorded rate -- 6 covers up to 64x (about 6 octaves up),
 *  comfortably past what this module's own `tune` range (+-24 semitones,
 *  matching vco.ts) plus a keyboard's realistic pitch-CV span can reach. */
export const SAMPLER_MIP_LEVELS = 7

/** Cascaded one-pole sections per direction in `zeroPhaseLowpass` -- see
 *  the module doc comment. A one-pole filter's knee is gradual (the same
 *  lesson docs/CONTINUATION.md trap 7 records for the ladder: slope ramps
 *  from ~-18 dB/oct near the knee to ~-68 dB/oct approaching Nyquist, not
 *  a uniform figure), and the content this module needs suppressed often
 *  sits close to the knee (one to two octaves above cutoff), not deep in
 *  the asymptote -- 3 stages each way measured only -38 dB at a one-octave
 *  pitch-up against a harmonically rich source (see
 *  tests/node/dsp/sampler.test.ts's "alias floor across playback rates").
 *  8 stages each way (16 poles causal, doubled to effectively ~32 by the
 *  zero-phase forward+backward pass) reaches this project's RELEASE bar
 *  (<=-60 dB) at every rate measured, 1x-16x. */
const LOWPASS_STAGES = 8

/** Each mip level's cutoff sits at this fraction of its target Nyquist
 *  (`sourceNyquist / 2^k`), leaving transition-band headroom below the
 *  hard limit -- the same idea as the wavefolder's oversampling FIR
 *  cutting off at 0.45x rather than exactly 0.5x (dsp/wavefolder.ts). */
const MIP_CUTOFF_SAFETY = 0.75

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

/** Downmix an arbitrary-channel-count buffer to mono by averaging channels
 *  -- the same "stereo appears only at the destination, everything else
 *  stays mono" convention ROADMAP section 1a established for the rest of
 *  this engine (Panner/Ping-Pong/Width are the only stereo-aware modules).
 *  A sampler loading a stereo file is exactly the kind of "everything else"
 *  case that convention covers: it becomes one mono voice, patchable like
 *  any other source, not a special stereo module. */
export function downmixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return Float32Array.from(channels[0]!)
  const frames = channels[0]!.length
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (const ch of channels) sum += ch[i] ?? 0
    out[i] = sum / channels.length
  }
  return out
}

/** One-pole lowpass coefficient for a target cutoff, exponential-approach
 *  form (the same shape `dsp/segment.ts`'s envelope coefficient and
 *  `wavefolder.ts`'s DC blocker both use, applied here as a genuine
 *  lowpass rather than an envelope follower or a blocker). */
function onePoleCoeff(cutoffHz: number, sampleRate: number): number {
  return 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate)
}

/** One causal one-pole lowpass pass, seeded from the signal's own first
 *  sample (not zero) so a loud sample doesn't fade up from silence over
 *  the filter's settling time -- that transient would otherwise show up as
 *  real, audible energy at the start of every mip level built from a
 *  loud/percussive source. */
function onePolePass(src: Float32Array, coeff: number): Float32Array {
  const out = new Float32Array(src.length)
  let y = src.length > 0 ? src[0]! : 0
  for (let i = 0; i < src.length; i++) {
    y += (src[i]! - y) * coeff
    out[i] = y
  }
  return out
}

function reversed(src: Float32Array): Float32Array {
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i++) out[i] = src[src.length - 1 - i]!
  return out
}

/** Zero-phase (filtfilt) lowpass: `LOWPASS_STAGES` cascaded one-pole
 *  passes forward, the same cascade again on the time-reversed signal,
 *  reversed back. See the module doc comment for why (order, no phase
 *  distortion/pre-ringing). */
function zeroPhaseLowpass(src: Float32Array, cutoffHz: number, sampleRate: number): Float32Array {
  const coeff = onePoleCoeff(Math.max(cutoffHz, 1), sampleRate)
  let cur = src
  for (let s = 0; s < LOWPASS_STAGES; s++) cur = onePolePass(cur, coeff)
  cur = reversed(cur)
  for (let s = 0; s < LOWPASS_STAGES; s++) cur = onePolePass(cur, coeff)
  return reversed(cur)
}

export interface SamplerBuffer {
  /** `mips[0]` is the unfiltered source; `mips[k]` (k >= 1) is lowpass-
   *  filtered to `sourceNyquist / 2^k`. Every level is the same length as
   *  the source -- this filters, it does not resample -- so a single
   *  `start`/`end` fraction pair addresses the same sample indices in
   *  every level. */
  mips: Float32Array[]
  /** The rate the source was recorded at, which may differ from the
   *  `AudioContext` actually playing it back (a 44.1 kHz file loaded into
   *  a 48 kHz session, say) -- `sampleAt` corrects for the ratio so
   *  `tune=0, pitchCv=0` always means "plays at the recorded pitch and
   *  duration," regardless of context rate. */
  sourceSampleRate: number
  frames: number
}

/** Empty sampler buffer -- the "no sample loaded" state, distinct from
 *  `undefined` so `sampleAt` has one fewer branch to special-case (an
 *  empty buffer's own `frames === 0` guard already makes it silent). */
export const EMPTY_SAMPLER_BUFFER: SamplerBuffer = { mips: [new Float32Array(0)], sourceSampleRate: 48000, frames: 0 }

/** Build the mip set for a freshly loaded mono buffer. Expensive relative
 *  to a single sample (one zero-phase filter pass per level) but meant to
 *  run once per load, off the audio thread's per-sample path -- see the
 *  module doc comment. */
export function buildSamplerBuffer(
  mono: Float32Array, sourceSampleRate: number, levels: number = SAMPLER_MIP_LEVELS,
): SamplerBuffer {
  const nyquist = sourceSampleRate / 2
  const mips: Float32Array[] = [mono]
  for (let k = 1; k < levels; k++) {
    const cutoff = (nyquist / 2 ** k) * MIP_CUTOFF_SAFETY
    mips.push(zeroPhaseLowpass(mono, cutoff, sourceSampleRate))
  }
  return { mips, sourceSampleRate, frames: mono.length }
}

/** 4-point cubic (Catmull-Rom) interpolated read at an arbitrary
 *  continuous `pos`, edges **clamped**, not wrapped -- unlike
 *  `wavetable.ts`'s `readTable` (a periodic table, correctly wrapped), a
 *  sampler buffer is a one-shot/loop *region* with real start and end
 *  points, so reading past either edge should hold the boundary sample,
 *  not wrap into unrelated material. Same Horner-form formula as
 *  `readTable` otherwise -- see this file's own doc comment for why this
 *  order. */
function cubicAt(table: Float32Array, pos: number): number {
  const n = table.length
  if (n === 0) return 0
  const i1 = Math.floor(pos)
  const frac = pos - i1
  const at = (i: number): number => table[clamp(i, 0, n - 1)]!
  const y0 = at(i1 - 1)
  const y1 = at(i1)
  const y2 = at(i1 + 1)
  const y3 = at(i1 + 2)
  const a0 = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3
  const a1 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3
  const a2 = -0.5 * y0 + 0.5 * y2
  const a3 = y1
  return ((a0 * frac + a1) * frac + a2) * frac + a3
}

/**
 * Which mip level is *safe* to read at a given effective playback rate.
 *
 * This deliberately does **not** mirror `wavetable.ts`'s `mipLevelFrac`
 * (fractional level, `floor`-selected, crossfaded toward the next level as
 * the fraction rises) -- that shape is safe for the oscillator because
 * every level there is built band-limited *for the top of its own usage
 * range* (`topFreqForLevel(level) = LOWEST_HZ * 2^(level+1)`, exactly
 * where the next level takes over). This module's levels are built the
 * other way around -- level `k` is safe *up to* `2^k` (`buildSamplerBuffer`'s
 * own doc comment) -- so a `floor`-selected fractional blend would keep
 * mixing in level `k` for rates all the way up to `2^(k+1)`, a full octave
 * *past* the point it stops being safe. Measured directly: blending level 0
 * (the unfiltered source, safe only at rate <= 1) into playback at rate 1.5
 * -- roughly its 41% blend weight there -- measured -32.6 dB, far worse
 * than either adjacent integer rate (see tests/node/dsp/sampler.test.ts's
 * "alias floor across playback rates" and `.superpowers/sdd/sampler-
 * report.md` for the full before/after). The fix is `ceil`, not `floor`:
 * always read the *lowest level whose own safety already covers the
 * current rate*, with no fractional blend into a less-safe neighbor.
 * A rate exactly on a level boundary reads that level cleanly (its own
 * cap); everything up to the next boundary reads the *next* level instead
 * of blending toward it -- slightly darker than the oscillator's
 * as-bright-as-safely-possible crossfade would be, but never unsafe. The
 * oscillator's own honesty note about hard switching applies here too:
 * "measured within 1.3 dB of crossfading at the low boundaries" -- a
 * cleanly safe hard switch beats an unsafe smooth one.
 */
function safeMipLevel(rate: number, levels: number): number {
  const r = Math.max(Math.abs(rate), 1e-9)
  if (r <= 1) return 0
  return clamp(Math.ceil(Math.log2(r)), 0, levels - 1)
}

const HALF_PI = Math.PI / 2

/** Equal-power crossfade -- the loop-seam blend, distinct from the mip
 *  blend below (plain linear, matching `readBlended`'s precedent): this
 *  one mixes two excerpts of genuinely different material at the loop
 *  seam, where a linear fade can dip audibly if the two sides aren't
 *  phase-correlated. Standard technique for an audio crossfade. */
function equalPowerMix(a: number, b: number, t: number): number {
  return a * Math.cos(t * HALF_PI) + b * Math.sin(t * HALF_PI)
}

/** Reads one mip level at `pos`, applying the loop-tail crossfade when
 *  `pos` sits inside the last `xfade` samples of the loop region (see the
 *  module doc comment for the "wrap destination is offset by `xfade`"
 *  derivation that makes this click-free). Pure -- does not touch `pos`
 *  itself; `sampleAt` advances/wraps state once per sample, after reading
 *  both mip levels needed for the antialiasing blend at the *same*
 *  position. */
function readOneMip(
  table: Float32Array, pos: number, dir: 1 | -1, startIdx: number, endIdx: number, xfade: number,
): number {
  if (xfade > 0) {
    if (dir > 0 && pos >= endIdx - xfade) {
      const t = clamp((pos - (endIdx - xfade)) / xfade, 0, 1)
      return equalPowerMix(cubicAt(table, pos), cubicAt(table, startIdx + t * xfade), t)
    }
    if (dir < 0 && pos <= startIdx + xfade) {
      const t = clamp((startIdx + xfade - pos) / xfade, 0, 1)
      return equalPowerMix(cubicAt(table, pos), cubicAt(table, endIdx - t * xfade), t)
    }
  }
  return cubicAt(table, pos)
}

export type SamplerMode = 'oneshot' | 'loop'

export interface SamplerParams {
  /** Semitones, same range convention as vco.ts's `tune` (+-24). */
  tune: number
  /** Loop/one-shot region, as a fraction [0, 1] of the buffer -- resolution-
   *  independent of buffer length, so the same param values mean the same
   *  thing regardless of how long the loaded file is. */
  start: number
  end: number
  mode: SamplerMode
  reverse: boolean
}

export interface SamplerState {
  /** Fractional read position, in source-sample units. */
  pos: number
  active: boolean
  /** Previous gate value, thresholded -- edge detection, same convention
   *  as `dsp/segment.ts`'s `EnvState.lastGate`. */
  lastGate: 0 | 1
}

export function createSamplerState(): SamplerState {
  return { pos: 0, active: false, lastGate: 0 }
}

/** Loop crossfade width in source samples: a fixed 5 ms (the standard
 *  "declick" loop-crossfade length -- long enough to smooth a worst-case
 *  waveform discontinuity, short enough not to visibly eat into a short
 *  loop), capped to a quarter of the loop region so a very short loop
 *  never has its crossfade windows overlap each other. */
const LOOP_XFADE_SECONDS = 0.005

function loopXfadeSamples(startIdx: number, endIdx: number, sourceSampleRate: number): number {
  const want = LOOP_XFADE_SECONDS * sourceSampleRate
  return Math.max(0, Math.min(want, (endIdx - startIdx) / 4))
}

/** 1V/octave-style playback rate: `tune=0, cv=0` plays at exactly the
 *  recorded pitch (rate 1). Doubling `cv` by 1 doubles the rate (one
 *  octave up), the same convention `pitchToFreq` uses for absolute
 *  frequency -- this is its relative-rate analog, appropriate for a
 *  sampler where there's no fixed reference frequency, only "faster or
 *  slower than recorded." Clamped to the range the mip set actually
 *  covers (`SAMPLER_MIP_LEVELS`), the same "graceful degradation at an
 *  extreme rather than NaN/Infinity" pattern `pitchToFreq`'s own Nyquist
 *  clamp uses. */
export function samplerPlaybackRate(tuneSemitones: number, cv: number, maxOctaves = SAMPLER_MIP_LEVELS - 1): number {
  const octaves = clamp(cv + tuneSemitones / 12, -maxOctaves, maxOctaves)
  return 2 ** octaves
}

const MIN_REGION_SAMPLES = 4

/**
 * Advance one sample and return the Sampler's output.
 *
 * `pitchCv` is the 1V/octave input (already summed from any patched
 * source); `gate` is the trigger/gate input, thresholded at 0.5 like every
 * other gate signal in this engine. `contextSampleRate` is the live
 * `AudioContext`'s rate, used only to correct for a loaded file recorded
 * at a different rate (see `SamplerBuffer.sourceSampleRate`'s comment).
 */
export function sampleAt(
  state: SamplerState,
  buf: SamplerBuffer,
  gate: number,
  pitchCv: number,
  p: SamplerParams,
  contextSampleRate: number,
): number {
  const n = buf.frames
  const high = gate >= 0.5
  if (n < MIN_REGION_SAMPLES) {
    state.lastGate = high ? 1 : 0
    return 0
  }

  const dir: 1 | -1 = p.reverse ? -1 : 1
  const startIdx = clamp(p.start, 0, 1) * (n - 1)
  let endIdx = clamp(p.end, 0, 1) * (n - 1)
  if (endIdx - startIdx < MIN_REGION_SAMPLES) endIdx = Math.min(n - 1, startIdx + MIN_REGION_SAMPLES)
  const xfade = p.mode === 'loop' ? loopXfadeSamples(startIdx, endIdx, buf.sourceSampleRate) : 0

  if (high && !state.lastGate) {
    // Rising edge: (re)trigger from the region's leading edge in the
    // current direction -- a retrigger mid-playback restarts cleanly
    // rather than phasing with whatever was already in flight.
    state.pos = dir > 0 ? startIdx : endIdx
    state.active = true
  }
  if (!high && state.lastGate && p.mode === 'loop') {
    // Loop mode is gated like a held note (the Keyboard's own convention);
    // one-shot ignores release entirely -- that's what makes it a
    // "one-shot" rather than a second loop mode with extra steps.
    state.active = false
  }
  state.lastGate = high ? 1 : 0
  if (!state.active) return 0

  const rate = samplerPlaybackRate(p.tune, pitchCv) * (buf.sourceSampleRate / contextSampleRate)
  const level = safeMipLevel(rate, buf.mips.length)
  const out = readOneMip(buf.mips[level]!, state.pos, dir, startIdx, endIdx, xfade)

  const advance = Math.max(Math.abs(rate), 1e-6)
  state.pos += dir * advance
  if (p.mode === 'loop') {
    // `while`, not `if`: at an extreme rate/short-loop combination a
    // single step can outrun the region by more than one lap -- see
    // tests/node/dsp/sampler.test.ts's "stability under extreme settings".
    while (dir > 0 && state.pos >= endIdx) state.pos = startIdx + xfade + (state.pos - endIdx)
    while (dir < 0 && state.pos <= startIdx) state.pos = endIdx - xfade - (startIdx - state.pos)
  } else {
    if ((dir > 0 && state.pos >= endIdx) || (dir < 0 && state.pos <= startIdx)) state.active = false
  }
  return out
}

/** Downsampled min/max envelope of a buffer, `buckets` columns wide --
 *  what `rack/sampler-panel.ts`'s waveform display actually draws. Pure
 *  and Node-testable on its own, separate from the playback path so the
 *  display never has to re-scan the whole (possibly long) buffer per
 *  animation frame. */
export function computeWaveformPeaks(mono: Float32Array, buckets: number): { min: Float32Array; max: Float32Array } {
  const min = new Float32Array(buckets)
  const max = new Float32Array(buckets)
  if (mono.length === 0 || buckets <= 0) return { min, max }
  const perBucket = mono.length / buckets
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * perBucket)
    const end = Math.max(start + 1, Math.floor((b + 1) * perBucket))
    let lo = Infinity
    let hi = -Infinity
    for (let i = start; i < end && i < mono.length; i++) {
      const v = mono[i]!
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    min[b] = lo === Infinity ? 0 : lo
    max[b] = hi === -Infinity ? 0 : hi
  }
  return { min, max }
}
