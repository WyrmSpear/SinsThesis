import { describe, it, expect, afterEach } from 'vitest'
import { noteToPitchCv, parseMidiMessage, NoteStack, keyToNote, inKeyRange, requestMidiAccess } from '../../src/engine/midi'

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

describe('inKeyRange (Keyboard module zone gate)', () => {
  it('accepts a note inside the range', () => {
    expect(inKeyRange(60, 48, 72)).toBe(true)
  })

  it('rejects a note below the range', () => {
    expect(inKeyRange(47, 48, 72)).toBe(false)
  })

  it('rejects a note above the range', () => {
    expect(inKeyRange(73, 48, 72)).toBe(false)
  })

  it('is inclusive of the low boundary', () => {
    expect(inKeyRange(48, 48, 72)).toBe(true)
  })

  it('is inclusive of the high boundary', () => {
    expect(inKeyRange(72, 48, 72)).toBe(true)
  })

  it('accepts every note across the full default 0-127 range', () => {
    expect(inKeyRange(0, 0, 127)).toBe(true)
    expect(inKeyRange(127, 0, 127)).toBe(true)
    expect(inKeyRange(64, 0, 127)).toBe(true)
  })

  it('allows a one-note zone when low equals high', () => {
    expect(inKeyRange(60, 60, 60)).toBe(true)
    expect(inKeyRange(59, 60, 60)).toBe(false)
    expect(inKeyRange(61, 60, 60)).toBe(false)
  })

  it('rejects every note when the range is inverted (low > high) -- an empty, not a crashing, zone', () => {
    expect(inKeyRange(60, 72, 48)).toBe(false)
  })

  // The split-keyboard scenario itself: two non-overlapping zones, boundary
  // notes go to exactly one side, and a note in the gap (there is none here
  // since they're adjacent) or genuinely outside both is silent everywhere.
  it('supports two adjacent non-overlapping zones with no gap and no double-trigger', () => {
    const lowZone = { low: 0, high: 59 } // sub bass
    const highZone = { low: 60, high: 127 } // lead
    // The seam: 59 is the top of the low zone, 60 is the bottom of the high one.
    expect(inKeyRange(59, lowZone.low, lowZone.high)).toBe(true)
    expect(inKeyRange(59, highZone.low, highZone.high)).toBe(false)
    expect(inKeyRange(60, lowZone.low, lowZone.high)).toBe(false)
    expect(inKeyRange(60, highZone.low, highZone.high)).toBe(true)
  })

  // Overlap policy (documented on keyboard-midi.ts): both zones respond
  // independently to a note in the overlap -- this module makes no
  // decision between them, it only answers "is this note in my own
  // range," so an overlapping note is simply `true` for both calls.
  it('both zones independently accept a note in an overlap -- no arbitration here', () => {
    const zoneA = { low: 0, high: 72 }
    const zoneB = { low: 60, high: 127 }
    expect(inKeyRange(65, zoneA.low, zoneA.high)).toBe(true)
    expect(inKeyRange(65, zoneB.low, zoneB.high)).toBe(true)
  })
})

describe('requestMidiAccess', () => {
  // No test here ever stubs `globalThis.navigator` itself out of existence
  // -- Node 22 already defines one with no `requestMIDIAccess`, which is
  // itself the real "browser lacks the API entirely" case this function's
  // own doc comment names as an ordinary state, not a failure. Restoring
  // it (rather than deleting the property) keeps that ambient case honest
  // for every other test file in this run.
  const original = (globalThis.navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess

  afterEach(() => {
    ;(globalThis.navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess = original
  })

  it('resolves to null when the browser has no requestMIDIAccess at all', async () => {
    delete (globalThis.navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess
    await expect(requestMidiAccess()).resolves.toBeNull()
  })

  it('resolves to null when the browser rejects (permission refused)', async () => {
    ;(globalThis.navigator as unknown as { requestMIDIAccess: () => Promise<never> }).requestMIDIAccess = () =>
      Promise.reject(new Error('permission denied'))
    await expect(requestMidiAccess()).resolves.toBeNull()
  })

  it('resolves with the access object when the browser grants it', async () => {
    const fakeAccess = { inputs: new Map(), outputs: new Map() }
    ;(globalThis.navigator as unknown as { requestMIDIAccess: () => Promise<unknown> }).requestMIDIAccess = () =>
      Promise.resolve(fakeAccess)
    await expect(requestMidiAccess()).resolves.toBe(fakeAccess)
  })
})
