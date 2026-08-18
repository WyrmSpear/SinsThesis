import { describe, it, expect } from 'vitest'
import { noteToPitchCv, parseMidiMessage, NoteStack, keyToNote } from '../../src/engine/midi'

describe('noteToPitchCv', () => {
  it('places A4 at zero', () => {
    expect(noteToPitchCv(69)).toBeCloseTo(0, 6)
  })

  it('places one octave up at 1.0', () => {
    expect(noteToPitchCv(81)).toBeCloseTo(1, 6)
  })

  it('places one octave down at -1.0', () => {
    expect(noteToPitchCv(57)).toBeCloseTo(-1, 6)
  })
})

describe('parseMidiMessage', () => {
  it('reads a note-on', () => {
    expect(parseMidiMessage(new Uint8Array([0x90, 60, 100])))
      .toEqual({ kind: 'noteOn', note: 60, velocity: 100 / 127 })
  })

  it('reads a note-on with zero velocity as a note-off', () => {
    expect(parseMidiMessage(new Uint8Array([0x90, 60, 0])))
      .toEqual({ kind: 'noteOff', note: 60 })
  })

  it('reads a note-off', () => {
    expect(parseMidiMessage(new Uint8Array([0x80, 60, 64])))
      .toEqual({ kind: 'noteOff', note: 60 })
  })

  it('reads a control change', () => {
    expect(parseMidiMessage(new Uint8Array([0xb0, 74, 127])))
      .toEqual({ kind: 'cc', controller: 74, value: 1 })
  })

  it('ignores messages it does not handle', () => {
    expect(parseMidiMessage(new Uint8Array([0xf8]))).toBeUndefined()
  })
})

describe('NoteStack', () => {
  it('reports nothing when empty', () => {
    expect(new NoteStack().current()).toBeUndefined()
  })

  it('gives the most recent note priority', () => {
    const stack = new NoteStack()
    stack.press(60)
    stack.press(64)
    expect(stack.current()).toBe(64)
  })

  it('falls back to the held note when the newest releases', () => {
    const stack = new NoteStack()
    stack.press(60)
    stack.press(64)
    stack.release(64)
    expect(stack.current()).toBe(60)
  })

  it('ignores a release for a note that is not held', () => {
    const stack = new NoteStack()
    stack.press(60)
    stack.release(99)
    expect(stack.current()).toBe(60)
  })
})

describe('keyToNote', () => {
  it('maps the A key to C in the given octave', () => {
    expect(keyToNote('KeyA', 4)).toBe(60)
  })

  it('returns undefined for an unmapped key', () => {
    expect(keyToNote('Escape', 4)).toBeUndefined()
  })
})
