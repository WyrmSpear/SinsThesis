/**
 * Band-limited mipmapped wavetable oscillator core.
 *
 * A naive saw or triangle steps or kinks discontinuously once per cycle, and
 * a polynomial correction (see polyblep.ts) only ever approximates the
 * resulting band-limited step -- it cannot exceed roughly half a period of
 * correction reach no matter how it's tuned. A wavetable sidesteps the
 * problem instead of approximating a fix for it: each mip level is built by
 * additive synthesis with only the harmonics that stay below Nyquist for the
 * *top* frequency that level will ever be asked to play, so the table is
 * exactly band-limited by construction. There is nothing left to alias
 * short of interpolation error, which 2048 samples/table plus cubic
 * interpolation keeps far below audibility (measured: -100 to -147 dB
 * RELEASE-grade at every frequency this project tested -- see
 * .superpowers/sdd/2026-08-18-phase1a-engine/minblep-spec.md section 7).
 *
 * Pulse is not a separate table: it's the saw table read twice and combined
 * via the difference identity in `pulseSample` below, so PWM is exact and
 * continuously variable with no crossfading between discrete duty-cycle
 * tables. Mip-level switching itself *is* crossfaded (`readBlended`) between
 * the two adjacent tables, weighted by fractional octave position -- hard
 * switching measured within 1.3 dB of crossfading at the three lowest
 * boundaries, which is why it shipped first, but an audit of all seven
 * boundaries found triangle's worst single-sample delta reaching 0.42-0.74
 * at the top two, well past this codebase's 0.35 tick threshold. Sine has no
 * discontinuity of any order and stays analytic.
 *
 * Table generation is expensive relative to a single sample (millions of
 * sin/cos evaluations) but happens once per sample rate and is cached at
 * module scope -- `getWavetableSet` -- so every oscillator instance in a
 * worklet bundle shares one read-only table set rather than rebuilding it
 * per voice.
 *
 * Pure by design: no audio context, no DOM. The worklets are shells over
 * this module, exactly as they are over polyblep.ts (which stays in the
 * tree as the reference implementation these tables are measured against --
 * see the note at the top of that file).
 */

export type OscShape = 'saw' | 'pulse' | 'tri' | 'sine'

/** Samples per mip table. Matches the spec's measured configuration. */
export const TABLE_SIZE = 2048

/** Lowest mip level's low edge. Below this, the lowest level is reused --
 *  harmless, since sub-audio (LFO) rates are far from that level's Nyquist
 *  cap and effectively play back the full harmonic series unattenuated. */
export const LOWEST_HZ = 20

/** 20 Hz * 2^12 = 81 920 Hz, comfortably spanning and exceeding the audible
 *  range and the highest frequency pitchToFreq's Nyquist clamp can produce. */
export const OCTAVE_COUNT = 12

export interface WavetableSet {
  sampleRate: number
  tableSize: number
  lowestHz: number
  octaveCount: number
  /** One table per octave, index 0 = lowest. Saw only; pulse reuses this. */
  saw: Float32Array[]
  tri: Float32Array[]
}

/** Highest frequency mip level `i` will ever be asked to play -- the value
 *  used to cap harmonics so the level stays band-limited across its whole
 *  range, not just at its low edge. */
function topFreqForLevel(level: number): number {
  return LOWEST_HZ * 2 ** (level + 1)
}

/** Largest harmonic count such that `harmonic * topFreqHz` stays strictly
 *  below Nyquist. Always at least 1 (the fundamental), even past Nyquist --
 *  that level is then unreachable in practice (pitchToFreq's clamp keeps
 *  playable frequencies well under it), but generation must not divide by
 *  zero or produce an empty table. */
function maxHarmonicFor(topFreqHz: number, nyquist: number): number {
  let h = Math.floor(nyquist / topFreqHz)
  if (h * topFreqHz >= nyquist) h -= 1
  return Math.max(1, h)
}

