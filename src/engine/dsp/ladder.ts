/**
 * Zero-delay-feedback (TPT) four-pole ladder filter.
 *
 * Four one-pole stages sit inside a single feedback loop. A naive
 * implementation delays that loop by one sample, which detunes the resonant
 * peak and turns self-oscillation unstable near the top of the range. Solving
 * the loop algebraically (the `u` term below) removes the delay, so the peak
 * lands where the cutoff says it should and full resonance oscillates cleanly.
 *
 * The tanh on the loop input is the transistor nonlinearity: it compresses as
 * resonance climbs, which is why the real circuit thickens rather than
 * screaming into clipping. That same tanh is why a saw (no half-wave
 * symmetry) into a resonant loop bleeds DC: tanh's odd-symmetric curve
 * only cancels the mean of a signal whose positive and negative halves are
 * mirror images, and a saw's aren't. A sine (half-wave symmetric) is
 * untouched -- measured -240 dBFS regardless of resonance -- but the stock
 * saw patch measures -29 to -23 dBFS DC at resonance 0.3-1.0, a fifteenth of
 * the instrument's headroom quietly gone from its own default patch.
 *
 * The fix is a one-pole DC blocker, `y[n] = x[n] - x[n-1] + R*y[n-1]`,
 * folded into this function rather than left to the worklet shell. Three
 * things point that way: (1) `ladderSample` is what dsp/ladder.test.ts
 * exercises directly, and every one of those tests -- self-oscillation,
 * passband, calibration -- should see the filter's actual, correct output,
 * not a DC-polluted one that only gets cleaned up if every caller remembers
 * to add a second stage; (2) a real analog ladder's tanh-equivalent
 * (transistor pairs) sits inside the same feedback path this blocker
 * corrects for, so treating DC rejection as part of the filter's own
 * behavior -- not a downstream mixing concern -- matches what the circuit
 * this models actually does; (3) unlike the LFO, whose output is a CV
 * signal that must keep its DC component (an LFO parked at 0 Hz is a
 * static offset, which is a legitimate and used case), the ladder's output
 * is always audio-rate and never itself used as a DC-carrying CV source
 * elsewhere in this codebase, so blocking DC here has no signal this
 * project relies on to lose.
 */

export interface LadderState {
  /** Integrator state, one per pole. */
  s: [number, number, number, number]
  /** DC blocker state: previous input and previous output. */
  dcX: number
  dcY: number
}

/**
 * Zero is an exact fixed point of this recursion: fed pure silence, the loop
 * never perturbs itself, so a caller relying on high resonance to self-start
 * from nothing will see no oscillation without an outside kick -- a real
 * ladder circuit has a thermal noise floor to do that; this state does not.
 */
export function createLadderState(): LadderState {
  return { s: [0, 0, 0, 0], dcX: 0, dcY: 0 }
}

/** Pole for the one-pole DC blocker, solved so its corner sits at `hz`
 *  regardless of sample rate -- the same role bilinear prewarp plays for
 *  the ladder's own cutoff above. At 48 kHz and 4 Hz this is ~0.9995, the
 *  figure usually quoted for this design. */
function dcBlockerPole(hz: number, sampleRate: number): number {
  return 1 - (2 * Math.PI * hz) / sampleRate
}

/** Corner frequency for the ladder's output DC blocker: high enough to
 *  clear DC in well under a second, low enough to leave the bass alone.
 *  Measured attenuation at 20/30/50 Hz is in ladder.test.ts. */
const DC_BLOCKER_HZ = 4

/**
 * Process one sample.
 *
 * @param resonance 0 to 1. 1 places the loop gain at self-oscillation.
 * @param cutoffHz Sets the per-stage pole frequency. This is the calibration
 *   landmark: the filter self-oscillates here and tracks it at 1 V/octave, so a
 *   resonant ladder plays in tune. At resonance 0 the passive four-pole corner
 *   sits about 0.435x lower -- the cascade factor sqrt(2^(1/4) - 1) -- which is
 *   analog ladder behavior, not a calibration error.
 */
export function ladderSample(
  state: LadderState,
  input: number,
  cutoffHz: number,
  resonance: number,
  sampleRate: number,
): number {
  const nyquist = sampleRate * 0.5
  const fc = Math.min(Math.max(cutoffHz, 10), nyquist * 0.99)

  // Bilinear prewarp, so the digital cutoff matches the analog one.
  const wd = 2 * Math.PI * fc
  const T = 1 / sampleRate
  const wa = (2 / T) * Math.tan((wd * T) / 2)
  const g = (wa * T) / 2
  const G = g / (1 + g)

  // 4.0 is the linear self-oscillation threshold, and tanh's unity small-signal
  // gain leaves the loop marginally stable there -- it oscillates, but barely.
  // Real ladder circuits are driven past the threshold, so full resonance
  // screams rather than whispers. Measured tail RMS at 1 kHz: 0.012 at k=4.0,
  // 0.076 at k=4.2.
  const k = Math.min(Math.max(resonance, 0), 1) * 4.2

  const [s0, s1, s2, s3] = state.s

  // Contribution of the stored state to the loop output, folded back to the input.
  const S = (((s0 * G + s1) * G + s2) * G + s3) / (1 + g)

  // Zero-delay solve for the ladder input.
  const G4 = G * G * G * G
  // The closed loop has a DC gain of 1/(1 + k), so without compensation the
  // passband collapses by nearly 10 dB as resonance opens and the patch goes
  // thin exactly when it should get more aggressive. Scaling the input by
  // (1 + k) restores unity passband across the whole resonance range.
  const u = Math.tanh((input * (1 + k) - k * S) / (1 + k * G4))

  // Four TPT one-poles in series.
  let x = u
  for (let i = 0; i < 4; i++) {
    const v = (x - state.s[i]!) * G
    const y = v + state.s[i]!
    state.s[i] = y + v
    x = y
  }

  // DC blocker (see the module doc comment for why it lives here).
  const R = dcBlockerPole(DC_BLOCKER_HZ, sampleRate)
  const dcOut = x - state.dcX + R * state.dcY
  state.dcX = x
  state.dcY = dcOut
  return dcOut
}
