import type { PatchGraph, Cable } from '../src/engine/graph'
import type { PortDir } from '../src/engine/types'
import type { JackRegistry } from './panel'
import { showCableInspector, type CableInspectorHandle } from './cable-inspector'

/**
 * Patch cables: an SVG overlay drawn on top of the rack. The engine is the
 * source of truth throughout -- a drag that lands on a valid jack pair calls
 * `graph.connect`, and only *then* does a cable get drawn; removing a cable
 * calls `graph.disconnect` and only then is the path removed. Nothing here
 * tracks a connection the graph does not also know about.
 *
 * Clicking a cable no longer removes it outright -- it *selects* it and
 * opens `rack/cable-inspector.ts`'s live reading (waveform, fundamental,
 * RMS), tapped from the cable's source node without disturbing the signal
 * itself. See that module's doc comment for the full click-to-inspect vs.
 * click-to-remove reasoning; this file only owns *when* the tap exists --
 * attached the instant a cable is selected, detached the instant it is
 * deselected -- and the three ways a cable can be deselected: clicking it
 * again, clicking anywhere else, or its own inspector's remove button.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

interface JackRef {
  moduleId: string
  portId: string
  dir: PortDir
  el: HTMLElement
}

function jackKey(moduleId: string, portId: string): string {
  return `${moduleId}:${portId}`
}

/** A gently sagging curve between two points, the way a real cable hangs
 *  under its own weight rather than stretching taut. */
function hangingPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = x2 - x1
  const sag = Math.min(140, Math.abs(dx) * 0.3) + 36
  const midX = (x1 + x2) / 2
  const midY = (y1 + y2) / 2 + sag
  return `M ${x1} ${y1} Q ${midX} ${midY} ${x2} ${y2}`
}

export class CableLayer {
  private readonly svg: SVGSVGElement
  private readonly jacks = new Map<string, JackRef>()
  private readonly cableGroups = new Map<string, { group: SVGGElement; from: JackRef; to: JackRef }>()
  private dragFrom: JackRef | null = null
  private dragPreview: SVGPathElement | null = null
  private readonly resizeObserver: ResizeObserver
  private readonly onWindowResize = (): void => this.reflow()
  private selectedCableId: string | null = null
  private inspector: CableInspectorHandle | null = null

  /** Called after a drag or a cable-click changes the graph -- the same
   *  kind of change-notification hook `buildPanel` takes, so a caller (the
   *  rack's autosave) has one place to hear about every kind of patch
   *  edit instead of hooking each gesture separately. */
  onChange?: () => void

  constructor(
    private readonly container: HTMLElement,
    private readonly graph: PatchGraph,
  ) {
    this.svg = document.createElementNS(SVG_NS, 'svg')
    this.svg.classList.add('cable-layer')
    container.append(this.svg)

    window.addEventListener('pointermove', this.onDragMove)
    window.addEventListener('pointerup', this.onDragEnd)
    this.resizeObserver = new ResizeObserver(() => this.reflow())
    this.resizeObserver.observe(container)
    window.addEventListener('resize', this.onWindowResize)
    // "Click elsewhere deselects" -- a cable's own hit-path click handler
    // and the inspector popover's own listeners both call
    // `stopPropagation`, so this only ever sees a click that landed on
    // neither: the rack background, a module panel, a jack. Escape is the
    // keyboard equivalent, for a cable selected without a mouse nearby.
    window.addEventListener('click', this.onOutsideClick)
    window.addEventListener('keydown', this.onKeyDown)
  }

  /** Tears down every listener and observer this layer registered, plus
   *  its own SVG element -- the counterpart `new CableLayer(...)` needs
   *  when a patch load discards the current graph and rebuilds a fresh
   *  one. Without this, each load would leak a `pointermove`/`pointerup`/
   *  `resize` listener and a `ResizeObserver` bound to a container that
   *  may itself be gone. */
  destroy(): void {
    this.closeInspector()
    window.removeEventListener('pointermove', this.onDragMove)
    window.removeEventListener('pointerup', this.onDragEnd)
    window.removeEventListener('resize', this.onWindowResize)
    window.removeEventListener('click', this.onOutsideClick)
    window.removeEventListener('keydown', this.onKeyDown)
    this.resizeObserver.disconnect()
    this.svg.remove()
    this.jacks.clear()
    this.cableGroups.clear()
  }

