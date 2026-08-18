import type { ModuleDescriptor, ModuleInstance } from '../types'
import { NoteStack, noteToPitchCv, keyToNote, type MidiEvent } from '../midi'

/**
 * The panel that gets sound out of the rack without a MIDI controller
 * attached: computer-keyboard keys drive it directly, and `handleMidiEvent`
 * lets the UI layer forward real MIDI once (if ever) the browser grants
 * access. Three independent `ConstantSourceNode`s carry pitch, gate, and
 * velocity — there is no worklet here, so each output port is its own node
 * rather than a shared multi-output front.
 */
export interface KeyboardMidiInstance extends ModuleInstance {
  handleMidiEvent(e: MidiEvent): void
  handleKey(code: string, down: boolean): void
}

export const keyboardMidiDescriptor: ModuleDescriptor = {
  type: 'keyboard',
  name: 'Keyboard/MIDI',
  hp: 10,
  customPanel: 'keyboard',
  ports: [
    { id: 'pitch', dir: 'out', signal: 'cv', label: 'Pitch', pos: [0, 3] },
    { id: 'gate', dir: 'out', signal: 'gate', label: 'Gate', pos: [1, 3] },
    { id: 'velocity', dir: 'out', signal: 'cv', label: 'Velocity', pos: [2, 3] },
  ],
  params: [
    { id: 'octave', label: 'Octave', min: 0, max: 8, default: 4, curve: 'lin', unit: '' },
    { id: 'glide', label: 'Glide', min: 0, max: 1, default: 0, curve: 'exp', unit: 's' },
  ],
  layout: [
    { kind: 'knob', ref: 'octave', x: 0, y: 0 },
    { kind: 'knob', ref: 'glide', x: 1, y: 0 },
    { kind: 'jack', ref: 'pitch', x: 0, y: 3 },
    { kind: 'jack', ref: 'gate', x: 1, y: 3 },
    { kind: 'jack', ref: 'velocity', x: 2, y: 3 },
  ],
  create(ctx): KeyboardMidiInstance {
    const pitch = new ConstantSourceNode(ctx, { offset: 0 })
    const gate = new ConstantSourceNode(ctx, { offset: 0 })
    const velocity = new ConstantSourceNode(ctx, { offset: 0 })
    pitch.start()
    gate.start()
    velocity.start()

    const settings = { octave: 4, glide: 0 }
    const notes = new NoteStack()
    // Computer-keyboard keys press MIDI-shaped note numbers into the same
    // stack, so last-note priority is shared between both input paths.
    const keyToNoteNumbers = new Map<string, number>()

    function setPitch(note: number): void {
      const now = ctx.currentTime
      if (settings.glide > 0) {
        pitch.offset.setTargetAtTime(noteToPitchCv(note), now, settings.glide)
      } else {
        pitch.offset.setValueAtTime(noteToPitchCv(note), now)
      }
    }

    function noteOn(note: number, vel: number): void {
      notes.press(note)
      setPitch(note)
      gate.offset.setValueAtTime(1, ctx.currentTime)
      velocity.offset.setValueAtTime(vel, ctx.currentTime)
    }

    function noteOff(note: number): void {
      notes.release(note)
      const current = notes.current()
      if (current === undefined) {
        gate.offset.setValueAtTime(0, ctx.currentTime)
      } else {
        setPitch(current)
      }
    }

    function handleMidiEvent(e: MidiEvent): void {
      if (e.kind === 'noteOn') noteOn(e.note, e.velocity)
      else if (e.kind === 'noteOff') noteOff(e.note)
      // CC messages are not yet routed to a destination; ignored for now.
    }

    function handleKey(code: string, down: boolean): void {
      if (down) {
        if (keyToNoteNumbers.has(code)) return // key-repeat guard
        const note = keyToNote(code, settings.octave)
        if (note === undefined) return
        keyToNoteNumbers.set(code, note)
        noteOn(note, 1)
      } else {
        const note = keyToNoteNumbers.get(code)
        if (note === undefined) return
        keyToNoteNumbers.delete(code)
        noteOff(note)
      }
    }

    return {
      inputs: new Map(),
      outputs: new Map<string, AudioNode>([
        ['pitch', pitch],
        ['gate', gate],
        ['velocity', velocity],
      ]),
      setParam(id, value) {
        if (id === 'octave') settings.octave = value
        else if (id === 'glide') settings.glide = value
      },
      dispose() {
        pitch.stop()
        gate.stop()
        velocity.stop()
        pitch.disconnect()
        gate.disconnect()
        velocity.disconnect()
      },
      handleMidiEvent,
      handleKey,
    }
  },
}
