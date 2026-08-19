import type { LayoutItem, ModuleDescriptor, ParamSpec, PortSpec } from '../src/engine/types'
import type { PatchGraph } from '../src/engine/graph'
import { buildKnob } from './knob'
import { buildSwitch } from './switch'

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
  /** Called after any control on this panel changes the graph -- a knob
   *  drag, a switch click. The renderer stays ignorant of *why* a caller
   *  wants to know (autosave, in this app); it only ever plumbs the one
   *  hook through, the same way it already plumbs `jacks`. */
  onChange?: () => void
  /** When present, the panel grows a remove control (the header's own
   *  corner, not a module-specific button) that calls back with this
   *  module's id. Omit to render a panel with no way to remove itself --
   *  used for ghosts, which manage their own removal affordance. */
  onRemove?: (moduleId: string) => void
}

interface RowPlan {
  cols: number
  rows: number
  rowIndex(item: LayoutItem): number
}

/**
 * Collapses layout rows nothing occupies. Every descriptor authors knobs on
 * rows 0-1 and jacks on a fixed row further down (the convention "jacks sit
 * at a module's bottom edge") purely for readability in the source file --
 * the row *number* isn't meaningful screen geometry, only relative order is.
 * Rendering those numbers literally (N grid rows of equal height, forced to
 * a total of N * a fixed row height) turned every unused row into real,
 * visible dead space: a panel with two knob rows and one jack row authored
 * two rows further down rendered two blank rows nobody put anything in --
 * the "much taller than their content" panels this fixes.
 *
 * Jacks and everything else (knobs, switches, the unused fallback kinds)
 * are compacted independently, each preserving its own original relative
 * row order, and jack rows always render immediately after the last control
 * row -- consistent with "jacks sit at the bottom" without literally
 * reserving the vertical space in between.
 */
function planRows(descriptor: ModuleDescriptor): RowPlan {
  let maxX = 0
  const controlYs = new Set<number>()
  const jackYs = new Set<number>()
  for (const item of descriptor.layout) {
    maxX = Math.max(maxX, item.x)
    if (item.kind === 'jack') jackYs.add(item.y)
    else controlYs.add(item.y)
  }
  const sortedControl = [...controlYs].sort((a, b) => a - b)
  const sortedJack = [...jackYs].sort((a, b) => a - b)
  const controlIndex = new Map(sortedControl.map((y, i) => [y, i]))
  const jackIndex = new Map(sortedJack.map((y, i) => [y, sortedControl.length + i]))

  return {
    cols: maxX + 1,
    rows: Math.max(1, sortedControl.length + sortedJack.length),
    rowIndex(item) {
      return (item.kind === 'jack' ? jackIndex : controlIndex).get(item.y) ?? 0
    },
  }
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
 * `LayoutItem.kind` also declares `'button'` and `'display'`, and a layout
 * item can still name `'switch'` explicitly for a param with no `labels`
 * (nothing in the Phase 1 module set does either). Those stay unexercised
 * placeholders so the generic path does not throw if a future descriptor
 * uses one; report that rather than pretending it was tested. `'switch'`
 * itself is no longer purely a placeholder -- see the `labels` branch below,
 * which draws a real switch for any knob-kind layout item whose param
 * declares `labels`, without the descriptor needing to say `kind: 'switch'`
 * at all.
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
 * native meaning on a display). Row height is deliberately *not* a
 * matching fixed constant -- see `planRows` -- each row is sized to its own
 * content instead, so a row of jacks and a row of knobs are each exactly as
 * tall as they need to be.
 */
