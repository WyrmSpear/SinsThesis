/**
 * Antialiased wavefolder.
 *
 * Clipping flattens a peak; folding reflects it back down, so the waveform
 * gains inflection points instead of losing them. That is why a folded sine
 * grows a bright, metallic harmonic series while a clipped sine just gets
 * buzzy. Drive scales the signal into the folding region.
 *
 * `foldSample` below is the fold's closed form -- a period-4, unit-amplitude
 * triangle wave in `v = drive*x + symmetry` -- replacing what used to be a
 * loop reflecting up to 32 times. It is mathematically identical to the old
 * loop (verified bit-identical, float rounding only) and stays exported for
 * anything that wants the instantaneous, unfiltered nonlinearity, but it is
 * NOT what the worklet calls per sample any more, because it band-limits
 * nothing it creates: the closed form still has a slope discontinuity (kink)
 * every time `v` crosses an odd integer, and a rising `drive` raises the rate
 * of kinks per cycle linearly -- roughly 40 kinks/cycle at drive 20. Measured
 * (1109 Hz fundamental, 48 kHz, Blackman-Harris alias floor): drive 1.5 hit
 * only -45.7 dB, drive 3 only -31.9 dB (well inside the range a player uses),
 * and drive 16-20 measured +6.4 to +6.8 dB -- alias energy LOUDER than the
 * fundamental. See `.superpowers/sdd/2026-08-18-phase1a-engine/wavefolder-spec.md`
 * for the full derivation and measurement history.
 *
 * The fix actually used, `wavefolderSample`, is three separable pieces, in
 * order of increasing effectiveness and cost:
 *
 * 1. **ADAA order 1** (`adaaFold` below) replaces a direct per-sample
 *    evaluation `foldClosed(v[n])` with a divided difference of the fold's
 *    antiderivative, `(T(v[n]) - T(v[n-1])) / (v[n] - v[n-1])`, falling back
 *    to `foldClosed` at the midpoint when the denominator is near zero. This
 *    is the standard technique for a memoryless nonlinearity with a
 *    discontinuity (Parker/D'Angelo/Falaize, *Antiderivative Antialiasing
 *    for Stateless Nonlinearities*, DAFx 2016) and it is cheap: no
 *    oversampling, one extra state variable. Measured alone it bought a
 *    real but modest 4-8 dB (drive 3: -31.9 -> -36.3 dB) -- nowhere near
 *    enough on its own. The reason: order-1 ADAA's local-linearity
 *    assumption between consecutive samples breaks down once the kink rate
 *    approaches the sample rate, and this folder can produce dozens of
 *    kinks per cycle at high drive. ADAA-1 alone is NOT the fix. It stays
 *    in the design as the inner nonlinearity -- strictly better than the
 *    raw fold and free once you're already oversampling -- but oversampling
 *    is what does the actual band-limiting.
 * 2. **4x oversampling scoped to the fold**, running ADAA-1 (not the raw
 *    fold) at the oversampled rate, interpolated up and decimated back down
 *    through a 127-tap Blackman-windowed-sinc FIR (`FIR`, `INTERP_BRANCHES`
 *    below), reused for both stages via textbook polyphase decomposition --
 *    this is what actually band-limits the kinks. Measured with this
 *    config: drive 1.5 -> -97.4 dB, drive 3 -> -87.9 dB, drive 8 -> -63.8 dB,
 *    drive 20 -> -45.6 dB. Only oversampling *of the ADAA-corrected signal*
 *    reaches these numbers -- oversampling without ADAA, or ADAA without
 *    oversampling, both leave real energy on the table (see the spec for
 *    the tap-count and window-vs-ratio experiments that pinned this down).
 * 3. **A one-pole DC blocker** after decimation, at the module's native
 *    rate. Folding an asymmetric waveform (`symmetry != 0`) is not an
 *    aliasing problem -- ADAA does not touch it (measured DC unchanged) --
 *    it's a genuine property of a fold law that is no longer odd-symmetric
 *    once `symmetry != 0`. `R = 0.995` (~38 Hz corner at 48 kHz) settles to
 *    -148.7 dBFS, comfortably inside the -100 dBFS bar and identical in
 *    spirit to `ladder.ts`'s output DC blocker.
 *
 * Honest caveat, not silently hidden: **drive above ~10 is ACCEPTABLE-grade
 * by measurement (-56 to -46 dB), not RELEASE (<=-60 dB).** At that many
 * folds per cycle the *true*, unaliased signal genuinely contains energy
 * approaching and past Nyquist -- there is no free lunch, and 8x
 * oversampling only buys a further ~2 dB at double the cost. The 0.1-20
 * drive range ships as-is rather than being narrowed to hide this; drive
 * <=8, the range a player actually reaches for, is fully RELEASE-grade.
 */

