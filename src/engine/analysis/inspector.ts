import type { PatchGraph } from '../graph'

/**
 * Structural queries over a patch.
 *
 * The test suite uses this to assert wiring; Phase 4's academy uses the same
 * calls to grade build-this-patch levels. Every failure is a sentence, because
 * a grade that says only "72%" teaches nothing.
 */

/**
 * How a query names a module: a specific id (`"vco-1"`, unchanged from the
 * original grader), or `{ type }` -- "any module of this type." A rubric
 * that only cares "some VCO reaches some Output," not which one, should
 * write the latter: the palette assigns ids like `vco-1`/`vco-2`
 * deterministically today, but a level that grants a type a player can add
 * more than one of, or a player who deletes and re-adds a module, breaks an
 * id-pinned query even though the patch is functionally correct. That is
 * the worst kind of grading bug for a teaching tool -- it tells a correct
 * player they are wrong.
 */
export type ModuleRef = string | { readonly type: string }

export interface InspectorQuery {
  /** Module types that must be present. */
  hasModule?: string[]
  /** [from, fromPort, to, toPort] tuples that must be patched. `from`/`to`
   *  may each be an id or a `{ type }` ref (see `ModuleRef`). */
  connected?: Array<[ModuleRef, string, ModuleRef, string]>
  params?: Array<{ module: ModuleRef; param: string; value: number; tolerance?: number }>
}

/** Which concrete module a `ModuleRef` actually resolved to when a query
 *  passed or failed, for a presentation layer to look up display names and
 *  port/param labels with. `inspect` never imports anything UI-facing
 *  itself -- this is plain data, the same shape whether the query named an
 *  id or a type. */
export interface ResolvedRef {
  readonly id: string
  readonly type: string
}

/** The structured form behind each of `InspectorResult.failures`' English
 *  sentences, same order. `inspect` still speaks in engine ids in
 *  `failures` -- academy/feedback.ts is where those get rephrased in a
 *  player's terms ("the second VCO," a port's label, a param's own units)
 *  without parsing English back out of a sentence or re-deriving the check. */
export type InspectorFailure =
  | { kind: 'missingModule'; type: string }
  | { kind: 'missingConnection'; from: ResolvedRef; fromPort: string; to: ResolvedRef; toPort: string }
  | { kind: 'missingParam'; module: ResolvedRef; param: string }
  | {
      kind: 'paramMismatch'
      module: ResolvedRef
      param: string
      actual: number
      expected: number
      tolerance: number
    }

export interface InspectorResult {
  pass: boolean
  failures: string[]
  /** One entry per `failures` string, in the same order. See `InspectorFailure`. */
  detail: InspectorFailure[]
}

function article(word: string): 'a' | 'an' {
  return /^[aeiou]/i.test(word) ? 'an' : 'a'
}

function isTypeRef(ref: ModuleRef): ref is { type: string } {
  return typeof ref === 'object'
}

