/**
 * Bitcrusher: bit-depth reduction and sample-rate decimation, plus a
 * circuit-bent-flavored "bend" stutter.
 *
 * **Its aliasing is deliberate. Do not "fix" it.** Every other nonlinear
 * module in this codebase (`wavefolder.ts`, `drive.ts`) exists to remove
 * aliasing a naive implementation would introduce -- ADAA plus 4x
 * oversampling, measured and documented at length. This module is the one
 * deliberate exception: a Speak & Spell, an SP-1200, an early sampler
 * chopped down to 8-bit/26 kHz for cost reasons, all sound the way they do
 * *because* their quantization and resampling are unfiltered. Decimation
 * (`decimate` below) is a plain sample-and-hold at a reduced rate with no
 * anti-alias lowpass in front of it, and quantization (`quantize`) is a
 * bare `round()` with no dither or noise-shaping -- both are exactly the
 * "naive" implementations this project's own history (see docs/
 * CONTINUATION.md's measured-quality table) already proved sound bad on
 * an oscillator or a wavefolder. Here that is correct. The distinction
 * that matters in a codebase this strict about measured alias floors: the
 * oscillator and the wavefolder had a defect that measurement caught; this
 * module has a *feature* that the same measurement technique should be
 * used to verify is present and controllable, not removed.
 *
 * **Bit-depth reduction** (`quantize`): `bits` is continuous, not an
 * integer switch -- `2^bits` need not be a whole number for the step-size
 * formula below to make sense, so CV can sweep bit depth smoothly instead
 * of zippering between integer steps. `step = 2 / (2^bits - 1)` maps
 * `[-1, 1]` onto `2^bits` evenly spaced levels (the same convention a real
 * ADC's full-scale range uses), and `quantize` rounds to the nearest one.
 * At `bits = 16` the step is small enough (~3e-5) to sit far below this
 * engine's own DSP noise floor -- `wav.ts`'s own PCM16 choice already
 * established that 16 bits is inaudibly transparent for this project's
 * signal levels -- so `bits = 16` is this module's "off" position, the
 * same role `drive = 1`/`symmetry = 0` play for the wavefolder. DC offset,
 * measured on a symmetric sine (`tests/node/dsp/bitcrusher.test.ts`'s "DC
 * offset" describe block): -125 to -240 dB across every bit depth 1-16,
 * and -128.6 dB for decimation alone -- a bare `round()` has no dithering,
 * but a signal that crosses zero evenly across many cycles keeps its
 * quantization error balanced regardless.
 *
 * **Sample-rate decimation** (`decimate`): a plain sample-and-hold clocked
 * at `rate` Hz, independent of the bit-depth stage. `rate` at or above the
 * context's own sample rate captures every sample (transparent -- the
 * "off" position); a low `rate` holds each captured sample for many output
 * samples, the classic "crushed," metallic lo-fi texture. No lowpass
 * filtering is inserted anywhere in this path -- see the module doc
 * comment above for why that omission is the point.
 *
 * **Bend** (`bendSample`): a periodic stutter, not a random glitch --
 * deterministic so it's testable and so a player can predict it, in the
 * spirit of a circuit-bent toy's *repeatable* faults (a specific solder
 * bridge always does the same thing) rather than genuine noise. At
 * `bend = 0` it is fully bypassed. As `bend` rises from 0 to 1, three
 * things move together: stutters happen more often (period `BEND_MAX_
 * PERIOD_S` down to `BEND_MIN_PERIOD_S`), each stutter occupies a larger
 * fraction of its period (`BEND_MIN_HOLD_FRAC` up to `BEND_MAX_HOLD_FRAC`),
 * and the repeated chunk gets longer (`BEND_MIN_CHUNK_S` up to `BEND_MAX_
 * CHUNK_S`) -- so turning the knob up reads as "increasingly stuck," a
 * single continuous gesture rather than an on/off toggle. Implementation:
 * the crushed signal is continuously recorded into a small ring buffer;
 * on each period boundary, the last `chunk` samples are copied out and
 * replayed on a loop for `hold` samples before normal playback resumes.
 * This is literally the "glitch/stutter" flavor this module's task named
 * as an alternative to bit-pattern sample-and-hold -- a genuine repeat of
 * real recently-played material, not a randomly broken sample.
 */

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export const MIN_BITS = 1
export const MAX_BITS = 16
export const MIN_RATE_HZ = 100
export const MAX_RATE_HZ = 48000

/** Quantizes `x` (expected in roughly [-1, 1], but not clamped -- a hot
 *  signal quantizes on its own extended range rather than clipping, which
 *  would be a second, unrelated nonlinearity) to `2^bits` evenly spaced
 *  levels across [-1, 1]. */
export function quantize(x: number, bits: number): number {
  const b = clamp(bits, MIN_BITS, MAX_BITS)
  const levels = 2 ** b
  const step = 2 / (levels - 1)
  return Math.round(x / step) * step
}

export interface BitcrusherState {
  /** Sample-and-hold decimator: fractional progress toward the next
   *  capture instant, in units of "one decimated sample period," and the
   *  value captured at the last one. */
  decimPhase: number
  heldValue: number
  /** Small ring buffer of recent crushed output, continuously written --
   *  the source material `bendSample` copies a chunk out of when a
   *  stutter triggers. */
  ring: Float32Array
  ringPos: number
  /** Bend state: samples elapsed in the current period, and (while
   *  stuttering) the frozen chunk being replayed, how far into it, and
   *  how many samples of hold remain. */
  bendPhase: number
  inGlitch: boolean
  glitchChunk: Float32Array
  glitchChunkLen: number
  glitchReadPos: number
  glitchHoldRemaining: number
}

