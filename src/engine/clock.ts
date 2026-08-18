/**
 * Transport math. Pure, so it tests in Node and the modules that consume it
 * stay thin.
 */

/** Seconds per step. `division` counts steps per beat: 4 gives sixteenths. */
export function stepDuration(bpm: number, division: number): number {
  if (bpm <= 0) throw new Error(`stepDuration: bpm must be positive, got ${bpm}`)
  if (division <= 0) throw new Error(`stepDuration: division must be positive, got ${division}`)
  return 60 / bpm / division
}

/** Absolute times for `count` steps beginning at `startTime`. */
export function scheduleSteps(
  startTime: number,
  count: number,
  bpm: number,
  division: number,
): number[] {
  const step = stepDuration(bpm, division)
  const times: number[] = []
  for (let i = 0; i < count; i++) times.push(startTime + i * step)
  return times
}

/** One gate pulse's rise and fall time, on the audio clock. */
export interface StepEdge {
  on: number
  off: number
}

/**
 * The rolling-horizon scheduling math behind clock-module.ts's fix for A2
 * (the clock silently stopping after a fixed 60 s horizon).
 *
 * `epoch` anchors the step grid -- step 0 begins there. `scheduledUntil` is
 * the audio-clock time everything up to has already had edges scheduled
 * for. `target` is how far ahead the caller wants to be scheduled *now*.
 * Returns the edges still needed to close the gap up to `target`, plus the
 * new `scheduledUntil`.
 *
 * Pure and independent of any AudioContext, timer, or notion of wall-clock
 * time: it has no built-in ceiling because it has no concept of "the end"
 * at all, only "how far have we gotten." A caller drives it indefinitely
 * simply by calling it again with a larger `target` -- which is exactly
 * what clock-module.ts's periodic top-up does, using `ctx.currentTime` (a
 * live session) or the offline context's known render length (a bounded
 * one) to produce that `target`. This function never touches an AudioNode
 * and is never asked to guess how much real time has passed, which is what
 * makes it possible to prove "no ceiling" with a handful of fast,
 * deterministic Node calls instead of an AudioContext and a clock to wait on.
 */
export function rollingHorizonEdges(
  epoch: number,
  scheduledUntil: number,
  target: number,
  bpm: number,
  division: number,
  pulseWidth: number,
): { edges: StepEdge[]; scheduledUntil: number } {
  if (target <= scheduledUntil) return { edges: [], scheduledUntil }

  const dur = stepDuration(bpm, division)

  // First step index whose time is >= scheduledUntil, so this never
  // re-emits an edge already covered nor skips one.
  const stepsSoFar = Math.max(0, Math.ceil((scheduledUntil - epoch) / dur))
  const start = epoch + stepsSoFar * dur
  const count = Math.ceil((target - start) / dur) + 1

  const edges: StepEdge[] = []
  for (const t of scheduleSteps(start, count, bpm, division)) {
    if (t >= target) break
    edges.push({ on: t, off: t + dur * pulseWidth })
  }
  return { edges, scheduledUntil: target }
}
