import { describe, it, expect } from 'vitest'
import { stepDuration, scheduleSteps, rollingHorizonEdges } from '../../src/engine/clock'
import { LOOKAHEAD_SECONDS } from '../../src/engine/modules/clock-module'

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

// A2 follow-up: Chrome's documented "intensive throttling" caps a hidden
// tab's timers to about once a minute after roughly five minutes hidden --
// default behavior, not an edge case. clock-module.ts's `topUp` asks for
// `ctx.currentTime + LOOKAHEAD_SECONDS` every time its timer fires; if
// LOOKAHEAD_SECONDS is smaller than the gap between two wakeups, the
// schedule runs dry before the next tick arrives and the gate holds its
// last value -- silently stalled -- until the tick after that. The old
// LOOKAHEAD_SECONDS (5) stalled 55 of every 60 seconds under this exact
// throttle (91.7% of the time). This simulates that throttle directly
// against clock-module.ts's real, deployed constant (not a guessed value)
// by driving rollingHorizonEdges the same way `topUp` does, advancing the
// clock 60 s between wakeups and asserting the schedule is always still
// ahead of "now" the moment each tick fires -- i.e. the gate is never
// caught with nothing scheduled.
describe('surviving Chrome intensive throttling (once-a-minute timer ticks)', () => {
  const THROTTLED_TICK_SECONDS = 60
  const bpm = 120
  const division = 1
  const pulseWidth = 0.5

  it('keeps the horizon ahead of "now" at every throttled wakeup', () => {
    let epoch = 0
    let scheduledUntil = epoch
    let now = epoch

    // First tick, same as clock-module.ts's creation-time rescheduleGate.
    ;({ scheduledUntil } = rollingHorizonEdges(
      epoch, scheduledUntil, now + LOOKAHEAD_SECONDS, bpm, division, pulseWidth,
    ))

    // 30 simulated minutes of a backgrounded, throttled tab: one wakeup
    // every 60 s, nothing in between (no earlier ticks ever fire -- that is
    // what "intensive throttling" means).
    for (let tick = 0; tick < 30; tick++) {
      now += THROTTLED_TICK_SECONDS
      // The audio clock has already reached `now` by the time this wakeup
      // runs. If the horizon from the previous tick didn't reach this far,
      // the gate already stalled before this line even executes.
      expect(scheduledUntil).toBeGreaterThan(now)
      ;({ scheduledUntil } = rollingHorizonEdges(
        epoch, scheduledUntil, now + LOOKAHEAD_SECONDS, bpm, division, pulseWidth,
      ))
    }
  })

  it('LOOKAHEAD_SECONDS itself clears the documented worst-case tick interval with margin', () => {
    // Not just "greater than" -- a comfortable margin, so a tick landing a
    // little late (the throttle is described as "roughly" once a minute,
    // not exactly) still doesn't stall.
    expect(LOOKAHEAD_SECONDS).toBeGreaterThanOrEqual(THROTTLED_TICK_SECONDS * 1.5)
  })
})

// Finding 3 (final review): topUp never clamped the start of scheduling to
// "now". The 90 s horizon and the throttling suite above cover the steady
// state -- a tick arriving late, but not absurdly late -- correctly. But if
// a tick ever arrives much later than that (machine sleep/resume, or a long
// main-thread stall), scheduledUntil sits far behind ctx.currentTime by the
// time the next tick fires, and without a clamp, rollingHorizonEdges would
// treat every edge between that stale point and the new target as still
// owed -- all of them already in the past -- and emit them in one
// synchronous burst. At 300 BPM, division 8 (a 25 ms step, this module's
// fastest setting), a ten-minute gap is roughly 24,000 edges -- 48,000
// setValueAtTime calls -- in one call. The fix clamps the start of
// scheduling to `ctx.currentTime` (`const from = Math.max(scheduledUntil,
// ctx.currentTime)` in clock-module.ts's topUp) before calling
// rollingHorizonEdges, so a late tick only ever schedules LOOKAHEAD_SECONDS
// worth of edges, however far scheduledUntil had fallen behind.
describe('surviving a large time jump (machine sleep/resume, a long stall)', () => {
  const bpm = 300
  const division = 8 // the module's fastest setting -- see FINDING 3's own math
  const pulseWidth = 0.5
  const GAP_SECONDS = 600 // ten minutes: far past both LOOKAHEAD_SECONDS and the throttle

  it('demonstrates the bug this fixes: unclamped, a large gap emits tens of thousands of edges in one call', () => {
    let epoch = 0
    let scheduledUntil = epoch
    let now = epoch
    ;({ scheduledUntil } = rollingHorizonEdges(
      epoch, scheduledUntil, now + LOOKAHEAD_SECONDS, bpm, division, pulseWidth,
    ))

    now += GAP_SECONDS
    // Unclamped: the pre-fix call, passing the stale scheduledUntil
    // straight through, exactly as topUp used to.
    const { edges } = rollingHorizonEdges(
      epoch, scheduledUntil, now + LOOKAHEAD_SECONDS, bpm, division, pulseWidth,
    )
    expect(edges.length).toBeGreaterThan(20000)
  })

  it('stays bounded to about LOOKAHEAD_SECONDS worth of edges after the same gap, clamped', () => {
    let epoch = 0
    let scheduledUntil = epoch
    let now = epoch
    ;({ scheduledUntil } = rollingHorizonEdges(
      epoch, scheduledUntil, now + LOOKAHEAD_SECONDS, bpm, division, pulseWidth,
    ))

    now += GAP_SECONDS
    // The fix: clamp the start of scheduling to "now" before asking for
    // more edges, the same way clock-module.ts's topUp does.
    const from = Math.max(scheduledUntil, now)
    const target = now + LOOKAHEAD_SECONDS
    const { edges, scheduledUntil: newScheduledUntil } = rollingHorizonEdges(
      epoch, from, target, bpm, division, pulseWidth,
    )

    const stepsInHorizon = LOOKAHEAD_SECONDS / stepDuration(bpm, division)
    // A little slack (+2) for the half-open step-count arithmetic in
    // rollingHorizonEdges, not for the gap itself -- the whole point is
    // that GAP_SECONDS (600) contributes nothing here.
    expect(edges.length).toBeLessThan(stepsInHorizon + 2)
    expect(newScheduledUntil).toBe(target)
  })
})
