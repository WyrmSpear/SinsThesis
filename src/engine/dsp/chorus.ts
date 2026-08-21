/**
 * Chorus geometry: the small amount of pure math behind `modules/chorus.ts`.
 *
 * Unlike the Flanger, the Chorus needs no worklet and no per-sample DSP
 * here. It has **no feedback**, so its graph contains no cycle, so Web
 * Audio inserts no render quantum (the failure that forced the Flanger to
 * own its delay line -- see `dsp/flanger.ts`). Native `DelayNode`s sweep
 * correctly. What lives in this file is only the geometry that decides
 * where the three voices sit and how their LFOs relate, factored out so the
 * Node suite can check it without a browser.
 *
 * **Three voices at 120 degrees, and why the phase comes from a
 * PeriodicWave.** A chorus thickens because several detuned copies beat
 * against each other; three copies sweeping *in phase* would just be one
 * louder copy. `OscillatorNode` has no phase control, and the obvious
 * workarounds are both wrong:
 *
 * - Starting three oscillators at staggered times gives the right offset
 *   only at the rate they were started at. Change the Rate knob and the
 *   relationship silently drifts, because a time offset is a fixed number
 *   of seconds, not a fixed fraction of a cycle.
 * - Giving each voice a different sweep depth is not a phase offset at all;
 *   the voices still reach their extremes together.
 *
 * A `PeriodicWave` carries phase in its coefficients, so the offset is a
 * property of the waveform itself and survives any rate change. For a
 * single harmonic, Web Audio synthesises `real[1] * cos(wt) + imag[1] *
 * sin(wt)`, and `sin(wt + p) = cos(p) * sin(wt) + sin(p) * cos(wt)`, so
 * `real[1] = sin(p)` and `imag[1] = cos(p)`. (The built-in `'sine'` type is
 * the `p = 0` case of exactly this: `real = [0, 0]`, `imag = [0, 1]`.)
 */

/** Even thirds of a cycle. Three is the smallest count that thickens
 *  without the two-voice case's audible in-and-out-of-phase pulsing. */
export const VOICE_PHASES = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3] as const

/** Centre delay, seconds. 20 ms sits in the middle of the classic chorus
 *  window (10-30 ms): long enough that the copies read as separate voices
 *  rather than as the Flanger's single comb, short enough not to read as an
 *  echo. */
export const BASE_DELAY_SECONDS = 0.02

/** Per-voice multipliers on the centre delay at spread 1. At spread 0 all
 *  three voices sit exactly on the centre; at spread 1 they sit at 12, 20
 *  and 28 ms. */
export const SPREAD_OFFSETS = [-0.4, 0, 0.4] as const

/** Sweep half-width at depth 1, seconds. Bounded so the shortest voice
 *  (12 ms at full spread) stays well clear of zero: 12 - 5 = 7 ms. */
export const MAX_SWEEP_SECONDS = 0.005

export const MIN_RATE_HZ = 0.05
export const MAX_RATE_HZ = 8

/** Where voice `index` sits, before its LFO moves it. */
export function voiceDelaySeconds(index: number, spread: number): number {
  const offset = SPREAD_OFFSETS[index] ?? 0
  const clamped = spread < 0 ? 0 : spread > 1 ? 1 : spread
  return BASE_DELAY_SECONDS * (1 + clamped * offset)
}

/**
 * Coefficients for a unit sine advanced by `phase` radians, in the layout
 * `BaseAudioContext.createPeriodicWave(real, imag)` expects. See this
 * file's doc comment for the derivation.
 */
export function sinePhaseCoefficients(phase: number): { real: Float32Array; imag: Float32Array } {
  return {
    real: new Float32Array([0, Math.sin(phase)]),
    imag: new Float32Array([0, Math.cos(phase)]),
  }
}
