import type { ModuleDescriptor, ModuleInstance } from '../types'
import { NoteStack, noteToPitchCv, keyToNote, inKeyRange, type MidiEvent } from '../midi'

/**
 * The panel that gets sound out of the rack without a MIDI controller
 * attached: computer-keyboard keys drive it directly, and `handleMidiEvent`
 * lets the UI layer forward real MIDI once (if ever) the browser grants
 * access. Three independent `ConstantSourceNode`s carry pitch, gate, and
 * velocity — there is no worklet here, so each output port is its own node
 * rather than a shared multi-output front.
 *
 * **Key range.** `rangeLow`/`rangeHigh` (MIDI note numbers, inclusive on
 * both ends) restrict which notes this instance responds to at all —
 * computer key, on-screen/touch press, or real MIDI alike, all gated at the
 * same `inZone` check before anything reaches the shared `NoteStack`. This
 * is what makes a split keyboard possible: two Keyboard modules with
 * non-overlapping ranges (say 0-59 and 60-127) each drive their own chain
 * from the low and high halves of one physical or on-screen keyboard,
 * exactly like a hardware dual-manual interface. Default is the full
 * 0-127 range, so an existing single-Keyboard patch is unaffected.
 *
 * This is **not** polyphony — deliberately deferred to a later phase (see
 * docs/CONTINUATION.md). Each zone is its own independent monophonic voice
 * with its own last-note priority (`NoteStack`); a zone never sounds more
 * than one note at a time, it just claims a different slice of the
 * keyboard than its neighbor.
 *
 * **Overlapping zones.** If two Keyboard modules' ranges overlap, both
 * simply respond independently to a note in the overlap — there is no
 * cross-module arbitration (narrower-wins, first-added-wins, etc.), because
 * no module knows the others exist. This is also the natural, zero-plumbing
 * consequence of how input already reaches every Keyboard instance: each
 * module's own panel (`rack/keyboard-panel.ts`) attaches its own `window`
 * keydown listener, so a single physical keydown is already delivered to
 * every Keyboard module's panel today, overlapping ranges or not. "Both
 * respond" is simply that existing behavior, formalized and documented
 * rather than left as an accident of the panel wiring.
 */
export interface KeyboardMidiInstance extends ModuleInstance {
  handleMidiEvent(e: MidiEvent): void
  handleKey(code: string, down: boolean): void
  /** Press an absolute MIDI note under a caller-chosen id, sharing the same
   *  NoteStack and last-note priority as `handleKey`. The dev harness's
   *  on-screen piano and touch input use this instead of `handleKey`
   *  because they address notes directly rather than through a computer
   *  key code and the current octave. Silently ignored when `note` falls
   *  outside this instance's [rangeLow, rangeHigh] zone. */
  pressNote(id: string, note: number): void
  releaseNote(id: string): void
  /** The note currently sounding by last-note priority, across every input
   *  source -- undefined when nothing is held. */
  currentNote(): number | undefined
}

