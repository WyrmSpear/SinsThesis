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
 * Magnitude spectrum of a real signal.
 *
 * Applies a Hann window and scales so that a full-scale sine reads ~1.0 at
 * its bin. Returns n/2 bins; bin i corresponds to i * sampleRate / n Hz.
 */
export function fftMagnitude(samples: Float32Array): Float32Array {
  const n = samples.length
  if (!isPowerOfTwo(n)) {
    throw new Error(`fftMagnitude: length ${n} is not a power of two`)
  }

  const re = new Float64Array(n)
  const im = new Float64Array(n)

  // Hann window; its coherent gain of 0.5 is corrected in the scale below.
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)))
    re[i] = samples[i]! * w
  }

  fftInPlace(re, im)

  const half = n >> 1
  const out = new Float32Array(half)
  const scale = 4 / n // 2/n for the one-sided spectrum, 2x for Hann's 0.5 gain
  for (let i = 0; i < half; i++) {
    out[i] = Math.hypot(re[i]!, im[i]!) * scale
  }
  return out
}
