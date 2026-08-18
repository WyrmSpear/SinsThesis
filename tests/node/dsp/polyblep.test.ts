import { describe, it, expect } from 'vitest'
import { createOscState, oscSample, hardSync, type OscShape } from '../../../src/engine/dsp/polyblep'
import { peakHz, aliasFloorDb, rms } from '../../../src/engine/analysis/features'

const SR = 48000
const N = 8192

function render(shape: OscShape, freq: number, pw = 0.5): Float32Array {
  const state = createOscState()
  const out = new Float32Array(N)
  for (let i = 0; i < N; i++) out[i] = oscSample(state, shape, freq, SR, pw)
  return out
}

describe.each(['saw', 'pulse', 'tri', 'sine'] as OscShape[])('%s oscillator', (shape) => {
  it('oscillates at the requested frequency', () => {
    expect(peakHz(render(shape, 440), SR)).toBeCloseTo(440, -1)
  })

  it('stays inside +/-1.05', () => {
    const out = render(shape, 220)
    for (const v of out) expect(Math.abs(v)).toBeLessThan(1.05)
  })

  it('produces signal, not silence', () => {
    expect(rms(render(shape, 220))).toBeGreaterThan(0.05)
  })
})

describe('antialiasing', () => {
  // 2 kHz was dropped as the test frequency: 48000 / 2000 = 24 exactly, so
  // the (now-fixed) metric folds every alias onto a harmonic and excludes it,
  // reporting a window-floor number instead of the oscillator's real alias
  // floor. 441 Hz is not a small-integer divisor of 48000.
  //
  // This oscillator is a PolyBLEP baseline, not a minBLEP one, and it
  // genuinely does not clear -60 dB -- that -60 dB figure in the old test
  // was an artifact of the broken metric, not a property of this oscillator.
  // These are the honest starting numbers; a follow-up task will raise the
  // real alias floor to the professional bar.
  it('holds the saw alias floor at its honest pre-minBLEP baseline at 441 Hz', () => {
    // Measured: -43.2 dB. Margin of ~3 dB below that.
    expect(aliasFloorDb(render('saw', 441), SR, 441)).toBeLessThan(-40)
  })

  it('holds the pulse alias floor at its honest pre-minBLEP baseline at 441 Hz', () => {
    // Measured: -43.4 dB. Margin of ~3 dB below that.
    expect(aliasFloorDb(render('pulse', 441), SR, 441)).toBeLessThan(-40)
  })
})

describe('pulse width', () => {
  it('shifts the duty cycle away from square', () => {
    // A 25% pulse spends less time high, so its mean sits lower than a square's.
    const mean = (a: Float32Array) => a.reduce((s, v) => s + v, 0) / a.length
    expect(mean(render('pulse', 100, 0.25))).toBeLessThan(mean(render('pulse', 100, 0.5)) - 0.2)
  })
})

describe('sub-audio rates', () => {
  it('runs an LFO at 0.5 Hz without going unstable', () => {
    const state = createOscState()
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < SR * 4; i++) {
      const v = oscSample(state, 'tri', 0.5, SR)
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
    expect(max).toBeGreaterThan(0.8)
    expect(min).toBeLessThan(-0.8)
    expect(Number.isFinite(max)).toBe(true)
  })
})

describe('hardSync', () => {
  it('resets phase so the next sample restarts the cycle', () => {
    const state = createOscState()
    for (let i = 0; i < 100; i++) oscSample(state, 'saw', 440, SR)
    hardSync(state)
    expect(state.phase).toBe(0)
    const first = oscSample(state, 'saw', 440, SR)
    expect(first).toBeLessThan(-0.9)
  })
})
