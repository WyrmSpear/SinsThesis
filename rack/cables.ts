import type { PatchGraph, Cable } from '../src/engine/graph'
import type { PortDir } from '../src/engine/types'
import type { JackRegistry } from './panel'

/**
 * Patch cables: an SVG overlay drawn on top of the rack. The engine is the
 * source of truth throughout -- a drag that lands on a valid jack pair calls
 * `graph.connect`, and only *then* does a cable get drawn; a click on a
 * cable calls `graph.disconnect` and only then is the path removed. Nothing
 * here tracks a connection the graph does not also know about.
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
  }

  /** Tears down every listener and observer this layer registered, plus
   *  its own SVG element -- the counterpart `new CableLayer(...)` needs
   *  when a patch load discards the current graph and rebuilds a fresh
   *  one. Without this, each load would leak a `pointermove`/`pointerup`/
   *  `resize` listener and a `ResizeObserver` bound to a container that
   *  may itself be gone. */
  destroy(): void {
    window.removeEventListener('pointermove', this.onDragMove)
    window.removeEventListener('pointerup', this.onDragEnd)
    window.removeEventListener('resize', this.onWindowResize)
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

    group.append(visible, hit)
    this.svg.append(group)
    this.cableGroups.set(cable.id, { group, from, to })
    this.positionCable(cable.id)

    hit.addEventListener('click', () => {
      this.graph.disconnect(cable.id)
      this.removeCable(cable.id)
      this.onChange?.()
    })
  }

  removeCable(cableId: string): void {
    const entry = this.cableGroups.get(cableId)
    if (!entry) return
    entry.group.remove()
    this.cableGroups.delete(cableId)
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
