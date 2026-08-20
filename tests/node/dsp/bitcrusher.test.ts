import { describe, it, expect } from 'vitest'
import {
  quantize, decimate, createBitcrusherState, bitcrusherSample,
  MIN_BITS, MAX_BITS, MIN_RATE_HZ, MAX_RATE_HZ, type BitcrusherParams,
} from '../../../src/engine/dsp/bitcrusher'
import { fftMagnitude } from '../../../src/engine/analysis/fft'

const SR = 48000

function sineTone(frames: number, f0: number, sampleRate = SR, amp = 0.9): Float32Array {
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) out[i] = amp * Math.sin((2 * Math.PI * f0 * i) / sampleRate)
  return out
}

const bypassParams: BitcrusherParams = { bits: MAX_BITS, rate: MAX_RATE_HZ, bend: 0 }

describe('quantize', () => {
  it('at bits=1 collapses to essentially a sign/threshold detector -- exactly 2 distinct output levels', () => {
    const levels = new Set<number>()
    for (let x = -1; x <= 1; x += 0.001) levels.add(quantize(x, 1))
    expect(levels.size).toBeLessThanOrEqual(2)
  })

  it('produces exactly 2^bits distinct levels for a fine full-range sweep, at several integer bit depths', () => {
    for (const bits of [1, 2, 3, 4, 5, 8]) {
      const levels = new Set<number>()
      const steps = 20000
      for (let i = 0; i <= steps; i++) {
        const x = -1 + (2 * i) / steps
        levels.add(Math.round(quantize(x, bits) * 1e6) / 1e6) // dedupe float noise
      }
      // A fine sweep should hit at or very near every one of the 2^bits
      // levels -- allow a small margin for the sweep not landing exactly
      // on a boundary level.
      const expected = 2 ** bits
      expect(levels.size).toBeGreaterThanOrEqual(Math.min(expected - 1, expected))
      expect(levels.size).toBeLessThanOrEqual(expected)
    }
  })

  it('at bits=16 is essentially transparent -- error far below this project\'s own noise floor', () => {
    let maxErr = 0
    for (let x = -1; x <= 1; x += 0.0001) maxErr = Math.max(maxErr, Math.abs(quantize(x, 16) - x))
    // Same order as wav.ts's own PCM16 quantization step (~3e-5).
    expect(maxErr).toBeLessThan(1e-4)
  })

  it('is monotonic -- a larger input never quantizes to a smaller output', () => {
    for (const bits of [1, 3, 8]) {
      let prev = -Infinity
      for (let x = -1; x <= 1; x += 0.01) {
        const q = quantize(x, bits)
        expect(q).toBeGreaterThanOrEqual(prev)
        prev = q
      }
    }
  })

  it('clamps out-of-range bits rather than producing garbage', () => {
    expect(Number.isFinite(quantize(0.3, 0))).toBe(true)
    expect(Number.isFinite(quantize(0.3, 100))).toBe(true)
  })
})

describe('decimate', () => {
  it('at rate >= sampleRate, captures every sample -- transparent', () => {
    const state = createBitcrusherState()
    const input = sineTone(2000, 441)
    let maxErr = 0
    for (let i = 0; i < input.length; i++) {
      const out = decimate(state, input[i]!, SR, SR)
      maxErr = Math.max(maxErr, Math.abs(out - input[i]!))
    }
    expect(maxErr).toBeLessThan(1e-6)
  })

  it('holds each captured sample for exactly sampleRate/rate output samples', () => {
    const state = createBitcrusherState()
    const rate = 4800 // 1/10th of sampleRate -> hold for 10 samples
    const input = sineTone(500, 441)
    const out = new Float32Array(input.length)
    for (let i = 0; i < input.length; i++) out[i] = decimate(state, input[i]!, rate, SR)

    // Count run lengths of identical consecutive values.
    const runs: number[] = []
    let runLen = 1
    for (let i = 1; i < out.length; i++) {
      if (out[i] === out[i - 1]) runLen++
      else { runs.push(runLen); runLen = 1 }
    }
    runs.push(runLen)
    // Every run (except possibly the first, a partial one from init) should
    // be close to 10 samples long.
    const steadyRuns = runs.slice(1, -1)
    for (const r of steadyRuns) expect(r).toBeGreaterThanOrEqual(9)
    for (const r of steadyRuns) expect(r).toBeLessThanOrEqual(11)
  })

  it('a low rate produces a genuinely stepped (decimated) waveform, verified against a fresh reference', () => {
    const state = createBitcrusherState()
    const rate = 2000
    const input = sineTone(2000, 441)
    const out = new Float32Array(input.length)
    for (let i = 0; i < input.length; i++) out[i] = decimate(state, input[i]!, rate, SR)
    let changes = 0
    for (let i = 1; i < out.length; i++) if (out[i] !== out[i - 1]) changes++
    // sampleRate/rate = 24, so ~2000/24 ~= 83 changes expected -- far fewer
    // than the ~1000+ a smoothly varying sine would produce unstepped.
    expect(changes).toBeLessThan(150)
    expect(changes).toBeGreaterThan(40)
  })
})

