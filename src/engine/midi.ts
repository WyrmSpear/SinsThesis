/** MIDI note 69 is A4, and the engine references pitch CV to A4 at 0.0. */
const A4_NOTE = 69

export function noteToPitchCv(midiNote: number): number {
  return (midiNote - A4_NOTE) / 12
}

export type MidiEvent =
  | { kind: 'noteOn'; note: number; velocity: number }
  | { kind: 'noteOff'; note: number }
  | { kind: 'cc'; controller: number; value: number }

/** Parse one MIDI message. Returns undefined for messages the engine ignores. */
export function parseMidiMessage(data: Uint8Array): MidiEvent | undefined {
  const status = data[0]
  if (status === undefined) return undefined
  const command = status & 0xf0
  const a = data[1] ?? 0
  const b = data[2] ?? 0

  if (command === 0x90) {
    // Running-status keyboards send note-on with zero velocity for note-off.
    return b === 0 ? { kind: 'noteOff', note: a } : { kind: 'noteOn', note: a, velocity: b / 127 }
  }
  if (command === 0x80) return { kind: 'noteOff', note: a }
  if (command === 0xb0) return { kind: 'cc', controller: a, value: b / 127 }
  return undefined
}

/**
 * Last-note priority, the behavior of a Mother-32 or an MS-20: the newest key
 * wins, and releasing it hands the voice back to whatever is still held.
 */
export class NoteStack {
  private readonly held: number[] = []

  press(note: number): void {
    this.release(note)
    this.held.push(note)
  }

  release(note: number): void {
    const index = this.held.lastIndexOf(note)
    if (index !== -1) this.held.splice(index, 1)
  }

  current(): number | undefined {
    return this.held[this.held.length - 1]
  }

  get size(): number {
    return this.held.length
  }
}

/** The ASDF row as a piano keyboard, so anyone can play without hardware. */
const KEY_MAP: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6,
  KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14,
}

/** `octave` 4 puts KeyA on middle C (MIDI 60). */
export function keyToNote(code: string, octave: number): number | undefined {
  const offset = KEY_MAP[code]
  return offset === undefined ? undefined : offset + (octave + 1) * 12
}

/**
 * Is `note` inside a Keyboard module's key-range zone? Both bounds
 * inclusive, so `low === high` is a legal one-note zone rather than an
 * always-false one. Kept as a pure, standalone predicate (rather than a
 * closure inside `keyboard-midi.ts`) specifically so the zone rule itself
 * -- boundaries inclusive, nothing fancier -- has a node-level unit test
 * independent of the Web Audio machinery the module instance needs.
 */
export function inKeyRange(note: number, low: number, high: number): boolean {
  return note >= low && note <= high
}

/**
 * Request Web MIDI access. Refusal is not an error: many browsers gate this
 * behind a permission prompt or lack the API entirely, and the computer
 * keyboard must keep working either way. Callers get `null` rather than a
 * rejected promise so "no MIDI" is an ordinary state, not a failure path.
 */
export async function requestMidiAccess(): Promise<MIDIAccess | null> {
  const nav = globalThis.navigator as (Navigator & { requestMIDIAccess?: typeof navigator.requestMIDIAccess }) | undefined
  if (!nav?.requestMIDIAccess) return null
  try {
    return await nav.requestMIDIAccess()
  } catch {
    return null
  }
}
