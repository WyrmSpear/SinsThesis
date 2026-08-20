import { fftMagnitude, type FftWindow } from './fft'

/** Largest power of two that fits in `n`. */
function fitPow2(n: number): number {
  let p = 1
  while (p * 2 <= n) p *= 2
  return p
}

/** Magnitude spectrum of the largest power-of-two prefix, with the size used. */
function spectrumOf(
  samples: Float32Array, window: FftWindow = 'hann',
): { mags: Float32Array; size: number } {
  const size = fitPow2(samples.length)
  return { mags: fftMagnitude(samples.subarray(0, size), window), size }
}

export function binToHz(bin: number, sampleRate: number, fftSize: number): number {
  return (bin * sampleRate) / fftSize
}

export function peakHz(samples: Float32Array, sampleRate: number): number {
  const { mags, size } = spectrumOf(samples)
  let peak = 1
  for (let i = 1; i < mags.length; i++) if (mags[i]! > mags[peak]!) peak = i
  return binToHz(peak, sampleRate, size)
}

/**
 * Fundamental frequency by normalised autocorrelation, over lags
 * corresponding to `[minHz, maxHz]`. Added for `pitchDropOctaves` below --
 * `peakHz`'s "loudest FFT bin" definition of pitch is the *spectral* peak,
 * not the fundamental, and the two are the same thing only for a
 * relatively clean waveform. They come apart exactly where
 * constrained-challenge's harder levels live: a heavily wavefolded or
 * FM-distorted tone can have a harmonic louder than its own fundamental,
 * and `peakHz` then reports that harmonic instead -- measured directly, an
 * envelope-driven wavefolder patch with a *perfectly steady* pitch (no
 * cable anywhere near the oscillator's tuning) read a spurious ~0.8 octave
 * "pitch drift" this way, because the fold's own intensity (and therefore
 * which harmonic dominates) changes over the same envelope that was meant
 * to only affect brightness. Autocorrelation instead measures the
 * waveform's own repetition period, which distortion (folding, FM,
 * wavetable choice) does not change even when it reshapes the spectral
 * envelope -- exactly the property `pitchDropOctaves` needs to tell "the
 * pitch actually moved" apart from "the timbre changed, so the loudest bin
 * moved with it." Returns 0 if nothing in range correlates (silence, or
 * noise with no periodic content).
 *
 * A plain argmax over normalised correlation octave-errors on a clean tone:
 * for a pure sine, correlation at 2x, 3x, 4x... the true period is
 * mathematically identical to correlation at the true period itself (both
 * are 1.0), so which one numerically wins is decided by floating-point
 * summation noise, not signal content -- caught by a unit test that fed a
 * plain 220 Hz sine in and got a "fundamental" of 44 Hz back (exactly a
 * fifth harmonic-length lag) purely from rounding. Fixed the standard way
 * autocorrelation-based pitch trackers (e.g. YIN) do: find the best
 * correlation anywhere in range, then return the *shortest* lag within 1%
 * of it, rather than whichever lag happens to argmax. Every integer
 * multiple of the true period is a candidate near-tie; the shortest one is
 * always the fundamental.
 */
export function autocorrelationPitchHz(
  samples: Float32Array, sampleRate: number, minHz = 30, maxHz = 1000,
): number {
  const maxLag = Math.floor(sampleRate / minHz)
  const minLag = Math.max(1, Math.floor(sampleRate / maxHz))
  const n = Math.min(samples.length, maxLag * 3)
  if (n <= maxLag || minLag >= maxLag) return 0

  const norms = new Float32Array(maxLag + 1)
  let globalBest = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0
    let energy = 0
    for (let i = 0; i + lag < n; i++) {
      sum += samples[i]! * samples[i + lag]!
      energy += samples[i]! * samples[i]!
    }
    const norm = energy > EPS ? sum / energy : 0
    norms[lag] = norm
    if (norm > globalBest) globalBest = norm
  }
  if (globalBest <= 0) return 0

  const threshold = globalBest * 0.99
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (norms[lag]! >= threshold) return sampleRate / lag
  }
  return 0
}

