/**
 * Zero-delay-feedback (TPT) two-integrator state-variable filter, in the
 * Oberheim SEM / ARP 2600 family rather than the Moog ladder in
 * `ladder.ts`. The two topologies share the same zero-delay-feedback
 * machinery -- `zdf.ts`'s bilinear prewarp, and an implicit loop solved
 * algebraically instead of delayed by a sample -- but they are genuinely
 * different circuits, not a mode switch on one circuit: a ladder cascades
 * four one-pole stages inside a single feedback loop; this cascades two
 * one-pole integrators inside a loop that exposes every intermediate
 * signal as its own output.
 *
 * That is the SVF's defining feature and the reason it earns a second
 * filter module rather than a "type" knob on the first one: lowpass,
 * bandpass, highpass and notch are all available *simultaneously* from one
 * instance, patchable at once -- a mode switch cannot do that. And because
 * it is a two-pole (not four-pole) topology, every output rolls off at
 * 12 dB/octave, not the ladder's 24. That is not a deficiency to fix; it is
 * the character difference between these two filters, and it is why having
 * both in the rack unlocks more patches than either alone. See
 * `slopeDbPerOctave` measurements in svf.test.ts for the measured figure.
 *
 * Cutoff landmark: unlike the ladder (whose knob marks the self-oscillation
 * frequency, sitting above the passive corner -- see ladder.ts's own doc
 * comment), this filter's `cutoffHz` parameter sets `g = tan(pi*fc/fs)`,
 * which is the resonant *center* frequency f0: the frequency the bandpass
 * and notch outputs are centered on, and where the lowpass and highpass
 * outputs cross at equal magnitude, for *any* resonance setting -- the one
 * landmark that stays fixed as the resonance knob moves, because it is the
 * only frequency every one of the four simultaneous outputs agrees on. At
 * resonance 0 (Q = 1/sqrt(2), maximally flat/Butterworth), f0 also happens
 * to be the lowpass/highpass -3 dB corner, so the knob's meaning is
 * continuous with plain-lowpass intuition at the flat setting while staying
 * meaningful everywhere else. Measured accuracy is in svf.test.ts.
 *
 * Resonance stays strictly on the damped side of this loop's own stability
 * boundary (see K_MIN below) -- unlike the ladder, whose resonance is
 * deliberately pushed *past* its linear threshold and relies on tanh, inside
 * the loop, to catch the result. That asymmetry is not an oversight: a first
 * attempt mirrored the ladder exactly (tanh on the value driving the two
 * integrators) and it made things *worse*, not better -- see K_MIN's own
 * comment for the measurement that killed it. This filter's only
 * nonlinearity is a tanh on the incoming signal, applied once, before the
 * implicit loop solve even starts (see `svfSample` below) -- unlike a tanh
 * placed after the solve, saturating the excitation first keeps the solve
 * internally self-consistent, so it adds hot-input headroom without
 * touching the stability the strictly-positive `k` already guarantees.
 */

import { prewarp } from './zdf'

export interface SvfState {
  /** Bandpass integrator memory (Zavalishin's ic1eq). */
  s1: number
  /** Lowpass integrator memory (Zavalishin's ic2eq). */
  s2: number
}

/** Zero is an exact fixed point: silence in, silence forever out, so (as
 *  with the ladder) a caller relying on high resonance to self-start from
 *  nothing needs an outside kick -- the worklet shell supplies a continuous
 *  dither for that, matching ladder.worklet.ts's own approach. */
export function createSvfState(): SvfState {
  return { s1: 0, s2: 0 }
}

/** The four simultaneous outputs a real SVF exposes at once. Passed in by
 *  the caller and mutated in place so a per-sample audio-rate loop (the
 *  worklet's `process()`) does not allocate an object every sample. */
export interface SvfOutputs {
  lp: number
  bp: number
  hp: number
  notch: number
}

export function createSvfOutputs(): SvfOutputs {
  return { lp: 0, bp: 0, hp: 0, notch: 0 }
}

/** Damping (Simper/Zavalishin's `k`, equal to 1/Q) at resonance 0:
 *  sqrt(2), the classic Butterworth figure -- maximally flat, no resonant
 *  bump, and the setting at which f0 is also the -3 dB corner (see the
 *  module doc comment). */
const K_FLAT = Math.SQRT2

