import type { PatchGraph } from '../src/engine/graph'
import type { CableLayer } from './cables'

/**
 * Drag-to-reorder: pick a module up by its header, drop it between two
 * others. The engine already has storage for this -- `PatchGraph.setSlot`/
 * `getSlot`, which `serializePatch`/`loadPatch` (src/engine/patch.ts) round
 * trip through a `.sinp` file -- so the only thing missing is a way to
 * change it from the rack.
 *
 * The approach is plain DOM reordering, not an absolute-position drag: on
 * each pointermove the dragged panel's DOM node is physically moved to
 * before/after whichever sibling panel the pointer is currently nearest, and
 * `cableLayer.reflow()` is called right after -- since every cable's anchor
 * is read live from its jack's `getBoundingClientRect()` (rack/cables.ts),
 * moving the panel element is what makes a cable visibly follow its module
 * while dragging, with no separate "redraw the cable" step. Only on
 * pointerup does the final DOM order get written back into the graph via
 * `setSlot`, one call per module, all in row 0 (the rack is a single
 * left-to-right strip; nothing in this UI creates a second row of *slots* --
 * the visual wrap into multiple lines is just flexbox running out of
 * horizontal space).
 *
 * `graph`/`cableLayer` are passed as getters, not values, because
 * rack/main.ts reassigns both on every patch load (a fresh `PatchGraph` and
 * `CableLayer` replace the old ones entirely -- see its `mountGraph`) and
 * this module is wired up exactly once, at boot.
 */

export function enableReorder(
  container: HTMLElement,
  getGraph: () => PatchGraph,
  getCableLayer: () => CableLayer,
  onReordered: () => void,
): void {
  let draggingEl: HTMLElement | null = null
  let activePointerId: number | null = null

  function panelsInOrder(): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>(':scope > .module-panel')]
  }

  // No `setPointerCapture` here, deliberately -- rack/cables.ts's own drag
  // (jack-to-jack cable dragging) already established the pattern this
  // mirrors: track the drag in module state and listen on `window` for
  // move/up. A fast drag can carry the pointer clean off the element that
  // started it (past the dragged panel's own shrinking/moving box as
  // siblings reflow around it), and a plain module-level flag survives that
  // with no special handling, the same way it already does for cables.
  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('.module-remove')) return // let the remove button's own click through
    const header = target.closest('.module-header')
    if (!header) return
    const panel = header.closest('.module-panel') as HTMLElement | null
    if (!panel) return

    draggingEl = panel
    activePointerId = e.pointerId
    panel.classList.add('module-dragging')
    e.preventDefault()
  }

  function onPointerMove(e: PointerEvent): void {
    if (!draggingEl || e.pointerId !== activePointerId) return

    // Nearest sibling by straight-line distance to the pointer, then insert
    // before/after it depending on which side of its own center the pointer
    // landed on -- the simplest rule that reorders correctly within a row
    // and degrades sanely across the rack's flex-wrap line breaks.
    let nearest: HTMLElement | null = null
    let nearestDist = Infinity
    for (const sib of panelsInOrder()) {
      if (sib === draggingEl) continue
      const r = sib.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const dist = (e.clientX - cx) ** 2 + (e.clientY - cy) ** 2
      if (dist < nearestDist) {
        nearestDist = dist
        nearest = sib
      }
    }
    if (nearest) {
      const r = nearest.getBoundingClientRect()
      const before = e.clientX < r.left + r.width / 2
      container.insertBefore(draggingEl, before ? nearest : nearest.nextSibling)
    }

    getCableLayer().reflow()
  }

  function endDrag(): void {
    if (!draggingEl) return
    const panel = draggingEl
    draggingEl = null
    activePointerId = null
    panel.classList.remove('module-dragging')

    // The dragged panel's DOM node was already physically moved during
    // `onPointerMove` (see this file's header comment) -- committing to the
    // graph is the same whether the gesture ended in a clean `pointerup` or
    // was cancelled out from under it (`pointercancel`, or the window
    // losing focus mid-drag): whatever order the panels are visually in
    // right now is what gets written back, since there is no "revert to
    // where it started" affordance to fall back to and leaving the graph's
    // slots out of sync with what is on screen would be worse.
    const graph = getGraph()
    panelsInOrder().forEach((el, index) => {
      const id = el.dataset['module']
      if (id) graph.setSlot(id, [0, index])
    })
    getCableLayer().reflow()
    onReordered()
  }

  function onPointerUp(e: PointerEvent): void {
    if (!draggingEl || e.pointerId !== activePointerId) return
    endDrag()
  }

  // `pointercancel` fires instead of `pointerup` whenever the browser takes
  // a touch gesture away mid-drag (a scroll takeover, a pinch-zoom, an
  // interrupting call) -- without this, exactly like the bug this mirrors
  // in `rack/cables.ts`, `draggingEl` would never clear, the panel would
  // stay visually stuck in "picked up" (`.module-dragging`'s reduced
  // opacity and drop shadow) forever, and every subsequent `pointermove`
  // anywhere in the window would keep shoving it around the rack. Window
  // `blur` mid-drag is the same class of gap on desktop (an OS-level app
  // switch, a permission prompt) with no guarantee either pointer event
  // still arrives.
  function onPointerCancel(e: PointerEvent): void {
    if (!draggingEl || e.pointerId !== activePointerId) return
    endDrag()
  }

  function onWindowBlur(): void {
    endDrag()
  }

  container.addEventListener('pointerdown', onPointerDown)
  // Move/up/cancel listen on the window, not the container: a fast drag can
  // carry the pointer outside the rack surface entirely (past its right
  // edge, or over the palette drawer), and a container-scoped listener
  // would stop seeing the drag the instant that happens.
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerCancel)
  window.addEventListener('blur', onWindowBlur)
}