/**
 * Lanczos sigma factor: a smooth taper applied to each harmonic's amplitude
 * (`sinc(n / (maxHarmonic + 1))`) that damps the Gibbs overshoot a truncated
 * Fourier series always has at a discontinuity -- ~9% for a sawtooth, no
 * matter how many harmonics are summed, because Gibbs doesn't shrink with
 * harmonic count. The taper only ever *attenuates* harmonics already below
 * Nyquist; it introduces nothing above the cutoff, so the table stays
 * exactly band-limited while headroom stays close to unity -- individual
 * tables measure within ±1.05, though `readBlended`'s crossfade of two
 * tables whose Gibbs ripples aren't in phase can add slightly past that at
 * a boundary (measured worst case ±1.053, pulse near 5120 Hz); the test
 * tolerance widens to ±1.06 to cover it. Standard technique for
 * additive-synthesis wavetables (see e.g. Lanczos's own treatment of
 * Fourier series smoothing).
 */
function lanczosSigma(n: number, maxHarmonic: number): number {
  const x = n / (maxHarmonic + 1)
  return x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
}

/** Rising band-limited sawtooth, -1 at phase 0 ramping to +1 just before
 *  wrap: `saw(t) = -(2/pi) * sum_{n=1}^{N} sin(2*pi*n*t) / n`. Matches
 *  polyblep.ts's `2t-1` convention (same sign, same wrap direction) so a
 *  patch built against one core reads the same on the other. */
function buildSawTable(topFreqHz: number, sampleRate: number, size: number): Float32Array {
  const maxHarmonic = maxHarmonicFor(topFreqHz, sampleRate / 2)
  const table = new Float32Array(size)
  const scale = -2 / Math.PI
  for (let i = 0; i < size; i++) {
    const t = i / size
    let sum = 0
    for (let n = 1; n <= maxHarmonic; n++) {
      sum += (Math.sin(2 * Math.PI * n * t) / n) * lanczosSigma(n, maxHarmonic)
    }
    table[i] = scale * sum
  }
  return table
}

/** Band-limited triangle, odd harmonics only, amplitude 1/n^2:
 *  `tri(t) = -(8/pi^2) * sum_{k=0}^{K} cos(2*pi*(2k+1)*t) / (2k+1)^2`.
 *  -1 at phase 0, rising to +1 at phase 0.5, falling back to -1 at wrap --
 *  continuous everywhere, so mip-level switching has nothing to click on
 *  beyond ordinary interpolation error. Converges fast enough (1/n^2) that
 *  the Lanczos taper barely matters here, but it's applied for consistency
 *  with the saw table. */
function buildTriTable(topFreqHz: number, sampleRate: number, size: number): Float32Array {
  const maxHarmonic = maxHarmonicFor(topFreqHz, sampleRate / 2)
  const table = new Float32Array(size)
  const scale = -8 / (Math.PI * Math.PI)
  for (let i = 0; i < size; i++) {
    const t = i / size
    let sum = 0
    for (let n = 1; n <= maxHarmonic; n += 2) {
      sum += (Math.cos(2 * Math.PI * n * t) / (n * n)) * lanczosSigma(n, maxHarmonic)
    }
    table[i] = scale * sum
  }
  return table
}

/** Build one mip set (saw + triangle tables for every octave) at a given
 *  sample rate. Pure and deterministic -- same inputs, same tables, every
 *  time -- but expensive enough (millions of sin/cos evaluations across all
 *  12 levels) that callers should go through `getWavetableSet` rather than
 *  calling this directly per voice. */
let buildCallCount = 0

/** Test-only hook: how many times `buildWavetableSet` has actually run (not
 *  cache hits through `getWavetableSet`). Exists so a test can prove the
 *  expensive generation happens once, at worklet module load, and never
 *  during sample generation -- see tests/node/worklets/wavetable-build-timing.test.ts. */
export function debugWavetableBuildCount(): number {
  return buildCallCount
}