/** Proper modulo: result always in `[0, m)`, unlike `%` for negative `v`. */
function properMod(v: number, m: number): number {
  return ((v % m) + m) % m
}

/**
 * The fold law itself: a period-4, unit-amplitude triangle wave in `v`
 * (already scaled by drive and offset by symmetry). O(1) closed form for
 * what used to be a loop reflecting `v` back into [-1, 1] up to 32 times.
 */
function foldClosed(v: number): number {
  const p = properMod(v, 4)
  if (p <= 1) return p
  if (p <= 3) return 2 - p
  return p - 4
}

/**
 * Antiderivative of `foldClosed` with respect to `v`, needed by ADAA. Exactly
 * periodic with no per-period drift term -- a full period of `foldClosed`
 * integrates to zero, so no `+ k * (period integral)` bookkeeping is needed
 * across an arbitrarily long divided-difference chain.
 */
function foldAntiderivative(v: number): number {
  const p = properMod(v, 4)
  if (p <= 1) return (p * p) / 2
  if (p <= 3) return 2 * p - (p * p) / 2 - 1
  return (p * p) / 2 - 4 * p + 8
}

/** Below this |v[n] - v[n-1]|, the ADAA divided difference is numerically
 *  unstable (0/0), so fall back to evaluating the fold at the midpoint --
 *  the limit the divided difference converges to as the denominator shrinks. */
const ADAA_EPS = 1e-6

/**
 * One step of first-order ADAA on the fold nonlinearity. `state.adaaPrevV`
 * carries the previous input to this same function across calls, so this is
 * a streaming, stateful replacement for a bare `foldClosed(v)` call -- see
 * the module doc comment for why this alone is not enough antialiasing and
 * has to run at the oversampled rate.
 */
function adaaFold(state: WavefolderState, v: number): number {
  const prev = state.adaaPrevV
  const diff = v - prev
  const y = Math.abs(diff) < ADAA_EPS ? foldClosed((v + prev) / 2)
    : (foldAntiderivative(v) - foldAntiderivative(prev)) / diff
  state.adaaPrevV = v
  return y
}

/**
 * Reflective wavefolder, instantaneous and unfiltered.
 *
 * Kept for callers that want the bare nonlinearity (and by the tests that
 * pin its exact shape), but the worklet no longer calls this directly --
 * see `wavefolderSample` for the antialiased path actually used in
 * `wavefolder.worklet.ts`.
 */
export function foldSample(input: number, drive: number, symmetry = 0): number {
  const v = input * Math.max(drive, 0) + symmetry
  return Math.min(Math.max(foldClosed(v), -1), 1)
}

// --- Polyphase oversampling FIR -------------------------------------------
//
// 4x oversampling, 127-tap Blackman-windowed-sinc lowpass, cutoff at
// 0.45/R (normalized to the oversampled rate) -- i.e. the real cutoff sits
// at 0.45 x the original sample rate, leaving a transition band below the
// original Nyquist. Both figures are load-bearing, not arbitrary: 63 taps
// was measurably insufficient at R=4 (worse than R=2 at high drive -- not
// enough taps for the narrower relative cutoff), and 127 is the practical
// floor -- more taps at fixed R=4 buys nothing further (confirmed: 127 and
// 255 taps gave identical -56.2 dB at drive 16). Computed once at module
// scope and shared by every wavefolder instance, the same pattern
// wavetable.ts uses for its (much larger) precomputed tables.

