import type { ModuleDescriptor, PortSpec } from '../src/engine/types'
import type { PatchGraph } from '../src/engine/graph'
import { buildKnob } from './knob'

/**
 * The generic panel renderer -- the thing this whole slice exists to prove
 * out. It reads a `ModuleDescriptor`'s `ports`, `params` and `layout` and
 * draws a module panel from nothing else. No module name is ever tested
 * against in here; if a descriptor needs something this file does not
 * provide, that is a gap in `ModuleDescriptor`, not a reason to special-case
 * a module.
 */

/** Registers a jack's DOM element so the cable layer can find its anchor
 *  point and identify which (moduleId, portId) it belongs to. */
export interface JackRegistry {
  register(moduleId: string, portId: string, el: HTMLElement): void
}

/** Escape hatch for `descriptor.customPanel`: given the module id and the
 *  live graph, return bespoke content to append below the generic grid.
 *  The renderer never inspects what a custom panel key *means* -- it only
 *  looks one up and appends whatever comes back, or nothing if the caller
 *  did not register that key. */
export type CustomPanelBuilder = (moduleId: string, graph: PatchGraph) => HTMLElement

export interface BuildPanelOptions {
  jacks: JackRegistry
  customPanels?: Record<string, CustomPanelBuilder>
}

function gridExtent(descriptor: ModuleDescriptor): { cols: number; rows: number } {
  let maxX = 0
  let maxY = 0
  for (const item of descriptor.layout) {
    maxX = Math.max(maxX, item.x)
    maxY = Math.max(maxY, item.y)
  }
  return { cols: maxX + 1, rows: maxY + 1 }
}

function buildJack(descriptor: ModuleDescriptor, moduleId: string, port: PortSpec, jacks: JackRegistry): HTMLElement {
  const el = document.createElement('div')
  el.className = `jack signal-${port.signal} dir-${port.dir}`
  el.dataset['module'] = moduleId
  el.dataset['port'] = port.id
  el.dataset['signal'] = port.signal
  el.dataset['dir'] = port.dir
  el.dataset['testid'] = `jack-${moduleId}-${port.id}`
  el.title = `${descriptor.name} — ${port.label} (${port.signal})`

  const socket = document.createElement('div')
  socket.className = 'jack-socket'
  const label = document.createElement('span')
  label.className = 'jack-label'
  label.textContent = port.label

  el.append(socket, label)
  jacks.register(moduleId, port.id, el)
  return el
}

/**
 * `LayoutItem.kind` also declares `'switch'`, `'button'` and `'display'`,
 * but no descriptor in the Phase 1 module set (all fifteen were checked)
 * emits any of the three -- the sequencer's step values are ordinary knobs,
 * and both modules that need something those kinds might have covered
 * (sequencer, keyboard) instead opt out of the grid entirely via
 * `customPanel`. These renderers exist so the generic path does not throw
 * if a future descriptor does use one, but they are unexercised by
 * anything real today; report that rather than pretending it was tested.
 */
function buildFallbackControl(kind: 'switch' | 'button' | 'display', ref: string): HTMLElement {
  const el = document.createElement('div')
  el.className = `fallback-control fallback-${kind}`
  el.dataset['ref'] = ref
  el.textContent = ref
  return el
}

/**
 * Panel geometry, not color or material -- so per Section 8 it does *not*
 * live in a theme token file. "Panel widths, knob sizes, jack positions"
 * are named explicitly as the things that stay identical across all eight
 * themes, which is exactly what lets a Playwright screenshot of one theme
 * match another structurally. `HP_PX` is an arbitrary but fixed screen
 * scale for "horizontal pitch" (a real Eurorack HP is 5.08mm, which has no
 * native meaning on a display); `ROW_PX` is the layout grid's fixed row
 * height. Both are geometry constants, deliberately not CSS custom
 * properties.
 */
const HP_PX = 16
const MIN_PANEL_PX = 120
const ROW_PX = 58

export function buildPanel(
  descriptor: ModuleDescriptor,
  moduleId: string,
  graph: PatchGraph,
  opts: BuildPanelOptions,
): HTMLElement {
  const panel = document.createElement('div')
  panel.className = 'module-panel'
  panel.dataset['module'] = moduleId
  panel.dataset['type'] = descriptor.type
  panel.dataset['testid'] = `module-${moduleId}`
  // `min-width`, not `width`: an ordinary module renders at exactly its
  // hp-derived size (nothing inside it is wider), but a module with
  // `customPanel` content that genuinely needs more room -- the keyboard's
  // on-screen piano, at 10hp, is narrower than a two-octave keyboard can
  // legibly be -- is allowed to grow past its nominal hp rather than
  // clipping or overflowing its neighbors. A first version of this used a
  // hard `width` here and the piano silently overflowed into the next
  // panel's column, invisible in the DOM and obvious the moment the page
  // was actually looked at.
  panel.style.minWidth = `${Math.max(MIN_PANEL_PX, descriptor.hp * HP_PX)}px`

  const header = document.createElement('div')
  header.className = 'module-header'
  const name = document.createElement('span')
  name.className = 'module-name'
  name.textContent = descriptor.name
  header.append(name)

  const { cols, rows } = gridExtent(descriptor)
  const grid = document.createElement('div')
  grid.className = 'module-grid'
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`
  grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`
  grid.style.height = `${rows * ROW_PX}px`

  const portsById = new Map(descriptor.ports.map((p) => [p.id, p]))
  const paramsById = new Map(descriptor.params.map((p) => [p.id, p]))

  for (const item of descriptor.layout) {
    let el: HTMLElement
    if (item.kind === 'knob') {
      const spec = paramsById.get(item.ref)
      if (!spec) throw new Error(`buildPanel: "${descriptor.type}" layout knob refers to unknown param "${item.ref}"`)
      const initial = graph.getParams(moduleId)[item.ref] ?? spec.default
      const knob = buildKnob(spec, initial, (value) => graph.setParam(moduleId, item.ref, value))
      el = knob.el
    } else if (item.kind === 'jack') {
      const port = portsById.get(item.ref)
      if (!port) throw new Error(`buildPanel: "${descriptor.type}" layout jack refers to unknown port "${item.ref}"`)
      el = buildJack(descriptor, moduleId, port, opts.jacks)
    } else {
      el = buildFallbackControl(item.kind, item.ref)
    }
    el.style.gridColumn = `${item.x + 1}`
    el.style.gridRow = `${item.y + 1}`
    grid.append(el)
  }

  panel.append(header, grid)

  if (descriptor.customPanel) {
    const builder = opts.customPanels?.[descriptor.customPanel]
    if (builder) {
      const custom = builder(moduleId, graph)
      custom.className = `${custom.className} custom-panel-content`.trim()
      panel.append(custom)
    } else {
      const badge = document.createElement('div')
      badge.className = 'custom-panel-missing'
      badge.textContent = `custom panel "${descriptor.customPanel}" not implemented`
      panel.append(badge)
    }
  }

  return panel
}
