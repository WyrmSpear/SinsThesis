import type { ParamSpec } from '../src/engine/types'

/**
 * Normalized-position <-> real-value mapping for a knob, honoring
 * `ParamSpec.curve`. Mirrors `dev/controls.ts`'s slider math exactly (same
 * problem, same shape) but is kept separate on purpose: `dev/` is the
 * proven harness and this task's brief is explicit that it must stay
 * untouched while the rack is in flux, so the rack owns its own copy
 * rather than reaching into a file it was told not to disturb.
 */

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t))
}

/** Maps a real param value to a [0, 1] knob position, honoring `curve`. */
export function toNormalized(value: number, spec: Pick<ParamSpec, 'min' | 'max' | 'curve'>): number {
  const { min, max, curve } = spec
  if (curve === 'exp') {
    const lo = Math.max(min, 1e-9)
    const v = Math.max(value, lo)
    return clamp01(Math.log(v / lo) / Math.log(max / lo))
  }
  return clamp01((value - min) / (max - min))
}

/** Inverse of `toNormalized`. */
export function fromNormalized(t: number, spec: Pick<ParamSpec, 'min' | 'max' | 'curve'>): number {
  const { min, max, curve } = spec
  const tt = clamp01(t)
  if (curve === 'exp') {
    const lo = Math.max(min, 1e-9)
    return lo * Math.pow(max / lo, tt)
  }
  return min + tt * (max - min)
}

/** Human-readable formatting shared by the knob readout. One fewer decimal
 *  digit per tier than a first pass used: a readout column is ~50px wide at
 *  this panel's tightest (hp=8, 2 columns) and "0.000 oct" (VCF's
 *  cutoffCvAmount at its default) does not fit that at a legible size,
 *  clipping to "0.000 …" (reported live). Hardware readouts do not carry
 *  three significant digits either -- a synth player reads a knob's
 *  position, not its value to the thousandth. */
export function formatValue(value: number, unit: string): string {
  const abs = Math.abs(value)
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 1 : 2
  const suffix = unit ? ` ${unit}` : ''
  return `${value.toFixed(digits)}${suffix}`
}
