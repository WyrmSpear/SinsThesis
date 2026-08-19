import { describe, it, expect, beforeEach } from 'vitest'
import { PatchGraph } from '../../src/engine/graph'
import { registerModule, clearRegistry } from '../../src/engine/registry'
import { loadPatch, type PatchFile } from '../../src/engine/patch'
import { inspect, type ModuleRef } from '../../src/engine/analysis/inspector'
import { LEVELS, getLevel } from '../../academy/levels'
import { stubContext, stubNode } from '../helpers/stub-instance'
import { vcoDescriptor } from '../../src/engine/modules/vco'
import { vcfDescriptor } from '../../src/engine/modules/vcf'
import { adsrDescriptor } from '../../src/engine/modules/adsr'
import { vcaDescriptor } from '../../src/engine/modules/vca'
import { lfoDescriptor } from '../../src/engine/modules/lfo'
import { keyboardMidiDescriptor } from '../../src/engine/modules/keyboard-midi'
import { outputDescriptor } from '../../src/engine/modules/output'
import type { ModuleDescriptor, ModuleInstance } from '../../src/engine/types'

/**
 * The academy's own worst-case bug is a level that cannot be beaten with
 * the modules it grants -- so this suite proves the opposite for every
 * level: its solution `.sinp` (a) uses only granted module types and (b)
 * actually satisfies its own `InspectorQuery`. Ids referenced anywhere in
 * a query are cross-checked against the solution's own module list, so a
 * typo'd module id in a rubric (which `inspect` would otherwise just
 * report as a generic "not patched" failure, indistinguishable from a
 * genuine miss) fails loudly here instead.
 *
 * Real module descriptors are imported for their `ports`/`params` --
 * exactly the ids academy rubrics are written against -- but `create()` is
 * replaced with a bare stub (`stubbedFrom`, mirroring
 * `tests/helpers/stub-instance.ts`'s own `stubDescriptor`), because the
 * real descriptors build actual WebAudio nodes (including
 * AudioWorkletNodes for vcf/adsr) that only exist with a real
 * AudioContext, which this plain-Node suite never constructs. Reusing the
 * real descriptor objects (rather than hand-copying port/param ids into
 * this file) means a future change to a module's ports can never silently
 * desync from what the academy tests against.
 */
function stubbedFrom(real: ModuleDescriptor): ModuleDescriptor {
  return {
    ...real,
    create(): ModuleInstance {
      const inputs = new Map<string, AudioNode | AudioParam>()
      const outputs = new Map<string, AudioNode>()
      for (const p of real.ports) {
        const node = stubNode() as unknown as AudioNode
        if (p.dir === 'in') inputs.set(p.id, node)
        else outputs.set(p.id, node)
      }
      const values = new Map<string, number>()
      return {
        inputs,
        outputs,
        setParam: (id, value) => values.set(id, value),
        dispose: () => values.clear(),
      }
    },
  }
}

const REAL_DESCRIPTORS = [
  vcoDescriptor, vcfDescriptor, adsrDescriptor, vcaDescriptor,
  lfoDescriptor, keyboardMidiDescriptor, outputDescriptor,
]

function loadGraph(file: PatchFile): PatchGraph {
  const { graph, ghosts } = loadPatch(stubContext(), file)
  expect(ghosts, `level solution/starting patch names an unregistered type: ${ghosts.join(', ')}`).toEqual([])
  return graph
}

describe('academy levels', () => {
  beforeEach(() => {
    clearRegistry()
    for (const d of REAL_DESCRIPTORS) registerModule(stubbedFrom(d))
  })

  it('defines at least four levels', () => {
    expect(LEVELS.length).toBeGreaterThanOrEqual(4)
  })

  it('every level id is unique', () => {
    const ids = LEVELS.map((l) => l.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  for (const level of LEVELS) {
    describe(level.id, () => {
      it('grants only real, registered module types', () => {
        for (const type of level.grantedModules) {
          expect(REAL_DESCRIPTORS.some((d) => d.type === type), `"${type}" is not a real module type`).toBe(true)
        }
      })

      it("the solution patch uses only modules the level grants", () => {
        for (const m of level.solution.modules) {
          expect(level.grantedModules, `solution uses "${m.type}" (${m.id}), which is not granted`).toContain(m.type)
        }
      })

      it('every module type the query requires is granted', () => {
        for (const type of level.query.hasModule ?? []) {
          expect(level.grantedModules, `query.hasModule requires "${type}", which is not granted`).toContain(type)
        }
      })

      it('every module the query references (by id or by type) resolves to a granted type', () => {
        // A rubric may name a module by its exact id (the original,
        // still-supported form) or by `{ type }` -- "any module of this
        // type" (src/engine/analysis/inspector.ts's `ModuleRef`). Either
        // way, whatever type it names must actually be one the level
        // grants, or the query can never be satisfied with what the
        // player's palette even offers.
        const typeOf = new Map(level.solution.modules.map((m) => [m.id, m.type]))
        function refType(ref: ModuleRef): string {
          if (typeof ref === 'object') return ref.type
          const type = typeOf.get(ref)
          expect(type, `query references module id "${ref}", which the solution never defines`).toBeDefined()
          return type!
        }

        const types = new Set<string>()
        for (const [fromRef, , toRef] of level.query.connected ?? []) {
          types.add(refType(fromRef))
          types.add(refType(toRef))
        }
        for (const p of level.query.params ?? []) types.add(refType(p.module))

        for (const type of types) {
          expect(level.grantedModules, `query references type "${type}", which is not granted`).toContain(type)
        }
      })

      it('is satisfiable: the solution patch, loaded, passes the query', () => {
        const graph = loadGraph(level.solution)
        const result = inspect(graph, level.query)
        expect(result.failures, 'a completable level must have a passing solution').toEqual([])
        expect(result.pass).toBe(true)
      })

      it('is not already solved by its own starting patch', () => {
        const graph = loadGraph(level.startingPatch)
        const result = inspect(graph, level.query)
        expect(result.pass, `${level.id}'s starting patch already satisfies its own query -- nothing to do`).toBe(false)
      })
    })
  }

  it('a starting patch chained from an earlier level is exactly that level\'s solution', () => {
    // Not re-parsing the rubric JSON here (levels.ts already resolved the
    // chain) -- this instead checks the resolved objects agree, which is
    // what actually matters: whoever's patch a player starts from really is
    // a patch some earlier level already proved passes its own query.
    const withParent = [
      ['02-shape-it', '01-first-sound'],
      ['03-play-notes', '02-shape-it'],
      ['04-modulate', '03-play-notes'],
      ['05-resonance', '04-modulate'],
    ] as const
    for (const [childId, parentId] of withParent) {
      const child = getLevel(childId)
      const parent = getLevel(parentId)
      expect(child, `expected level "${childId}"`).toBeDefined()
      expect(parent, `expected level "${parentId}"`).toBeDefined()
      expect(child!.startingPatch).toEqual(parent!.solution)
    }
  })

  it('the first level starts from an empty rack', () => {
    const first = LEVELS[0]!
    expect(first.startingPatch.modules).toEqual([])
    expect(first.startingPatch.cables).toEqual([])
  })
})
