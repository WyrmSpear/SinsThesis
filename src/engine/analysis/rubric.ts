import {
  spectralCentroid, spectralPeakinessDb,
  peakNormalizedEnvelope, attackMs as attackMsOf, decayMs as decayMsOf, peakRms as peakRmsOf,
  pitchDropOctaves as pitchDropOctavesOf, brightnessDropOctaves as brightnessDropOctavesOf,
  spectralCentroidMotionOctaves,
} from './features'

/**
 * Feature-bound grading for the academy's third mode, constrained
 * challenge -- "make a convincing kick using three modules and no
 * sequencer." `inspect()` grades topology (the exact wiring a level's
 * solution has); `compareSounds` grades distance to one target sound.
 * Neither fits here: a constrained-challenge level is graded on a *class*
 * of sounds, not one right answer and not one right patch, so the rubric
 * is a set of feature bounds -- is it percussive, is it dark enough, does
 * its pitch actually move -- any patch clearing every bound passes,
 * whatever it's wired like.
 *
 * Every feature this module knows how to grade is a thin named wrapper
 * around a measurement in `features.ts`; nothing here does its own DSP.
 * `FeatureName` is the vocabulary a rubric.json's `constrained.features`
 * object is written against (see academy/levels.ts's `ConstrainedRubric`),
 * and `gradeFeatures` is the one entry point that turns a rendered buffer
 * and a set of bounds into a pass/fail plus which bound, in which
 * direction, by how much -- the same "never a bare pass/fail" structure
 * `InspectorResult`/`SoundComparison` already use, so the academy's
 * presentation layer (academy/constrained-feedback.ts) can rephrase it the
 * same way.
 */

export interface FeatureBound {
  /** Value must be at or above this. */
  min?: number
  /** Value must be at or below this. */
  max?: number
}

export type FeatureName =
  | 'peakRms'
  | 'attackMs'
  | 'decayMs'
  | 'centroidHz'
  | 'peakinessDb'
  | 'pitchDropOctaves'
  | 'pitchDriftAbsOctaves'
  | 'brightnessDropOctaves'
  | 'centroidMotionOctaves'

export type FeatureBounds = Partial<Record<FeatureName, FeatureBound>>

export interface FeatureFailure {
  feature: FeatureName
  direction: 'tooLow' | 'tooHigh'
  value: number
  bound: number
}

export interface FeatureGradeResult {
  pass: boolean
  /** Every bounded feature's measured value, whether or not it passed --
   *  useful for calibration and for a caller that wants to show the raw
   *  numbers, not just which ones failed. */
  values: Partial<Record<FeatureName, number>>
  /** Ranked in bound-declaration order; empty when `pass` is true. */
  detail: FeatureFailure[]
}

// Shared measurement windows. A constrained-challenge level's own render
// length varies (a one-shot kick is graded over ~1s; a texture over
// several), but the *early/late* comparison windows these features use are
// about how a percussive envelope's first ~100ms behaves, which does not
// scale with the render's total length -- so these are fixed constants,
// not derived from `seconds`.
const ENVELOPE_WINDOW_MS = 20
const DRIFT_EARLY_MS = 15
const DRIFT_LATE_MS = 90
const RESONANCE_FROM_HZ = 150

// pitchDropOctaves/pitchDriftAbsOctaves need a wider analysis window than
// brightnessDropOctaves' default (50ms): a kick's fundamental lives as low
// as ~30-100Hz, and `peakHz`'s frequency resolution is `sampleRate /
// fftSize` -- at the 20ms window `driftOctaves` defaults to, that's a
// ~94Hz-wide bin at 48kHz, coarser than the gap between two nearby
// fundamentals in that range, so distinct early/late pitches collapsed
// onto the same bin and measured a false 0-octave drop (found by
// calibrating against a real patch, not by reasoning about it -- see
// .superpowers/sdd/academy-constrained-report.md). 60ms narrows that to
// ~23Hz, resolving them correctly.
const PITCH_WINDOW_MS = 60

function pitchDrift(samples: Float32Array, sampleRate: number): number {
  return pitchDropOctavesOf(samples, sampleRate, DRIFT_EARLY_MS, DRIFT_LATE_MS, PITCH_WINDOW_MS)
}

function computeFeature(name: FeatureName, samples: Float32Array, sampleRate: number): number {
  switch (name) {
    case 'peakRms':
      return peakRmsOf(samples, sampleRate, ENVELOPE_WINDOW_MS)
    case 'attackMs':
      return attackMsOf(peakNormalizedEnvelope(samples, sampleRate, ENVELOPE_WINDOW_MS), ENVELOPE_WINDOW_MS)
    case 'decayMs':
      return decayMsOf(peakNormalizedEnvelope(samples, sampleRate, ENVELOPE_WINDOW_MS), ENVELOPE_WINDOW_MS)
    case 'centroidHz':
      return spectralCentroid(samples, sampleRate)
    case 'peakinessDb':
      return spectralPeakinessDb(samples, sampleRate, RESONANCE_FROM_HZ, Math.min((sampleRate / 2) * 0.9, 10000))
    case 'pitchDropOctaves':
      return pitchDrift(samples, sampleRate)
    case 'pitchDriftAbsOctaves':
      return Math.abs(pitchDrift(samples, sampleRate))
    case 'brightnessDropOctaves':
      return brightnessDropOctavesOf(samples, sampleRate, DRIFT_EARLY_MS, DRIFT_LATE_MS)
    case 'centroidMotionOctaves':
      return spectralCentroidMotionOctaves(samples, sampleRate)
  }
}

/** Grades `samples` against `bounds`, one measurement per bounded feature.
 *  A feature with no bound in `bounds` is never computed at all -- a
 *  level's rubric only pays for what it actually grades. */
export function gradeFeatures(samples: Float32Array, sampleRate: number, bounds: FeatureBounds): FeatureGradeResult {
  const values: Partial<Record<FeatureName, number>> = {}
  const detail: FeatureFailure[] = []

  for (const feature of Object.keys(bounds) as FeatureName[]) {
    const bound = bounds[feature]
    if (!bound) continue
    const value = computeFeature(feature, samples, sampleRate)
    values[feature] = value
    if (bound.min !== undefined && value < bound.min) {
      detail.push({ feature, direction: 'tooLow', value, bound: bound.min })
    } else if (bound.max !== undefined && value > bound.max) {
      detail.push({ feature, direction: 'tooHigh', value, bound: bound.max })
    }
  }

  return { pass: detail.length === 0, values, detail }
}
