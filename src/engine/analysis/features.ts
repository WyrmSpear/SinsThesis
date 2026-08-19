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
