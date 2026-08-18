import type { PatchGraph } from '../graph'

/**
 * Structural queries over a patch.
 *
 * The test suite uses this to assert wiring; Phase 4's academy uses the same
 * calls to grade build-this-patch levels. Every failure is a sentence, because
 * a grade that says only "72%" teaches nothing.
 */
export interface InspectorQuery {
  /** Module types that must be present. */
  hasModule?: string[]
  /** [fromModuleId, fromPort, toModuleId, toPort] tuples that must be patched. */
  connected?: Array<[string, string, string, string]>
  params?: Array<{ module: string; param: string; value: number; tolerance?: number }>
}

export interface InspectorResult {
  pass: boolean
  failures: string[]
}

export function inspect(graph: PatchGraph, query: InspectorQuery): InspectorResult {
  const failures: string[] = []

  const presentTypes = graph.moduleIds.map((id) => graph.getType(id))
  for (const type of query.hasModule ?? []) {
    if (!presentTypes.includes(type)) failures.push(`the patch needs a ${type} module`)
  }

  for (const [fromId, fromPort, toId, toPort] of query.connected ?? []) {
    const found = graph.cables.some(
      (c) =>
        c.from[0] === fromId && c.from[1] === fromPort &&
        c.to[0] === toId && c.to[1] === toPort,
    )
    if (!found) failures.push(`${fromId}.${fromPort} is not patched to ${toId}.${toPort}`)
  }

  for (const check of query.params ?? []) {
    const tolerance = check.tolerance ?? 1e-6
    let actual: number | undefined
    try {
      actual = graph.getParams(check.module)[check.param]
    } catch {
      actual = undefined
    }
    if (actual === undefined) {
      failures.push(`${check.module} has no param "${check.param}"`)
    } else if (Math.abs(actual - check.value) > tolerance) {
      failures.push(
        `${check.module}.${check.param} reads ${actual}, but should be ` +
          `${check.value} (within ${tolerance})`,
      )
    }
  }

  return { pass: failures.length === 0, failures }
}
