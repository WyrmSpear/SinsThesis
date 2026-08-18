import { fftMagnitude } from './fft'

/** Largest power of two that fits in `n`. */
function fitPow2(n: number): number {
  let p = 1
  while (p * 2 <= n) p *= 2
  return p
}

/** Magnitude spectrum of the largest power-of-two prefix, with the size used. */
function spectrumOf(samples: Float32Array): { mags: Float32Array; size: number } {
  const size = fitPow2(samples.length)
  return { mags: fftMagnitude(samples.subarray(0, size)), size }
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

const EPS = 1e-12
const db = (x: number) => 20 * Math.log10(Math.max(x, EPS))

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
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 1; i < mags.length; i++) {
    const hz = binToHz(i, sampleRate, size)
    if (hz < fromHz || hz > toHz) continue
    xs.push(Math.log2(hz))
    ys.push(db(mags[i]!))
  }
  if (xs.length < 2) throw new Error('slopeDbPerOctave: band too narrow to fit')

  const n = xs.length
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  const meanY = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - meanX) * (ys[i]! - meanY)
    den += (xs[i]! - meanX) ** 2
  }
  return num / den
}

/**
 * Loudest non-harmonic content, in dB relative to the fundamental.
 *
 * Bins within a quarter-tone of any integer multiple of `fundamentalHz` count
 * as harmonic and are excluded; everything else is alias or noise. An
 * antialiased oscillator should stay below -60.
 */
export function aliasFloorDb(
  samples: Float32Array, sampleRate: number, fundamentalHz: number,
): number {
  const { mags, size } = spectrumOf(samples)
  const binHz = sampleRate / size
  const tolerance = Math.max(binHz * 2, fundamentalHz * 0.03)

  let fundamental = 0
  let worstAlias = 0
  for (let i = 1; i < mags.length; i++) {
    const hz = binToHz(i, sampleRate, size)
    const nearestHarmonic = Math.round(hz / fundamentalHz) * fundamentalHz
    const isHarmonic = nearestHarmonic > 0 && Math.abs(hz - nearestHarmonic) <= tolerance
    if (isHarmonic) {
      if (Math.abs(nearestHarmonic - fundamentalHz) <= tolerance) {
        fundamental = Math.max(fundamental, mags[i]!)
      }
    } else if (mags[i]! > worstAlias) {
      worstAlias = mags[i]!
    }
  }
  if (fundamental === 0) throw new Error('aliasFloorDb: no energy at the fundamental')
  return db(worstAlias) - db(fundamental)
}
