import { rms } from './features'

/**
 * Frame-wise pitch tracking: analysis windows stepped across a buffer,
 * each reporting a frequency and a confidence -- unlike `peakHz`
 * (features.ts), which reduces a whole buffer to one number and cannot say
 * anything about a pitch that moves.
 *
 * Method: YIN (de Cheveigné & Kawahara, 2002), not an FFT-peak search.
 * `peakHz` finds the *loudest* frequency bin, which is exactly the trap
 * the task warns about: a bright saw's second harmonic can carry more
 * energy than its fundamental, so a peak-picker reports an octave high.
 * YIN never looks at which frequency is loudest -- it looks at which time
 * lag makes the waveform best predict itself. A saw's fundamental period
 * `T` is a lag where *every* harmonic (including a loud second one) lines
 * back up with itself simultaneously; a false candidate at `T/2` only
 * lines up the harmonics that happen to be even multiples of it, so it
 * scores worse on the same difference function regardless of which
 * harmonic is loudest. That difference function -- the squared difference
 * between the signal and a copy of itself shifted by each candidate lag,
 * cumulative-mean normalized so small lags aren't structurally favored --
 * is what's implemented below, plus YIN's own two refinements: an
 * absolute-threshold search that takes the *first* dip below threshold
 * rather than the global minimum (so a genuine octave-below subharmonic
 * doesn't win just because a slightly deeper dip happens to sit there),
 * and parabolic interpolation around the chosen lag for sub-sample period
 * resolution. Plain autocorrelation (no cumulative-mean step) was the
 * simpler alternative and was rejected: it structurally favors short lags,
 * which is a *second* source of octave error the tests below would have
 * had to work around on top of the one already being tested for.
 *
 * Confidence is `1 - d'(tau)` at the chosen lag -- YIN's own aperiodicity
 * measure, 1 for a perfectly periodic frame and dropping toward 0 as the
 * frame departs from periodicity. A frame below `silenceRms` or one where
 * no lag ever dips under `threshold` gets `hz: undefined` rather than a
 * confidence-zero guess: a noise burst genuinely has no fundamental, and
 * reporting one anyway -- even a low-confidence one -- would draw a lie on
 * a display built to show where pitch is real.
 *
 * **The ceiling above `maxHz` declines rather than folds.** `maxHz` bounds
 * the *search* -- lags shorter than `sampleRate/maxHz` are never candidates
 * -- which used to mean a tone genuinely above it (nothing here to find at
 * its real, short period) locked onto the first dip the search *could* see,
 * almost always the subharmonic at ~2x the true period: a confident,
 * silent octave-down error (2093 Hz reporting 1046.6 Hz at confidence
 * 0.999 was the repro that found this). Fixed by checking, before
 * accepting that subharmonic, whether the difference function it computed
 * anyway (down to lag 1, regardless of `minLag`) also dips below threshold
 * at a lag *shorter* than the search floor -- if so, a period shorter than
 * `maxHz` allows is genuinely present and the candidate the search did
 * accept is that period's own subharmonic, so the frame declines
 * (`hz: undefined`) instead of reporting it. `maxHz`'s default is now 8000
 * Hz -- comfortably above C8 (4186 Hz), the top note of a full 88-key
 * keyboard -- rather than 1500, which folded notes as ordinary as C7
 * (2093 Hz). Accuracy still degrades gracefully approaching the ceiling
 * (interpolating a handful of samples per period is inherently less
 * precise than interpolating hundreds), but the octave is never wrong and
 * a tone truly above the ceiling is reported as absent, not invented.
 */

export interface PitchFrame {
  /** Frame center, in seconds from the start of the buffer. */
  timeSec: number
  /** Estimated fundamental, or `undefined` for a frame with no detectable
   *  pitch (silence, noise, or a period YIN's threshold never accepted). */
  hz: number | undefined
  /** 0..1, YIN's own periodicity confidence. 0 whenever `hz` is undefined. */
  confidence: number
}

