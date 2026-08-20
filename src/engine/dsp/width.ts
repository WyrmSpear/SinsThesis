/**
 * Mid-side width: stereo in, stereo out, wider or narrower without ever
 * losing mono compatibility. The third and last new stereo module ROADMAP
 * section 1a calls for.
 *
 * Encode: `mid = (l + r) / 2` (what both channels agree on), `side =
 * (l - r) / 2` (what they disagree on -- the stereo image itself). Scale
 * `side` by `width` and decode: `left' = mid + width*side`, `right' = mid -
 * width*side`. At `width = 1` this is the identity (`left' = left, right' =
 * right` -- see the round-trip test). At `width = 0` both channels collapse
 * to `mid`, i.e. pure mono. Above 1, the stereo difference is exaggerated.
 *
 * The property that matters most, per this project's own roadmap warning
 * ("a widener that sounds impressive in headphones and collapses to thin or
 * hollow in mono... every stereo module needs a mono-compatibility check as
 * an acceptance criterion, not an afterthought"): **`left' + right'` is
 * exactly `left + right`, for every value of `width`.**
 *
 *   left' + right' = (mid + width*side) + (mid - width*side) = 2*mid
 *                   = (l + r) = left + right
 *
 * The `width` terms cancel algebraically -- not approximately, not "usually"
 * -- so summing this module's output to mono reproduces the *input's* mono
 * sum exactly, regardless of how wide or narrow `width` is set. That is the
 * reason M/S was chosen over a Haas-delay (comb-filtering) widener, which
 * has no such guarantee: a short delay between channels is exactly the setup
 * for phase cancellation when two channels are summed, and how much
 * cancels depends on the delay time and the material's own frequency
 * content, not on anything the plugin can promise up front.
 *
 * Pure functions here, a thin worklet shell (width.worklet.ts) that calls
 * `widthSample` in a per-sample loop -- the same split every other DSP
 * module in this codebase uses (dsp/svf.ts, dsp/wavefolder.ts, ...) -- so
 * `tests/node/dsp/width.test.ts`'s round-trip and mono-invariance checks are
 * checking the exact code the audio thread runs, not a hand-verified
 * equivalent of it.
 */

export interface MidSide {
  mid: number
  side: number
}

export function msEncode(left: number, right: number): MidSide {
  return { mid: (left + right) / 2, side: (left - right) / 2 }
}

export interface StereoSample {
  left: number
  right: number
}

export function msDecode(mid: number, side: number, width: number): StereoSample {
  const scaled = side * width
  return { left: mid + scaled, right: mid - scaled }
}

/** Composes encode -> scale -> decode in one call, for convenience and for
 *  the widthSample the width.worklet.ts shell calls per sample. */
export function widthSample(left: number, right: number, width: number): StereoSample {
  const { mid, side } = msEncode(left, right)
  return msDecode(mid, side, width)
}