/** Ring buffer sized for the longest chunk `bendSample` can ever request
 *  (`BEND_MAX_CHUNK_S`) at a generous sample rate ceiling -- fixed at
 *  construction so the hot path never allocates. */
const RING_SECONDS_CEILING = 0.1
const RING_SAMPLE_RATE_CEILING = 192000
const RING_LEN = Math.ceil(RING_SECONDS_CEILING * RING_SAMPLE_RATE_CEILING)

export function createBitcrusherState(): BitcrusherState {
  return {
    decimPhase: 1, // >=1 so the very first sample is captured immediately
    heldValue: 0,
    ring: new Float32Array(RING_LEN),
    ringPos: 0,
    bendPhase: 0,
    inGlitch: false,
    glitchChunk: new Float32Array(RING_LEN),
    glitchChunkLen: 0,
    glitchReadPos: 0,
    glitchHoldRemaining: 0,
  }
}

/** Sample-and-hold decimation at `rateHz`, no anti-alias filtering --
 *  see the module doc comment. `rateHz >= sampleRate` captures every
 *  sample (transparent). */
export function decimate(state: BitcrusherState, input: number, rateHz: number, sampleRate: number): number {
  const rate = clamp(rateHz, MIN_RATE_HZ, MAX_RATE_HZ)
  state.decimPhase += rate / sampleRate
  if (state.decimPhase >= 1) {
    state.decimPhase -= Math.floor(state.decimPhase)
    state.heldValue = input
  }
  return state.heldValue
}

const BEND_MAX_PERIOD_S = 2.0
const BEND_MIN_PERIOD_S = 0.12
const BEND_MIN_HOLD_FRAC = 0.08
const BEND_MAX_HOLD_FRAC = 0.55
const BEND_MIN_CHUNK_S = 0.015
const BEND_MAX_CHUNK_S = 0.09

/** Runs the crushed signal through the ring buffer and the stutter state
 *  machine described in the module doc comment. `crushed` must already be
 *  the bit-quantized, decimated signal -- bend operates downstream of
 *  both, replaying real recently-crushed material rather than raw input. */
function bendSample(state: BitcrusherState, crushed: number, bend: number, sampleRate: number): number {
  state.ring[state.ringPos] = crushed
  state.ringPos = (state.ringPos + 1) % state.ring.length

  const amount = clamp(bend, 0, 1)
  if (amount <= 0) {
    state.inGlitch = false
    state.bendPhase = 0
    return crushed
  }

  const periodSamples = Math.max(1, Math.round(lerp(BEND_MAX_PERIOD_S, BEND_MIN_PERIOD_S, amount) * sampleRate))
  state.bendPhase += 1
  if (state.bendPhase >= periodSamples) {
    state.bendPhase = 0
    const holdFrac = lerp(BEND_MIN_HOLD_FRAC, BEND_MAX_HOLD_FRAC, amount)
    const chunkSeconds = lerp(BEND_MIN_CHUNK_S, BEND_MAX_CHUNK_S, amount)
    const chunkLen = clamp(Math.round(chunkSeconds * sampleRate), 1, state.ring.length)
    // Copy the last `chunkLen` samples out of the ring into a dedicated
    // buffer -- a controlled, sequential copy (no per-sample modulo
    // juggling during replay) done once per trigger, at most every
    // BEND_MIN_PERIOD_S seconds, not in the per-sample hot path.
    for (let i = 0; i < chunkLen; i++) {
      const src = (state.ringPos - chunkLen + i + state.ring.length * 2) % state.ring.length
      state.glitchChunk[i] = state.ring[src]!
    }
    state.glitchChunkLen = chunkLen
    state.glitchReadPos = 0
    state.glitchHoldRemaining = Math.max(1, Math.round(periodSamples * holdFrac))
    state.inGlitch = true
  }

  if (state.inGlitch) {
    const out = state.glitchChunk[state.glitchReadPos % state.glitchChunkLen]!
    state.glitchReadPos += 1
    state.glitchHoldRemaining -= 1
    if (state.glitchHoldRemaining <= 0) state.inGlitch = false
    return out
  }

  return crushed
}

export interface BitcrusherParams {
  /** Continuous, 1..16 -- see `quantize`'s own doc comment for why
   *  fractional values are meaningful. */
  bits: number
  /** Hz, 100..48000. */
  rate: number
  /** 0..1, off at 0. */
  bend: number
}

/** One output sample: decimate, then quantize, then (optionally) bend.
 *  This ordering matters -- bend replays *crushed* material, so a
 *  stutter's own texture still carries whatever lo-fi character `bits`/
 *  `rate` are set to, rather than sneaking in a clean, un-crushed repeat. */
export function bitcrusherSample(
  state: BitcrusherState, input: number, p: BitcrusherParams, sampleRate: number,
): number {
  const decimated = decimate(state, input, p.rate, sampleRate)
  const crushed = quantize(decimated, p.bits)
  return bendSample(state, crushed, p.bend, sampleRate)
}
