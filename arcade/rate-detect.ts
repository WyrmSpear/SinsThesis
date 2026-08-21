/**
 * Wub Disruptor -- the modulation-rate detector. Pure numeric code (no DOM,
 * no Web Audio), the same split `arcade/game.ts` established for the
 * pan-paddle: `rack/wub-panel.ts` reads real audio off a parallel analyser
 * tap and turns it into a plain number sequence, and everything from there
 * -- "what rate is that sequence wobbling at, and how sure are we" -- lives
 * here where it is node-testable with synthetic data.
 *
 * **What "the player's modulation rate" means, operationally.** ROADMAP
 * 3a's design brief for this game: detect the rate of amplitude or
 * brightness *variation in the output*, not any knob or CV value directly
 * -- the honest approach, and the same principle the paddle's `readBalance`
 * already established (it rewards achieving a result by any means, not
 * memorizing one knob). `rack/wub-panel.ts` feeds this module one number
 * per animation frame -- RMS level or spectral centroid, both already
 * computed live for the scope elsewhere in this project -- and this file
 * finds the dominant periodicity in that sequence.
 *
 * **Why this doesn't just call `src/engine/analysis/features.ts`'s
 * `autocorrelationPitchHz`.** Same underlying technique (normalised
 * autocorrelation, search over a lag range converted to Hz), but two
 * things differ enough to need a separate, small implementation rather
 * than a shared one: the search band is three orders of magnitude lower
 * (0.5-9 Hz LFO wobble vs. 30-1000 Hz audio pitch) and the frame-rate
 * "sample rate" this operates at (~60 Hz) means a target period is only
 * ever a handful to a few hundred samples long, not the thousands an audio
 * pitch tracker gets -- short enough that the audio tracker's plain
 * "global-argmax, then prefer the shortest near-tied lag" logic
 * mis-fires (measured directly, see this file's own test: at a coarse
 * 60 Hz frame rate a 5.33 Hz target's true period is 11.25 samples, not an
 * integer, so the two nearest integer lags are both slightly
 * decorrelated by that quantization while a lag that happens to land on an
 * exact multiple of the true period reads a *higher* raw correlation --
 * the classic subharmonic trap). The fix used here -- scan lags
 * short-to-long and take the first strong local peak, the same move YIN
 * makes searching for the first dip below a threshold rather than the
 * global minimum -- is specific to this frame-rate regime and not
 * something the audio-pitch function should also do (it doesn't have this
 * problem at audio sample rates, where a target period is thousands of
 * samples and quantization error is negligible).
 */

/** Search band, Hz. Covers the musical divisions a tempo-locked LFO can
 *  reasonably be asked to hit at ordinary tempos (roughly a half note
 *  through a sixteenth-note triplet across 80-160 BPM) with margin on both
 *  ends so a target near the edge doesn't get clipped by the search
 *  window itself. */
export const RATE_MIN_HZ = 0.5
export const RATE_MAX_HZ = 9

export interface RateEstimate {
  readonly hz: number
  /** Normalised cross-correlation at the winning lag, 0..1 (clamped). A
   *  clean periodic wobble at the target rate reads close to 1; noise or a
   *  non-periodic signal reads low. `rack/wub-panel.ts` gates on this
   *  before trusting `hz` at all -- see `LOCK_CONFIDENCE`. */
  readonly confidence: number
}

/** Below this confidence, `hz` is not trusted to mean anything -- measured
 *  empirically (see `tests/node/arcade-rate-detect.test.ts`): a genuine
 *  target-rate wobble reads 0.95+ even under noise and hand-jitter, while
 *  a signal with no real periodicity in-band reads well under this. */
export const LOCK_CONFIDENCE = 0.5

/**
 * Dominant periodicity of `values` (one feature reading per frame,
 * `sampleRateHz` frames/second on average -- doesn't need to be exact,
 * `rack/wub-panel.ts` passes the buffer's own measured average frame
 * rate), by normalised cross-correlation over `[minHz, maxHz]`.
 *
 * Needs a window covering at least a couple of periods of whatever it's
 * trying to detect: `values.length` shorter than `sampleRateHz / minHz`
 * (one period at the slowest rate this could report) returns `undefined`
 * rather than guessing off a fragment. This is *why* the game paces slow
 * targets differently from fast ones (`arcade/wub-game.ts`'s
 * `targetLifetimeMs`) -- a half-note wobble physically cannot be confirmed
 * in under a couple of seconds, no matter how good the player's aim is.
 */
export function detectRateHz(
  values: Float32Array,
  sampleRateHz: number,
  minHz = RATE_MIN_HZ,
  maxHz = RATE_MAX_HZ,
  peakThreshold = LOCK_CONFIDENCE,
): RateEstimate | undefined {
  const maxLag = Math.floor(sampleRateHz / minHz)
  const minLag = Math.max(1, Math.floor(sampleRateHz / maxHz))
  if (values.length <= maxLag || minLag >= maxLag) return undefined

  let mean = 0
  for (const v of values) mean += v
  mean /= values.length
  const centered = new Float32Array(values.length)
  for (let i = 0; i < values.length; i++) centered[i] = values[i]! - mean

  // Normalised cross-correlation, energy computed over the same
  // overlapping range as the sum (not the whole buffer) -- a lag-dependent
  // window shrinks as lag grows, and normalising by the *whole* buffer's
  // energy biases long lags low relative to short ones, enough to flip the
  // ranking outright on a short (few-cycle) window. See this file's own
  // header comment for the measured example.
  const corrs = new Float32Array(maxLag + 2)
  for (let lag = Math.max(1, minLag - 1); lag <= maxLag + 1; lag++) {
    let sum = 0
    let e1 = 0
    let e2 = 0
    for (let i = 0; i + lag < centered.length; i++) {
      sum += centered[i]! * centered[i + lag]!
      e1 += centered[i]! * centered[i]!
      e2 += centered[i + lag]! * centered[i + lag]!
    }
    const denom = Math.sqrt(e1 * e2)
    corrs[lag] = denom > 1e-9 ? sum / denom : 0
  }

  // First strong local peak, shortest lag first -- see header comment for
  // why the global argmax is the wrong target here. Falls back to
  // whatever the global best was if nothing clears the threshold, so a
  // weak-but-real signal still reports its best guess at a low confidence
  // the caller can gate on, rather than returning nothing at all.
  let bestLag = -1
  let bestCorr = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    const c = corrs[lag]!
    const isPeak = c >= corrs[lag - 1]! && c >= corrs[lag + 1]!
    if (isPeak && c >= peakThreshold) {
      bestLag = lag
      bestCorr = c
      break
    }
    if (c > bestCorr) {
      bestCorr = c
      bestLag = lag
    }
  }
  if (bestLag < 0 || bestCorr <= 0) return undefined
  return { hz: sampleRateHz / bestLag, confidence: Math.min(1, bestCorr) }
}