export const keyboardMidiDescriptor: ModuleDescriptor = {
  type: 'keyboard',
  name: 'Keyboard/MIDI',
  // 16 HP -- within the 10-16 Eurorack range this module's own knobs/jacks
  // would need, sized instead by the on-screen piano its `customPanel`
  // appends below them. The piano itself (`dev/piano.ts`) lays out every
  // key as a percentage of its own container's width, so it has no fixed
  // px floor of its own -- see `rack/style.css`'s `.keyboard-panel-content`
  // for the width:100% that replaced its old hard-coded 420px (the panel
  // it sits in is now hp-pinned and theme-independent, so a percentage of
  // it is exactly as geometry-stable as the fixed px used to be). The two
  // zone knobs (below) join the existing octave/glide row rather than
  // opening a new one -- a fourth 64px-ish column at this hp comfortably
  // fits a 38px dial, and adding a whole row would eat into the panel's
  // fixed 392px/3U budget, which the piano's own hint text already uses
  // most of (rack/panel.ts's PANEL_HEIGHT_PX comment).
  hp: 16,
  group: 'control',
  customPanel: 'keyboard',
  ports: [
    { id: 'pitch', dir: 'out', signal: 'cv', label: 'Pitch', pos: [0, 3] },
    { id: 'gate', dir: 'out', signal: 'gate', label: 'Gate', pos: [1, 3] },
    { id: 'velocity', dir: 'out', signal: 'cv', label: 'Velocity', pos: [0, 4] },
  ],
  params: [
    { id: 'octave', label: 'Octave', min: 0, max: 8, default: 4, curve: 'lin', unit: '' },
    { id: 'glide', label: 'Glide', min: 0, max: 1, default: 0, curve: 'exp', unit: 's' },
    // Note numbers, not Hz or an octave/semitone pair -- precise and what
    // `keyToNote`/MIDI already speak. `unit: 'note'` is a display-only
    // marker `rack/curve.ts`'s `formatValue` special-cases to read "C2"
    // rather than "36" (src/engine/analysis/note.ts, per this task's
    // brief) -- the engine and the saved patch value are still plain MIDI
    // note integers throughout; only the knob readout is musical.
    { id: 'rangeLow', label: 'Lo', min: 0, max: 127, default: 0, curve: 'lin', unit: 'note' },
    { id: 'rangeHigh', label: 'Hi', min: 0, max: 127, default: 127, curve: 'lin', unit: 'note' },
  ],
  layout: [
    { kind: 'knob', ref: 'octave', x: 0, y: 0 },
    { kind: 'knob', ref: 'glide', x: 1, y: 0 },
    { kind: 'knob', ref: 'rangeLow', x: 2, y: 0 },
    { kind: 'knob', ref: 'rangeHigh', x: 3, y: 0 },
    { kind: 'jack', ref: 'pitch', x: 0, y: 3 },
    { kind: 'jack', ref: 'gate', x: 1, y: 3 },
    { kind: 'jack', ref: 'velocity', x: 0, y: 4 },
  ],
  create(ctx): KeyboardMidiInstance {
    const pitch = new ConstantSourceNode(ctx, { offset: 0 })
    const gate = new ConstantSourceNode(ctx, { offset: 0 })
    const velocity = new ConstantSourceNode(ctx, { offset: 0 })
    pitch.start()
    gate.start()
    velocity.start()

    const settings = { octave: 4, glide: 0, rangeLow: 0, rangeHigh: 127 }
    const notes = new NoteStack()
    // Every input path -- computer-keyboard keys, whatever calls
    // `pressNote`/`releaseNote` (the on-screen piano), and real MIDI
    // (`handleMidiEvent`) -- presses into this same map, keyed by an id
    // namespaced per source (`key:<code>` vs `ext:<id>` vs `midi:<note>`)
    // so none of the three can collide with each other. That is what keeps
    // last-note priority shared across mouse, keyboard and MIDI: all three
    // funnel through the one `notes` NoteStack via `noteOn`/`noteOff`
    // below, never a second parallel path. (A genuinely shared edge case
    // survives this: two *different* sources pressing the exact same note
    // number still share one entry in `notes`, so releasing it from either
    // source silences it even if the other source's key is still
    // physically down. That was already true of key-vs-mouse before this
    // task and is not attempted here -- it would need per-source reference
    // counting inside `NoteStack` itself, a bigger change than this task's
    // scope.)
    const noteIdMap = new Map<string, number>()

    function inZone(note: number): boolean {
      return inKeyRange(note, settings.rangeLow, settings.rangeHigh)
    }

    function clampNote(v: number): number {
      return Math.min(127, Math.max(0, Math.round(v)))
    }

    function trigger(id: string, note: number, vel = 1): void {
      if (noteIdMap.has(id)) return // repeat guard: id already sounding
      noteIdMap.set(id, note)
      noteOn(note, vel)
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

    // Routed through the same trigger/untrigger id-map every other input
    // source uses (namespaced `midi:<note>`), not a direct noteOn/noteOff
    // call the way this used to bypass it entirely. Two things that fixes:
    // a repeated note-on with no note-off between (a real running-status
    // controller quirk) now dedupes the same way a held computer key does,
    // instead of re-triggering; and MIDI-held notes are now visible in
    // `noteIdMap` the same way keyboard/mouse-held ones are, for any future
    // caller that wants to know what's down and from where. Velocity still
    // reaches `noteOn` -- `trigger`'s new third argument -- so this is not
    // a loss of fidelity, just a shared path.
    function handleMidiEvent(e: MidiEvent): void {
      if (e.kind === 'noteOn') {
        if (!inZone(e.note)) return
        trigger(`midi:${e.note}`, e.note, e.velocity)
      } else if (e.kind === 'noteOff') {
        untrigger(`midi:${e.note}`)
      }
      // CC messages are never this module's concern: `rack/main.ts` routes
      // them straight to `src/engine/midi-learn.ts`'s `MidiLearnController`
      // instead of forwarding them here, since a CC binds to *any* param on
      // *any* module, not specifically to a Keyboard instance's own knobs.
    }

    function handleKey(code: string, down: boolean): void {
      const id = `key:${code}`
      if (down) {
        const note = keyToNote(code, settings.octave)
        if (note === undefined || !inZone(note)) return
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
      if (!inZone(note)) return
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
        else if (id === 'rangeLow') settings.rangeLow = clampNote(value)
        else if (id === 'rangeHigh') settings.rangeHigh = clampNote(value)
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
