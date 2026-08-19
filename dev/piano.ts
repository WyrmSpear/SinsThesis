/**
 * The on-screen piano. Pure UI: it owns the DOM and the pointer-event state
 * machine for pressing, releasing, and gliding across keys, but it never
 * touches the engine directly. Every press/release is reported through the
 * options callbacks, and `main.ts` is the one place that turns those into
 * `keyboardInstance.pressNote` / `releaseNote` calls -- so there is exactly
 * one path from "the user did something" to "a note plays," whether that
 * something was a mouse click, a drag, a touch, or a computer keydown.
 *
 * Layout is two-plus octaves fixed at absolute MIDI note numbers (not tied
 * to the octave knob), from `startNote` to `endNote` inclusive, arranged as
 * a standard piano: white keys as equal-width flex columns, black keys
 * absolutely positioned over the boundary between the white keys on either
 * side of them.
 */

/** Semitone offsets within an octave that fall on a white key: C D E F G A
 *  B. A black key sits between every pair except E-F and B-C. */
const WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11]

function isWhite(note: number): boolean {
  return WHITE_OFFSETS.includes(((note % 12) + 12) % 12)
}

export interface PianoOptions {
  startNote: number
  endNote: number
  /** A pointer (mouse or touch) went down on `note`. */
  onPress(pointerId: number, note: number): void
  /** The same pointer, still held, moved onto a different key. */
  onMove(pointerId: number, note: number): void
  /** The pointer was released or left the keyboard entirely while held. */
  onRelease(pointerId: number): void
  /** The computer-key letter for `note` under the *current* octave
   *  setting, or undefined if no computer key currently plays it. Called
   *  once per key at build time and again via `refreshLabels()`. */
  labelFor(note: number): string | undefined
}

export interface PianoHandle {
  readonly el: HTMLElement
  /** Reflect held/not-held state on the key for `note`, if it is in range.
   *  A no-op for notes outside [startNote, endNote] -- the caller doesn't
   *  need to know the piano's range to report engine-side held state. */
  setHeld(note: number, held: boolean): void
  /** Re-run `labelFor` across every key -- call after the octave changes. */
  refreshLabels(): void
}

export function buildPiano(opts: PianoOptions): PianoHandle {
  const { startNote, endNote } = opts
  const el = document.createElement('div')
  el.className = 'piano'
  el.dataset['testid'] = 'piano'

  const whiteNotes: number[] = []
  for (let n = startNote; n <= endNote; n++) if (isWhite(n)) whiteNotes.push(n)
  const whiteWidthPct = 100 / whiteNotes.length
  const blackWidthPct = whiteWidthPct * 0.62

  const keyByNote = new Map<number, HTMLElement>()
  const labelByNote = new Map<number, HTMLElement>()

  function whiteKeysBefore(note: number): number {
    return whiteNotes.filter((n) => n < note).length
  }

  function makeKey(note: number, white: boolean): HTMLElement {
    const key = document.createElement('div')
    key.className = white ? 'piano-key piano-key-white' : 'piano-key piano-key-black'
    key.dataset['note'] = String(note)
    key.dataset['testid'] = `piano-key-${note}`

    const label = document.createElement('span')
    label.className = 'piano-key-label'
    key.append(label)
    labelByNote.set(note, label)

    if (white) {
      key.style.width = `${whiteWidthPct}%`
    } else {
      const leftPct = whiteKeysBefore(note) * whiteWidthPct - blackWidthPct / 2
      key.style.left = `${leftPct}%`
      key.style.width = `${blackWidthPct}%`
    }

    keyByNote.set(note, key)
    return key
  }

  // White keys first (they lay out the flex row); black keys appended
  // afterward so they paint on top, positioned absolutely within `el`.
  for (const note of whiteNotes) el.append(makeKey(note, true))
  for (let n = startNote; n <= endNote; n++) {
    if (!isWhite(n)) el.append(makeKey(n, false))
  }

  // Interaction is delegated to the piano container rather than wired
  // per-key. A per-key `pointerenter`/`pointerleave` pair looked simpler
  // at first, but the browser fires the old key's `pointerleave` *before*
  // the new key's `pointerenter` when a drag crosses the boundary between
  // them -- so a naive "release on leave, press on enter" handler releases
  // the glissando's note and then finds nothing to move it to, silencing
  // the drag every time it crosses a key. Hit-testing on every
  // `pointermove` instead sidesteps that ordering entirely: there is only
  // ever one decision, "what key is under the pointer right now."
  el.style.touchAction = 'none' // don't let a drag-glissando scroll the page

  function keyAt(x: number, y: number): HTMLElement | null {
    const target = document.elementFromPoint(x, y)
    const key = target instanceof HTMLElement ? target.closest('.piano-key') : null
    return key instanceof HTMLElement && el.contains(key) ? key : null
  }

  el.addEventListener('pointerdown', (e) => {
    const key = keyAt(e.clientX, e.clientY)
    if (!key) return
    e.preventDefault()
    opts.onPress(e.pointerId, Number(key.dataset['note']))
  })
  el.addEventListener('pointermove', (e) => {
    if ((e.buttons & 1) === 0) return // only a held drag drives glissando
    const key = keyAt(e.clientX, e.clientY)
    if (!key) return
    opts.onMove(e.pointerId, Number(key.dataset['note']))
  })
  el.addEventListener('pointerup', (e) => opts.onRelease(e.pointerId))
  el.addEventListener('pointercancel', (e) => opts.onRelease(e.pointerId))
  // Fires when the pointer leaves the *container* -- i.e. the drag has
  // left the whole keyboard, not just crossed from one key to the next.
  // This is what stops a note from droning if the user drags off the
  // edge of the keyboard while still holding the mouse button.
  el.addEventListener('pointerleave', (e) => opts.onRelease(e.pointerId))

  function refreshLabels(): void {
    for (const [note, label] of labelByNote) {
      const text = opts.labelFor(note)
      label.textContent = text ?? ''
      label.classList.toggle('has-key', text !== undefined)
    }
  }
  refreshLabels()

  return {
    el,
    setHeld(note, held) {
      keyByNote.get(note)?.classList.toggle('held', held)
    },
    refreshLabels,
  }
}
