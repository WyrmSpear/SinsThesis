/**
 * Antialiased Drive (saturation).
 *
 * `tanh` already lives inside the ladder's feedback loop, and the
 * wavefolder folds -- reflects a signal back into range instead of
 * flattening it, which is why it grows a bright, metallic harmonic series
 * rather than getting buzzy. This module is the missing third: a plain
 * drive-into-saturation stage, the growl and grit dubstep/trap/grime/bass
 * house are built on, with nothing folding or reflecting -- just pushing a
 * signal into a curve that compresses its peaks.
 *
 * Two curves (`curve` param, discrete, 0='Soft'/1='Hard'):
 *
 * - **Soft**: `tanh(drive * x)`, odd-symmetric, no DC of its own. This is
 *   the "warm, rounds the peaks" character.
 * - **Hard**: an *asymmetric* clip, `clamp(drive * x, HARD_LO, HARD_HI)`
 *   with `HARD_LO != -HARD_HI`. Asymmetric because a symmetric hard clip
 *   would just be a louder, buzzier version of the same odd-harmonic
 *   content Soft already produces -- the reason to offer a second curve at
 *   all is that asymmetric clipping generates *even* harmonics (a
 *   genuinely different, more "fizzy transistor" character) and, as a
 *   direct consequence of clipping a waveform's positive and negative
 *   excursions by different amounts, a DC offset. See "DC blocker" below
 *   for why that's handled, not just noted.
 *
 * Both curves have a kink (Soft: none in value, but its antiderivative-free
 * evaluation still generates harmonics fast as drive rises; Hard: two
 * literal slope discontinuities, at HARD_LO and HARD_HI) that a direct
 * per-sample evaluation would alias badly at audio rates and high drive --
 * this project already found and fixed exactly that failure once, in the
 * wavefolder (`dsp/wavefolder.ts`): a naive fold went from alias energy
 * *louder than the fundamental* at high drive to -87.8 dB at drive 3 using
 * first-order antiderivative antialiasing (ADAA-1) plus 4x oversampling
 * scoped to the nonlinearity. This module reuses that exact approach --
 * same ADAA-1 technique (a closed-form antiderivative, evaluated as a
 * divided difference, with a midpoint fallback near zero denominator), same
 * 4x oversampling ratio, same 127-tap Blackman-windowed-sinc polyphase FIR
 * design (cutoff at 0.45x the *original* sample rate, same shape as
 * wavefolder.ts's `designBlackmanSincLowpass`/`polyphaseSplit`) -- deliberately
 * a second, independent copy rather than an import from wavefolder.ts. The
 * two modules' oversampling/DC-blocker machinery is bit-for-bit identical
 * in design, not shared in code: this project already accepts that same
 * tradeoff for dsp/wavetable.ts (duplicated per worklet bundle rather than
 * shared across the one-bundle-per-worklet build, ~384 KB of accepted cost
 * -- see docs/CONTINUATION.md), and the same reasoning applies here at far
 * smaller size: touching a working, heavily-measured module (wavefolder.ts)
 * to extract a shared oversampling module is a real regression risk for a
 * modest DRY win, so this file pays a few hundred duplicated lines instead.
 *
 * Measured alias floors (1109 Hz fundamental, 48 kHz, Blackman-Harris
 * window, N=65536, matching the wavefolder's own methodology) and the
 * four-fundamental sweep at non-commensurate frequencies (131, 441, 1109,
 * 2637 Hz -- see docs/CONTINUATION.md trap 1) are in this module's own test
 * file, tests/node/dsp/drive.test.ts, and reported in
 * .superpowers/sdd/bass-toolkit-report.md.
 *
 * DC blocker: unconditional, at the module's native rate, one-pole,
 * 4 Hz corner -- identical formula and corner to ladder.ts's and
 * wavefolder.ts's own output DC blockers (the same "audible band starts
 * around 20 Hz, leave real headroom below that" reasoning, see
 * wavefolder.ts's doc comment Finding 1 for the measured cost of getting
 * this corner wrong). Soft never produces DC on its own (odd-symmetric),
 * but the blocker runs for both curves anyway -- cheap, harmless when
 * there's nothing to block, and it means Hard's asymmetry is corrected by
 * construction rather than by the player noticing a DC-heavy patch later.
 *
 * Tone: a single one-pole lowpass after the antialiased nonlinearity, at
 * the native (already band-limited) rate. This is a linear filter -- it
 * doesn't generate new harmonics -- so it needs no oversampling of its own,
 * unlike the two curves above.
 */

const ADAA_EPS = 1e-6

// --- Soft: tanh(drive * x) --------------------------------------------------
// Antiderivative of tanh(v) w.r.t. v is ln(cosh(v)). No drive-dependent
// normalization: "drive" is a plain pre-gain into the curve, the same
// convention wavefolder.ts's `v = input*drive + symmetry` uses. At the
// range's low end (drive near its minimum) this stays close to linear for
// any input within the module's headroom -- see the measured unity-drive
// numbers in the test file/report -- without adding a special-cased branch
// that would only matter in the limit drive -> 0.
function softCurve(v: number): number {
  return Math.tanh(v)
}
function softAntiderivative(v: number): number {
  return Math.log(Math.cosh(v))
}

