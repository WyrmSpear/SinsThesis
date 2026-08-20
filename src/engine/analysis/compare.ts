import { fftMagnitude } from './fft'
import {
  binToHz, spectralCentroid, spectralPeakinessDb, peakHz, db,
  peakNormalizedEnvelope, attackMs as attackMsOf,
} from './features'

/**
 * Perceptual-distance comparison between two rendered buffers -- the
 * academy's match-this-sound grading mode. This is the second grading
 * caller `engine/analysis` was built for (the first, `inspector.ts`, grades
 * topology; this grades sound), and the whole module exists because raw
 * FFT bin-by-bin L2 was rejected by design: it punishes an inaudible phase
 * or pitch offset exactly as harshly as a wrong filter, which is the "near
 * miss scores badly in ways that feel unfair" failure this mode was built
 * to avoid. Every measurement below is deliberately either mel-scaled,
 * normalised against its own level, or both, so the things a listener does
 * not notice (absolute level, phase, a few cents of pitch drift) do not
 * move the score, and the things they do notice (spectral shape, loudness
 * contour over time, brightness, resonance, waveform "fullness") do.
 *
 * Compare like with like: `target` and `player` must be the same length, at
 * the same sample rate, rendered through the same trigger schedule (see
 * `renderPatch` in `../render.ts`) -- a level's own responsibility, not
 * this module's.
 */

// ---- spectral shape: a short-time mel-dB "spectrogram", mean-subtracted
// per frame -- multiple frames rather than one FFT over the whole buffer so
// a swept filter (the resonant-sweep level) grades on its actual sweep
// shape instead of an average that blurs the sweep away; mean-subtracting
// each frame's mel-dB vector is what makes the comparison indifferent to
// absolute level, per Section 4's "normalise before comparing". ----

const MEL_BINS = 24
const NUM_FRAMES = 6
const FRAME_SIZE = 4096
const MIN_HZ = 40

/**
 * Dynamic range kept below each frame's own loudest mel band before
 * anything quieter is floored flat. Without this, a mel bin that falls
 * between a sparse harmonic spectrum's partials (a plain oscillator, not
 * noise) reads the FFT's own numeric floor -- `db()`'s `EPS = 1e-12` puts
 * that near -240 dB, nowhere close to anything audible. A tiny, genuinely
 * inaudible bit of energy landing in that bin (e.g. pulse width nudged 5%
 * off of a perfect square, which wakes a whisper of even harmonics that
 * were previously silent) then reads as a ~180 dB jump in that one bin --
 * measured directly, an otherwise-inaudible pulse-width tweak scored a
 * *worse* distance than swapping the waveform entirely.
 *
 * The floor is relative to each frame's own peak, not an absolute dBFS
 * number, and that distinction matters: an *absolute* floor was tried
 * first and broke level-invariance (also measured directly, via
 * tests/node/analysis/compare.test.ts's "not dominated by a level
 * difference" case) -- scaling a whole signal down by 20 dB pushes bins
 * that were just above an absolute floor to just below it, while bins
 * already comfortably clear of it shift cleanly, so the *pattern* of
 * which bins get clamped changes with level alone, and mean-subtracting
 * (Section 4: "normalise before comparing") cannot undo a nonlinear clamp
 * applied before it. A floor relative to the frame's own peak moves with
 * the signal's own level, so which bins get clamped is identical
 * regardless of how loud the render happened to be.
 */
const MEL_RELATIVE_FLOOR_DB = 60

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700)
}
function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1)
}

function largestPow2(n: number): number {
  let p = 1
  while (p * 2 <= n) p *= 2
  return p
}

/** Triangular mel filterbank: `filters[f][bin]` is filter `f`'s weight on
 *  FFT bin `bin`, dense (not sparse) because `MEL_BINS` and typical FFT
 *  sizes here keep the whole table well under a megabyte and this is
 *  called at most a few times per Check, never per audio sample. */
function buildMelFilters(
  numFilters: number, fftSize: number, sampleRate: number, minHz: number, maxHz: number,
): Float32Array[] {
  const half = fftSize / 2
  const melMin = hzToMel(minHz)
  const melMax = hzToMel(maxHz)
  const points: number[] = []
  for (let i = 0; i < numFilters + 2; i++) {
    points.push(melToHz(melMin + ((melMax - melMin) * i) / (numFilters + 1)))
  }
  const binHz = sampleRate / fftSize
  const bins = points.map((hz) => hz / binHz)

  const filters: Float32Array[] = []
  for (let f = 0; f < numFilters; f++) {
    const left = bins[f]!
    const center = bins[f + 1]!
    const right = bins[f + 2]!
    const row = new Float32Array(half)
    for (let bin = 0; bin < half; bin++) {
      if (bin >= left && bin <= center && center > left) row[bin] = (bin - left) / (center - left)
      else if (bin > center && bin <= right && right > center) row[bin] = (right - bin) / (right - center)
    }
    filters.push(row)
  }
  return filters
}