const HP_PX = 16
const MIN_PANEL_PX = 120

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
  // `width`, not `min-width`: Section 8 requires panel width to be
  // theme-independent, and `min-width` cannot deliver that because it lets
  // the panel shrink-to-fit its widest child -- which, for ordinary
  // modules, means the widest *label text*, and a label's rendered width
  // depends on the active theme's font-family/letter-spacing/font-size
  // tokens (Moog Wood's serif vs. Phosphor Lab's wider Courier New vs.
  // Reaktor Dark's own IBM Plex Mono measurably disagreed on it). A first
  // attempt at a hard `width` here broke ADSR -- not because `width` is
  // wrong, but because ADSR's own `hp` (8, 128px) was too small for its
  // four knobs in the first place: 128px split four ways leaves each grid
  // track well under the 38px a knob dial needs, and `min-width`'s
  // shrink-to-fit growth had been silently bailing that undersized
  // descriptor out the whole time. The real fix is both halves together:
  // every descriptor's `hp` is now audited against what its own layout
  // needs at that width (see each module file's `hp` and
  // .superpowers/sdd/themes-complete-report.md for the audit table), and
  // *only* with that audit done does pinning `width` stop being a
  // regression. `HP_PX` is deliberately not a theme token (Section 8: "if
  // it varies per theme, geometry is not identical") -- one arbitrary but
  // fixed px-per-hp scale, shared by every theme because it lives here,
  // not in a theme file. The keyboard's on-screen piano (`customPanel`)
  // still needs its own hp large enough to fit its fixed-420px content
  // (see keyboard-midi.ts) -- there is no longer a shrink-to-fit safety
  // net for it either.
  panel.style.width = `${Math.max(MIN_PANEL_PX, descriptor.hp * HP_PX)}px`

  const header = document.createElement('div')
  header.className = 'module-header'
  const name = document.createElement('span')
  name.className = 'module-name'
  name.textContent = descriptor.name
  header.append(name)

  if (opts.onRemove) {
    const removeBtn = document.createElement('button')
    removeBtn.type = 'button'
    removeBtn.className = 'module-remove'
    removeBtn.dataset['testid'] = `remove-${moduleId}`
    removeBtn.title = `Remove ${descriptor.name}`
    removeBtn.textContent = '×'
    removeBtn.addEventListener('click', () => opts.onRemove!(moduleId))
    header.append(removeBtn)
  }

  const plan = planRows(descriptor)
  const grid = document.createElement('div')
  grid.className = 'module-grid'
  grid.style.gridTemplateColumns = `repeat(${plan.cols}, 1fr)`
  grid.style.gridTemplateRows = `repeat(${plan.rows}, auto)`

  const portsById = new Map(descriptor.ports.map((p) => [p.id, p]))
  const paramsById = new Map(descriptor.params.map((p) => [p.id, p]))

  function buildParamControl(spec: ParamSpec): HTMLElement {
    const initial = graph.getParams(moduleId)[spec.id] ?? spec.default
    const onChange = (value: number): void => {
      graph.setParam(moduleId, spec.id, value)
      opts.onChange?.()
    }
    // A param with `labels` is discrete, not continuous (src/engine/types.ts)
    // -- draw the switch, not the knob, regardless of which `layout.kind`
    // the descriptor used to reach it. The decision lives entirely in the
    // descriptor's own `ParamSpec`, so no module is special-cased here.
    return spec.labels ? buildSwitch(spec, initial, onChange).el : buildKnob(spec, initial, onChange).el
  }

  for (const item of descriptor.layout) {
    let el: HTMLElement
    if (item.kind === 'knob') {
      const spec = paramsById.get(item.ref)
      if (!spec) throw new Error(`buildPanel: "${descriptor.type}" layout knob refers to unknown param "${item.ref}"`)
      el = buildParamControl(spec)
    } else if (item.kind === 'jack') {
      const port = portsById.get(item.ref)
      if (!port) throw new Error(`buildPanel: "${descriptor.type}" layout jack refers to unknown port "${item.ref}"`)
      el = buildJack(descriptor, moduleId, port, opts.jacks)
    } else if (item.kind === 'switch' && paramsById.get(item.ref)?.labels) {
      el = buildParamControl(paramsById.get(item.ref)!)
    } else {
      el = buildFallbackControl(item.kind, item.ref)
    }
    el.style.gridColumn = `${item.x + 1}`
    el.style.gridRow = `${plan.rowIndex(item) + 1}`
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