// --- Hard: asymmetric clip --------------------------------------------------
// Fixed, asymmetric thresholds -- not derived from `drive` or `symmetry`,
// because the whole point of offering this as a *second curve* rather than
// a knob on Soft is that it's a qualitatively different, fixed character
// (even-harmonic-rich, DC-generating) a player picks deliberately. `drive`
// still controls how hard the signal is pushed into these thresholds, via
// the same `v = drive * x` pre-gain as Soft.
const HARD_LO = -0.8
const HARD_HI = 0.95

function hardCurve(v: number): number {
  return Math.min(Math.max(v, HARD_LO), HARD_HI)
}

// Piecewise antiderivative of clamp(v, lo, hi): lo*v - lo^2/2 below lo,
// v^2/2 between, hi*v - hi^2/2 above hi -- continuous by construction (the
// three pieces are matched at both boundaries with the middle piece's
// integration constant set to 0). Same derivation pattern as
// wavefolder.ts's `foldAntiderivative`, just for a clamp instead of a fold.
function hardAntiderivative(v: number): number {
  if (v <= HARD_LO) return HARD_LO * v - (HARD_LO * HARD_LO) / 2
  if (v >= HARD_HI) return HARD_HI * v - (HARD_HI * HARD_HI) / 2
  return (v * v) / 2
}

export type DriveCurve = 'soft' | 'hard'

function curveOf(v: number, curve: DriveCurve): number {
  return curve === 'hard' ? hardCurve(v) : softCurve(v)
}
function antiderivativeOf(v: number, curve: DriveCurve): number {
  return curve === 'hard' ? hardAntiderivative(v) : softAntiderivative(v)
}

/** One step of first-order ADAA on the selected curve. Same divided-
 *  difference-with-midpoint-fallback shape as wavefolder.ts's `adaaFold`. */
function adaaStep(prevV: number, v: number, curve: DriveCurve): number {
  const diff = v - prevV
  if (Math.abs(diff) < ADAA_EPS) return curveOf((v + prevV) / 2, curve)
  return (antiderivativeOf(v, curve) - antiderivativeOf(prevV, curve)) / diff
}

// --- Polyphase oversampling FIR ---------------------------------------------
// Independent copy of wavefolder.ts's design (see the module doc comment
// for why this is duplicated rather than imported): 4x oversampling,
// 127-tap Blackman-windowed-sinc lowpass, cutoff at 0.45/OVERSAMPLE
// (normalized to the oversampled rate).

const OVERSAMPLE = 4
const FIR_TAPS = 127
const FIR_CUTOFF = 0.45 / OVERSAMPLE

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

function polyphaseSplit(h: Float64Array, r: number): Float64Array[] {
  const branches: number[][] = Array.from({ length: r }, () => [])
  for (let i = 0; i < h.length; i++) branches[i % r]!.push(h[i]!)
  return branches.map((b) => Float64Array.from(b))
}

const FIR = designBlackmanSincLowpass(FIR_TAPS, FIR_CUTOFF)
const INTERP_BRANCHES = polyphaseSplit(
  Float64Array.from(FIR, (x) => x * OVERSAMPLE),
  OVERSAMPLE,
)
const INTERP_HISTORY_LEN = Math.max(...INTERP_BRANCHES.map((b) => b.length))

// --- DC blocker --------------------------------------------------------------

function dcBlockerPole(hz: number, sampleRate: number): number {
  return 1 - (2 * Math.PI * hz) / sampleRate
}
const DC_BLOCKER_HZ = 4

export interface DriveState {
  interpHistory: Float64Array
  interpHead: number
  adaaPrevV: number
  decimHistory: Float64Array
  decimHead: number
  dcX: number
  dcY: number
  /** One-pole tone (lowpass) filter state, at the native rate. */
  toneY: number
}

export function createDriveState(): DriveState {
  return {
    interpHistory: new Float64Array(INTERP_HISTORY_LEN),
    interpHead: 0,
    adaaPrevV: 0,
    decimHistory: new Float64Array(FIR_TAPS),
    decimHead: 0,
    dcX: 0,
    dcY: 0,
    toneY: 0,
  }
}

function ringRead(buf: Float64Array, head: number, j: number): number {
  const len = buf.length
  return buf[(head - j + len * 2) % len]!
}

/** Unfiltered, single-evaluation nonlinearity -- kept for tests that want
 *  the bare curve shape (and by extension, a reference for what ADAA is
 *  correcting), the same role `foldSample` plays for the wavefolder. Not
 *  what the worklet calls; see `driveSample`. */
export function driveCurveRaw(input: number, drive: number, curve: DriveCurve): number {
  return curveOf(input * Math.max(drive, 0), curve)
}