const melFilterCache = new Map<string, Float32Array[]>()
function melFilters(fftSize: number, sampleRate: number): Float32Array[] {
  const maxHz = Math.min((sampleRate / 2) * 0.9, 12000)
  const key = `${fftSize}:${sampleRate}`
  let cached = melFilterCache.get(key)
  if (!cached) {
    cached = buildMelFilters(MEL_BINS, fftSize, sampleRate, MIN_HZ, maxHz)
    melFilterCache.set(key, cached)
  }
  return cached
}

/** Start indices for `numFrames` equal-size analysis windows spread across
 *  `totalLength` -- shared by every short-time measurement below (the mel
 *  spectrogram and, since the fix described in the `peakiness` doc
 *  comment, the resonance proxy too), so "how this buffer gets sliced into
 *  frames" has exactly one definition. */
function frameStarts(totalLength: number, frameSize: number, numFrames: number): number[] {
  const hop = totalLength > frameSize ? Math.floor((totalLength - frameSize) / Math.max(1, numFrames - 1)) : 0
  const starts: number[] = []
  for (let f = 0; f < numFrames; f++) starts.push(Math.min(f * hop, Math.max(0, totalLength - frameSize)))
  return starts
}

function melSpectrogram(samples: Float32Array, sampleRate: number): Float32Array[] {
  const frameSize = Math.min(FRAME_SIZE, largestPow2(samples.length))
  const filters = melFilters(frameSize, sampleRate)
  const frames: Float32Array[] = []
  for (const start of frameStarts(samples.length, frameSize, NUM_FRAMES)) {
    const frame = samples.subarray(start, start + frameSize)
    const mags = fftMagnitude(frame, 'blackman-harris')
    const melDb = new Float32Array(filters.length)
    let frameMax = -Infinity
    for (let m = 0; m < filters.length; m++) {
      const weights = filters[m]!
      let energy = 0
      for (let bin = 0; bin < weights.length; bin++) energy += mags[bin]! * weights[bin]!
      const value = db(energy)
      melDb[m] = value
      if (value > frameMax) frameMax = value
    }
    const floor = frameMax - MEL_RELATIVE_FLOOR_DB
    for (let m = 0; m < melDb.length; m++) melDb[m] = Math.max(melDb[m]!, floor)
    const mean = melDb.reduce((a, b) => a + b, 0) / melDb.length
    for (let m = 0; m < melDb.length; m++) melDb[m] = melDb[m]! - mean
    frames.push(melDb)
  }
  return frames
}

// ---- envelope shape: peak-normalised RMS over time -- level-invariant the
// same way the spectral side is, and what "too short an attack" is actually
// measured from. ----

const ENV_WINDOW_MS = 20

// `peakNormalizedEnvelope`/`attackMs` used to be private copies here; both
// now live in features.ts, generalized for the constrained-challenge mode's
// use (analysis/rubric.ts), which needs the identical measurement on a
// single render rather than a pairwise comparison. Same window size, same
// 10%/90% crossing rule -- behavior here is unchanged.
function normalizedEnvelope(samples: Float32Array, sampleRate: number): Float32Array {
  return peakNormalizedEnvelope(samples, sampleRate, ENV_WINDOW_MS)
}

// ---- waveform "fullness": odd-vs-even harmonic balance, the actual
// acoustic difference between a hollow square/pulse (odd harmonics only,
// in the ideal case) and a full saw (every harmonic). ----

/** Sum of squared magnitude across the given harmonic numbers of `f0`, each
 *  harmonic located as the loudest bin within a tolerance window around
 *  `h * f0` -- the same technique `aliasFloorDb` uses so a fundamental that
 *  doesn't land exactly on a bin still locates its harmonics correctly. */
function harmonicEnergy(
  mags: Float32Array, size: number, sampleRate: number, f0: number, harmonics: readonly number[],
): number {
  const binHz = sampleRate / size
  const tolerance = Math.max(binHz * 4, f0 * 0.05)
  let energy = 0
  for (const h of harmonics) {
    const target = h * f0
    let peak = 0
    for (let i = 1; i < mags.length; i++) {
      const hz = binToHz(i, sampleRate, size)
      if (Math.abs(hz - target) <= tolerance) peak = Math.max(peak, mags[i]!)
    }
    energy += peak * peak
  }
  return energy
}

/** Odd-vs-even harmonic balance, in dB. Positive means the odd harmonics
 *  dominate (hollower, more square/pulse-like); negative means the even
 *  harmonics are comparably strong (fuller, more saw-like). Harmonic 1 (the
 *  fundamental) is excluded from both sides -- every waveform has one, so
 *  it doesn't discriminate. */
