/**
 * Equal-power (constant-power) pan law -- the math the Panner module needs,
 * factored out so a Node test can check it without a browser.
 *
 * A *linear* pan crossfades L and R as straight ramps: `left = 1 - t`,
 * `right = t` for `t` in [0, 1]. That satisfies "hard left is 1, hard right
 * is 1" but nothing in between: at center (t = 0.5) `left = right = 0.5`, so
 * the total *power* delivered -- `left^2 + right^2` -- is 0.5 there against
 * 1.0 at either extreme, a 3 dB dip. A source panned to center sounds
 * quieter than the same source panned hard to either side, which is the
 * "hole in the middle" this project's own roadmap (docs/ROADMAP.md, section
 * 1a) names directly.
 *
 * Equal-power panning instead moves the source around a quarter-circle:
 * `left = cos(theta)`, `right = sin(theta)`, `theta` sweeping 0 to pi/2 as
 * pan sweeps -1 to 1. `cos^2(theta) + sin^2(theta) = 1` for every theta, so
 * total power is exactly constant across the whole sweep -- center reads
 * -3.01 dB on *each* channel (cos(pi/4) = sin(pi/4) = 0.7071), not because
 * something is lost, but because the same total power is now split evenly
 * between two channels instead of concentrated in one. See
 * tests/node/dsp/pan.test.ts for the measurement that center and the
 * extremes agree in total power to a fraction of a dB.
 *
 * This is also exactly what WebAudio's native `StereoPannerNode` (which
 * `panner.ts` actually uses at the graph level, since it's a well-specified
 * native implementation of this identical law) is specified to compute --
 * this module exists so that specification has an independent, Node-testable
 * check rather than trusting the browser's own claim to conformance.
 */

export interface PanGains {
  left: number
  right: number
}

/** `pan` in [-1, 1]: -1 is hard left, 0 is center, 1 is hard right. Values
 *  outside that range are clamped rather than rejected -- a CV-driven pan
 *  (an LFO through `panCv`) can easily overshoot momentarily, and clamping
 *  keeps that a silent, harmless plateau instead of a thrown error on the
 *  audio thread. */
export function equalPowerGains(pan: number): PanGains {
  const clamped = Math.max(-1, Math.min(1, pan))
  const theta = ((clamped + 1) * Math.PI) / 4 // 0 at hard left, pi/2 at hard right
  return { left: Math.cos(theta), right: Math.sin(theta) }
}

/** Applies `equalPowerGains` to one mono sample, returning both channels. */
export function equalPowerPanSample(input: number, pan: number): PanGains {
  const { left, right } = equalPowerGains(pan)
  return { left: input * left, right: input * right }
}