export interface PitchTrackOptions {
  /** Analysis window length, in samples, before YIN's own lag search
   *  extends it (see `EXTRA_LAG_HEADROOM_FRACTION` below). Default 2048. */
  frameSize?: number
  /** Samples between successive frame starts. Default 512 (75% overlap at
   *  the default frame size), fine enough to trace a fast glide without
   *  costing an impractical number of frames. */
  hopSize?: number
  /** Lowest frequency YIN will report. Default 60 Hz -- below a synth
   *  bass note, comfortably above mains hum. */
  minHz?: number
  /** Highest frequency YIN will report. Default 8000 Hz -- above C8
   *  (4186 Hz), the top note of a full 88-key keyboard. A frame whose true
   *  period is shorter than this (i.e. a tone genuinely above `maxHz`)
   *  reports `hz: undefined` rather than the subharmonic fold a naive
   *  lag-search ceiling would produce -- see the module doc comment above. */
  maxHz?: number
  /** YIN's absolute threshold on the cumulative mean normalized
   *  difference function -- the paper's own default. Lower is stricter
   *  (fewer, more confident detections); higher accepts noisier frames. */
  threshold?: number
  /** A frame quieter than this RMS is unvoiced by definition -- skips the
   *  YIN search entirely rather than letting quantization noise or a
   *  worklet's own dither floor (docs/CONTINUATION.md's R28) read as a
   *  spurious pitch. */
  silenceRms?: number
}

const DEFAULTS: Required<PitchTrackOptions> = {
  frameSize: 2048,
  hopSize: 512,
  minHz: 60,
  maxHz: 8000,
  threshold: 0.15,
  silenceRms: 1e-3,
}

/** YIN needs headroom beyond the nominal `frameSize` to search lags out to
 *  `sampleRate / minHz` -- the integration window (the part that's
 *  actually compared at each candidate lag) is `frameSize` itself, and the
 *  frame fetched from the buffer is `frameSize + maxLag` long so every
 *  candidate lag has a full `frameSize` samples of overlap to compare. */
function yinFrame(
  frame: Float32Array, sampleRate: number, minHz: number, maxHz: number, threshold: number,
): { hz: number | undefined; confidence: number } {
  const maxLag = Math.floor(sampleRate / minHz)
  const minLag = Math.max(1, Math.floor(sampleRate / maxHz))
  const integrationWindow = frame.length - maxLag
  if (integrationWindow <= 0 || minLag >= maxLag) return { hz: undefined, confidence: 0 }

  // Step 1-2 of the YIN paper: the difference function, then its
  // cumulative-mean normalization. d(0) is never used (lag 0 is always a
  // perfect, meaningless match), so cmnd[0] is fixed at 1 by definition.
  const d = new Float32Array(maxLag + 1)
  for (let tau = 1; tau <= maxLag; tau++) {
    let sum = 0
    for (let j = 0; j < integrationWindow; j++) {
      const diff = frame[j]! - frame[j + tau]!
      sum += diff * diff
    }
    d[tau] = sum
  }

  const cmnd = new Float32Array(maxLag + 1)
  cmnd[0] = 1
  let runningSum = 0
  for (let tau = 1; tau <= maxLag; tau++) {
    runningSum += d[tau]!
    cmnd[tau] = runningSum > 0 ? (d[tau]! * tau) / runningSum : 1
  }

  // A dip below threshold at a lag *shorter* than minLag means a period
  // shorter than sampleRate/maxHz is genuinely present -- a true
  // fundamental above the ceiling this call was configured to trust. Left
  // unchecked, the search below starts at minLag and would happily accept
  // whatever dip it finds first at or beyond minLag, which for a tone
  // above maxHz is the *subharmonic* at roughly twice the true period: a
  // confident, wrong, octave-down answer (see pitch-track.ts's own doc
  // comment on why that's worse than declining). d/cmnd are already
  // computed down to tau=1 regardless of minLag, so this costs one more
  // linear scan, not another difference-function pass.
  for (let tau = 1; tau < minLag; tau++) {
    if (cmnd[tau]! < threshold) return { hz: undefined, confidence: 0 }
  }

  // Step 3-4: absolute threshold, first dip below it, refined to that
  // dip's own local minimum -- not the global minimum over all lags. This
  // is precisely what keeps a loud second harmonic from winning: a
  // false candidate at half the true period may (or may not) dip lower
  // still further out, but the true period's own dip is found first and
  // accepted as soon as it clears the threshold.
  let tauEstimate = -1
  for (let tau = minLag; tau <= maxLag; tau++) {
    if (cmnd[tau]! < threshold) {
      while (tau + 1 <= maxLag && cmnd[tau + 1]! < cmnd[tau]!) tau++
      tauEstimate = tau
      break
    }
  }
  if (tauEstimate === -1) return { hz: undefined, confidence: 0 }

  // Step 5: parabolic interpolation around the chosen lag, for sub-sample
  // period resolution -- otherwise pitch is quantized to sampleRate/integer.
  const left = Math.max(1, tauEstimate - 1)
  const right = Math.min(maxLag, tauEstimate + 1)
  let refinedTau = tauEstimate
  if (left !== tauEstimate && right !== tauEstimate) {
    const s0 = cmnd[left]!, s1 = cmnd[tauEstimate]!, s2 = cmnd[right]!
    const denom = 2 * (2 * s1 - s2 - s0)
    if (denom !== 0) refinedTau = tauEstimate + (s2 - s0) / denom
  }

  const hz = sampleRate / refinedTau
  const confidence = Math.max(0, Math.min(1, 1 - cmnd[tauEstimate]!))
  return { hz, confidence }
}