export function rms(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!
  return Math.sqrt(sum / samples.length)
}

/** One RMS value per `windowSize` samples. Trailing partial window is dropped. */
export function rmsEnvelope(samples: Float32Array, windowSize: number): Float32Array {
  const count = Math.floor(samples.length / windowSize)
  const out = new Float32Array(count)
  for (let w = 0; w < count; w++) {
    out[w] = rms(samples.subarray(w * windowSize, (w + 1) * windowSize))
  }
  return out
}

export function spectralCentroid(samples: Float32Array, sampleRate: number): number {
  const { mags, size } = spectrumOf(samples)
  let weighted = 0
  let total = 0
  for (let i = 1; i < mags.length; i++) {
    weighted += binToHz(i, sampleRate, size) * mags[i]!
    total += mags[i]!
  }
  return total === 0 ? 0 : weighted / total
}

export const EPS = 1e-12
export const db = (x: number) => 20 * Math.log10(Math.max(x, EPS))

/** A least-squares fit of dB against log2(Hz) over every bin in `[fromHz,
 *  toHz]`, shared by `slopeDbPerOctave` (wants just the slope) and
 *  `spectralPeakinessDb` (wants the residual of each bin above the line). */
function fitLogLogDb(
  mags: Float32Array, size: number, sampleRate: number, fromHz: number, toHz: number,
): { slope: number; intercept: number; points: { hz: number; db: number }[] } {
  const points: { hz: number; db: number }[] = []
  for (let i = 1; i < mags.length; i++) {
    const hz = binToHz(i, sampleRate, size)
    if (hz < fromHz || hz > toHz) continue
    points.push({ hz, db: db(mags[i]!) })
  }
  if (points.length < 2) throw new Error('fitLogLogDb: band too narrow to fit')

  const n = points.length
  const meanX = points.reduce((a, p) => a + Math.log2(p.hz), 0) / n
  const meanY = points.reduce((a, p) => a + p.db, 0) / n
  let num = 0
  let den = 0
  for (const p of points) {
    const x = Math.log2(p.hz)
    num += (x - meanX) * (p.db - meanY)
    den += (x - meanX) ** 2
  }
  const slope = num / den
  return { slope, intercept: meanY - slope * meanX, points }
}

/**
 * Least-squares slope of the spectrum in dB against log2(Hz), measured between
 * `fromHz` and `toHz`. A one-pole filter reads about -6, a four-pole about -24.
 *
 * Fits every bin in the band. On dense spectra -- noise, filtered noise -- that
 * is unbiased and is the intended use. On sparse harmonic spectra the
 * inter-harmonic leakage floor dominates the fit and biases the result steeper
 * than the harmonic envelope, so compare like with like rather than reading an
 * absolute figure off a harmonic-rich signal.
 */
export function slopeDbPerOctave(
  samples: Float32Array, sampleRate: number, fromHz: number, toHz: number,
): number {
  const { mags, size } = spectrumOf(samples)
  return fitLogLogDb(mags, size, sampleRate, fromHz, toHz).slope
}

/**
 * How far the loudest bin in `[fromHz, toHz]` sticks up above the band's own
 * least-squares rolloff trend, in dB -- added for the academy's
 * match-this-sound grading mode (`engine/analysis/compare.ts`), which needs
 * a "how resonant does this sound" number that works whether the peak sits at
 * a fixed cutoff or is being swept by an LFO (see the resonant-sweep level).
 *
 * A plain lowpass rolloff tracks its own trend line closely -- low
 * peakiness, close to 0 dB, regardless of how steep the rolloff itself is.
 * A resonant peak sticks up out of that same trend by however many dB the
 * resonance boosts it, which is exactly the "zing" a player hears and a raw
 * magnitude reading (dominated by cutoff frequency and drive, not
 * resonance) would miss. Blackman-Harris, like `aliasFloorDb`: this is a
 * floor-relative measurement and Hann's -31.5 dB first sidelobe would put
 * a floor under it (see fft.ts's `FftWindow` doc comment).
 */
