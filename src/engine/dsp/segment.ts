/**
 * Gate-driven envelope and sample-and-hold cores.
 *
 * The envelope approaches each target exponentially, the way an analog RC
 * stage does, rather than moving in straight lines. Stages advance when the
 * level gets close enough to its target, and release starts from wherever the
 * level currently sits, so a retrigger mid-release never clicks.
 */

export type EnvStage = 'idle' | 'attack' | 'decay' | 'sustain' | 'release'

export interface EnvState {
  stage: EnvStage
  level: number
  /** Previous gate value, used to detect edges. */
  lastGate: number
}

export interface AdsrParams {
  /** Seconds. */
  attack: number
  decay: number
  /** 0 to 1. */
  sustain: number
  /** Seconds. */
  release: number
}

export function createEnvState(): EnvState {
  return { stage: 'idle', level: 0, lastGate: 0 }
}

/** Per-sample coefficient for an exponential approach to a target. */
function coeff(seconds: number, sampleRate: number): number {
  const samples = Math.max(seconds, 0.0001) * sampleRate
  return 1 - Math.exp(-1 / samples)
}

/** Overshoot the target slightly so the stage completes in about its stated time. */
const ATTACK_TARGET = 1.05
const CLOSE_ENOUGH = 0.001

export function envSample(
  state: EnvState,
  gate: number,
  p: AdsrParams,
  sampleRate: number,
): number {
  const high = gate >= 0.5

  if (high && state.lastGate < 0.5) state.stage = 'attack'
  if (!high && state.lastGate >= 0.5) state.stage = 'release'
  state.lastGate = gate

  switch (state.stage) {
    case 'idle':
      state.level = 0
      break

    case 'attack':
      state.level += (ATTACK_TARGET - state.level) * coeff(p.attack, sampleRate)
      if (state.level >= 1) {
        state.level = 1
        state.stage = 'decay'
      }
      break

    case 'decay':
      state.level += (p.sustain - state.level) * coeff(p.decay, sampleRate)
      if (Math.abs(state.level - p.sustain) < CLOSE_ENOUGH) {
        state.level = p.sustain
        state.stage = 'sustain'
      }
      break

    case 'sustain':
      state.level = p.sustain
      break

    case 'release':
      state.level += (0 - state.level) * coeff(p.release, sampleRate)
      if (state.level < CLOSE_ENOUGH) {
        state.level = 0
        state.stage = 'idle'
      }
      break
  }

  return state.level
}

export interface SampleHoldState {
  held: number
  lastTrigger: number
}

export function createSampleHoldState(): SampleHoldState {
  return { held: 0, lastTrigger: 0 }
}

/** Capture `input` on each rising edge of `trigger`, and hold it otherwise. */
export function sampleHold(
  state: SampleHoldState,
  input: number,
  trigger: number,
): number {
  if (trigger >= 0.5 && state.lastTrigger < 0.5) state.held = input
  state.lastTrigger = trigger
  return state.held
}

export interface SequencerState {
  /** -1 means "no clock pulse seen yet". Reading clamps that to step 0, so a
   *  sequencer that has never been clocked still shows its first step. */
  index: number
  lastClock: number
  lastReset: number
}

export function createSequencerState(): SequencerState {
  return { index: -1, lastClock: 0, lastReset: 0 }
}

export interface SequencerOutput {
  cv: number
  gate: number
}

/**
 * Advance the step index on each clock rising edge, wrapping at `steps`, and
 * read the corresponding entry of `values` as `cv`. `gate` simply follows the
 * clock's high period. A rising edge on `reset` returns to step 0.
 *
 * The first-ever clock edge selects step 0 rather than advancing past it --
 * pulse 1 plays step 1, pulse 2 plays step 2, and so on -- which is why the
 * index starts at the sentinel -1 instead of 0: `(-1 + 1) % steps` is 0.
 */
export function sequencerStep(
  state: SequencerState,
  clock: number,
  reset: number,
  steps: number,
  values: readonly number[],
): SequencerOutput {
  const count = Math.max(1, Math.min(16, Math.round(steps)))

  if (reset >= 0.5 && state.lastReset < 0.5) state.index = 0
  state.lastReset = reset

  if (clock >= 0.5 && state.lastClock < 0.5) {
    state.index = state.index < 0 ? 0 : (state.index + 1) % count
  }
  state.lastClock = clock

  const activeIndex = state.index < 0 ? 0 : state.index
  const idx = Math.min(activeIndex, count - 1, Math.max(values.length - 1, 0))
  const cv = values[idx] ?? 0
  const gate = clock >= 0.5 ? 1 : 0
  return { cv, gate }
}