const OVERSAMPLE = 4
const FIR_TAPS = 127
const FIR_CUTOFF = 0.45 / OVERSAMPLE

/**
 * Blackman-windowed sinc lowpass, `taps` coefficients (odd, so there is a
 * well-defined center tap), normalized to unity DC gain. `cutoff` is in
 * cycles/sample (i.e. a fraction of whatever rate the filter will run at).
 */
function designBlackmanSincLowpass(taps: number, cutoff: number): Float64Array {
  const center = (taps - 1) / 2
  const h = new Float64Array(taps)
  let sum = 0
  for (let n = 0; n < taps; n++) {
    const m = n - center
    const sinc = m === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * m) / (Math.PI * m)
    const window = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (taps - 1))
      + 0.08 * Math.cos((4 * Math.PI * n) / (taps - 1))
    h[n] = sinc * window
    sum += h[n]!
  }
  for (let n = 0; n < taps; n++) h[n] = h[n]! / sum
  return h
}

/**
 * Splits a prototype FIR into `r` polyphase branches for efficient
 * interpolation: `branch[k][j] = h[j*r + k]`. Standard derivation (zero-stuff
 * `x` by `r`, convolve with `h`, then group terms by `i mod r` where `i` is
 * the tap index) -- see the module spec for the full derivation. Using this
 * split means producing all `r` oversampled outputs for one input sample
 * costs `taps` total multiply-adds, not `taps * r`.
 */
function polyphaseSplit(h: Float64Array, r: number): Float64Array[] {
  const branches: number[][] = Array.from({ length: r }, () => [])
  for (let i = 0; i < h.length; i++) branches[i % r]!.push(h[i]!)
  return branches.map((b) => Float64Array.from(b))
}

/** Unity-gain prototype, reused (per the spec's "single design, standard
 *  polyphase reuse") for both interpolation and decimation. */
const FIR = designBlackmanSincLowpass(FIR_TAPS, FIR_CUTOFF)

/** Interpolation needs gain `OVERSAMPLE` to conserve amplitude across the
 *  zero-stuffing implicit in upsampling; decimation does not (it is a plain
 *  lowpass-then-downsample, no zero-stuffing involved), so `FIR` itself
 *  (unity gain) is reused directly as the decimation filter below. */
const INTERP_BRANCHES = polyphaseSplit(
  Float64Array.from(FIR, (x) => x * OVERSAMPLE),
  OVERSAMPLE,
)
const INTERP_HISTORY_LEN = Math.max(...INTERP_BRANCHES.map((b) => b.length))

// --- DC blocker -------------------------------------------------------------
//
// Folding an asymmetric waveform (symmetry != 0) is not an aliasing
// artifact -- ADAA does not touch it, see the module doc comment -- so it
// needs its own one-pole blocker after decimation, at the module's native
// rate. Same shape as ladder.ts's output DC blocker.

/** Pole for the one-pole DC blocker, solved so its corner sits at `hz`
 *  regardless of sample rate. At 48 kHz and 38 Hz this is ~0.995, the
 *  figure the spec measured settling to -148.7 dBFS. */
function dcBlockerPole(hz: number, sampleRate: number): number {
  return 1 - (2 * Math.PI * hz) / sampleRate
}

const DC_BLOCKER_HZ = 38

export interface WavefolderState {
  /** Ring buffer of raw input samples at the original rate, for the
   *  polyphase interpolator. */
  interpHistory: Float64Array
  interpHead: number
  /** Previous `v` fed to the fold, carried at the oversampled rate. */
  adaaPrevV: number
  /** Ring buffer of folded oversampled samples, for the decimation FIR. */
  decimHistory: Float64Array
  decimHead: number
  /** DC blocker state: previous input and previous output. */
  dcX: number
  dcY: number
}

