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
