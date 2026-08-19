import { describe, it, expect } from 'vitest'
import { hzToMidi, midiToHz, hzToNoteName, formatNoteName } from '../../../src/engine/analysis/note'
import { noteToPitchCv } from '../../../src/engine/midi'

describe('hzToNoteName', () => {
  it('reads A4 exactly at 440 Hz with zero cents', () => {
    const n = hzToNoteName(440)
    expect(n.letter).toBe('A')
    expect(n.octave).toBe(4)
    expect(n.midiNote).toBe(69)
    expect(n.cents).toBeCloseTo(0, 5)
  })

  it('reads middle C (MIDI 60) at ~261.63 Hz', () => {
    const n = hzToNoteName(261.6256)
    expect(n.letter).toBe('C')
    expect(n.octave).toBe(4)
    expect(n.midiNote).toBe(60)
  })

  it('crosses the octave boundary from B to C', () => {
    // B3 (MIDI 59) sits just below C4 (MIDI 60).
    const b3 = hzToNoteName(midiToHz(59))
    expect(b3.letter).toBe('B')
    expect(b3.octave).toBe(3)
    const c4 = hzToNoteName(midiToHz(60))
    expect(c4.letter).toBe('C')
    expect(c4.octave).toBe(4)
  })

  it('reports a sharp note as positive cents', () => {
    // 18 cents sharp of A4.
    const hz = 440 * 2 ** (18 / 1200)
    const n = hzToNoteName(hz)
    expect(n.letter).toBe('A')
    expect(n.octave).toBe(4)
    expect(n.cents).toBeCloseTo(18, 1)
  })

  it('reports a flat note as negative cents', () => {
    const hz = 440 * 2 ** (-25 / 1200)
    const n = hzToNoteName(hz)
    expect(n.letter).toBe('A')
    expect(n.cents).toBeCloseTo(-25, 1)
  })

  it('snaps a frequency just below the A/A# boundary to A, sharp', () => {
    // Halfway between A4 and A#4 minus a hair: rounds down to A4, reading
    // just under +50 cents rather than crossing over to A#4 at a large
    // negative offset.
    const hz = midiToHz(69.49)
    const n = hzToNoteName(hz)
    expect(n.letter).toBe('A')
    expect(n.cents).toBeCloseTo(49, 0)
  })

  it('snaps a frequency just above the A/A# boundary to A#, flat', () => {
    const hz = midiToHz(69.51)
    const n = hzToNoteName(hz)
    expect(n.letter).toBe('A#')
    expect(n.cents).toBeCloseTo(-49, 0)
  })

  it('throws for a non-positive frequency', () => {
    expect(() => hzToNoteName(0)).toThrow()
    expect(() => hzToNoteName(-100)).toThrow()
  })
})

describe('formatNoteName', () => {
  it('omits the cents suffix when exactly in tune', () => {
    expect(formatNoteName(hzToNoteName(440))).toBe('A4')
  })

  it('shows a sharp reading with a plus sign', () => {
    const hz = 440 * 2 ** (18 / 1200)
    expect(formatNoteName(hzToNoteName(hz))).toBe('A4 +18¢')
  })

  it('shows a flat reading with a minus sign', () => {
    const hz = 440 * 2 ** (-2 / 1200)
    expect(formatNoteName(hzToNoteName(hz))).toBe('A4 −2¢')
  })
})

describe('agreement with noteToPitchCv (src/engine/midi.ts)', () => {
  it('names every MIDI note 21..108 (piano range) consistently with the engine pitch-CV convention', () => {
    for (let midi = 21; midi <= 108; midi++) {
      const cv = noteToPitchCv(midi)
      // The engine's own convention: pitch CV of `cv` octaves above A4.
      const hz = 440 * 2 ** cv
      const n = hzToNoteName(hz)
      expect(n.midiNote).toBe(midi)
      expect(n.cents).toBeCloseTo(0, 5)
      // hzToMidi/midiToHz round-trip agrees too.
      expect(hzToMidi(midiToHz(midi))).toBeCloseTo(midi, 6)
    }
  })
})
