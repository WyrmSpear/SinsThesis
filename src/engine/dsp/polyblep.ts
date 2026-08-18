/**
 * PolyBLEP oscillator core.
 *
 * SUPERSEDED, KEPT AS REFERENCE ONLY -- do not import this from a worklet or
 * any live signal path. The VCO worklet and the LFO processor both read from
 * dsp/wavetable.ts now: mipmapped band-limited wavetables measured 50-90 dB
 * better alias rejection at roughly 1/15th the CPU (see
 * .superpowers/sdd/2026-08-18-phase1a-engine/minblep-spec.md section 7 and
 * task-M2-report.md for the numbers). This file stays in the tree because
 * its honest, unimproved alias floor is the baseline the wavetable core is
 * measured against -- its tests below still pass and should keep passing,
 * but nothing should import `oscSample` from here again. Don't delete it as
 * dead code, and don't resurrect it as a live path without re-running that
 * comparison.
 *
 * A naive saw or pulse steps discontinuously once per cycle, and that step
 * folds energy back below Nyquist as audible alias tones. PolyBLEP subtracts a
 * polynomial approximation of a band-limited step at each discontinuity, which
 * buys roughly 60 dB of alias rejection for a few arithmetic operations.
 *
 * Pure by design: no audio context, no DOM. It has no worklet shell anymore
 * (see above) but stays a pure module on the same principle.
 */

export type OscShape = 'saw' | 'pulse' | 'tri' | 'sine'

export interface OscState {
  /** Normalized phase in [0, 1). */
  phase: number
  /** Leaky integrator state used to derive triangle from a square. */
  triIntegrator: number
}

export function createOscState(phase = 0): OscState {
  return { phase, triIntegrator: 0 }
}

/** Restart the cycle. Used by the VCO's hard-sync input. */
export function hardSync(state: OscState): void {
  state.phase = 0
  state.triIntegrator = 0
}

/**
 * Correction applied near a discontinuity. `t` is the phase, `dt` the phase
 * increment per sample; the polynomial spans one sample either side of the step.
 */
function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt
    return x + x - x * x - 1
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt
    return x * x + x + x + 1
  }
  return 0
}

const TWO_PI = Math.PI * 2

/** Advance one sample and return the oscillator's output in [-1, 1]. */
export function oscSample(
  state: OscState,
  shape: OscShape,
  freq: number,
  sampleRate: number,
  pulseWidth = 0.5,
): number {
  const dt = Math.abs(freq) / sampleRate
  state.phase += dt
  if (state.phase >= 1) state.phase -= 1

  const t = state.phase

  switch (shape) {
    case 'sine':
      return Math.sin(TWO_PI * t)

    case 'saw':
      return 2 * t - 1 - polyBlep(t, dt)

    case 'pulse': {
      const pw = Math.min(Math.max(pulseWidth, 0.01), 0.99)
      let v = t < pw ? 1 : -1
      v += polyBlep(t, dt)
      let fall = t - pw
      if (fall < 0) fall += 1
      v -= polyBlep(fall, dt)
      return v
    }

    case 'tri': {
      // Integrate a band-limited square. The leak is scaled to the phase
      // increment, so amplitude stays near unity at every rate -- this core
      // drives the LFO down to 0.01 Hz as well as the VCO up to audio rates.
      // (A fixed leak constant instead ties amplitude to frequency: it would
      // leave the LFO nearly silent at sub-Hz rates and saturate the
      // integrator into a clipped square at audio rates.)
      let square = t < 0.5 ? 1 : -1
      square += polyBlep(t, dt)
      let half = t + 0.5
      if (half >= 1) half -= 1
      square -= polyBlep(half, dt)

      state.triIntegrator = dt * square + (1 - dt) * state.triIntegrator
      return Math.min(Math.max(4 * state.triIntegrator, -1), 1)
    }
  }
}
