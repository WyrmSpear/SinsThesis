import { describe, it, expect } from 'vitest'
import { foldSample } from '../../../src/engine/dsp/wavefolder'
import { spectralCentroid } from '../../../src/engine/analysis/features'

const SR = 48000
const N = 8192

function foldedSine(drive: number): Float32Array {
  const out = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    out[i] = foldSample(Math.sin((2 * Math.PI * 200 * i) / SR), drive)
  }
  return out
}

describe('foldSample', () => {
  it('passes signal through unchanged at unity drive', () => {
    expect(foldSample(0.5, 1)).toBeCloseTo(0.5, 6)
    expect(foldSample(-0.5, 1)).toBeCloseTo(-0.5, 6)
  })

  it('reflects a value that exceeds +1', () => {
    // 1.5 folds back to 2 - 1.5 = 0.5
    expect(foldSample(1.5, 1)).toBeCloseTo(0.5, 6)
  })

  it('reflects a value below -1', () => {
    expect(foldSample(-1.5, 1)).toBeCloseTo(-0.5, 6)
  })

  it('keeps output inside +/-1 even at extreme drive', () => {
    for (let d = 1; d <= 20; d += 0.5) {
      for (let x = -1; x <= 1; x += 0.05) {
        expect(Math.abs(foldSample(x, d))).toBeLessThanOrEqual(1.0001)
      }
    }
  })

  it('adds harmonics as drive rises', () => {
    expect(spectralCentroid(foldedSine(6), SR))
      .toBeGreaterThan(spectralCentroid(foldedSine(1), SR) * 2)
  })
})