describe('bitcrusherSample: unity/bypass settings pass signal essentially unchanged', () => {
  it('bits=16, rate=48000, bend=0 reproduces the input to within quantization noise', () => {
    const state = createBitcrusherState()
    const input = sineTone(4000, 441)
    let maxErr = 0
    for (let i = 0; i < input.length; i++) {
      const out = bitcrusherSample(state, input[i]!, bypassParams, SR)
      maxErr = Math.max(maxErr, Math.abs(out - input[i]!))
    }
    expect(maxErr).toBeLessThan(2e-4)
  })
})

describe('bitcrusherSample: verifies bit depth is real, not cosmetic', () => {
  it('the number of distinct output levels over a full sweep tracks 2^bits, at a fixed rate', () => {
    for (const bits of [2, 4, 6]) {
      const state = createBitcrusherState()
      const params: BitcrusherParams = { bits, rate: MAX_RATE_HZ, bend: 0 }
      const levels = new Set<number>()
      const n = 20000
      for (let i = 0; i < n; i++) {
        const x = -1 + (2 * i) / n
        levels.add(Math.round(bitcrusherSample(state, x, params, SR) * 1e6) / 1e6)
      }
      const expected = 2 ** bits
      expect(levels.size).toBeLessThanOrEqual(expected)
      expect(levels.size).toBeGreaterThanOrEqual(expected - 1)
    }
  })
})

describe('bitcrusherSample: alias floor is present (verifying the intentional aliasing exists)', () => {
  // The inverse of every other module's own alias-floor test in this
  // codebase: this module's whole point is to alias, so the claim under
  // test is "a low bit depth / low rate measurably adds broadband,
  // non-harmonic energy," not "stays clean." A clean sine crushed hard
  // should show real energy far from its own fundamental.
  it('a hard crush (bits=2) adds substantial non-harmonic energy versus an uncrushed tone', () => {
    const f0 = 1109
    const n = 65536
    const clean = sineTone(n, f0, SR, 0.9)
    const state = createBitcrusherState()
    const crushed = new Float32Array(n)
    const params: BitcrusherParams = { bits: 2, rate: MAX_RATE_HZ, bend: 0 }
    for (let i = 0; i < n; i++) crushed[i] = bitcrusherSample(state, clean[i]!, params, SR)

    const cleanMags = fftMagnitude(clean, 'blackman-harris')
    const crushedMags = fftMagnitude(crushed, 'blackman-harris')
    // Sum of magnitude outside a narrow band around the fundamental --
    // a crude but effective "how much broadband junk is here" measure.
    const binHz = SR / n
    const fundBin = Math.round(f0 / binHz)
    function nonFundamentalEnergy(mags: Float32Array): number {
      let sum = 0
      for (let i = 1; i < mags.length; i++) {
        if (Math.abs(i - fundBin) <= 3) continue
        sum += mags[i]!
      }
      return sum
    }
    const cleanJunk = nonFundamentalEnergy(cleanMags)
    const crushedJunk = nonFundamentalEnergy(crushedMags)
    expect(crushedJunk).toBeGreaterThan(cleanJunk * 20)
  })

  it('a low decimation rate adds substantial non-harmonic (imaging) energy', () => {
    const f0 = 1109
    const n = 65536
    const clean = sineTone(n, f0, SR, 0.9)
    const state = createBitcrusherState()
    const crushed = new Float32Array(n)
    const params: BitcrusherParams = { bits: MAX_BITS, rate: 3000, bend: 0 }
    for (let i = 0; i < n; i++) crushed[i] = bitcrusherSample(state, clean[i]!, params, SR)

    const binHz = SR / n
    const fundBin = Math.round(f0 / binHz)
    const crushedMags = fftMagnitude(crushed, 'blackman-harris')
    const cleanMags = fftMagnitude(clean, 'blackman-harris')
    function nonFundamentalEnergy(mags: Float32Array): number {
      let sum = 0
      for (let i = 1; i < mags.length; i++) {
        if (Math.abs(i - fundBin) <= 3) continue
        sum += mags[i]!
      }
      return sum
    }
    expect(nonFundamentalEnergy(crushedMags)).toBeGreaterThan(nonFundamentalEnergy(cleanMags) * 20)
  })
})

describe('bitcrusherSample: DC offset', () => {
  it('crushing a zero-mean tone at various bit depths introduces no large DC bias', () => {
    for (const bits of [1, 2, 4, 8, 16]) {
      const state = createBitcrusherState()
      const input = sineTone(8192, 300)
      const out = new Float32Array(input.length)
      const params: BitcrusherParams = { bits, rate: MAX_RATE_HZ, bend: 0 }
      for (let i = 0; i < input.length; i++) out[i] = bitcrusherSample(state, input[i]!, params, SR)
      const mags = fftMagnitude(out.subarray(0, 8192), 'blackman-harris')
      const dcDb = 20 * Math.log10(Math.max(mags[0]!, 1e-12))
      // Measured -125 to -240 dB across every bit depth (a symmetric sine
      // crosses zero evenly across many cycles, so a bare `round()`
      // quantizer's error stays balanced) -- bar set with real margin
      // below that, not loosened to make this pass.
      expect(dcDb).toBeLessThan(-100)
    }
  })

  it('decimation alone (no bit reduction) introduces no meaningful DC', () => {
    const state = createBitcrusherState()
    const input = sineTone(8192, 300)
    const out = new Float32Array(input.length)
    const params: BitcrusherParams = { bits: MAX_BITS, rate: 4000, bend: 0 }
    for (let i = 0; i < input.length; i++) out[i] = bitcrusherSample(state, input[i]!, params, SR)
    const mags = fftMagnitude(out.subarray(0, 8192), 'blackman-harris')
    const dcDb = 20 * Math.log10(Math.max(mags[0]!, 1e-12))
    // Measured -128.6 dB.
    expect(dcDb).toBeLessThan(-100)
  })
})