export function inspect(graph: PatchGraph, query: InspectorQuery): InspectorResult {
  const failures: string[] = []
  const detail: InspectorFailure[] = []
  const reportedMissingTypes = new Set<string>()

  function reportMissingModule(type: string): void {
    if (reportedMissingTypes.has(type)) return
    reportedMissingTypes.add(type)
    failures.push(`the patch needs ${article(type)} ${type} module`)
    detail.push({ kind: 'missingModule', type })
  }

  const presentTypes = graph.moduleIds.map((id) => graph.getType(id))
  for (const type of query.hasModule ?? []) {
    if (!presentTypes.includes(type)) reportMissingModule(type)
  }

  // ---- type-ref resolution -------------------------------------------
  // A `{ type }` ref means "any module of this type," not one specific id.
  // When the same type is named more than once in a query, every
  // occurrence must resolve to the *same* concrete module -- e.g. a level
  // whose query says both "some ADSR's out reaches some VCA's cv" and
  // "some VCA's out reaches the Output" must not let two different VCAs
  // each satisfy one half; that would grade a patch that does not actually
  // work as passing, which is worse than grading it correctly as failing.
  // So below: find one assignment of a concrete module id to every type
  // named anywhere in the query, and report pass only if *some* assignment
  // makes every connected/params check true at once.
  const typeCandidates = new Map<string, string[]>()
  function candidatesFor(type: string): string[] {
    let list = typeCandidates.get(type)
    if (!list) {
      list = graph.moduleIds.filter((id) => graph.getType(id) === type)
      typeCandidates.set(type, list)
    }
    return list
  }

  const typesUsed = new Set<string>()
  for (const [from, , to] of query.connected ?? []) {
    if (isTypeRef(from)) typesUsed.add(from.type)
    if (isTypeRef(to)) typesUsed.add(to.type)
  }
  for (const p of query.params ?? []) {
    if (isTypeRef(p.module)) typesUsed.add(p.module.type)
  }

  const cleanTypes: string[] = []
  for (const type of typesUsed) {
    if (candidatesFor(type).length === 0) reportMissingModule(type)
    else cleanTypes.push(type)
  }

  // A connected/params entry naming a type with zero instances can never
  // pass -- `reportMissingModule` already said so above -- so it is left
  // out of the search below rather than adding a second, less useful
  // sentence about a module that does not exist yet.
  function refBlocked(ref: ModuleRef): boolean {
    return isTypeRef(ref) && candidatesFor(ref.type).length === 0
  }
  const liveConnected = (query.connected ?? []).filter(([from, , to]) => !refBlocked(from) && !refBlocked(to))
  const liveParams = (query.params ?? []).filter((p) => !refBlocked(p.module))

  function resolve(ref: ModuleRef, combo: ReadonlyMap<string, string>): ResolvedRef {
    if (typeof ref === 'string') return { id: ref, type: graph.getType(ref) ?? ref }
    return { id: combo.get(ref.type)!, type: ref.type }
  }

  function evaluate(combo: ReadonlyMap<string, string>): { failures: string[]; detail: InspectorFailure[] } {
    const f: string[] = []
    const d: InspectorFailure[] = []
    for (const [fromRef, fromPort, toRef, toPort] of liveConnected) {
      const from = resolve(fromRef, combo)
      const to = resolve(toRef, combo)
      const found = graph.cables.some(
        (c) => c.from[0] === from.id && c.from[1] === fromPort && c.to[0] === to.id && c.to[1] === toPort,
      )
      if (!found) {
        f.push(`${from.id}.${fromPort} is not patched to ${to.id}.${toPort}`)
        d.push({ kind: 'missingConnection', from, fromPort, to, toPort })
      }
    }
    for (const check of liveParams) {
      const mod = resolve(check.module, combo)
      const tolerance = check.tolerance ?? 1e-6
      let actual: number | undefined
      try {
        actual = graph.getParams(mod.id)[check.param]
      } catch {
        actual = undefined
      }
      if (actual === undefined) {
        f.push(`${mod.id} has no param "${check.param}"`)
        d.push({ kind: 'missingParam', module: mod, param: check.param })
      } else if (Math.abs(actual - check.value) > tolerance) {
        f.push(`${mod.id}.${check.param} reads ${actual}, but should be ${check.value} (within ${tolerance})`)
        d.push({
          kind: 'paramMismatch',
          module: mod,
          param: check.param,
          actual,
          expected: check.value,
          tolerance,
        })
      }
    }
    return { failures: f, detail: d }
  }

  // Cartesian product of candidate ids over every clean type used, capped
  // generously -- a real rack never carries enough instances of one module
  // type for this to matter, but the cap keeps a pathological patch from
  // hanging the check instead of just grading it.
  const MAX_COMBOS = 5000
  function* combos(): Generator<Map<string, string>> {
    if (cleanTypes.length === 0) {
      yield new Map()
      return
    }
    const lists = cleanTypes.map((t) => candidatesFor(t))
    const idx = lists.map(() => 0)
    for (let n = 0; n < MAX_COMBOS; n++) {
      const map = new Map<string, string>()
      cleanTypes.forEach((t, i) => map.set(t, lists[i]![idx[i]!]!))
      yield map

      let pos = idx.length - 1
      while (pos >= 0) {
        idx[pos]!++
        if (idx[pos]! < lists[pos]!.length) break
        idx[pos] = 0
        pos--
      }
      if (pos < 0) return
    }
  }

  let best: { failures: string[]; detail: InspectorFailure[] } | undefined
  for (const combo of combos()) {
    const result = evaluate(combo)
    if (result.failures.length === 0) {
      best = result
      break
    }
    if (!best || result.failures.length < best.failures.length) best = result
  }
  if (best) {
    failures.push(...best.failures)
    detail.push(...best.detail)
  }

  return { pass: failures.length === 0, failures, detail }
}
