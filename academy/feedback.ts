import { getModule } from '../src/engine/registry'
import type { PatchGraph } from '../src/engine/graph'
import type { InspectorFailure, InspectorResult, ResolvedRef } from '../src/engine/analysis/inspector'

/**
 * Turns an `InspectorResult` into the sentences the academy panel actually
 * shows a player -- the presentation layer `inspect`'s own doc comment asks
 * for. `inspect` (src/engine/analysis/inspector.ts) stays engine-facing on
 * purpose: its `failures` strings speak in module ids (`vco-1`) because
 * they're also what the test suite asserts against, and the engine must
 * never import anything UI-shaped. This file lives in `academy/` instead,
 * one level up, and reads `InspectorResult.detail` -- structured
 * module/port/param identity, not English -- to build text in the same
 * words the level's own brief uses:
 *
 * - a module's `ModuleDescriptor.name` ("Ladder VCF"), never its `type`
 *   string ("vcf") or id ("vcf-1")
 * - a port's `PortSpec.label` ("Out", "1V/Oct"), never its port id
 * - "the second VCO" when the patch has more than one instance of a type,
 *   since the id that disambiguates them internally (`vco-2`) is never
 *   shown anywhere in the rack's own UI
 * - a param's own unit and, for a discrete param, its switch position's
 *   label -- never a bare number the panel itself never displays
 *
 * Nothing here re-derives pass/fail or re-reads the graph for wiring --
 * that stays `inspect`'s job entirely. This only rephrases what it already
 * found.
 */

function article(name: string): 'a' | 'an' {
  const word = name.trim().split(/[\s/]+/)[0] ?? name
  // Acronyms are read letter by letter ("el-eff-oh"), so the article
  // follows how the *letter's name* sounds, not the letter itself -- "an
  // LFO," never "a LFO." The classic set of letters whose own names start
  // with a vowel sound: A, E, F, H, I, L, M, N, O, R, S, X.
  if (/^[A-Z]{2,}$/.test(word)) return 'AEFHILMNORSX'.includes(word[0]!) ? 'an' : 'a'
  return /^[aeiou]/i.test(word) ? 'an' : 'a'
}

const ORDINALS = [
  'first', 'second', 'third', 'fourth', 'fifth',
  'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
]
function ordinal(n: number): string {
  return ORDINALS[n - 1] ?? `${n}th`
}

/** "the VCO" when the patch has only one; "the second VCO" -- by creation
 *  order, the same order the palette assigns ids in -- once there's more
 *  than one. Never the bare id a beginner has no way to have seen. */
function describeModule(ref: ResolvedRef, graph: PatchGraph): string {
  const name = getModule(ref.type)?.name ?? ref.type
  const sameType = graph.moduleIds.filter((id) => graph.getType(id) === ref.type)
  if (sameType.length <= 1) return `the ${name}`
  const index = sameType.indexOf(ref.id)
  return index === -1 ? `the ${name}` : `the ${ordinal(index + 1)} ${name}`
}

function moduleArticle(type: string): string {
  const name = getModule(type)?.name ?? type
  return `${article(name)} ${name}`
}

function portLabel(type: string, portId: string): string {
  return getModule(type)?.ports.find((p) => p.id === portId)?.label ?? portId
}

/** A param's value, in the words the knob itself shows: a discrete param's
 *  switch-position label when it has one, otherwise a couple of decimal
 *  places and the panel's own unit suffix -- never a raw float. */
function formatParamValue(type: string, paramId: string, value: number): string {
  const spec = getModule(type)?.params.find((p) => p.id === paramId)
  if (!spec) return String(value)
  if (spec.labels) {
    const index = Math.round(value) - spec.min
    return spec.labels[index] ?? String(value)
  }
  const rounded = Math.round(value * 100) / 100
  return spec.unit ? `${rounded}${spec.unit}` : `${rounded}`
}

export function describeFailure(failure: InspectorFailure, graph: PatchGraph): string {
  switch (failure.kind) {
    case 'missingModule':
      return `add ${moduleArticle(failure.type)} module`

    case 'missingConnection': {
      const from = describeModule(failure.from, graph)
      const to = describeModule(failure.to, graph)
      const fromPort = portLabel(failure.from.type, failure.fromPort)
      const toPort = portLabel(failure.to.type, failure.toPort)
      return `patch ${from}'s "${fromPort}" jack into ${to}'s "${toPort}" jack`
    }

    case 'missingParam': {
      const mod = describeModule(failure.module, graph)
      return `${mod} has no "${failure.param}" control`
    }

    case 'paramMismatch': {
      const mod = describeModule(failure.module, graph)
      const spec = getModule(failure.module.type)?.params.find((p) => p.id === failure.param)
      const label = spec?.label ?? failure.param
      const target = formatParamValue(failure.module.type, failure.param, failure.expected)
      const actual = formatParamValue(failure.module.type, failure.param, failure.actual)
      return `turn ${mod}'s "${label}" to about ${target} -- it's at ${actual} now`
    }
  }
}

/** Player-facing rephrasing of `result.failures`, same order and length. */
export function describeFailures(result: InspectorResult, graph: PatchGraph): string[] {
  return result.detail.map((f) => describeFailure(f, graph))
}
