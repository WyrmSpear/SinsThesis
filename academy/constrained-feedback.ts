import type { FeatureFailure } from '../src/engine/analysis/rubric'

/**
 * Player-facing rephrasing of a constrained-challenge `FeatureFailure` --
 * the same split `academy/feedback.ts` (build-this-patch) and
 * `academy/sound-feedback.ts` (match-this-sound) already draw: the engine
 * side (`src/engine/analysis/rubric.ts`) stays plain data (a feature name,
 * a direction, a value, a bound), and this is where that becomes a
 * sentence naming an actual knob -- Section 4's "never a bare pass/fail,
 * say which property missed and in which direction."
 *
 * One feature name can mean different things on different levels --
 * `attackMs`/`decayMs`/`peakRms` are graded the same way (percussive:
 * fast, short, audible) on both 09-thump and 11-fold-pluck, but
 * `pitchDropOctaves` (09-thump wants the pitch to fall) and
 * `pitchDriftAbsOctaves` (11-fold-pluck wants the pitch to *not* move) are
 * deliberately two different feature names for that reason -- see
 * rubric.ts's own doc comment -- so a single `feature -> message` table
 * never has to guess which of two opposite meanings a level intended.
 */

const MESSAGES: Record<FeatureFailure['feature'], { tooLow: string; tooHigh: string }> = {
  peakRms: {
    tooLow: `It's too quiet to hear clearly -- check that everything is actually patched through to the Output, and that the VCA's Level or CV Amt isn't sitting at 0.`,
    tooHigh: `It's uncomfortably loud -- back off the VCA's Level a little.`,
  },
  attackMs: {
    tooLow: `The attack is faster than it needs to be -- that's fine as-is.`,
    tooHigh: `It fades in too slowly to feel percussive -- turn the envelope's Att(ack) down, closer to 0.`,
  },
  decayMs: {
    tooLow: `It's cut off before it can really be heard -- give the envelope a touch more Decay.`,
    tooHigh: `It rings on too long to feel like a hit -- turn the envelope's Decay down, and make sure Sustain is low so it actually dies out instead of holding.`,
  },
  centroidHz: {
    tooLow: `It's duller than it needs to be -- that's fine as-is.`,
    tooHigh: `It's too bright and thin for this -- try a lower oscillator pitch (Octave), or a mellower waveform (Sine or Triangle).`,
  },
  peakinessDb: {
    tooLow: `It needs more edge -- turn the filter's Res(onance) up.`,
    tooHigh: `It's ringing too hard -- turn the filter's Res(onance) down a little.`,
  },
  pitchDropOctaves: {
    tooLow: `The pitch isn't dropping -- patch the envelope's "Out" into the oscillator's "FM" jack too, and turn its FM knob up, so the pitch falls as the sound decays.`,
    tooHigh: `The pitch is dropping further than it needs to -- turn the oscillator's FM knob down a little.`,
  },
  pitchDriftAbsOctaves: {
    tooLow: `The pitch is rock-steady -- that's fine as-is.`,
    tooHigh: `The pitch is sliding around -- make sure nothing is patched into the oscillator's "FM" or "1V/Oct" jacks; this one should hold a single note while its color changes instead.`,
  },
  brightnessDropOctaves: {
    tooLow: `The tone isn't changing color as it decays -- with no filter granted, try patching the envelope's "Out" into the Wavefolder's "CV" jack too, and turn its Amt up, so the fold (and the brightness) fades along with the note.`,
    tooHigh: `The tone is changing color faster than it needs to -- that's fine as-is.`,
  },
  centroidMotionOctaves: {
    tooLow: `This sounds static -- nothing changes while it plays. Patch the LFO's "Out" into something that shapes tone over time: the filter's "CV" jack (cutoff), or the oscillator's "FM" jack (pitch).`,
    tooHigh: `It's moving faster than it needs to -- that's fine as-is.`,
  },
}

export function describeFeatureFailure(failure: FeatureFailure): string {
  const table = MESSAGES[failure.feature]
  return failure.direction === 'tooLow' ? table.tooLow : table.tooHigh
}

/** Player-facing rephrasing of `result.detail`, same order and length. */
export function describeFeatureFailures(detail: readonly FeatureFailure[]): string[] {
  return detail.map(describeFeatureFailure)
}
