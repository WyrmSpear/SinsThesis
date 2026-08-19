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
  /** Press an absolute MIDI note under a caller-chosen id, sharing the same
   *  NoteStack and last-note priority as `handleKey`. The dev harness's
   *  on-screen piano and touch input use this instead of `handleKey`
   *  because they address notes directly rather than through a computer
   *  key code and the current octave. */
  pressNote(id: string, note: number): void
  releaseNote(id: string): void
  /** The note currently sounding by last-note priority, across every input
   *  source -- undefined when nothing is held. */
  currentNote(): number | undefined
}

export const keyboardMidiDescriptor: ModuleDescriptor = {
  type: 'keyboard',
  name: 'Keyboard/MIDI',
  hp: 10,
  group: 'control',
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
    // Every input path -- computer-keyboard keys and whatever calls
    // `pressNote`/`releaseNote` (the on-screen piano) -- presses into this
    // same map, keyed by an id namespaced per source (`key:<code>` vs
    // `ext:<id>`) so the two can't collide. That is what keeps last-note
    // priority shared across mouse and keyboard: both funnel through the
    // one `notes` NoteStack via `noteOn`/`noteOff` below, never a second
    // parallel path.
    const noteIdMap = new Map<string, number>()

    function trigger(id: string, note: number): void {
      if (noteIdMap.has(id)) return // repeat guard: id already sounding
      noteIdMap.set(id, note)
      noteOn(note, 1)
    }

    function untrigger(id: string): void {
      const note = noteIdMap.get(id)
      if (note === undefined) return
      noteIdMap.delete(id)
      noteOff(note)
    }

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
      const id = `key:${code}`
      if (down) {
        const note = keyToNote(code, settings.octave)
        if (note === undefined) return
        trigger(id, note)
      } else {
        untrigger(id)
      }
    }

    // The on-screen piano's entry point: an id the caller controls (so a
    // mouse drag across keys and a multi-touch chord each get their own
    // id) and an absolute MIDI note, bypassing `keyToNote`'s octave
    // lookup entirely. Namespaced `ext:` so it can never collide with a
    // computer-keyboard id above, but it presses into the very same
    // `noteIdMap` / `notes` NoteStack.
    function pressNote(id: string, note: number): void {
      trigger(`ext:${id}`, note)
    }

    function releaseNote(id: string): void {
      untrigger(`ext:${id}`)
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
      pressNote,
      releaseNote,
      currentNote: () => notes.current(),
    }
  },
}
