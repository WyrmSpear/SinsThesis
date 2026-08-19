import { describe, it, expect } from 'vitest'
import { compareSounds } from '../../../src/engine/analysis/compare'

/**
 * compareSounds is pure signal-in, number-out -- no AudioContext, no
 * worklets -- so these run against synthesized buffers the same way
 * features.test.ts exercises peakHz/spectralCentroid/etc, rather than
 * against a real renderGraph render (which needs a browser; see
 * tests/browser/rack-match-sound.test.ts for that side, with real DSP).
 *
 * 441 Hz is this project's known-safe test frequency: 48000 / 441 is not
 * near an integer (docs/CONTINUATION.md trap #1). Every other frequency
 * used below was checked against the same rule before use.
 */

const SR = 48000
const N = SR // one second

function gen(n: number, fn: (i: number) => number): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = fn(i)
  return out
}

/** Band-limited saw built from partials -- no aliasing by construction,
 *  same technique features.test.ts uses. */
function bandlimitedSaw(hz: number, n: number): Float32Array {
  const partials = Math.floor(SR / 2 / hz)
  return gen(n, (i) => {
    let v = 0
    for (let k = 1; k <= partials; k++) v += Math.sin((2 * Math.PI * k * hz * i) / SR) / k
    return (v * 2) / Math.PI
  })
}

/** Band-limited square (odd partials only), the same construction as
 *  bandlimitedSaw but stepping by 2 -- a hollow waveform by design. */
function bandlimitedSquare(hz: number, n: number): Float32Array {
  const partials = Math.floor(SR / 2 / hz)
  return gen(n, (i) => {
    let v = 0
    for (let k = 1; k <= partials; k += 2) v += Math.sin((2 * Math.PI * k * hz * i) / SR) / k
    return (v * 4) / Math.PI
  })
}

/** One-pole lowpass -- a plain -6 dB/oct rolloff, enough to stand in for a
 *  filter's cutoff without needing the real ladder worklet. */
function onePoleLowpass(x: Float32Array, cutoffHz: number): Float32Array {
  const alpha = 1 - Math.exp((-2 * Math.PI * cutoffHz) / SR)
  const y = new Float32Array(x.length)
  let prev = 0
  for (let i = 0; i < x.length; i++) {
    prev = prev + alpha * (x[i]! - prev)
    y[i] = prev
  }
  return y
}

/** A short, bright-ish pluck: a filtered saw under a fast-attack,
 *  exponentially-decaying envelope. */
function pluck(f0: number, cutoffHz: number, n: number = N): Float32Array {
  const filtered = onePoleLowpass(bandlimitedSaw(f0, n), cutoffHz)
  const attackSamples = Math.round(0.01 * SR)
  return gen(n, (i) => {
    const env = i < attackSamples ? i / attackSamples : Math.exp(-(i - attackSamples) / (0.3 * SR))
    return filtered[i]! * env
  })
}

describe('compareSounds', () => {
  it('reads near-zero distance for a signal against itself', () => {
    const sig = pluck(441, 3000)
    const cmp = compareSounds(sig, sig, SR, 0.5)
    expect(cmp.distance).toBeLessThan(1e-5)
    expect(cmp.pass).toBe(true)
    expect(cmp.detail).toEqual([])
  })

  it('is not dominated by a level difference alone', () => {
    const sig = pluck(441, 3000)
    const quiet = gen(sig.length, (i) => sig[i]! * 0.1) // -20 dB, same shape
    const loud = gen(sig.length, (i) => sig[i]! * 3) // +9.5 dB
    const quietDistance = compareSounds(sig, quiet, SR, 1).distance
    const loudDistance = compareSounds(sig, loud, SR, 1).distance
    // A wildly different sound (see the detune/cutoff tests below) reads
    // well above 1; level alone should stay small.
    expect(quietDistance).toBeLessThan(0.15)
    expect(loudDistance).toBeLessThan(0.15)
  })

  it('grows monotonically as the patch is detuned', () => {
    const base = pluck(441, 3000)
    const near = compareSounds(base, pluck(467, 3000), SR, 1).distance
    const mid = compareSounds(base, pluck(587, 3000), SR, 1).distance
    const far = compareSounds(base, pluck(880, 3000), SR, 1).distance
    expect(near).toBeLessThan(mid)
    expect(mid).toBeLessThan(far)
  })

  it('grows monotonically as the cutoff is moved', () => {
    const base = pluck(441, 4200)
    const near = compareSounds(base, pluck(441, 3100), SR, 1).distance
    const mid = compareSounds(base, pluck(441, 1500), SR, 1).distance
    const far = compareSounds(base, pluck(441, 380), SR, 1).distance
    expect(near).toBeLessThan(mid)
    expect(mid).toBeLessThan(far)
  })

  it('names brightness, in the right direction, when only cutoff moved down', () => {
    const target = pluck(441, 6500)
    const player = pluck(441, 700)
    const cmp = compareSounds(target, player, SR, 0.02) // tiny threshold forces a fail
    expect(cmp.pass).toBe(false)
    expect(cmp.detail.some((d) => d.kind === 'brightness' && d.direction === 'darker')).toBe(true)
  })

  it('names fullness for a hollow-vs-full waveform mismatch at the same pitch and cutoff', () => {
    const target = bandlimitedSaw(441, N) // full harmonic series
    const player = bandlimitedSquare(441, N) // odd harmonics only -- hollow
    const cmp = compareSounds(target, player, SR, 0.02)
    expect(cmp.pass).toBe(false)
    expect(cmp.detail.some((d) => d.kind === 'fullness' && d.direction === 'hollower')).toBe(true)
  })
})
