import { describe, it, expect } from 'vitest'
import { gradeFeatures } from '../../../src/engine/analysis/rubric'

/**
 * gradeFeatures is pure signal-in, verdict-out -- no AudioContext -- so
 * this exercises the bound-evaluation logic itself against synthetic
 * buffers built to have known, hand-checkable feature values, the same
 * split tests/browser/analysis/rubric-render.test.ts draws for real DSP
 * (real patches, real worklets, the actual three-pass/two-fail matrix).
 */

const SR = 48000
const N = SR // 1 second

function gen(n: number, fn: (i: number) => number): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = fn(i)
  return out
}

/** A percussive one-shot: fast attack, exponential decay, optional pitch
 *  envelope from f0 down (or up) to f1 with time constant tau. */
function pluck(f0: number, f1: number, tau: number, decayS: number, n: number = N): Float32Array {
  let phase = 0
  return gen(n, (i) => {
    const t = i / SR
    const f = f1 + (f0 - f1) * Math.exp(-t / tau)
    phase += (2 * Math.PI * f) / SR
    const env = t < 0.002 ? t / 0.002 : Math.exp(-(t - 0.002) / decayS)
    return Math.sin(phase) * env
  })
}

describe('gradeFeatures', () => {
  it('passes when every bound is satisfied', () => {
    const sig = pluck(300, 80, 0.03, 0.1)
    const result = gradeFeatures(sig, SR, {
      peakRms: { min: 0.1 },
      attackMs: { max: 20 },
      decayMs: { max: 400 },
      pitchDropOctaves: { min: 0.5 },
    })
    expect(result.pass).toBe(true)
    expect(result.detail).toEqual([])
  })

  it('computes only bounded features -- an unbounded one never appears in values', () => {
    const sig = pluck(300, 80, 0.03, 0.1)
    const result = gradeFeatures(sig, SR, { peakRms: { min: 0.01 } })
    expect(Object.keys(result.values)).toEqual(['peakRms'])
  })

  it('reports tooLow with the offending value and bound when a min bound is missed', () => {
    const silence = new Float32Array(N)
    const result = gradeFeatures(silence, SR, { peakRms: { min: 0.05 } })
    expect(result.pass).toBe(false)
    expect(result.detail).toEqual([{ feature: 'peakRms', direction: 'tooLow', value: 0, bound: 0.05 }])
  })

  it('reports tooHigh with the offending value and bound when a max bound is exceeded', () => {
    const sig = pluck(300, 300, 1, 5) // no pitch drop, very slow decay -- rings on
    const result = gradeFeatures(sig, SR, { decayMs: { max: 50 } })
    expect(result.pass).toBe(false)
    expect(result.detail.length).toBe(1)
    expect(result.detail[0]!.feature).toBe('decayMs')
    expect(result.detail[0]!.direction).toBe('tooHigh')
    expect(result.detail[0]!.bound).toBe(50)
    expect(result.detail[0]!.value).toBeGreaterThan(50)
  })

  it('collects every failing bound, not just the first', () => {
    const sig = pluck(300, 300, 1, 5) // flat pitch, slow decay, quiet-ish
    const result = gradeFeatures(sig, SR, {
      pitchDropOctaves: { min: 0.5 }, // flat pitch -- fails
      decayMs: { max: 50 }, // rings on -- fails
      peakRms: { min: 0.001 }, // loud enough -- passes
    })
    expect(result.pass).toBe(false)
    const failedFeatures = result.detail.map((d) => d.feature).sort()
    expect(failedFeatures).toEqual(['decayMs', 'pitchDropOctaves'])
  })

  it('pitchDriftAbsOctaves is symmetric: both a rise and a fall trip a max bound', () => {
    const falling = pluck(400, 100, 0.03, 0.3)
    const rising = pluck(100, 400, 0.03, 0.3)
    const bounds = { pitchDriftAbsOctaves: { max: 0.1 } }
    expect(gradeFeatures(falling, SR, bounds).pass).toBe(false)
    expect(gradeFeatures(rising, SR, bounds).pass).toBe(false)
  })

  it('pitchDriftAbsOctaves passes a genuinely steady pitch', () => {
    const steady = pluck(200, 200, 1, 0.3)
    const result = gradeFeatures(steady, SR, { pitchDriftAbsOctaves: { max: 0.1 } })
    expect(result.pass).toBe(true)
  })

  it('centroidMotionOctaves distinguishes a swept tone from a static one', () => {
    let phase = 0
    const swept = gen(N, (i) => {
      const t = i / N
      const f = 200 * Math.pow(4, Math.sin(2 * Math.PI * 0.5 * t))
      phase += (2 * Math.PI * f) / SR
      return Math.sin(phase)
    })
    const flat = gen(N, (i) => Math.sin((2 * Math.PI * 300 * i) / SR))
    const bounds = { centroidMotionOctaves: { min: 1 } }
    expect(gradeFeatures(swept, SR, bounds).pass).toBe(true)
    expect(gradeFeatures(flat, SR, bounds).pass).toBe(false)
  })

  it('an empty bounds object always passes with no detail', () => {
    const result = gradeFeatures(new Float32Array(N), SR, {})
    expect(result).toEqual({ pass: true, values: {}, detail: [] })
  })
})