/**
 * Antialiased drive, one output sample per call.
 *
 * Pipeline: interpolate the input up 4x (polyphase FIR), run ADAA-1 on the
 * selected curve at the oversampled rate, decimate back down (same FIR,
 * unity gain), DC-block, then apply Tone (one-pole lowpass) and Level
 * (linear gain) at the native rate.
 *
 * @param drive pre-gain into the curve, clamped to >= 0.
 * @param toneHz one-pole lowpass cutoff. Pass the sample rate (or above) to
 *   leave Tone effectively out of the signal path.
 * @param level linear output gain, applied last.
 * @param sampleRate the caller's native (pre-oversampling) rate.
 */
/**
 * @param oversample Default `true` -- the full 4x-oversampled pipeline this
 *   module's doc comment measures (~550 ns/sample on the desktop machine
 *   `.superpowers/sdd/mobile-perf-report.md` measured against). `false` is
 *   the mobile "Performance" mode added for `docs/CONTINUATION.md`'s mobile
 *   CPU finding -- same mechanism as `wavefolder.ts`'s `oversample`
 *   parameter (ADAA-1 alone, at the native rate, skipping both FIRs),
 *   measured at ~61 ns/sample (~9x cheaper). Unlike the wavefolder, this
 *   mode holds up well: Soft is a single smooth tanh curve, not a fold with
 *   a sharp per-cycle kink, so ADAA-1's local-linearity assumption between
 *   samples is a much better fit even without oversampling. Re-measured
 *   honestly, 48 kHz, Blackman-Harris, same four fundamentals as this
 *   module's own honesty-sweep test:
 *
 *   | f0 (Hz) | drive 1.5 | drive 3 | drive 8 | drive 16 | drive 20 |
 *   |---|---|---|---|---|---|
 *   | 131  | -101.3 dB | -101.4 dB | -101.4 dB | -101.4 dB | -101.4 dB |
 *   | 441  | -129.5 dB | -129.6 dB | -105.5 dB |  -65.1 dB |  -57.7 dB |
 *   | 1109 | -127.4 dB | -105.8 dB |  -52.4 dB |  -38.8 dB |  -36.6 dB |
 *   | 2637 |  -88.8 dB |  -54.5 dB |  -32.6 dB |  -28.3 dB |  -27.7 dB |
 *
 *   Worst case anywhere in the sweep is -27.7 dB (2637 Hz, drive 20) --
 *   measurably worse than full quality's -73.6 dB at the same point, but
 *   never positive (alias never exceeds the fundamental, unlike the
 *   wavefolder's performance mode at high drive on a bright fundamental)
 *   and RELEASE-grade through most of the low-mid range even without
 *   oversampling. Still a real, stated trade -- default-off, never applied
 *   silently. See `tests/node/dsp/drive.test.ts`'s "performance mode"
 *   describe block for the measurement that produced this table.
 */
export function driveSample(
  state: DriveState,
  input: number,
  drive: number,
  curve: DriveCurve,
  toneHz: number,
  level: number,
  sampleRate: number,
  oversample = true,
): number {
  const d = Math.max(drive, 0)

  let decimated: number
  if (!oversample) {
    // Performance mode: ADAA-1 at the native rate, no oversampling FIR in
    // either direction.
    const v = input * d
    decimated = adaaStep(state.adaaPrevV, v, curve)
    state.adaaPrevV = v
  } else {
    state.interpHead = (state.interpHead + 1) % state.interpHistory.length
    state.interpHistory[state.interpHead] = input

    for (let k = 0; k < OVERSAMPLE; k++) {
      const branch = INTERP_BRANCHES[k]!
      let acc = 0
      for (let j = 0; j < branch.length; j++) {
        acc += branch[j]! * ringRead(state.interpHistory, state.interpHead, j)
      }
      const v = acc * d
      const shaped = adaaStep(state.adaaPrevV, v, curve)
      state.adaaPrevV = v

      state.decimHead = (state.decimHead + 1) % state.decimHistory.length
      state.decimHistory[state.decimHead] = shaped
    }

    decimated = 0
    for (let i = 0; i < FIR.length; i++) {
      decimated += FIR[i]! * ringRead(state.decimHistory, state.decimHead, i)
    }
  }

  // DC blocker, at the native rate.
  const R = dcBlockerPole(DC_BLOCKER_HZ, sampleRate)
  const dcOut = decimated - state.dcX + R * state.dcY
  state.dcX = decimated
  state.dcY = dcOut

  // Tone: one-pole lowpass, exponential-decay form (standard RC one-pole).
  // toneHz >= sampleRate/2 makes `a` <= 0 and the filter passes everything
  // essentially unchanged -- how a "fully bright" Tone setting stays inert
  // without a special-cased bypass branch.
  const a = Math.exp((-2 * Math.PI * toneHz) / sampleRate)
  state.toneY = a * state.toneY + (1 - a) * dcOut

  return state.toneY * level
}