function oddEvenBalanceDb(samples: Float32Array, sampleRate: number): number {
  const f0 = peakHz(samples, sampleRate)
  if (f0 < 20) return 0
  const size = largestPow2(samples.length)
  const mags = fftMagnitude(samples.subarray(0, size), 'blackman-harris')
  const odd = harmonicEnergy(mags, size, sampleRate, f0, [3, 5, 7])
  const even = harmonicEnergy(mags, size, sampleRate, f0, [2, 4, 6])
  return db(Math.sqrt(odd)) - db(Math.sqrt(even))
}

// ---- resonance: features.ts's own peakiness measurement, over a band wide
// enough to catch a swept cutoff -- and taken as a *maximum across several
// short frames*, not one measurement over the whole buffer. That distinction
// was found by actually playing 08-match-resonance (see
// academy-match-sound-report.md): the resonant-sweep level's whole point is
// that the peak's frequency moves over the render's 2 seconds, and a single
// FFT over the *entire* buffer averages that moving peak's energy across
// every frequency it ever swept through -- smearing it into looking *less*
// peaky than a plain static, narrow-band patch (e.g. a low fixed cutoff
// with no resonance at all, whose sparse surviving harmonics still fit a
// log-log trend line poorly and read as "peaky" by the single-window
// measurement). That smearing produced exactly backwards feedback: a
// flat, non-resonant player patch was told it had "more resonance than the
// target." Taking the max across short frames instead measures "how peaky
// does this get, at its peakiest moment" -- what a listener actually
// responds to on a sweep, and unchanged for a static patch, where every
// frame is equally peaky anyway. ----

const RESONANCE_FROM_HZ = 150
const RESONANCE_TO_HZ_FRACTION = 0.9 // of Nyquist, capped below
const RESONANCE_FRAME_SIZE = 4096

function peakiness(samples: Float32Array, sampleRate: number): number {
  const toHz = Math.min((sampleRate / 2) * RESONANCE_TO_HZ_FRACTION, 10000)
  const frameSize = Math.min(RESONANCE_FRAME_SIZE, largestPow2(samples.length))
  let worst = -Infinity
  for (const start of frameStarts(samples.length, frameSize, NUM_FRAMES)) {
    const frame = samples.subarray(start, start + frameSize)
    worst = Math.max(worst, spectralPeakinessDb(frame, sampleRate, RESONANCE_FROM_HZ, toHz))
  }
  return worst
}

// ---- assembled features + the comparison itself ----

export interface SoundFeatures {
  /** Mean-subtracted log-mel-energy vectors, one per analysis frame. */
  melDb: Float32Array[]
  /** Peak-normalised RMS envelope. */
  envelope: Float32Array
  centroidHz: number
  attackMs: number
  /** Resonance proxy: how far the loudest bin sticks up above the band's own rolloff trend. */
  peakinessDb: number
  /** Waveform "fullness" proxy: odd-vs-even harmonic balance. */
  oddEvenDb: number
}

export function extractSoundFeatures(samples: Float32Array, sampleRate: number): SoundFeatures {
  const envelope = normalizedEnvelope(samples, sampleRate)
  return {
    melDb: melSpectrogram(samples, sampleRate),
    envelope,
    centroidHz: spectralCentroid(samples, sampleRate),
    attackMs: attackMsOf(envelope, ENV_WINDOW_MS),
    peakinessDb: peakiness(samples, sampleRate),
    oddEvenDb: oddEvenBalanceDb(samples, sampleRate),
  }
}

/**
 * Per-bin dB difference is capped before it's squared into the RMS average
 * -- a Huber-loss-style clip, not plain L2. Measured directly, without
 * this a single mel bin that happens to sit where a harmonic nulls out at
 * exactly one waveform setting (a perfect square's missing 2nd harmonic is
 * the sharpest example -- see the `pulseWidth` doc note on the
 * hollow-square level) swings by tens of dB the instant a player's knob
 * drifts a percent away from that exact value, and squared-and-averaged
 * across only 24 bins, that one bin alone was enough to fail an otherwise
 * dead-on-target patch. A listener does not perceive one quiet harmonic
 * partial as "tens of dB of difference" -- they perceive one waveform
 * sounding a little brighter or thinner than the other -- so this caps
 * any single bin's contribution at what a large, obviously-audible
 * difference already looks like, and lets the *number of bins* that
 * differ (a genuinely different waveform moves many of them) still
 * dominate the score the way it should.
 */
const MAX_BIN_DIFF_DB = 12

