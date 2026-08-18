import { describe, it, expect } from 'vitest'
import {
  createEnvState, envSample, createSampleHoldState, sampleHold,
  createSequencerState, sequencerStep, type AdsrParams,
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

  it('releases from wherever attack got to when the gate falls early', () => {
    // 5 ms into a 10 ms attack, so the envelope is partway up and nowhere near
    // a stage boundary. Release must continue from that level, not restart.
    const rising = run(1, 0.005)
    const level = rising.last
    expect(level).toBeGreaterThan(0.05)
    expect(level).toBeLessThan(1)

    const released = run(0, 0.0005, rising.state)
    expect(released.values[0]!).toBeLessThanOrEqual(level)
    expect(released.values[0]!).toBeGreaterThan(level * 0.9)
  })

  it('releases from the decay stage without jumping', () => {
    // 35 ms in: past the 1.0 peak, partway down toward sustain.
    const decaying = run(1, 0.035)
    const level = decaying.last
    expect(level).toBeGreaterThan(0.5)
    expect(level).toBeLessThan(1)

    const released = run(0, 0.0005, decaying.state)
    expect(released.values[0]!).toBeLessThanOrEqual(level)
    expect(released.values[0]!).toBeGreaterThan(level * 0.9)
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

describe('sequencerStep', () => {
  const values = [0, 1, 2] // three programmed octaves

  it('shows step 0 before any clock pulse arrives', () => {
    const state = createSequencerState()
    expect(sequencerStep(state, 0, 0, 3, values).cv).toBe(0)
  })

  it('the first rising edge selects step 0, not step 1', () => {
    const state = createSequencerState()
    expect(sequencerStep(state, 1, 0, 3, values).cv).toBe(0)
  })

  it('advances one step per rising edge and wraps at `steps`', () => {
    const state = createSequencerState()
    const cvs: number[] = []
    // Three low/high pairs so each pulse produces exactly one rising edge.
    for (const clock of [1, 0, 1, 0, 1, 0, 1, 0]) {
      cvs.push(sequencerStep(state, clock, 0, 3, values).cv)
    }
    expect(cvs).toEqual([0, 0, 1, 1, 2, 2, 0, 0]) // wraps back to step 0
  })

  it('does not advance again while the clock stays high', () => {
    const state = createSequencerState()
    sequencerStep(state, 1, 0, 3, values)
    sequencerStep(state, 1, 0, 3, values)
    expect(sequencerStep(state, 1, 0, 3, values).cv).toBe(0)
  })

  it('a reset rising edge returns to step 0', () => {
    const state = createSequencerState()
    sequencerStep(state, 1, 0, 3, values) // step 0
    sequencerStep(state, 0, 0, 3, values)
    sequencerStep(state, 1, 0, 3, values) // step 1
    expect(sequencerStep(state, 0, 0, 3, values).cv).toBe(1)
    expect(sequencerStep(state, 0, 1, 3, values).cv).toBe(0) // reset edge
  })

  it('the gate follows the clock high period', () => {
    const state = createSequencerState()
    expect(sequencerStep(state, 1, 0, 3, values).gate).toBe(1)
    expect(sequencerStep(state, 0, 0, 3, values).gate).toBe(0)
  })

  it('clamps a fractional or out-of-range steps param', () => {
    const state = createSequencerState()
    expect(() => sequencerStep(state, 0, 0, 30, values)).not.toThrow()
    expect(() => sequencerStep(state, 0, 0, 0.4, values)).not.toThrow()
  })
})