export function spectralPeakinessDb(
  samples: Float32Array, sampleRate: number, fromHz: number, toHz: number,
): number {
  const { mags, size } = spectrumOf(samples, 'blackman-harris')
  const fit = fitLogLogDb(mags, size, sampleRate, fromHz, toHz)
  let maxResidual = -Infinity
  for (const p of fit.points) {
    const predicted = fit.intercept + fit.slope * Math.log2(p.hz)
    maxResidual = Math.max(maxResidual, p.db - predicted)
  }
  return maxResidual
}

/**
 * Loudest non-harmonic content, in dB relative to the fundamental -- the
 * closest thing this codebase has to a trustworthy alias-floor measurement.
 *
 * Uses the Blackman-Harris window (see fft.ts) rather than Hann, because
 * Hann's -31.5 dB first sidelobe puts a floor under any measurement built on
 * it: readings near -31 dB are the window, not the signal. Blackman-Harris's
 * -92 dB sidelobes let a genuinely clean oscillator read that low.
 *
 * DC (h=0) is excluded from the alias search on the same basis as every
 * other harmonic: a window spreads energy from 0 Hz into its neighboring
 * bins, and without this exclusion that leakage gets counted as "alias" even
 * when the oscillator has none. (A synthetically band-limited pulse with
 * pw=0.3 and no real aliasing used to report a *positive* floor for exactly
 * this reason; with DC excluded it reads about -144.7 dB.)
 *
 * The exclusion band around each harmonic -- including DC -- is
 * `max(binHz * 8, fundamentalHz * 0.03)` wide, and the fundamental's own
 * magnitude is the maximum over every bin within that same tolerance of
 * `fundamentalHz`, not a single rounded bin, so a test tone that isn't
 * exactly bin-aligned is still located correctly.
 *
 * IMPORTANT: do not call this with a `fundamentalHz` where
 * `sampleRate / fundamentalHz` is at or near an integer. When it is, every
 * alias product also lands on an exact harmonic multiple of the fundamental
 * and gets excluded along with the real harmonics -- the metric then reports
 * however quiet the *window floor* is, not how much the oscillator aliases.
 * That is exactly how this project previously measured a fictitious -71 dB
 * "alias floor" at 2 kHz into a 48 kHz sample rate (48000 / 2000 = 24):
 * every alias folded onto a harmonic and vanished from the count along with
 * it. Prefer a fundamental that is not a small-integer divisor of the sample
 * rate.
 */
// ---- envelope timing: attack/decay in ms, off a peak-normalised RMS
// envelope -- added for the academy's third grading mode,
// constrained-challenge (`analysis/rubric.ts`), which grades a single
// render's envelope *shape* rather than comparing two renders the way
// `compare.ts`'s match-this-sound mode does. `compare.ts` already computed
// an equivalent peak-normalised envelope and attack time privately, for its
// own pairwise use; those two are now built on the general versions here
// instead of duplicating the math, and behave identically (same window
// size, same 10%/90% crossing rule) -- see compare.ts's own imports. ----

/** RMS envelope (`rmsEnvelope`, `windowMs`-wide windows), scaled so its own
 *  peak reads 1 -- level-invariant the same way `compare.ts` needs it to
 *  be, and the basis `attackMs`/`decayMs` and `peakRms` below measure from.
 *  A buffer at or below the noise floor for its entire length (silence)
 *  comes back unscaled rather than divided by ~zero. */
export function peakNormalizedEnvelope(samples: Float32Array, sampleRate: number, windowMs = 20): Float32Array {
  const windowSize = Math.max(1, Math.round((windowMs / 1000) * sampleRate))
  const env = rmsEnvelope(samples, windowSize)
  let peak = 0
  for (const v of env) peak = Math.max(peak, v)
  if (peak < EPS) return env
  const out = new Float32Array(env.length)
  for (let i = 0; i < env.length; i++) out[i] = env[i]! / peak
  return out
}

/** Time from a peak-normalised envelope's own 10% point to its own 90%
 *  point, in ms. Reads 0 for a sound that starts already near its peak (an
 *  unfired ADSR, or a free-running drone) -- there is no attack there to
 *  measure, which is the right answer. */