/**
 * Damping at resonance 1. Deliberately *not* pushed through or past k=0 the
 * way the ladder pushes its resonance past its linear self-oscillation
 * threshold: a first attempt tried exactly that (tanh-limiting the signal
 * driving the loop, mirroring the ladder) and it does not generalize --
 * measured directly, it rang at 52-258 Hz regardless of a 100-5000 Hz
 * cutoff setting, a relaxation oscillation timed by the limiter and the
 * loop gain, not the resonant frequency the cutoff knob claims. The
 * difference from the ladder: the ladder's resonance term only shapes the
 * *excitation* feeding a cascade of individually, unconditionally stable
 * one-pole stages (each pole's own recursion never involves resonance), so
 * clamping that one excitation value is sufficient. Here resonance (`k`)
 * sits inside the loop's own pole-position algebra (the `(k+g)` and
 * `1+kg+g^2` terms above) -- crossing k=0 moves the poles themselves past
 * the unit circle, and clamping only `hp` afterward does not bound `bp`
 * and `lp`, whose per-sample growth scales with `g` (which is unbounded
 * near Nyquist) regardless of how tightly `hp` is clamped.
 *
 * K_MIN instead keeps k strictly positive -- the loop stays linearly,
 * unconditionally BIBO-stable by construction (standard 2nd-order filter
 * theory), for any cutoff and any input amplitude, with no nonlinearity
 * required for boundedness. That mattered beyond the relaxation-oscillator
 * finding above: the same first attempt, tanh-limiting the post-solve `hp`,
 * also produced six-figure output spikes at some (not all -- the pattern
 * wasn't even monotonic in distance to Nyquist) near-Nyquist
 * cutoff/resonance combinations, measured up to 302,029 at cutoff 22 kHz,
 * resonance 1. Removing that tanh and keeping the loop fully linear at the
 * same cutoffs and resonances dropped every one of those cases to single
 * digits -- confirming the spikes were the tanh substitution's own
 * self-consistency error (the loop's stored state is fed by the
 * *saturated* hp, not the value the algebra actually solved for, and nothing
 * bounds how far apart those two get once the loop's own gain, driven by
 * `g`, gets large), not a property of the underlying filter. 0.01 (Q=100,
 * ~40 dB resonant peak) was chosen by measurement in svf.test.ts: high
 * enough to ring audibly for a genuinely long tail once kicked (dozens of
 * cycles) while keeping the hot-input stability bound (a 4.0-amplitude
 * noise burst) comfortably inside two digits even at the filter's most
 * extreme settings.
 */
const K_MIN = 0.01

/** Exponential interpolation (not linear, like the ladder's resonance-to-k
 *  scale): most of a resonance knob's audible "zing" belongs to its top
 *  quarter-turn on real hardware, and an exponential curve concentrates the
 *  Q increase there instead of spreading it evenly, matching every other
 *  perceptually-scaled param in this codebase (ParamSpec's own `curve:
 *  'exp'`). */
function resonanceToK(resonance: number): number {
  const r = Math.min(Math.max(resonance, 0), 1)
  return K_FLAT * Math.pow(K_MIN / K_FLAT, r)
}

/**
 * Process one sample, writing all four simultaneous outputs into `out`.
 *
 * @param resonance 0 to 1. 1 sets k to K_MIN -- a very high but strictly
 *   positive Q, not literal self-oscillation (see K_MIN's own comment).
 * @param cutoffHz The resonant center frequency f0 -- see the module doc
 *   comment for why this, not the ladder's self-oscillation landmark, is
 *   this topology's natural knob meaning.
 */
export function svfSample(
  state: SvfState,
  input: number,
  cutoffHz: number,
  resonance: number,
  sampleRate: number,
  out: SvfOutputs,
): void {
  const { g } = prewarp(cutoffHz, sampleRate)
  const k = resonanceToK(resonance)

  // Saturate the excitation before the solve, not the solved result after
  // it (see the module doc comment for why the latter measured worse, not
  // better). tanh's unity small-signal gain leaves ordinary program-level
  // signals untouched -- ordinary audio samples in this codebase sit well
  // under 1.0 -- so cutoff/resonance calibration holds at normal levels;
  // only a hot input (several volts) meaningfully compresses here.
  const v0 = Math.tanh(input)

  // Zero-delay solve: hp[n] depends on bp[n] and lp[n], which both depend on
  // hp[n] in turn. Substituting the trapezoidal integrator update for each
  // (bp[n] = g*hp[n] + s1, lp[n] = g*bp[n] + s2) and solving for hp[n]
  // algebraically -- rather than using bp/lp from the *previous* sample, a
  // one-sample delay that would detune the resonant peak and destabilize
  // high resonance, exactly the problem ladder.ts's own doc comment
  // describes -- gives this closed form (Zavalishin/Simper's TPT SVF).
  const hp = (v0 - (k + g) * state.s1 - state.s2) / (1 + k * g + g * g)
  const bp = g * hp + state.s1
  const lp = g * bp + state.s2

  state.s1 = g * hp + bp
  state.s2 = g * bp + lp

  out.lp = lp
  out.bp = bp
  out.hp = hp
  // lp + hp = v0 - k*bp exactly -- the standard SVF notch identity,
  // verified in this file's header derivation notes and cross-checked by
  // svf.test.ts.
  out.notch = lp + hp
}
