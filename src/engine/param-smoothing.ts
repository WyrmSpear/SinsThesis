/**
 * B3: turning a knob used to snap every param straight to its new value --
 * `PatchGraph.setParam` never passed a time, and every module assigned
 * `.value` directly (or, for worklet params, called `setValueAtTime` only
 * when a caller supplied `atTime`, which nothing ever did) -- so every knob
 * turn was a step discontinuity: spec acceptance criterion 3 ("turn knobs
 * and hear the change without clicks or zipper noise") was unimplemented,
 * not merely unproven.
 *
 * `scheduleParam` is the one place that decides how a param change reaches
 * an `AudioParam`, used by every module below with a continuous param:
 *
 * - `atTime` given -- an exact `setValueAtTime`. This is for precise,
 *   clock-driven automation (nothing calls it with a time today, but the
 *   seam exists for it), where landing exactly on the audio clock matters
 *   more than gliding.
 * - `atTime` omitted -- the ordinary case, an interactive knob turn with no
 *   schedule of its own -- ramps via `setTargetAtTime` from right now,
 *   with a short enough time constant to feel instant but long enough to
 *   remove the step.
 *
 * Not every param goes through this. Discrete/switch-like params --
 * waveform shape, step count -- stay instantaneous: they select a branch
 * or index a table (e.g. `SHAPES[Math.round(shape)]`), so a value between
 * two settings is meaningless, and smoothing one would just delay the
 * switch rather than soften it. Each module's `setParam` says which of its
 * params it classifies which way and why.
 */

/** setTargetAtTime time constant for a live knob turn: fast enough to read
 *  as instant, slow enough that no single sample steps by an audible
 *  amount. 8 ms reaches ~95% of the way to the target within about three
 *  time constants (24 ms). See the param-change click test (grep this
 *  project for "PARAM_SMOOTH_TIME_CONSTANT") for the measured worst-case
 *  single-sample delta this leaves, before and after. */
export const PARAM_SMOOTH_TIME_CONSTANT = 0.008

/**
 * Schedule `param` toward `value`, exactly at `atTime` if given, or smoothly
 * from right now if not. See the module doc comment above for why.
 */
export function scheduleParam(
  param: AudioParam,
  value: number,
  ctx: BaseAudioContext,
  atTime: number | undefined,
): void {
  if (atTime !== undefined) param.setValueAtTime(value, atTime)
  else param.setTargetAtTime(value, ctx.currentTime, PARAM_SMOOTH_TIME_CONSTANT)
}
