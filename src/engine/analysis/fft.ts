/**
 * Radix-2 FFT with a Hann window, used by every measurement in the engine.
 * Pure: no audio context, no DOM, runs identically in Node and the browser.
 */

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0
}

/** In-place complex FFT. `re` and `im` must be the same power-of-two length. */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j]!, re[i]!]
      ;[im[i], im[j]] = [im[j]!, im[i]!]
    }
  }

  // Danielson-Lanczos butterflies.
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k]!
        const aIm = im[i + k]!
        const bRe = re[i + k + len / 2]! * curRe - im[i + k + len / 2]! * curIm
        const bIm = re[i + k + len / 2]! * curIm + im[i + k + len / 2]! * curRe
        re[i + k] = aRe + bRe
        im[i + k] = aIm + bIm
        re[i + k + len / 2] = aRe - bRe
        im[i + k + len / 2] = aIm - bIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

/**
 * Window applied before the FFT.
 *
 * 'hann' has a first sidelobe at -31.5 dB relative to its mainlobe: any
 * measurement built on it cannot report a noise or alias floor below about
 * -31 dB, because at that point you are reading the window, not the signal.
 * 'blackman-harris' (4-term) pushes the first sidelobe down to about -92 dB
 * at the cost of a wider mainlobe, which is why every floor measurement in
 * features.ts (aliasFloorDb, and anything else claiming a floor below -31 dB)
 * must use it instead of 'hann'.
 */
export type FftWindow = 'hann' | 'blackman-harris'

/**
 * Magnitude spectrum of a real signal.
 *
 * Applies the requested window (Hann by default, for backward compatibility
 * with existing callers) and scales so that a full-scale sine reads ~1.0 at
 * its bin. Returns n/2 bins; bin i corresponds to i * sampleRate / n Hz.
 */
export function fftMagnitude(samples: Float32Array, window: FftWindow = 'hann'): Float32Array {
  const n = samples.length
  if (!isPowerOfTwo(n)) {
    throw new Error(`fftMagnitude: length ${n} is not a power of two`)
  }

  const re = new Float64Array(n)
  const im = new Float64Array(n)

  let windowSum = 0
  if (window === 'blackman-harris') {
    // 4-term Blackman-Harris: -92 dB first sidelobe, versus Hann's -31.5 dB.
    const a = [0.35875, 0.48829, 0.14128, 0.01168]
    for (let i = 0; i < n; i++) {
      const w =
        a[0]! -
        a[1]! * Math.cos((2 * Math.PI * i) / (n - 1)) +
        a[2]! * Math.cos((4 * Math.PI * i) / (n - 1)) -
        a[3]! * Math.cos((6 * Math.PI * i) / (n - 1))
      re[i] = samples[i]! * w
      windowSum += w
    }
  } else {
    // Hann window; its coherent gain of 0.5 is corrected in the scale below.
    for (let i = 0; i < n; i++) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)))
      re[i] = samples[i]! * w
    }
  }

  fftInPlace(re, im)

  const half = n >> 1
  const out = new Float32Array(half)
  // Hann: 2/n for the one-sided spectrum, 2x for the 0.5 coherent gain -> 4/n.
  // Blackman-Harris: normalize by its own coherent gain (windowSum / n) so a
  // full-scale sine still reads ~1.0 -- i.e. 2 / windowSum.
  const scale = window === 'blackman-harris' ? 2 / windowSum : 4 / n
  for (let i = 0; i < half; i++) {
    out[i] = Math.hypot(re[i]!, im[i]!) * scale
  }
  return out
}
