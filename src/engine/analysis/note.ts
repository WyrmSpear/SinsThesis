/**
 * Musical reading of a frequency -- note letter, octave number, and cents
 * deviation from equal temperament. Pure, no UI import, so the academy's
 * graders (and any future feature that wants "how far off is this note")
 * can call it directly, the same way `features.ts`/`compare.ts` already do
 * for loudness and spectral shape.
 *
 * A4 = 440 Hz, 12-tone equal temperament, MIDI note 69 = A4 -- the same
 * convention `noteToPitchCv` in `src/engine/midi.ts` already assumes (its
 * own comment: "MIDI note 69 is A4, and the engine references pitch CV to
 * A4 at 0.0"). This module does not import midi.ts (nor the reverse -- it
 * has no reason to depend on MIDI event parsing), but
 * `tests/node/analysis/note.test.ts` cross-checks the two directly: for
 * every MIDI note `m`, `midiToHz(m)` fed back through `hzToNoteName` must
 * report `midiNote === m`, and `noteToPitchCv(m)` (converted back to Hz via
 * `A4_HZ * 2 ** cv`, since a pitch CV of 1 is defined as one octave) must
 * agree too. If either drifts, a player's on-screen note name would
 * silently disagree with the pitch the engine actually plays for the same
 * value -- the "cross-check them in a test" the task asked for.
 */

const A4_HZ = 440
const A4_MIDI = 69 // matches midi.ts's A4_NOTE

const NOTE_LETTERS = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
] as const

export interface NoteName {
  /** "C", "C#", ... "B" -- sharps only, never flats (matches the engine's
   *  own MIDI-note convention; nothing here needs enharmonic spelling). */
  letter: string
  /** Scientific pitch notation: MIDI 60 ("middle C") is C4, MIDI 69 is A4. */
  octave: number
  /** Deviation from the nearest equal-tempered semitone, in cents,
   *  range (-50, 50]. Positive means sharp of that note, negative flat. */
  cents: number
  /** The nearest MIDI note number (rounded; `hz` need not land exactly on
   *  one -- that's what `cents` reports). */
  midiNote: number
}

/** Fractional MIDI note number for `hz` -- not rounded, so callers that
 *  want raw pitch height (a pitch-track's y-axis, for instance) don't have
 *  to reconstruct it from `hzToNoteName`'s rounded `midiNote` + `cents`. */
export function hzToMidi(hz: number): number {
  return A4_MIDI + 12 * Math.log2(hz / A4_HZ)
}

export function midiToHz(midiNote: number): number {
  return A4_HZ * 2 ** ((midiNote - A4_MIDI) / 12)
}

/**
 * Converts a frequency to how a musician names it. Throws on a non-positive
 * frequency -- there is no note name for that, and a silent caller getting
 * back `NaN` letters is worse than an explicit error (the same reasoning
 * `aliasFloorDb` uses for its own "no energy at the fundamental" throw).
 */
export function hzToNoteName(hz: number): NoteName {
  if (!(hz > 0)) throw new Error(`hzToNoteName: frequency must be positive, got ${hz}`)
  const midiFloat = hzToMidi(hz)
  const midiNote = Math.round(midiFloat)
  const cents = (midiFloat - midiNote) * 100
  const letter = NOTE_LETTERS[((midiNote % 12) + 12) % 12]!
  const octave = Math.floor(midiNote / 12) - 1
  return { letter, octave, cents, midiNote }
}

/** "E4", "A4 +18¢", "A4 −2¢" -- the readout format the task asks for
 *  ("329.6 Hz · E4 −2¢"). Omits the cents suffix only when they round to
 *  exactly zero, so a genuinely in-tune note reads clean. Uses a real minus
 *  sign (U+2212), not a hyphen, matching the task's own example text. */
export function formatNoteName(note: NoteName): string {
  const rounded = Math.round(note.cents)
  if (rounded === 0) return `${note.letter}${note.octave}`
  const sign = rounded > 0 ? '+' : '−'
  return `${note.letter}${note.octave} ${sign}${Math.abs(rounded)}¢`
}