export function attackMs(normEnv: Float32Array, windowMs: number): number {
  let tenPct = -1
  let ninetyPct = -1
  for (let i = 0; i < normEnv.length; i++) {
    if (tenPct === -1 && normEnv[i]! >= 0.1) tenPct = i
    if (ninetyPct === -1 && normEnv[i]! >= 0.9) {
      ninetyPct = i
      break
    }
  }
  if (tenPct === -1 || ninetyPct === -1 || ninetyPct < tenPct) return 0
  return (ninetyPct - tenPct) * windowMs
}

/** Time from a peak-normalised envelope's own peak down to 10% of it, in
 *  ms -- the "how long does this ring on" half of an envelope's shape that
 *  `attackMs` doesn't cover, needed for the constrained-challenge mode's
 *  "is this actually short" bounds (a convincing kick has to die away, not
 *  just start fast). Infinity for a sound that never decays within the
 *  render -- a drone, or anything still near full level when the buffer
 *  ends -- which is the right answer: there is no decay there to measure,
 *  and a rubric bounding this with a `max` correctly rejects it either way. */
export function decayMs(normEnv: Float32Array, windowMs: number): number {
  let peakIndex = -1
  let peakVal = -Infinity
  for (let i = 0; i < normEnv.length; i++) {
    if (normEnv[i]! > peakVal) {
      peakVal = normEnv[i]!
      peakIndex = i
    }
  }
  if (peakIndex === -1) return 0
  for (let i = peakIndex; i < normEnv.length; i++) {
    if (normEnv[i]! <= 0.1) return (i - peakIndex) * windowMs
  }
  return Infinity
}

/** How loud the signal actually got at its loudest `windowMs` window, in
 *  RMS -- not the whole-buffer `rms()`, which reads misleadingly quiet for
 *  anything percussive: a one-shot patch rendered for a few seconds spends
 *  most of that buffer near silence after it decays, and averaging that
 *  silence in is the wrong "is this loud enough" gate. */
export function peakRms(samples: Float32Array, sampleRate: number, windowMs = 20): number {
  const windowSize = Math.max(1, Math.round((windowMs / 1000) * sampleRate))
  const env = rmsEnvelope(samples, windowSize)
  let peak = 0
  for (const v of env) peak = Math.max(peak, v)
  return peak
}

// ---- drift and motion: how far a per-buffer scalar measurement moves
// over the length of a render -- added for the same mode, which needs to
// tell "the pitch swept down as it decayed" (a kick's pitch envelope) or
// "the tone got duller as it decayed" (a brightness envelope faked without
// a filter) apart from "this never changes at all" (a static tone),
// neither of which any single-scalar feature above (peakHz,
// spectralCentroid) can express on its own -- each collapses the whole
// buffer to one number. ----

/** How far `measure` moves between a short window early in the buffer and
 *  another later on, in octaves (log2 of the ratio). Positive means the
 *  measurement fell from the early window to the later one; negative means
 *  it rose. 0 when either window has no signal to measure (nothing to
 *  report, not a measured drop) or falls outside the buffer entirely. */
function driftOctaves(
  measure: (chunk: Float32Array, sampleRate: number) => number,
  samples: Float32Array,
  sampleRate: number,
  earlyStartMs: number,
  lateStartMs: number,
  windowMs: number,
): number {
  const windowSize = Math.max(1, Math.round((windowMs / 1000) * sampleRate))
  const earlyStart = Math.round((earlyStartMs / 1000) * sampleRate)
  const lateStart = Math.round((lateStartMs / 1000) * sampleRate)
  if (earlyStart + windowSize > samples.length || lateStart + windowSize > samples.length) return 0
  const early = measure(samples.subarray(earlyStart, earlyStart + windowSize), sampleRate)
  const late = measure(samples.subarray(lateStart, lateStart + windowSize), sampleRate)
  if (early <= 0 || late <= 0) return 0
  return Math.log2(early / late)
}