  /** Drop every jack this module registered -- called when its panel is
   *  removed so a stale `JackRef` (pointing at a detached DOM element)
   *  cannot linger in `this.jacks` and be offered as a drag target. */
  removeModuleJacks(moduleId: string): void {
    for (const key of [...this.jacks.keys()]) {
      if (key.startsWith(`${moduleId}:`)) this.jacks.delete(key)
    }
  }

  /**
   * Reconcile the drawn cables against `graph.cables` -- the engine's own
   * list, not anything this layer tracked independently. Removing a
   * module drops its cables inside `PatchGraph.removeModule` before this
   * is ever called; this only makes the screen agree with what the graph
   * already did, the same "engine decides, view redraws" split every
   * other mutation here follows.
   */
  syncFromGraph(): void {
    const liveIds = new Set(this.graph.cables.map((c) => c.id))
    for (const id of [...this.cableGroups.keys()]) {
      if (!liveIds.has(id)) this.removeCable(id)
    }
    for (const cable of this.graph.cables) {
      if (!this.cableGroups.has(cable.id)) this.renderCable(cable)
    }
  }

  /** Handed to `buildPanel` so jacks register themselves as they're built. */
  get jackRegistry(): JackRegistry {
    return {
      register: (moduleId, portId, el) => {
        const dir = (el.dataset['dir'] as PortDir | undefined) ?? 'in'
        const ref: JackRef = { moduleId, portId, dir, el }
        this.jacks.set(jackKey(moduleId, portId), ref)
        el.addEventListener('pointerdown', (e) => {
          e.preventDefault()
          e.stopPropagation()
          this.dragFrom = ref
          this.dragPreview = document.createElementNS(SVG_NS, 'path')
          this.dragPreview.classList.add('cable-preview')
          this.svg.append(this.dragPreview)
          this.updatePreview(e.clientX, e.clientY)
        })
      },
    }
  }

  /** Draw an already-connected cable -- used both for the starter patch's
   *  initial cabling and for a fresh drag, so there is exactly one code
   *  path that turns a `Cable` into an on-screen curve. */
  renderCable(cable: Cable): void {
    const from = this.jacks.get(jackKey(cable.from[0], cable.from[1]))
    const to = this.jacks.get(jackKey(cable.to[0], cable.to[1]))
    if (!from || !to) return // ghost endpoint or unrendered module -- nothing to draw

    const group = document.createElementNS(SVG_NS, 'g')
    group.classList.add('cable', `signal-${from.el.dataset['signal']}`)
    if (cable.delayed) group.classList.add('cable-delayed')
    if (!cable.active) group.classList.add('cable-inactive')

    const visible = document.createElementNS(SVG_NS, 'path')
    visible.classList.add('cable-visible')
    const hit = document.createElementNS(SVG_NS, 'path')
    hit.classList.add('cable-hit')
    // `cable.id` is stable for this cable's lifetime (PatchGraph never
    // reuses it) -- a test-only hook for locating one specific cable
    // (`getByTestId`) the same way every jack and knob already exposes one.
    hit.dataset['testid'] = `cable-${cable.id}`

    group.append(visible, hit)
    this.svg.append(group)
    this.cableGroups.set(cable.id, { group, from, to })
    this.positionCable(cable.id)

    hit.addEventListener('click', (e) => {
      e.stopPropagation() // otherwise the window-level "click elsewhere" listener fires right after this and closes what it just opened
      this.toggleInspect(cable.id, hit)
    })
  }

  removeCable(cableId: string): void {
    if (cableId === this.selectedCableId) this.closeInspector()
    const entry = this.cableGroups.get(cableId)
    if (!entry) return
    entry.group.remove()
    this.cableGroups.delete(cableId)
  }

  /** Select `cableId` and open its inspector, or -- if it is already
   *  selected -- deselect it. Only one cable is ever inspected at a time:
   *  selecting a second closes the first's tap before opening the new one,
   *  the same "at most one open" rule a real scope probe follows (you only
   *  have the one probe). */
  private toggleInspect(cableId: string, hitEl: SVGPathElement): void {
    if (this.selectedCableId === cableId) {
      this.closeInspector()
      return
    }
    this.closeInspector()

    const cable = this.graph.cables.find((c) => c.id === cableId)
    if (!cable) return
    const sourceNode = this.graph.getInstance(cable.from[0])?.outputs.get(cable.from[1])
    if (!sourceNode) return // ghost source -- nothing to tap

    const box = hitEl.getBBox()
    this.selectedCableId = cableId
    this.cableGroups.get(cableId)?.group.classList.add('cable-selected')
    this.inspector = showCableInspector(
      this.container,
      this.graph.audioContext,
      sourceNode,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      () => {
        this.graph.disconnect(cableId)
        this.removeCable(cableId)
        this.onChange?.()
      },
    )
  }

