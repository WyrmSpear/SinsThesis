import type { PatchGraph } from '../src/engine/graph'
import type { KeyboardMidiInstance } from '../src/engine/modules/keyboard-midi'
import { keyToNote } from '../src/engine/midi'
import { buildPiano } from '../dev/piano'

/**
 * The keyboard/MIDI module's bespoke panel content -- the escape hatch
 * `descriptor.customPanel: 'keyboard'` names. `buildPanel` still draws its
 * octave/glide/range knobs and pitch/gate/velocity jacks from the
 * descriptor the ordinary way; this only supplies the part no descriptor
 * field can express: an actual playable keyboard, its zone shading, and
 * the computer-keyboard shortcuts (octave, hold/sustain). `dev/piano.ts`
 * is reused verbatim for the piano widget itself -- it was already pure UI
 * with no engine coupling -- but this panel does not reuse `dev/main.ts`'s
 * own keydown wiring, which is page-level and owns the whole harness's
 * input, not one module's.
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

/** True while `target` is a place the browser expects ordinary typing --
 *  the patch-name field being the concrete case in this rack today, but
 *  written against the general shape (any input/textarea/select/
 *  contenteditable) rather than that one element id, so a future text
 *  field never has to remember to re-add this guard itself. Without it,
 *  every keystroke typing a patch name also played the ASDF row as notes
 *  -- discovered while wiring the Space-bar hold shortcut below, which
 *  would otherwise have swallowed spaces typed into patch names too. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function buildKeyboardPanel(moduleId: string, graph: PatchGraph): HTMLElement {
  const maybeInstance = graph.getInstance(moduleId) as KeyboardMidiInstance | undefined
  const wrap = document.createElement('div')
  wrap.className = 'keyboard-panel-content'
  if (!maybeInstance) return wrap // ghost module: no engine instance to wire up
  const instance: KeyboardMidiInstance = maybeInstance

  const readoutRow = document.createElement('div')
  readoutRow.className = 'kb-readout-row'

  const noteReadout = document.createElement('div')
  noteReadout.className = 'kb-note-readout'
  noteReadout.dataset['testid'] = 'note-readout'
  noteReadout.textContent = '—'

  // ---- hold / sustain: the one shortcut this task's brief names by name
  // ("without it you cannot hold a note and turn a knob on the rack page
  // the way you can on the harness with HOLD"). Mirrors dev/main.ts's own
  // `setHold` exactly -- an up-event (keyup, pointer release) does not
  // release the note in the engine while engaged, it just stops being
  // *physically* held, moving to `sustainedByHold` so the gate stays open
  // and every knob on this panel (or any other) is explorable in real
  // time. Turning hold back off flushes whatever is only sounding because
  // of it. Local to this panel/module, not page-global, the same way every
  // other piece of this panel's state already is -- two split-zone
  // Keyboard modules each get their own independent Hold. ----
  let holdEngaged = false
  const sustainedByHold = new Set<string>() // 'key:<code>' | 'mouse:<pointerId>'

  const holdBtn = document.createElement('button')
  holdBtn.type = 'button'
  holdBtn.className = 'kb-hold-btn'
  holdBtn.dataset['testid'] = 'kb-hold'
  holdBtn.textContent = 'Hold'
  holdBtn.title = 'Sustain the current note (Space) -- keeps sounding after release so you can turn a knob'
  holdBtn.setAttribute('aria-pressed', 'false')

  readoutRow.append(noteReadout, holdBtn)

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

  function setHold(engaged: boolean): void {
    holdEngaged = engaged
    holdBtn.classList.toggle('engaged', engaged)
    holdBtn.setAttribute('aria-pressed', String(engaged))
    if (engaged) return
    for (const ownerId of sustainedByHold) {
      if (ownerId.startsWith('key:')) {
        const code = ownerId.slice(4)
        heldKeyNotes.delete(code)
        instance.handleKey(code, false)
      } else {
        const pointerId = Number(ownerId.slice(6))
        activePointers.delete(pointerId)
        instance.releaseNote(`mouse:${pointerId}`)
      }
    }
    sustainedByHold.clear()
    refresh()
  }
  holdBtn.addEventListener('click', () => setHold(!holdEngaged))

  const piano = buildPiano({
    startNote: pianoStart,
    endNote: pianoEnd,
    onPress(pointerId, note) {
      sustainedByHold.delete(`mouse:${pointerId}`) // repressing clears any stale drone entry
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
      if (holdEngaged) {
        sustainedByHold.add(`mouse:${pointerId}`)
        return // stays open in the engine; activePointers keeps it lit
      }
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
  // Guarded against editable targets (see `isEditableTarget`'s comment)
  // and against a repeat-fired keydown, the same way the octave/hold
  // shortcuts below are.
  function onKeyDown(e: KeyboardEvent): void {
    if (isEditableTarget(e.target) || e.repeat) return
    if (e.code === 'Space') {
      e.preventDefault() // Space's default is page-scroll / activating a focused button
      setHold(!holdEngaged)
      return
    }
    const note = keyToNote(e.code, currentOctave())
    if (note === undefined) return
    sustainedByHold.delete(`key:${e.code}`) // repressing clears any stale drone entry
    instance.handleKey(e.code, true)
    heldKeyNotes.set(e.code, note)
    refresh()
  }
  function onKeyUp(e: KeyboardEvent): void {
    if (isEditableTarget(e.target)) return
    if (!heldKeyNotes.has(e.code)) return
    if (holdEngaged) {
      sustainedByHold.add(`key:${e.code}`)
      return // note stays open in the engine; heldKeyNotes keeps it lit
    }
    heldKeyNotes.delete(e.code)
    instance.handleKey(e.code, false)
    refresh()
  }
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)

  // Panic against a stuck drone: if the window loses focus while a key or
  // pointer is physically down (alt-tab away, a devtools panel steals
  // focus, ...), the browser never delivers that key's keyup/pointerup --
  // there was nothing here to catch that before. This releases only what
  // is *physically* held right now, not anything already sustained by Hold
  // on purpose (that drone is the whole point of Hold; losing window focus
  // to go read a knob's tooltip should not silence it).
  function releasePhysical(): void {
    for (const code of [...heldKeyNotes.keys()]) {
      heldKeyNotes.delete(code)
      instance.handleKey(code, false)
    }
    for (const pointerId of [...activePointers.keys()]) {
      activePointers.delete(pointerId)
      instance.releaseNote(`mouse:${pointerId}`)
    }
    refresh()
  }
  window.addEventListener('blur', releasePhysical)

  // ---- zone shading on the piano: polled, not event-driven, because the
  // rangeLow/rangeHigh knobs are drawn generically by rack/panel.ts from
  // the descriptor -- this custom panel has no hook into their onChange.
  // Self-terminating the same way rack/scope-panel.ts's own draw loop is:
  // once `wrap` leaves the document (module removed, patch reloaded),
  // nothing schedules another frame. Cheap (128 keys' worth of a class
  // toggle, only when the zone actually changed) -- not a redraw loop. ----
  let lastZone: readonly [number, number] | undefined
  function zoneTick(): void {
    if (!wrap.isConnected) return
    const params = graph.getParams(moduleId)
    const low = Math.round(params['rangeLow'] ?? 0)
    const high = Math.round(params['rangeHigh'] ?? 127)
    if (!lastZone || lastZone[0] !== low || lastZone[1] !== high) {
      piano.setZone(low, high)
      lastZone = [low, high]
    }
    requestAnimationFrame(zoneTick)
  }
  requestAnimationFrame(zoneTick)

  const hint = document.createElement('p')
  hint.className = 'kb-hint'
  hint.textContent =
    'A W S E D F T G Y H U J K O L plays; Z/X shifts octave; drag Lo/Hi to set this module’s key range ' +
    '(dimmed keys are outside it); Space holds the note so you can turn a knob hands-free.'

  wrap.append(hint, readoutRow, piano.el)
  return wrap
}