function melDistance(a: readonly Float32Array[], b: readonly Float32Array[]): number {
  const frames = Math.min(a.length, b.length)
  let sumSq = 0
  let count = 0
  for (let f = 0; f < frames; f++) {
    const bins = Math.min(a[f]!.length, b[f]!.length)
    for (let i = 0; i < bins; i++) {
      const d = Math.min(Math.abs(a[f]![i]! - b[f]![i]!), MAX_BIN_DIFF_DB)
      sumSq += d * d
      count++
    }
  }
  return count === 0 ? 0 : Math.sqrt(sumSq / count)
}

function envDistance(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let sumSq = 0
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!
    sumSq += d * d
  }
  return Math.sqrt(sumSq / n)
}

// Combination weights and "notice" thresholds. The weights and the general
// shape of the formula are a design choice (spectral shape carries more of
// a sound's identity than its envelope, hence 65/35); the pass threshold
// each level actually grades against is not guessed from these constants --
// see academy-match-sound-report.md for the measured correct-vs-close-miss
// numbers that set it.
const SPECTRAL_REF_DB = 9
const SPECTRAL_WEIGHT = 0.65
const ENVELOPE_WEIGHT = 0.35

const NOTICE = {
  brightnessOctaves: 0.25,
  attackMs: 30,
  resonanceDb: 3,
  fullnessDb: 5,
}

export type SoundDetail =
  | { kind: 'brightness'; direction: 'brighter' | 'darker'; octaves: number }
  | { kind: 'attack'; direction: 'shorter' | 'longer'; ms: number }
  | { kind: 'resonance'; direction: 'more' | 'less'; db: number }
  | { kind: 'fullness'; direction: 'hollower' | 'fuller'; db: number }

/** Ranks every dimension by how many multiples of its own "you'd notice
 *  this" threshold it's off by, keeps whichever cross that threshold (or,
 *  if literally none do but the overall distance still failed, the single
 *  worst one anyway) -- so a failed Check is never silent about what to
 *  try next, capped at three lines so it reads as guidance, not a wall of
 *  numbers. */
function buildDetail(target: SoundFeatures, player: SoundFeatures): SoundDetail[] {
  const items: { detail: SoundDetail; severity: number }[] = []

  const octaves = Math.log2(Math.max(player.centroidHz, 1) / Math.max(target.centroidHz, 1))
  items.push({
    detail: { kind: 'brightness', direction: octaves >= 0 ? 'brighter' : 'darker', octaves: Math.abs(octaves) },
    severity: Math.abs(octaves) / NOTICE.brightnessOctaves,
  })

  const attackDiff = player.attackMs - target.attackMs
  items.push({
    detail: { kind: 'attack', direction: attackDiff >= 0 ? 'longer' : 'shorter', ms: Math.abs(attackDiff) },
    severity: Math.abs(attackDiff) / NOTICE.attackMs,
  })

  const resDiff = player.peakinessDb - target.peakinessDb
  items.push({
    detail: { kind: 'resonance', direction: resDiff >= 0 ? 'more' : 'less', db: Math.abs(resDiff) },
    severity: Math.abs(resDiff) / NOTICE.resonanceDb,
  })

  const fullDiff = player.oddEvenDb - target.oddEvenDb
  items.push({
    detail: { kind: 'fullness', direction: fullDiff >= 0 ? 'hollower' : 'fuller', db: Math.abs(fullDiff) },
    severity: Math.abs(fullDiff) / NOTICE.fullnessDb,
  })

  const notable = items.filter((it) => it.severity >= 1)
  const chosen = notable.length > 0 ? notable : [items.reduce((a, b) => (b.severity > a.severity ? b : a))]
  return chosen.sort((a, b) => b.severity - a.severity).slice(0, 3).map((it) => it.detail)
}

export interface SoundComparison {
  pass: boolean
  /** 0 for identical sounds, growing with perceptual difference; unbounded above. */
  distance: number
  spectralDistance: number
  envelopeDistance: number
  /** Ranked, most-significant first; empty when `pass` is true. */
  detail: SoundDetail[]
}

/**
 * Compares two renders of the same duration and sample rate and grades how
 * close `player` is to `target`. `passThreshold` is a level's own rubric
 * value, not a constant baked in here -- see
 * `.superpowers/sdd/academy-match-sound-report.md` for how it was measured.
 */
export function compareSounds(
  target: Float32Array, player: Float32Array, sampleRate: number, passThreshold: number,
): SoundComparison {
  const tf = extractSoundFeatures(target, sampleRate)
  const pf = extractSoundFeatures(player, sampleRate)

  const spectralDistance = melDistance(tf.melDb, pf.melDb) / SPECTRAL_REF_DB
  const envelopeDistance = envDistance(tf.envelope, pf.envelope)
  const distance = SPECTRAL_WEIGHT * spectralDistance + ENVELOPE_WEIGHT * envelopeDistance

  return {
    pass: distance <= passThreshold,
    distance,
    spectralDistance,
    envelopeDistance,
    detail: distance <= passThreshold ? [] : buildDetail(tf, pf),
  }
}
