import { describe, it, expect } from 'vitest'
import { stepDuration, scheduleSteps } from '../../src/engine/clock'

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
