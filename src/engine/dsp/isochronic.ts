/**
 * Isochronic: a carrier amplitude-gated at a precise rate. Unlike the
 * Binaural module (dsp/binaural.ts), this works in mono and on speakers --
 * there is nothing dichotic about it, it's a single signal turned on and
 * off (with shaped edges, not a hard switch) at a settable rate.
 *
 * The gate is a square wave (`gatePhase < duty` -> 1, else 0) at `rateHz`,
 * run through the exact same exponential-approach envelope segment.ts's
 * ADSR attack/release stages already use (`envSample`, imported directly
 * rather than reimplemented) with `sustain` pinned to 1 -- a plain AR
 * envelope, retriggered every cycle by the square gate's own edges. That
 * reuse is deliberate, not incidental: `envSample`'s exponential approach
 * is exactly the "shaped envelope" the task asks for instead of a hard
 * square, and it is already measured elsewhere in this codebase (envelope
 * stage-transition clicks at -65 to -83 dBFS, docs/CONTINUATION.md) to be
 * click-free. `edgeSeconds` sets both the attack and release time constant
 * -- how soft the gate's edges are -- and it always applies: there is no
 * "shape = 0" setting that degenerates back into a true instant edge (see
 * modules/isochronic.ts's own param range), which is the actual fix for
 * "a hard square gate will click."
 *
 * The carrier is a bare sine (`Math.sin`, no wavetable) for the same
 * reason dsp/binaural.ts uses one: no harmonics to band-limit, so there is
 * nothing to gain from a mip-mapped table and a small amount of
 * interpolation error to lose by using one anyway.
 *
 * Clock-sync (locking `rateHz` to a clock division rather than the free
 * Hz knob) is handled by the worklet shell, in the exact same shape
 * segment.worklet.ts's LfoProcessor already established for the LFO's own
 * `division` param -- dsp/clock-sync.ts's `updateSync`/`isSyncLocked`/
 * `lockedRateHz`, with `resetGatePhase` below standing in for that file's
 * `hardSync` on the sample lock is first acquired. Kept out of this file
 * because clock-sync is already a separate, independently-tested concern
 * (tests/node/dsp/clock-sync.test.ts) that owns no opinion about what it's
 * driving the rate of.
 */

import { createEnvState, envSample, type EnvState } from './segment'

export interface IsoState {
  /** Normalized [0, 1) phase of the gate cycle. */
  gatePhase: number
  /** Normalized [0, 1) phase of the carrier oscillator. */
  carrierPhase: number
  /** The AR envelope shaping the square gate's edges. */
  env: EnvState
}

export function createIsoState(): IsoState {
  return { gatePhase: 0, carrierPhase: 0, env: createEnvState() }
}

/** Restart the gate cycle at its "on" edge -- used when clock lock is
 *  first acquired, mirroring dsp/clock-sync.ts's "hard-reset phase only on
 *  the sample lock is newly acquired, not on every subsequent pulse"
 *  contract (see that file's module doc comment, "a tempo change
 *  mid-note"). */
export function resetGatePhase(state: IsoState): void {
  state.gatePhase = 0
}

function wrap01(t: number): number {
  const w = t % 1
  return w < 0 ? w + 1 : w
}

export interface IsoParams {
  carrierHz: number
  rateHz: number
  /** Fraction of each gate cycle the gate is "on," in (0, 1). */
  duty: number
  /** Attack/release time constant for the gate's shaped edges, in seconds. */
  edgeSeconds: number
}

/** The shaped gate envelope alone, with no carrier multiplied in -- the
 *  actual quantity `edgeSeconds` shapes, and the right thing to measure a
 *  "click" against: an audio-rate carrier has its own ordinary per-sample
 *  slope (bounded by `2*pi*carrierHz/sampleRate`, present at every sample,
 *  everywhere, not just at gate edges) that would otherwise swamp a
 *  whole-signal worst-case-delta measurement and hide the actual edge
 *  artifact inside normal waveform motion -- see
 *  tests/node/dsp/isochronic.test.ts's own doc comment on this for the
 *  worked-through reasoning. Exported so that test can call it directly
 *  rather than reimplementing the gate math to isolate it. */
export function gateEnvelopeSample(
  state: Pick<IsoState, 'gatePhase' | 'env'>,
  rateHz: number,
  duty: number,
  edgeSeconds: number,
  sampleRate: number,
): number {
  state.gatePhase = wrap01(state.gatePhase + rateHz / sampleRate)
  const squareGate = state.gatePhase < duty ? 1 : 0
  const envParams = { attack: edgeSeconds, decay: 0.0001, sustain: 1, release: edgeSeconds }
  return envSample(state.env, squareGate, envParams, sampleRate)
}

/** Advance one sample: a shaped-edge amplitude gate at `rateHz`/`duty`
 *  multiplying a sine carrier at `carrierHz`. */
export function isoSample(state: IsoState, p: IsoParams, sampleRate: number): number {
  const shaped = gateEnvelopeSample(state, p.rateHz, p.duty, p.edgeSeconds, sampleRate)
  state.carrierPhase = wrap01(state.carrierPhase + p.carrierHz / sampleRate)
  const carrier = Math.sin(2 * Math.PI * state.carrierPhase)
  return carrier * shaped
}

/** The raw, unshaped square gate value at the current phase -- exists only
 *  so a test can measure "what a hard-edged gate's discontinuity would
 *  have been" as the baseline dsp/isochronic.ts's shaping is measured
 *  against. Never called from the worklet: production code always goes
 *  through `isoSample`'s shaped path. */
export function hardGateValue(gatePhase: number, duty: number): number {
  return gatePhase < duty ? 1 : 0
}
