/**
 * Flanger DSP: a swept fractional delay with regeneration.
 *
 * **Why this exists as a worklet at all**, when a flanger is "just" a
 * `DelayNode` with an LFO on `delayTime` and a feedback gain -- which is
 * exactly how `modules/delay.ts` is built, and how this module was built
 * first:
 *
 * The Web Audio spec requires an implementation to insert at least one
 * render quantum (128 samples, 2.667 ms at 48 kHz) of delay into any cycle
 * in the graph. A flanger's regeneration path *is* a cycle. So a native
 * flanger's feedback resonates on a comb of period `1 / (d + 0.002667)`
 * while its dry/wet summing notches sit at `1 / (2d)` -- two different,
 * unrelated combs. A real flanger's regeneration reinforces the comb the
 * module already has; that is what makes it sound like a flanger rather
 * than like two effects fighting.
 *
 * That was measured, not assumed. With `d = 1 ms` and feedback 0.9 the
 * native version's resonance peaks came out spaced **250-280 Hz**, against
 * 1000 Hz for the no-quantum model and **273 Hz** for the one-quantum model.
 * The quantum wins conclusively. At flanger delays the quantum is 27% to
 * 2600% of the delay itself, so it dominates -- which is also why this
 * never mattered for `delay.ts` (2.667 ms on a 300 ms echo is 0.9%,
 * inaudible) and does not affect the Chorus module (no feedback, so no
 * cycle, so no quantum).
 *
 * Owning the delay line here makes the feedback exact.
 *
 * **Cubic interpolation, and how to tell it is working.** A swept delay
 * reads at fractional sample positions, so the interpolator is the whole
 * fidelity story. Its quality shows up directly as notch depth: a perfect
 * fractional read nulls completely where dry and wet cancel, and a poor one
 * fills the null in. Catmull-Rom (4-point cubic) is used rather than the
 * usual linear read for that reason, and `tests/node/dsp/flanger.test.ts`
 * measures the resulting notch depth at deliberately fractional delays
 * rather than only at whole-sample ones, where linear would flatter itself.
 */

/** Sized for the widest sweep the panel can ask for (`manual` 10 ms at full
 *  depth reaches 19 ms) with generous headroom. Allocated once per instance. */
export const MAX_DELAY_SECONDS = 0.05

/** How far above the centre delay the LFO sweeps at depth 1, as a fraction
 *  of that centre. The sweep runs *upward* from `manual` rather than
 *  symmetrically around it -- which is how a hardware flanger's manual
 *  control behaves, and which also guarantees the read position never falls
 *  below `manual` and so never approaches the write head. A symmetric sweep
 *  would put the minimum delay at `manual * 0.1`, half a sample at the
 *  bottom of the manual range, where a delay line has nothing to read. */
export const SWEEP_SPAN = 0.9

export const MIN_MANUAL_SECONDS = 0.0001
export const MAX_MANUAL_SECONDS = 0.01
export const MIN_RATE_HZ = 0.05
export const MAX_RATE_HZ = 10
/** `|feedback| < 1` is what makes the recursion stable; 0.95 leaves margin
 *  and still resonates hard. Bipolar because the sign genuinely changes the
 *  sound -- see `modules/flanger.ts`'s doc comment. */
export const MAX_FEEDBACK = 0.95

/** Never read closer than this to the write head. Two samples keeps the
 *  4-point kernel entirely in already-written history. */
const MIN_DELAY_SAMPLES = 2

export interface FlangerState {
  buffer: Float32Array
  writeIndex: number
  /** LFO phase in radians, kept in state so a rate change mid-sweep
   *  continues from where the sweep already was instead of jumping. */
  phase: number
}

export interface FlangerParams {
  /** Centre (and minimum) delay, seconds. */
  manual: number
  /** LFO rate, Hz. */
  rate: number
  /** 0 freezes the sweep, 1 sweeps the full SWEEP_SPAN. */
  depth: number
  /** -MAX_FEEDBACK..MAX_FEEDBACK. */
  feedback: number
  /** 0 = dry only, 0.5 = deepest comb, 1 = wet only. */
  mix: number
}

export function createFlangerState(sampleRate: number): FlangerState {
  return {
    buffer: new Float32Array(Math.ceil(MAX_DELAY_SECONDS * sampleRate) + 4),
    writeIndex: 0,
    phase: 0,
  }
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)

/** Catmull-Rom read at a fractional distance back from the write head. */
function readCubic(buffer: Float32Array, writeIndex: number, delaySamples: number): number {
  const len = buffer.length
  const readPos = writeIndex - delaySamples
  // Bring into range without assuming how many wraps are needed.
  let base = readPos % len
  if (base < 0) base += len
  const i1 = Math.floor(base)
  const t = base - i1

  const i0 = (i1 - 1 + len) % len
  const i2 = (i1 + 1) % len
  const i3 = (i1 + 2) % len

  const p0 = buffer[i0]!
  const p1 = buffer[i1]!
  const p2 = buffer[i2]!
  const p3 = buffer[i3]!

  return (
    p1 +
    0.5 *
      t *
      (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)))
  )
}

/**
 * One sample through the flanger. Advances the LFO and the write head.
 *
 * The recursion is `buffer[write] = input + feedback * delayed`, with
 * `delayed` read from the same buffer at the swept fractional offset -- so
 * the regeneration travels the same delay the dry/wet notch is built from,
 * which is the entire reason this is not a `DelayNode`.
 */
export function flangerSample(
  state: FlangerState,
  input: number,
  params: FlangerParams,
  sampleRate: number,
): number {
  const manual = clamp(params.manual, MIN_MANUAL_SECONDS, MAX_MANUAL_SECONDS)
  const depth = clamp(params.depth, 0, 1)
  const feedback = clamp(params.feedback, -MAX_FEEDBACK, MAX_FEEDBACK)
  const mix = clamp(params.mix, 0, 1)
  const rate = clamp(params.rate, MIN_RATE_HZ, MAX_RATE_HZ)

  // Unipolar sweep, upward from `manual`. See SWEEP_SPAN's own comment.
  const lfo = 0.5 + 0.5 * Math.sin(state.phase)
  const delaySeconds = manual * (1 + SWEEP_SPAN * depth * lfo)
  const delaySamples = Math.max(delaySeconds * sampleRate, MIN_DELAY_SAMPLES)

  const delayed = readCubic(state.buffer, state.writeIndex, delaySamples)

  state.buffer[state.writeIndex] = input + feedback * delayed
  state.writeIndex = (state.writeIndex + 1) % state.buffer.length

  state.phase += (2 * Math.PI * rate) / sampleRate
  if (state.phase >= 2 * Math.PI) state.phase -= 2 * Math.PI

  return (1 - mix) * input + mix * delayed
}