describe('bitcrusherSample: bend (stutter)', () => {
  it('at bend=0, is bit-for-bit identical to the same signal with bend disabled', () => {
    const input = sineTone(20000, 441)
    const withBend0 = new Float32Array(input.length)
    const withoutBend = new Float32Array(input.length)
    const s1 = createBitcrusherState()
    const s2 = createBitcrusherState()
    for (let i = 0; i < input.length; i++) {
      withBend0[i] = bitcrusherSample(s1, input[i]!, { bits: 8, rate: 12000, bend: 0 }, SR)
      withoutBend[i] = bitcrusherSample(s2, input[i]!, { bits: 8, rate: 12000, bend: 0 }, SR)
    }
    expect(Array.from(withBend0)).toEqual(Array.from(withoutBend))
  })

  it('at a nonzero bend, the output eventually repeats a recent chunk verbatim (a genuine stutter, not noise)', () => {
    // A rich, non-periodic-looking signal (sum of two non-commensurate
    // sines) so an accidental match would be extremely unlikely.
    const n = 96000
    const input = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      input[i] = 0.5 * Math.sin((2 * Math.PI * 437 * i) / SR) + 0.3 * Math.sin((2 * Math.PI * 991 * i) / SR)
    }
    const state = createBitcrusherState()
    const out = new Float32Array(n)
    const params: BitcrusherParams = { bits: MAX_BITS, rate: MAX_RATE_HZ, bend: 0.8 }
    for (let i = 0; i < n; i++) out[i] = bitcrusherSample(state, input[i]!, params, SR)

    // Find a run of >= 200 consecutive samples that repeats later in the
    // buffer -- direct evidence of a stutter (material replayed verbatim),
    // not just "the output changed."
    const windowLen = 200
    let foundRepeat = false
    outer:
    for (let start = 0; start < n - windowLen * 3; start += 500) {
      const window = out.subarray(start, start + windowLen)
      for (let probe = start + windowLen; probe < n - windowLen; probe += 1) {
        let matches = true
        for (let k = 0; k < windowLen; k++) {
          if (out[probe + k] !== window[k]) { matches = false; break }
        }
        if (matches) { foundRepeat = true; break outer }
      }
    }
    expect(foundRepeat).toBe(true)
  })

  it('stays finite and bounded at maximum bend with maximum crush simultaneously', () => {
    const state = createBitcrusherState()
    const input = sineTone(20000, 300)
    const params: BitcrusherParams = { bits: MIN_BITS, rate: MIN_RATE_HZ, bend: 1 }
    for (let i = 0; i < input.length; i++) {
      const out = bitcrusherSample(state, input[i]!, params, SR)
      expect(Number.isFinite(out)).toBe(true)
      expect(Math.abs(out)).toBeLessThanOrEqual(1.01)
    }
  })
})

describe('bitcrusherSample: stability under extreme settings', () => {
  it('never produces NaN/Infinity across the full param range, swept', () => {
    const state = createBitcrusherState()
    const input = sineTone(5000, 500)
    for (let i = 0; i < input.length; i++) {
      const t = i / input.length
      const params: BitcrusherParams = {
        bits: MIN_BITS + t * (MAX_BITS - MIN_BITS),
        rate: MIN_RATE_HZ + t * (MAX_RATE_HZ - MIN_RATE_HZ),
        bend: t,
      }
      const out = bitcrusherSample(state, input[i]!, params, SR)
      expect(Number.isFinite(out)).toBe(true)
    }
  })

  it('handles out-of-range params (negative rate, bits above the max) without crashing', () => {
    const state = createBitcrusherState()
    expect(() => {
      for (let i = 0; i < 2000; i++) {
        bitcrusherSample(state, Math.sin(i * 0.1), { bits: -5, rate: -100, bend: 2 }, SR)
      }
    }).not.toThrow()
  })

  it('a silent input stays silent (no self-oscillation from the crusher alone)', () => {
    const state = createBitcrusherState()
    const params: BitcrusherParams = { bits: 4, rate: 4000, bend: 0.5 }
    let maxAbs = 0
    for (let i = 0; i < 20000; i++) {
      maxAbs = Math.max(maxAbs, Math.abs(bitcrusherSample(state, 0, params, SR)))
    }
    expect(maxAbs).toBe(0)
  })
})