/** Steps analysis windows across `samples` and returns one `PitchFrame`
 *  per step. The last partial window (shorter than a full frame) is
 *  dropped, matching `rmsEnvelope`'s own convention in features.ts. */
export function trackPitch(
  samples: Float32Array, sampleRate: number, opts: PitchTrackOptions = {},
): PitchFrame[] {
  const { frameSize, hopSize, minHz, maxHz, threshold, silenceRms } = { ...DEFAULTS, ...opts }
  const maxLag = Math.floor(sampleRate / minHz)
  const windowLength = frameSize + maxLag

  const frames: PitchFrame[] = []
  for (let start = 0; start + windowLength <= samples.length; start += hopSize) {
    const window = samples.subarray(start, start + windowLength)
    const timeSec = (start + windowLength / 2) / sampleRate
    if (rms(window) < silenceRms) {
      frames.push({ timeSec, hz: undefined, confidence: 0 })
      continue
    }
    const { hz, confidence } = yinFrame(window, sampleRate, minHz, maxHz, threshold)
    frames.push({ timeSec, hz, confidence })
  }
  return frames
}

/**
 * A single "what pitch is this buffer right now" reading -- one YIN frame
 * spanning the whole buffer, rather than `trackPitch`'s frame-wise contour.
 * For a live view polling a rolling `AnalyserNode` snapshot once an
 * animation frame (the scope panel's readout, the cable inspector), there
 * is no "over time" to trace, only "right now" -- and re-running the
 * frame-wise search at its default 75%-overlap hop across an 8192-sample
 * buffer just to keep one of eleven results would be wasted work.
 *
 * Forces `hopSize` to the buffer length so `trackPitch` produces at most
 * one frame; the buffer must be at least `frameSize + sampleRate/minHz`
 * samples for that frame to exist at all (2848 at the defaults and 48 kHz)
 * -- a caller with a smaller `AnalyserNode` buffer must size it up or pass
 * a smaller `frameSize`/higher `minHz`, the same tradeoff `trackPitch`
 * itself makes. Undefined exactly when `trackPitch` would report that one
 * frame unvoiced -- never a `peakHz`-style guess when nothing periodic is
 * there to find, which was this function's reason for existing: the scope
 * panel's old plain FFT-peak readout reported a bright saw's loud second
 * harmonic as the pitch, the exact trap YIN exists to avoid (see the
 * module doc comment above).
 */
export function singlePitchHz(
  samples: Float32Array, sampleRate: number, opts: PitchTrackOptions = {},
): number | undefined {
  const frames = trackPitch(samples, sampleRate, { ...opts, hopSize: samples.length })
  return frames[0]?.hz
}

/**
 * A single "dominant pitch" summary from a pitch track -- the reading a
 * readout shows ("329.6 Hz · E4 −2¢"). Averages in log-frequency (MIDI)
 * space, weighted by each frame's own confidence, so an octave-consistent
 * mean comes out even when confidence varies frame to frame -- averaging
 * in linear Hz would let a handful of low-confidence high readings drag a
 * mostly-steady low note sharp. Returns `undefined` when every frame is
 * unvoiced (silence, or nothing pitched was ever found).
 */
export function dominantPitchHz(frames: readonly PitchFrame[]): number | undefined {
  let weightedMidi = 0
  let totalWeight = 0
  for (const f of frames) {
    if (f.hz === undefined || f.confidence <= 0) continue
    const midi = 69 + 12 * Math.log2(f.hz / 440)
    weightedMidi += midi * f.confidence
    totalWeight += f.confidence
  }
  if (totalWeight <= 0) return undefined
  return 440 * 2 ** ((weightedMidi / totalWeight - 69) / 12)
}
