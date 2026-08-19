import type { PatchGraph } from '../src/engine/graph'
import type { JackRegistry } from './panel'

/**
 * A placeholder panel for a ghost module -- a module type this build's
 * registry does not know, kept alive by `PatchGraph.addGhost` /
 * `loadPatch` (`src/engine/patch.ts`) purely so its params and cables
 * round-trip through a save/load cycle instead of being silently dropped.
 * `buildPanel` (panel.ts) cannot draw one: it reads a `ModuleDescriptor`,
 * and a ghost has none by definition. This is the second, honest renderer
 * that exists precisely because of that -- it never guesses at a shape for
 * the unknown module, it only shows what the patch file actually recorded:
 * the raw type name, the raw param values, and jacks for whichever ports
 * its cables name (with no signal type or label to show, since none is
 * known).
 */

export function buildGhostPanel(
  moduleId: string,
  type: string,
  graph: PatchGraph,
  jacks: JackRegistry,
  onRemove: (moduleId: string) => void,
): HTMLElement {
  const panel = document.createElement('div')
  panel.className = 'module-panel module-panel-ghost'
  panel.dataset['module'] = moduleId
  panel.dataset['type'] = type
  panel.dataset['testid'] = `module-${moduleId}`
  panel.dataset['ghost'] = 'true'

  const header = document.createElement('div')
  header.className = 'module-header'
  const name = document.createElement('span')
  name.className = 'module-name'
  name.textContent = `UNKNOWN: ${type}`
  header.append(name)

  const removeBtn = document.createElement('button')
  removeBtn.type = 'button'
  removeBtn.className = 'module-remove'
  removeBtn.dataset['testid'] = `remove-${moduleId}`
  removeBtn.title = `Remove ${type} (unknown)`
  removeBtn.textContent = '×'
  removeBtn.addEventListener('click', () => onRemove(moduleId))
  header.append(removeBtn)

  const note = document.createElement('p')
  note.className = 'ghost-note'
  note.textContent = `This build does not have a "${type}" module. Its params and cables are kept as-is and will be written back out on the next save.`

  const params = graph.getParams(moduleId)
  const paramList = document.createElement('dl')
  paramList.className = 'ghost-params'
  for (const [id, value] of Object.entries(params)) {
    const dt = document.createElement('dt')
    dt.textContent = id
    const dd = document.createElement('dd')
    dd.textContent = String(value)
    paramList.append(dt, dd)
  }

  // A ghost has no descriptor, so there is no `PortSpec` to read a port's
  // direction or signal type from -- only its id, and only for the ports
  // its own cables actually name. `dir` per port is inferred from which
  // side of a cable it appears on, since that is the only fact this patch
  // file actually recorded about it.
  const portDirs = new Map<string, 'in' | 'out'>()
  for (const cable of graph.cables) {
    if (cable.from[0] === moduleId) portDirs.set(cable.from[1], 'out')
    if (cable.to[0] === moduleId) portDirs.set(cable.to[1], 'in')
  }

  const jackRow = document.createElement('div')
  jackRow.className = 'ghost-jacks'
  for (const [portId, dir] of portDirs) {
    const el = document.createElement('div')
    el.className = `jack signal-unknown dir-${dir}`
    el.dataset['module'] = moduleId
    el.dataset['port'] = portId
    el.dataset['signal'] = 'unknown'
    el.dataset['dir'] = dir
    el.dataset['testid'] = `jack-${moduleId}-${portId}`
    el.title = `${type} (unknown) — ${portId}`

    const socket = document.createElement('div')
    socket.className = 'jack-socket'
    const label = document.createElement('span')
    label.className = 'jack-label'
    label.textContent = portId

    el.append(socket, label)
    jacks.register(moduleId, portId, el)
    jackRow.append(el)
  }

  panel.append(header, note, paramList, jackRow)
  return panel
}