export function buildWavetableSet(sampleRate: number): WavetableSet {
  buildCallCount++
  const saw: Float32Array[] = []
  const tri: Float32Array[] = []
  for (let level = 0; level < OCTAVE_COUNT; level++) {
    const topFreqHz = topFreqForLevel(level)
    saw.push(buildSawTable(topFreqHz, sampleRate, TABLE_SIZE))
    tri.push(buildTriTable(topFreqHz, sampleRate, TABLE_SIZE))
  }
  return { sampleRate, tableSize: TABLE_SIZE, lowestHz: LOWEST_HZ, octaveCount: OCTAVE_COUNT, saw, tri }
}

const wavetableCache = new Map<number, WavetableSet>()

/** Cached, shared, read-only mip set for a sample rate -- built once on
 *  first request, reused by every oscillator instance after that. This is
 *  the entry point worklets and tests should use instead of
 *  `buildWavetableSet`. */
export function getWavetableSet(sampleRate: number): WavetableSet {
  let set = wavetableCache.get(sampleRate)
  if (!set) {
    set = buildWavetableSet(sampleRate)
    wavetableCache.set(sampleRate, set)
  }
  return set
}

/** Which mip level covers `freqHz`, hard-selected (no crossfade). Sample
 *  generation itself crossfades (see `mipLevelFrac` / `readBlended` below);
 *  this integer form is kept for callers -- tests included -- that need to
 *  know when a sweep crosses from one level's territory into the next. */
export function mipLevelForFreq(freqHz: number, set: WavetableSet): number {
  const f = Math.max(Math.abs(freqHz), set.lowestHz)
  const level = Math.floor(Math.log2(f / set.lowestHz))
  return Math.min(Math.max(level, 0), set.octaveCount - 1)
}

/**
 * Fractional mip level: the integer part is `mipLevelForFreq`, the
 * fractional part is how far `freqHz` sits between that level and the next.
 * Reading two adjacent tables and blending by this fraction (`readBlended`)
 * replaces hard switching.
 *
 * Hard switching measured within 1.3 dB of crossfading at the three lowest
 * boundaries (160/320/640 Hz) -- close enough that hard switching shipped
 * for being simpler. It does not hold at the top of the range: an audit
 * sweeping all seven boundaries found triangle's worst single-sample delta
 * reaching 0.42-0.74 at 5120/10240 Hz, past this codebase's 0.35 threshold.
 * Crossfading removes the *extra* jump switching adds on top of the
 * waveform's own steepness -- see the DC-blocker-adjacent measurement notes
 * in the mip-boundary test for what's left after this fix and why it can't
 * go lower without changing the top tables' amplitude.
 */
function mipLevelFrac(freqHz: number, set: WavetableSet): number {
  const f = Math.max(Math.abs(freqHz), set.lowestHz)
  const level = Math.log2(f / set.lowestHz)
  return Math.min(Math.max(level, 0), set.octaveCount - 1)
}

/** 4-point cubic (Catmull-Rom) interpolated read at normalized phase
 *  `t` in [0, 1). Horner-form evaluation, matching the ~25-30 flops/sample
 *  cost the spec measures for this design. */
function readTable(table: Float32Array, t: number): number {
  const size = table.length
  const pos = t * size
  const i1f = Math.floor(pos)
  const frac = pos - i1f
  const i1 = ((i1f % size) + size) % size
  const i0 = (i1 - 1 + size) % size
  const i2 = (i1 + 1) % size
  const i3 = (i1 + 2) % size
  const y0 = table[i0]!
  const y1 = table[i1]!
  const y2 = table[i2]!
  const y3 = table[i3]!
  const a0 = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3
  const a1 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3
  const a2 = -0.5 * y0 + 0.5 * y2
  const a3 = y1
  return ((a0 * frac + a1) * frac + a2) * frac + a3
}

export interface OscState {
  /** Normalized phase in [0, 1). */
  phase: number
}

export function createOscState(phase = 0): OscState {
  return { phase }
}