/** `driftOctaves` of the fundamental -- how much a sound's pitch fell
 *  (positive) or rose (negative) between an early window and a later one.
 *  This is what tells a kick's pitch-enveloped thump apart from a
 *  fixed-pitch tone with only an amplitude envelope, and (the harder
 *  case) what tells a genuinely pitch-bent tone apart from one whose
 *  *timbre* is changing instead (a wavefolder's drive fading with an
 *  envelope). Built on `autocorrelationPitchHz`, not `peakHz` -- see that
 *  function's own doc comment for why the spectral-peak definition of
 *  pitch is the wrong one here. */
export function pitchDropOctaves(
  samples: Float32Array,
  sampleRate: number,
  earlyStartMs: number,
  lateStartMs: number,
  windowMs = 20,
): number {
  return driftOctaves(autocorrelationPitchHz, samples, sampleRate, earlyStartMs, lateStartMs, windowMs)
}

/** `driftOctaves` of the spectral centroid -- how much a sound's timbre
 *  darkened (positive) or brightened (negative) between an early window
 *  and a later one, independent of any pitch change (a filter sweep, or a
 *  wavefolder's drive fading with an envelope, both move this; a static
 *  waveform's own decay does not, since scaling a fixed spectrum down
 *  uniformly does not move its centroid). */
export function brightnessDropOctaves(
  samples: Float32Array,
  sampleRate: number,
  earlyStartMs: number,
  lateStartMs: number,
  windowMs = 50,
): number {
  return driftOctaves(spectralCentroid, samples, sampleRate, earlyStartMs, lateStartMs, windowMs)
}

/** Spread (max - min, in octaves) of the spectral centroid measured over
 *  `frames` equal-size slices across the whole buffer -- a "does this
 *  sound's brightness move at all over its lifetime" proxy for a
 *  sustained, evolving texture, where `brightnessDropOctaves`'s two fixed
 *  early/late windows would miss motion that happens later, earlier, or
 *  more than once (an LFO sweeping a filter back and forth, for
 *  instance). A static tone or a filter sitting still reads near 0
 *  regardless of how bright or dark it is; genuine movement reads however
 *  many octaves the brightest and darkest moments differ by. */
export function spectralCentroidMotionOctaves(samples: Float32Array, sampleRate: number, frames = 8): number {
  const frameSize = Math.floor(samples.length / frames)
  if (frameSize < 256) return 0
  let min = Infinity
  let max = -Infinity
  for (let f = 0; f < frames; f++) {
    const chunk = samples.subarray(f * frameSize, (f + 1) * frameSize)
    const c = spectralCentroid(chunk, sampleRate)
    if (c > 0) {
      min = Math.min(min, c)
      max = Math.max(max, c)
    }
  }
  if (!Number.isFinite(min) || min <= 0) return 0
  return Math.log2(max / min)
}

export function aliasFloorDb(
  samples: Float32Array, sampleRate: number, fundamentalHz: number,
): number {
  const { mags, size } = spectrumOf(samples, 'blackman-harris')
  const binHz = sampleRate / size
  const tolerance = Math.max(binHz * 8, fundamentalHz * 0.03)

  let fundamental = 0
  for (let i = 1; i < mags.length; i++) {
    const hz = binToHz(i, sampleRate, size)
    if (Math.abs(hz - fundamentalHz) <= tolerance) {
      fundamental = Math.max(fundamental, mags[i]!)
    }
  }
  if (fundamental === 0) throw new Error('aliasFloorDb: no energy at the fundamental')

  let worstAlias = 0
  for (let i = 1; i < mags.length; i++) {
    const hz = binToHz(i, sampleRate, size)
    const harmonicIndex = Math.round(hz / fundamentalHz)
    const nearestHarmonic = harmonicIndex * fundamentalHz
    const isHarmonicOrDc = Math.abs(hz - nearestHarmonic) <= tolerance
    if (!isHarmonicOrDc && mags[i]! > worstAlias) {
      worstAlias = mags[i]!
    }
  }
  return db(worstAlias) - db(fundamental)
}
