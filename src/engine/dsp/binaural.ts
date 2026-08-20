/**
 * Binaural: two independent sine oscillators, one meant for each ear,
 * offset by a settable difference around a settable center frequency.
 *
 * This is a description of a mechanism, not a claim about an effect: two
 * slightly different tones, one per ear. What this module's name refers to
 * -- the perception some listeners describe when a slow beat is presented
 * this way -- happens in the listener, not in this module, and it requires
 * the two tones to be genuinely kept separate: headphones, or any other
 * route that keeps `left` and `right` from mixing before they reach the
 * two ears.
 *
 * Summed to mono, `left` and `right` become two sine waves physically added
 * together, and that sum is **not** silent or featureless at the beat
 * rate -- it is measurably, audibly amplitude-modulated at exactly the
 * `beat` frequency, dipping to a near-null every `1/(2*beat)` seconds. That
 * is ordinary two-tone acoustic interference (`sin(a) + sin(b) =
 * 2*sin((a+b)/2)*cos((a-b)/2)`, the textbook identity a piano tuner uses to
 * hear when two strings are out of tune), a real, physically-present
 * phenomenon with a long, well-understood history entirely independent of
 * this module -- not the same thing as, and not a preserved trace of,
 * what separate per-ear delivery does. `.superpowers/sdd/psychoacoustic-report.md`
 * measures this directly: a mono sum of this module's output is numerically
 * indistinguishable from two plain, independent oscillators mixed at the
 * same two frequencies with no "binaural" module involved at all -- which
 * is the honest way to state what does and doesn't survive losing separate
 * delivery. See `modules/binaural.ts`'s doc comment for the fuller version
 * of this note.
 *
 * `carrier` and `beat` (the difference between the two channels' own
 * frequencies) are the control surface a player actually wants -- not two
 * raw frequencies they'd have to compute the difference of by hand:
 *
 *   left  = carrier - beat/2
 *   right = carrier + beat/2   =>   right - left = beat, exactly.
 *
 * Each channel is a bare sine -- direct `Math.sin`, no wavetable lookup --
 * because a sine has no harmonics to band-limit, and a wavetable's cubic-
 * interpolation error (on the order of 1e-6, see `wavetable.ts`'s own
 * measured figures) is exactly the kind of noise a sub-hertz beat
 * measurement can't afford to budget for when it doesn't have to. Phase is
 * accumulated in a plain, wrapped `[0, 1)` float64 counter -- the same
 * representation `wavetable.ts`'s `OscState` uses -- which is what makes
 * "precise down to a fraction of a hertz over minutes, not seconds" hold:
 * float64 has about 15-16 significant decimal digits, so a phase
 * accumulator wrapped every cycle (never allowed to grow unbounded) carries
 * no accumulated rounding drift worth measuring across any duration this
 * module would ever run. Measured directly in
 * `tests/node/dsp/binaural.test.ts`'s multi-minute drift suite, not merely
 * asserted from the arithmetic.
 */

export interface BinauralState {
  phaseLeft: number
  phaseRight: number
}

export function createBinauralState(): BinauralState {
  return { phaseLeft: 0, phaseRight: 0 }
}

export interface ChannelFreqs {
  left: number
  right: number
}

/** Derive each ear's frequency from a carrier and a beat. Negative
 *  frequencies are clamped to 0 (silence on that channel) rather than
 *  produced -- reachable only if a CV-driven beat overshoots past twice
 *  the carrier, an edge case worth being silent about rather than folding
 *  into an audible artifact. */
export function deriveChannelFreqs(carrierHz: number, beatHz: number): ChannelFreqs {
  const half = beatHz / 2
  return { left: Math.max(carrierHz - half, 0), right: Math.max(carrierHz + half, 0) }
}

function wrap01(t: number): number {
  const w = t % 1
  return w < 0 ? w + 1 : w
}

export interface StereoSample {
  left: number
  right: number
}

/** Advance both oscillators by one sample and return the stereo pair. */
export function binauralSample(
  state: BinauralState,
  carrierHz: number,
  beatHz: number,
  sampleRate: number,
): StereoSample {
  const { left: leftHz, right: rightHz } = deriveChannelFreqs(carrierHz, beatHz)
  state.phaseLeft = wrap01(state.phaseLeft + leftHz / sampleRate)
  state.phaseRight = wrap01(state.phaseRight + rightHz / sampleRate)
  return {
    left: Math.sin(2 * Math.PI * state.phaseLeft),
    right: Math.sin(2 * Math.PI * state.phaseRight),
  }
}
