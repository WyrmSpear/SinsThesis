import type { PatchGraph } from '../src/engine/graph'
import type { KeyboardMidiInstance } from '../src/engine/modules/keyboard-midi'
import { keyToNote } from '../src/engine/midi'
import { buildPiano } from '../dev/piano'

/**
 * The keyboard/MIDI module's bespoke panel content -- the escape hatch
 * `descriptor.customPanel: 'keyboard'` names. `buildPanel` still draws its
 * octave/glide knobs and pitch/gate/velocity jacks from the descriptor the
 * ordinary way; this only supplies the part no descriptor field can
 * express: an actual playable keyboard. `dev/piano.ts` is reused verbatim
 * -- it was already pure UI with no engine coupling, so it needed no
 * changes to work here.
 */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function noteName(note: number): string {
  const name = NOTE_NAMES[((note % 12) + 12) % 12]
  const octave = Math.floor(note / 12) - 1
  return `${name}${octave}`
}

function noteFreq(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12)
}

export function buildKeyboardPanel(moduleId: string, graph: PatchGraph): HTMLElement {
  const maybeInstance = graph.getInstance(moduleId) as KeyboardMidiInstance | undefined
  const wrap = document.createElement('div')
  wrap.className = 'keyboard-panel-content'
  if (!maybeInstance) return wrap // ghost module: no engine instance to wire up
  const instance: KeyboardMidiInstance = maybeInstance

  const noteReadout = document.createElement('div')
  noteReadout.className = 'kb-note-readout'
  noteReadout.dataset['testid'] = 'note-readout'
  noteReadout.textContent = '—'

  const pianoStart = 60 // C4
  const pianoEnd = 84 // C6
  const heldKeyNotes = new Map<string, number>() // computer-key code -> note
  const activePointers = new Map<number, number>() // pointerId -> note

  function currentOctave(): number {
    return graph.getParams(moduleId)['octave'] ?? 4
  }

  function isHeld(note: number): boolean {
    for (const n of heldKeyNotes.values()) if (n === note) return true
    for (const n of activePointers.values()) if (n === note) return true
    return false
  }

  function refresh(): void {
    const note = instance.currentNote()
    noteReadout.textContent = note === undefined ? '—' : `${noteName(note)}  ${noteFreq(note).toFixed(2)} Hz`
    for (let n = pianoStart; n <= pianoEnd; n++) piano.setHeld(n, isHeld(n))
  }

  const piano = buildPiano({
    startNote: pianoStart,
    endNote: pianoEnd,
    onPress(pointerId, note) {
      instance.pressNote(`mouse:${pointerId}`, note)
      activePointers.set(pointerId, note)
      refresh()
    },
    onMove(pointerId, note) {
      const prev = activePointers.get(pointerId)
      if (prev === undefined || prev === note) return
      instance.releaseNote(`mouse:${pointerId}`)
      instance.pressNote(`mouse:${pointerId}`, note)
      activePointers.set(pointerId, note)
      refresh()
    },
    onRelease(pointerId) {
      if (!activePointers.has(pointerId)) return
      activePointers.delete(pointerId)
      instance.releaseNote(`mouse:${pointerId}`)
      refresh()
    },
    // The rack does not track which computer key plays which note per the
    // *live* octave param the way the dev harness's main.ts does (that
    // wiring lives in one page-level module there); this panel keeps the
    // piano purely mouse/touch-labeled rather than duplicating it.
    labelFor: () => undefined,
  })

  // Computer keyboard: same handleKey path as the dev harness, reading the
  // octave knob's current value fresh on every keypress -- the graph is
  // the source of truth, so there is nothing to keep in sync separately.
  function onKeyDown(e: KeyboardEvent): void {
    if (e.repeat) return
    const note = keyToNote(e.code, currentOctave())
    if (note === undefined) return
    instance.handleKey(e.code, true)
    heldKeyNotes.set(e.code, note)
    refresh()
  }
  function onKeyUp(e: KeyboardEvent): void {
    if (!heldKeyNotes.has(e.code)) return
    heldKeyNotes.delete(e.code)
    instance.handleKey(e.code, false)
    refresh()
  }
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)

  const hint = document.createElement('p')
  hint.className = 'kb-hint'
  hint.textContent = 'A W S E D F T G Y H U J K O L plays; drag the octave knob to shift range.'

  wrap.append(hint, noteReadout, piano.el)
  return wrap
}