export function createWavefolderState(): WavefolderState {
  return {
    interpHistory: new Float64Array(INTERP_HISTORY_LEN),
    interpHead: 0,
    adaaPrevV: 0,
    decimHistory: new Float64Array(FIR_TAPS),
    decimHead: 0,
    dcX: 0,
    dcY: 0,
  }
}

/** Reads `buf[head - j]` with wraparound, i.e. `j` samples before the most
 *  recently written one. */
function ringRead(buf: Float64Array, head: number, j: number): number {
  const len = buf.length
  return buf[(head - j + len * 2) % len]!
}

/**
 * Antialiased wavefolder, one output sample per call.
 *
 * Pipeline (all of it, per the spec, scoped entirely to this function --
 * nothing else in the worklet's per-sample path participates): interpolate
 * the raw input up to 4x via polyphase FIR, run ADAA-1 folding at that
 * oversampled rate (so the fold's kinks are resolved against a sample rate
 * 4x higher than the caller's), decimate back down through the same FIR
 * reused at unity gain, then DC-block at the native rate.
 *
 * @param drive clamped to >=0, same as the old `foldSample`.
 * @param sampleRate the caller's (pre-oversampling) rate -- only the DC
 *   blocker's pole depends on it; the oversampling FIR is a fixed ratio
 *   design, independent of the absolute rate.
 */
export function wavefolderSample(
  state: WavefolderState,
  input: number,
  drive: number,
  symmetry: number,
  sampleRate: number,
): number {
  const d = Math.max(drive, 0)

  // 1. Push the raw input into interpolation history and produce the R
  // oversampled input samples via polyphase interpolation.
  state.interpHead = (state.interpHead + 1) % state.interpHistory.length
  state.interpHistory[state.interpHead] = input

  for (let k = 0; k < OVERSAMPLE; k++) {
    const branch = INTERP_BRANCHES[k]!
    let acc = 0
    for (let j = 0; j < branch.length; j++) {
      acc += branch[j]! * ringRead(state.interpHistory, state.interpHead, j)
    }
    // 2. ADAA-1 fold at the oversampled rate.
    const v = acc * d + symmetry
    const folded = adaaFold(state, v)

    // 3. Push the folded oversampled sample into decimation history.
    state.decimHead = (state.decimHead + 1) % state.decimHistory.length
    state.decimHistory[state.decimHead] = folded
  }

  // 4. Decimate: one 127-tap dot product per *input* sample (not per
  // oversampled sample), which is what keeps this O(taps) rather than
  // O(taps * OVERSAMPLE) per original-rate output.
  let decimated = 0
  for (let i = 0; i < FIR.length; i++) {
    decimated += FIR[i]! * ringRead(state.decimHistory, state.decimHead, i)
  }

  // 5. DC blocker, at the native rate (see the module doc comment).
  const R = dcBlockerPole(DC_BLOCKER_HZ, sampleRate)
  const dcOut = decimated - state.dcX + R * state.dcY
  state.dcX = decimated
  state.dcY = dcOut
  // No output clamp here, deliberately: the fold itself (foldClosed) is
  // already bounded to [-1, 1], but the FIR stages can overshoot that by a
  // few thousandths of a dB worth of Gibbs-style ripple on a full-scale
  // input. Clamping that away would be a hard-clip nonlinearity bolted onto
  // the end of a carefully antialiased signal path -- measured to cost
  // 15-20 dB of alias floor on its own (a hard clip is a sharp, broadband-
  // generating discontinuity, exactly what the rest of this function exists
  // to avoid). The unclamped overshoot is inaudibly small and self-limiting
  // (it is filter ripple around a bounded input, not runaway gain).
  return dcOut
}
