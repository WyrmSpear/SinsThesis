import { describe, it, expect } from 'vitest'
import {
  createEnvState, envSample, createSampleHoldState, sampleHold, type AdsrParams,
} from '../../../src/engine/dsp/segment'

const SR = 48000
const P: AdsrParams = { attack: 0.01, decay: 0.05, sustain: 0.5, release: 0.1 }

function run(gate: number, seconds: number, state = createEnvState(), p = P): {
  state: ReturnType<typeof createEnvState>; last: number; values: number[]
} {
  const values: number[] = []
  let last = 0
  for (let i = 0; i < SR * seconds; i++) {
    last = envSample(state, gate, p, SR)
    values.push(last)
  }
  return { state, last, values }
}

describe('envSample', () => {
  it('sits at zero while idle', () => {
    expect(run(0, 0.05).last).toBe(0)
  })

  it('rises monotonically during attack', () => {
    const { values } = run(1, 0.008)
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!)
    }
  })

  it('reaches the peak by the end of attack', () => {
    // The envelope hits 1.0 partway through this window and then decays toward
    // sustain, so the peak is the thing to assert on -- the final sample is
    // already on the way down.
    const { values } = run(1, 0.05)
    expect(Math.max(...values)).toBeGreaterThan(0.99)
  })

  it('settles at the sustain level while the gate is held', () => {
    expect(run(1, 0.5).last).toBeCloseTo(P.sustain, 2)
  })

  it('falls to near silence after the gate releases', () => {
    const held = run(1, 0.5)
    expect(run(0, 0.6, held.state).last).toBeLessThan(0.01)
  })

  it('retriggers from the current level instead of jumping to zero', () => {
    const held = run(1, 0.5)
    const releasing = run(0, 0.02, held.state)
    const levelAtRetrigger = releasing.last
    expect(levelAtRetrigger).toBeGreaterThan(0.01)
    const retriggered = run(1, 0.001, releasing.state)
    expect(retriggered.values[0]!).toBeGreaterThanOrEqual(levelAtRetrigger * 0.9)
  })
})

describe('sampleHold', () => {
  it('holds its output until the next rising edge', () => {
    const state = createSampleHoldState()
    expect(sampleHold(state, 0.7, 1)).toBeCloseTo(0.7)
    expect(sampleHold(state, 0.2, 1)).toBeCloseTo(0.7) // still high, no new edge
    expect(sampleHold(state, 0.2, 0)).toBeCloseTo(0.7)
    expect(sampleHold(state, 0.2, 1)).toBeCloseTo(0.2) // rising edge captures
  })

  it('starts at zero', () => {
    expect(sampleHold(createSampleHoldState(), 0.9, 0)).toBe(0)
  })
})