  private closeInspector(): void {
    this.inspector?.close()
    this.inspector = null
    if (this.selectedCableId) this.cableGroups.get(this.selectedCableId)?.group.classList.remove('cable-selected')
    this.selectedCableId = null
  }

  private readonly onOutsideClick = (): void => {
    if (this.selectedCableId) this.closeInspector()
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.selectedCableId) this.closeInspector()
  }

  /** Recompute every cable's anchor points -- call after anything that
   *  could move a jack (window resize, rack reflow). */
  reflow(): void {
    const rect = this.container.getBoundingClientRect()
    this.svg.setAttribute('width', String(this.container.scrollWidth))
    this.svg.setAttribute('height', String(this.container.scrollHeight))
    this.svg.style.width = `${this.container.scrollWidth}px`
    this.svg.style.height = `${this.container.scrollHeight}px`
    for (const id of this.cableGroups.keys()) this.positionCable(id, rect)
  }

  private anchorOf(ref: JackRef, rect: DOMRect): [number, number] {
    const socket = ref.el.querySelector('.jack-socket') ?? ref.el
    const box = socket.getBoundingClientRect()
    return [box.left + box.width / 2 - rect.left + this.container.scrollLeft, box.top + box.height / 2 - rect.top + this.container.scrollTop]
  }

  private positionCable(cableId: string, rect = this.container.getBoundingClientRect()): void {
    const entry = this.cableGroups.get(cableId)
    if (!entry) return
    const [x1, y1] = this.anchorOf(entry.from, rect)
    const [x2, y2] = this.anchorOf(entry.to, rect)
    const d = hangingPath(x1, y1, x2, y2)
    entry.group.querySelectorAll('path').forEach((p) => p.setAttribute('d', d))
  }

  private updatePreview(clientX: number, clientY: number): void {
    if (!this.dragFrom || !this.dragPreview) return
    const rect = this.container.getBoundingClientRect()
    const [x1, y1] = this.anchorOf(this.dragFrom, rect)
    const x2 = clientX - rect.left + this.container.scrollLeft
    const y2 = clientY - rect.top + this.container.scrollTop
    this.dragPreview.setAttribute('d', hangingPath(x1, y1, x2, y2))
    this.dragPreview.classList.toggle('signal-' + this.dragFrom.el.dataset['signal'], true)
  }

  private readonly onDragMove = (e: PointerEvent): void => {
    if (!this.dragFrom) return
    this.updatePreview(e.clientX, e.clientY)
  }

  private readonly onDragEnd = (e: PointerEvent): void => {
    if (!this.dragFrom) return
    const from = this.dragFrom
    this.dragFrom = null
    this.dragPreview?.remove()
    this.dragPreview = null

    const target = document.elementFromPoint(e.clientX, e.clientY)
    const jackEl = target instanceof Element ? target.closest('.jack') : null
    if (!jackEl) return
    const moduleId = jackEl.getAttribute('data-module')
    const portId = jackEl.getAttribute('data-port')
    if (!moduleId || !portId) return
    const to = this.jacks.get(jackKey(moduleId, portId))
    if (!to) return

    this.tryConnect(from, to)
  }

  /**
   * Any port may connect to any port -- the engine deliberately does not
   * type-check by signal, and neither does this. The one constraint that
   * *is* real is structural, not a validation rule this UI invented: a
   * cable is a directed edge from an output to an input
   * (`PatchGraph.connect`'s `from`/`to` address `outputs`/`inputs` maps
   * respectively), so whichever end of the drag is the `out` jack supplies
   * `from` regardless of which end the drag started on -- exactly like
   * plugging a real cable in either order.
   */
  private tryConnect(a: JackRef, b: JackRef): void {
    if (a.moduleId === b.moduleId && a.portId === b.portId) return
    let from: JackRef
    let to: JackRef
    if (a.dir === 'out' && b.dir === 'in') {
      from = a
      to = b
    } else if (a.dir === 'in' && b.dir === 'out') {
      from = b
      to = a
    } else {
      return // two outputs or two inputs: not a connectable pair
    }
    const cable = this.graph.connect([from.moduleId, from.portId], [to.moduleId, to.portId])
    this.renderCable(cable)
    this.onChange?.()
  }
}
