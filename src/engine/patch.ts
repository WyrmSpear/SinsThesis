import { PatchGraph } from './graph'
import { getModule } from './registry'

export const PATCH_VERSION = 1

export interface PatchModuleEntry {
  id: string
  type: string
  /** Rack position: [row, column], in horizontal pitch units. */
  slot: [number, number]
  params: Record<string, number>
}

export interface PatchCableEntry {
  from: [string, string]
  to: [string, string]
}

export interface PatchFile {
  version: typeof PATCH_VERSION
  meta: { name: string; created: string; author: string }
  modules: PatchModuleEntry[]
  cables: PatchCableEntry[]
}

export function serializePatch(
  graph: PatchGraph,
  meta: Partial<PatchFile['meta']> = {},
): PatchFile {
  return {
    version: PATCH_VERSION,
    meta: {
      name: meta.name ?? 'Untitled',
      created: meta.created ?? new Date().toISOString(),
      author: meta.author ?? '',
    },
    modules: graph.moduleIds.map((id) => ({
      id,
      type: graph.getType(id)!,
      slot: graph.getSlot(id),
      params: { ...graph.getParams(id) },
    })),
    cables: graph.cables.map((c) => ({
      from: [c.from[0], c.from[1]] as [string, string],
      to: [c.to[0], c.to[1]] as [string, string],
    })),
  }
}

/**
 * Rebuild a graph from a file.
 *
 * A module type the registry does not know becomes a ghost: it keeps its
 * params and its cables, so a file written by a later version of SinsThesis
 * round-trips through an older one instead of losing data. The returned
 * `ghosts` array names the missing types so the UI can say what did not load.
 */
export function loadPatch(
  ctx: BaseAudioContext,
  file: PatchFile,
): { graph: PatchGraph; ghosts: string[] } {
  if (file.version !== PATCH_VERSION) {
    throw new Error(
      `loadPatch: this build reads patch version ${PATCH_VERSION}, ` +
        `but the file declares version ${file.version}`,
    )
  }

  const graph = new PatchGraph(ctx)
  const ghosts: string[] = []

  for (const entry of file.modules) {
    if (getModule(entry.type)) {
      graph.addModule(entry.type, entry.id)
      for (const [paramId, value] of Object.entries(entry.params)) {
        graph.setParam(entry.id, paramId, value)
      }
    } else {
      graph.addGhost(entry.id, entry.type, entry.params)
      if (!ghosts.includes(entry.type)) ghosts.push(entry.type)
    }
    graph.setSlot(entry.id, entry.slot)
  }

  for (const cable of file.cables) {
    graph.connect(cable.from, cable.to)
  }

  return { graph, ghosts }
}
