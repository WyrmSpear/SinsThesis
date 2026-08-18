import { describe, it, expect } from 'vitest'
import { stepDuration, scheduleSteps, rollingHorizonEdges } from '../../src/engine/clock'

describe('stepDuration', () => {
  it('gives half a second per beat at 120 BPM', () => {
    expect(stepDuration(120, 1)).toBeCloseTo(0.5, 6)
  })

  it('divides the beat into steps', () => {
    expect(stepDuration(120, 4)).toBeCloseTo(0.125, 6)
  })

  it('rejects a non-positive tempo', () => {
    expect(() => stepDuration(0, 4)).toThrow(/bpm/)
  })
})

describe('scheduleSteps', () => {
  it('spaces steps evenly from the start time', () => {
    expect(scheduleSteps(1, 4, 120, 2)).toEqual([1, 1.25, 1.5, 1.75])
  })

  it('returns nothing for a count of zero', () => {
    expect(scheduleSteps(0, 0, 120, 4)).toEqual([])
  })
})

// A2: the clock used to schedule out to a fixed 60 s horizon and never
// again. rollingHorizonEdges is the pure math a caller drives indefinitely
// by repeatedly asking for a larger `target` -- these tests prove it has
// no ceiling of its own, entirely independent of any AudioContext, timer,
// or wall-clock wait: they just keep calling it with a bigger `target`.
describe('rollingHorizonEdges', () => {
  const OLD_HORIZON_SECONDS = 60

  it('produces edges reaching past the old fixed 60 s horizon when asked to', () => {
    const { edges } = rollingHorizonEdges(0, 0, 90, 120, 1, 0.5)
    const last = edges.at(-1)!
    expect(last.on).toBeGreaterThan(OLD_HORIZON_SECONDS)
  })

  it('keeps producing edges arbitrarily far out -- there is no built-in ceiling', () => {
    // A target run out to 10x the old fixed horizon, in one call: nothing
    // in this function's signature or logic depends on an absolute
    // duration, so it has to keep going.
    const farTarget = OLD_HORIZON_SECONDS * 10
    const { edges, scheduledUntil } = rollingHorizonEdges(0, 0, farTarget, 120, 1, 0.5)
    expect(scheduledUntil).toBe(farTarget)
    expect(edges.at(-1)!.on).toBeGreaterThan(OLD_HORIZON_SECONDS)
    expect(edges.at(-1)!.on).toBeLessThan(farTarget)
    // At 120 BPM, division 1, a step is 0.5 s -- roughly farTarget / 0.5 edges.
    expect(edges.length).toBeGreaterThan(farTarget / 0.5 - 2)
  })

  it('resumes from scheduledUntil on a repeated top-up, matching a single call to the same target', () => {
    const bpm = 96
    const division = 2
    const pulseWidth = 0.3

    // Two top-ups: 0 -> 40, then 40 -> 130 (well past the old 60 s horizon).
    const first = rollingHorizonEdges(0, 0, 40, bpm, division, pulseWidth)
    const second = rollingHorizonEdges(0, first.scheduledUntil, 130, bpm, division, pulseWidth)

    // One call straight to 130 for comparison.
    const whole = rollingHorizonEdges(0, 0, 130, bpm, division, pulseWidth)

    const combined = [...first.edges, ...second.edges]
    expect(combined).toEqual(whole.edges)
    expect(second.scheduledUntil).toBe(130)
  })

  it('emits nothing when the target does not move the horizon forward', () => {
    const first = rollingHorizonEdges(0, 0, 20, 120, 1, 0.5)
    const again = rollingHorizonEdges(0, first.scheduledUntil, 20, 120, 1, 0.5)
    expect(again.edges).toEqual([])
    expect(again.scheduledUntil).toBe(first.scheduledUntil)
  })

  it('sets each edge\'s off time from the pulse width', () => {
    const { edges } = rollingHorizonEdges(0, 0, 2, 120, 1, 0.25)
    // stepDuration(120, 1) = 0.5s; pulseWidth 0.25 -> 0.125s pulse.
    expect(edges[0]).toEqual({ on: 0, off: 0.125 })
  })
})