/** Restart the cycle. Used by the VCO's hard-sync input. */
export function hardSync(state: OscState): void {
  state.phase = 0
}

function wrap01(t: number): number {
  let w = t % 1
  if (w < 0) w += 1
  return w
}

/**
 * Pulse via the saw-difference identity, corrected. The naive
 * `saw(t) - saw(t-w)` has zero mean regardless of width and inverted
 * polarity relative to this project's `t < pw -> +1` convention (measured:
 * mean ~0.0006 at w=0.5). The corrected form, `(2w-1) - [saw(t) - saw(t-w)]`,
 * tracks mean = 2w-1 exactly and matches polyblep.ts's high/low convention.
 * No second table: both reads come from the same saw mip level.
 */
function pulseSample(sawTable: Float32Array, t: number, w: number): number {
  const a = readTable(sawTable, t)
  const b = readTable(sawTable, wrap01(t - w))
  return (2 * w - 1) - (a - b)
}

/** Blend the two mip levels adjacent to `freqHz`, weighted by how far into
 *  the upper one it sits. `read(table, t)` is whichever per-shape reader
 *  (plain table lookup, or pulse's saw-difference) is being crossfaded --
 *  both levels must produce output in the same convention for the blend to
 *  be meaningful. At an exact octave boundary the weight is 0 (or 1 at the
 *  far end of the range), so this reduces to a single table read there and
 *  at every frequency that isn't near a boundary at all -- the extra table
 *  read only costs something during the transition band. */
function readBlended(
  tables: Float32Array[], freqHz: number, set: WavetableSet, read: (table: Float32Array) => number,
): number {
  const levelFrac = mipLevelFrac(freqHz, set)
  const level0 = Math.floor(levelFrac)
  const level1 = Math.min(level0 + 1, set.octaveCount - 1)
  const frac = levelFrac - level0
  if (frac === 0) return read(tables[level0]!)
  const a = read(tables[level0]!)
  const b = read(tables[level1]!)
  return a + (b - a) * frac
}

const TWO_PI = Math.PI * 2
const MIN_PW = 0.01
const MAX_PW = 0.99

/**
 * Advance one sample and return the oscillator's output in [-1, 1].
 *
 * `set` must be the caller's own already-built `WavetableSet` (from
 * `getWavetableSet`, called once up front -- at worklet module load, not
 * per sample). This function never calls `getWavetableSet` itself: doing so
 * from inside a per-sample loop is exactly the bug that put table
 * generation -- millions of trig calls -- on the audio thread's first
 * non-sine sample. `sine` doesn't read tables at all, but still takes `set`
 * so callers can hold one reference regardless of which shape is selected
 * at runtime.
 */
export function oscSample(
  state: OscState,
  shape: OscShape,
  freq: number,
  sampleRate: number,
  set: WavetableSet,
  pulseWidth = 0.5,
): number {
  const dt = Math.abs(freq) / sampleRate
  state.phase = wrap01(state.phase + dt)
  const t = state.phase

  if (shape === 'sine') return Math.sin(TWO_PI * t)

  switch (shape) {
    case 'saw':
      return readBlended(set.saw, freq, set, (table) => readTable(table, t))
    case 'tri':
      return readBlended(set.tri, freq, set, (table) => readTable(table, t))
    case 'pulse': {
      const w = Math.min(Math.max(pulseWidth, MIN_PW), MAX_PW)
      return readBlended(set.saw, freq, set, (table) => pulseSample(table, t, w))
    }
  }
}

/**
 * 1V/octave pitch mapping, extracted from the VCO worklet so the DSP math
 * lives in a pure module (the project rule the inline version violated):
 * pitch CV is 1.0 per octave from `baseHz`, clamped just under Nyquist
 * because past that point the phase increment stops wrapping meaningfully.
 */
export function pitchToFreq(baseHz: number, cv: number, sampleRate: number): number {
  return Math.min(baseHz * Math.pow(2, cv), sampleRate * 0.49)
}
