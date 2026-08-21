import type { KnobHandle } from './knob'

/**
 * MIDI learn's UI half: a small badge on a knob's dial showing "this knob
 * is bound to CC n," and the right-click (or long-press, for touch) menu
 * that arms/unbinds it. The mapping and storage live engine-side
 * (`src/engine/midi-learn.ts`) -- this file only ever calls the four hooks
 * `AttachMidiLearnOptions` hands it, never touches `PatchGraph` or
 * `MidiLearnController` directly, the same separation `rack/panel.ts`
 * already keeps between drawing a knob and what a knob's value *means*.
 *
 * The badge lives *inside* `.knob-dial` (queried off the handle's own
 * element, not a new prop on `KnobHandle` -- `knob.ts` needed no change at
 * all) and is absolutely positioned, so it adds zero footprint to the
 * dial's own box: `tests/browser/theme-geometry.test.ts` measures
 * `.knob-dial`'s `getBoundingClientRect()` across all thirteen themes and
 * would fail the instant a badge nudged that box by even one pixel.
 */

export interface KnobMidiBinding {
  controller: number
}

export interface AttachMidiLearnOptions {
  /** The current binding for this exact (module, param), or undefined. */
  getBinding(): KnobMidiBinding | undefined
  /** True while this exact target is the pending destination of an armed
   *  MIDI-learn gesture -- only one knob in the whole rack is ever armed
   *  at once (`MidiLearnController.arm`'s own doc comment). */
  isArmed(): boolean
  /** Right-click -> "MIDI Learn" (or "Cancel MIDI Learn" while armed) was
   *  chosen for this knob. */
  onLearnRequest(): void
  /** Right-click -> "Remove MIDI binding" was chosen. */
  onUnbind(): void
}

export interface MidiLearnHandle {
  /** Re-reads `getBinding()`/`isArmed()` and updates the badge and armed
   *  indicator. The caller (`rack/main.ts`) calls this after anything that
   *  could have changed either state for *any* knob -- a bind completing
   *  moves the armed flag off this knob (if it was armed) and possibly
   *  onto this knob (if it was just bound); arming a different knob
   *  disarms this one. */
  refresh(): void
  /** Detaches the context-menu listener -- called when a module panel is
   *  removed from the rack, mirroring every other per-module cleanup in
   *  `rack/main.ts`'s `removeModuleById`. */
  destroy(): void
}

let openMenuCloser: (() => void) | undefined

function closeOpenMenu(): void {
  openMenuCloser?.()
  openMenuCloser = undefined
}

function buildMenu(
  anchor: { x: number; y: number },
  items: Array<{ label: string; testid: string; onClick: () => void }>,
): void {
  closeOpenMenu()
  const menu = document.createElement('div')
  menu.className = 'knob-midi-menu'
  menu.dataset['testid'] = 'knob-midi-menu'
  menu.style.left = `${anchor.x}px`
  menu.style.top = `${anchor.y}px`

  for (const item of items) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'knob-midi-menu-item'
    btn.dataset['testid'] = item.testid
    btn.textContent = item.label
    btn.addEventListener('click', () => {
      item.onClick()
      closeMenu()
    })
    menu.append(btn)
  }

  function onOutsideClick(e: MouseEvent): void {
    if (e.target instanceof Node && menu.contains(e.target)) return
    closeMenu()
  }
  function closeMenu(): void {
    menu.remove()
    document.removeEventListener('pointerdown', onOutsideClick, true)
    if (openMenuCloser === closeMenu) openMenuCloser = undefined
  }
  // Capture phase: a right-click that opens this menu also fires a
  // trailing `pointerdown`/`click` on some browsers, which must not
  // immediately close what it just opened -- `contextmenu`'s own handler
  // (below) always calls `closeOpenMenu()` itself before building a new
  // one, so this listener only ever needs to catch a *later*, unrelated
  // click.
  document.addEventListener('pointerdown', onOutsideClick, true)
  document.body.append(menu)
  openMenuCloser = closeMenu
}

export function attachMidiLearn(knob: KnobHandle, opts: AttachMidiLearnOptions): MidiLearnHandle {
  const dial = knob.el.querySelector<HTMLElement>('.knob-dial')

  const badge = document.createElement('span')
  badge.className = 'knob-midi-badge'
  badge.dataset['testid'] = 'knob-midi-badge'
  badge.hidden = true
  dial?.append(badge)

  function refresh(): void {
    const binding = opts.getBinding()
    const armed = opts.isArmed()
    if (binding) {
      badge.hidden = false
      badge.textContent = `CC${binding.controller}`
      badge.title = `Bound to MIDI CC ${binding.controller}`
    } else {
      badge.hidden = true
      badge.textContent = ''
    }
    knob.el.classList.toggle('knob-midi-armed', armed)
    knob.el.classList.toggle('knob-midi-bound', Boolean(binding))
  }

  function onContextMenu(e: MouseEvent): void {
    e.preventDefault()
    const binding = opts.getBinding()
    const armed = opts.isArmed()
    const items: Array<{ label: string; testid: string; onClick: () => void }> = []
    if (armed) {
      items.push({ label: 'Cancel MIDI Learn', testid: 'knob-midi-cancel', onClick: opts.onLearnRequest })
    } else {
      items.push({
        label: binding ? 'Re-learn MIDI CC' : 'MIDI Learn',
        testid: 'knob-midi-learn',
        onClick: opts.onLearnRequest,
      })
      if (binding) {
        items.push({
          label: `Remove MIDI binding (CC ${binding.controller})`,
          testid: 'knob-midi-unbind',
          onClick: opts.onUnbind,
        })
      }
    }
    buildMenu({ x: e.clientX, y: e.clientY }, items)
  }

  knob.el.addEventListener('contextmenu', onContextMenu)
  refresh()

  return {
    refresh,
    destroy() {
      knob.el.removeEventListener('contextmenu', onContextMenu)
      badge.remove()
    },
  }
}
