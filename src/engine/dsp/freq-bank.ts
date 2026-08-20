/**
 * The Frequency Bank: sixteen fixed, named tones rather than a continuous
 * knob. `ParamSpec.labels` is the established way to express a discrete
 * choice (first added for lfo.ts's `shape`, since extended to `division`
 * and to this module) and renders as a switch, so the panel-facing
 * contract is nothing new -- what this file owns is making sure every
 * position is *exactly* what it claims to be, which is the entire value of
 * a module like this: a knob that reads "528" is worthless if it actually
 * produces 527.94.
 *
 * This module makes no claim about what any of these frequencies do --
 * only what they are, and where the numbers themselves come from:
 *
 * - **Solfeggio (nine tones).** A set of frequencies commonly cited in
 *   sound-work practice and offered here as exactly that -- a named,
 *   recognizable set some players will be looking for -- with no claim
 *   about any effect. The set's own numbers have no accepted acoustic or
 *   historical derivation beyond an arithmetic pattern in how they are
 *   usually listed; this module reproduces the set as commonly cited, not
 *   as a scientific standard.
 * - **Schumann resonance and its first four harmonics.** A real, measured
 *   geophysical phenomenon: standing electromagnetic waves in the cavity
 *   between the Earth's surface and the ionosphere, with a fundamental
 *   near 7.83 Hz (first predicted by W. O. Schumann, 1952; commonly cited
 *   harmonic values used here: ~14.3, ~20.8, ~27.3, ~33.8 Hz). These are
 *   electromagnetic resonances, not sound, and this module reproduces
 *   their frequencies as audio-rate tones for reference -- note that the
 *   lowest of them sit below or at the edge of typical human hearing
 *   (commonly cited around 20 Hz), so several of these entries will read
 *   more as a felt low-frequency pulse or a meter reading than a clearly
 *   pitched tone on typical playback equipment, which is a statement about
 *   audibility, not about any other property.
 * - **A432 / A440.** Two standard concert pitches for the note A above
 *   middle C. 440 Hz is the current widely-adopted reference (ISO 16); 432
 *   Hz is an alternate tuning some historical and contemporary instruments
 *   use. Offered side by side for direct comparison.
 */

export interface FreqBankEntry {
  /** Switch label. Length of FREQ_BANK must equal `labels.length`, and
   *  `registerModule`'s own validation enforces `labels.length === max -
   *  min + 1` on the param that reads this array (see modules/freq-bank.ts). */
  label: string
  hz: number
}

export const FREQ_BANK: readonly FreqBankEntry[] = [
  // Solfeggio
  { label: '174', hz: 174 },
  { label: '285', hz: 285 },
  { label: '396', hz: 396 },
  { label: '417', hz: 417 },
  { label: '528', hz: 528 },
  { label: '639', hz: 639 },
  { label: '741', hz: 741 },
  { label: '852', hz: 852 },
  { label: '963', hz: 963 },
  // Schumann resonance fundamental + first four harmonics
  { label: '7.83', hz: 7.83 },
  { label: '14.3', hz: 14.3 },
  { label: '20.8', hz: 20.8 },
  { label: '27.3', hz: 27.3 },
  { label: '33.8', hz: 33.8 },
  // Reference pitches, A above middle C
  { label: 'A432', hz: 432 },
  { label: 'A440', hz: 440 },
]

/** The exact frequency for a bank index, optionally shifted by a whole
 *  number of octaves. Multiplying by a power of two is exact in float64
 *  for every value this bank holds (each `hz` has at most 3 significant
 *  decimal digits and the panel's octave range is only -2..2), so shifting
 *  octaves never erodes the "exactly what it claims" guarantee -- 528 * 4
 *  is still exactly 2112, not an approximation of it. `index` is rounded
 *  and clamped rather than validated/thrown, matching this codebase's
 *  established worklet-parameter convention (e.g. wavetable.ts's
 *  `mipLevelForFreq`) of never letting an out-of-range control value reach
 *  an array access that could crash the audio thread. */
export function freqBankHz(index: number, octave = 0): number {
  const clampedIndex = Math.max(0, Math.min(FREQ_BANK.length - 1, Math.round(index)))
  return FREQ_BANK[clampedIndex]!.hz * 2 ** Math.round(octave)
}
