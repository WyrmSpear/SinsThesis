import { describe, it, expect, beforeEach } from 'vitest'
import { serializePatch, loadPatch, type PatchFile } from '../../src/engine/patch'
import { PatchGraph } from '../../src/engine/graph'
import { registerModule, clearRegistry } from '../../src/engine/registry'
import { stubDescriptor, stubContext, stubNode } from '../helpers/stub-instance'
import type { ModuleDescriptor, ModuleInstance } from '../../src/engine/types'

function buildPatch(): PatchGraph {
  const graph = new PatchGraph(stubContext())
  graph.addModule('vco', 'osc')
  graph.addModule('vcf', 'filter')
  graph.setParam('osc', 'level', 0.8)
  graph.connect(['osc', 'out'], ['filter', 'in'])
  graph.setSlot('filter', [1, 4])
  return graph
}

describe('patch format', () => {
  beforeEach(() => {
    clearRegistry()
    registerModule(stubDescriptor('vco'))
    registerModule(stubDescriptor('vcf'))
  })

  it('serializes modules, params, and cables', () => {
    const file = serializePatch(buildPatch(), { name: 'Test' })
    expect(file.version).toBe(1)
    expect(file.meta.name).toBe('Test')
    expect(file.modules.map((m) => m.id).sort()).toEqual(['filter', 'osc'])
    expect(file.modules.find((m) => m.id === 'osc')!.params.level).toBe(0.8)
    expect(file.cables).toEqual([{ from: ['osc', 'out'], to: ['filter', 'in'] }])
  })

  it('stores no theme, so a patch travels across skins', () => {
    expect(JSON.stringify(serializePatch(buildPatch()))).not.toMatch(/theme/i)
  })

  it('round-trips a patch without loss', () => {
    const original = serializePatch(buildPatch(), { name: 'Round' })
    const { graph, ghosts } = loadPatch(stubContext(), original)
    expect(ghosts).toEqual([])
    const again = serializePatch(graph, { name: 'Round', created: original.meta.created })
    expect(again).toEqual(original)
  })

  it('loads an unknown module type as a ghost and reports it', () => {
    const file: PatchFile = {
      version: 1,
      meta: { name: 'Future', created: '2026-08-18T00:00:00.000Z', author: '' },
      modules: [
        { id: 'osc', type: 'vco', slot: [0, 0], params: { level: 0.5 } },
        { id: 'x', type: 'quantum-vco', slot: [0, 1], params: { drift: 0.7 } },
      ],
      cables: [{ from: ['osc', 'out'], to: ['x', 'in'] }],
    }
    const { graph, ghosts } = loadPatch(stubContext(), file)
    expect(ghosts).toEqual(['quantum-vco'])
    expect(graph.getType('x')).toBe('quantum-vco')
    expect(graph.cables[0]!.active).toBe(false)
  })

  it('writes a ghost back out with its params and cables intact', () => {
    const file: PatchFile = {
      version: 1,
      meta: { name: 'Future', created: '2026-08-18T00:00:00.000Z', author: '' },
      modules: [{ id: 'x', type: 'quantum-vco', slot: [2, 3], params: { drift: 0.7 } }],
      cables: [],
    }
    const { graph } = loadPatch(stubContext(), file)
    const out = serializePatch(graph, file.meta)
    expect(out.modules[0]).toEqual({
      id: 'x', type: 'quantum-vco', slot: [2, 3], params: { drift: 0.7 },
    })
  })

  it('preserves a cable between two ghost modules', () => {
    const file: PatchFile = {
      version: 1,
      meta: { name: 'Two ghosts', created: '2026-08-18T00:00:00.000Z', author: '' },
      modules: [
        { id: 'g1', type: 'quantum-vco', slot: [0, 0], params: { drift: 0.7 } },
        { id: 'g2', type: 'quantum-vcf', slot: [0, 1], params: { warp: 0.2 } },
      ],
      cables: [{ from: ['g1', 'out'], to: ['g2', 'in'] }],
    }
    const { graph, ghosts } = loadPatch(stubContext(), file)
    expect(ghosts.sort()).toEqual(['quantum-vcf', 'quantum-vco'])
    expect(graph.cables[0]!.active).toBe(false)
    expect(serializePatch(graph, file.meta)).toEqual(file)
  })

  it('rejects a file from a newer format version', () => {
    const file = { ...serializePatch(buildPatch()), version: 99 } as unknown as PatchFile
    expect(() => loadPatch(stubContext(), file)).toThrow(/version 99/)
  })
})

/**
 * MIDI bindings: the same "absent means none, present only when non-empty"
 * convention `state` already established above, proven the same way --
 * omission for the ordinary case, round trip when present, and (the point
 * of this whole section) an existing file written before MIDI learn
 * existed loads without throwing and reports no bindings at all.
 */
describe('patch format: MIDI bindings', () => {
  beforeEach(() => {
    clearRegistry()
    registerModule(stubDescriptor('vco'))
    registerModule(stubDescriptor('vcf'))
  })

  it('omits midiBindings entirely when there are none', () => {
    const file = serializePatch(buildPatch(), { name: 'Test' })
    expect(file).not.toHaveProperty('midiBindings')
    expect(JSON.stringify(file)).not.toContain('midiBindings')
  })

  it('serializes bindings when given some', () => {
    const file = serializePatch(buildPatch(), { name: 'Test' }, [{ controller: 74, moduleId: 'osc', paramId: 'level' }])
    expect(file.midiBindings).toEqual([{ controller: 74, moduleId: 'osc', paramId: 'level' }])
  })

  it('round-trips bindings through load -> serialize unchanged', () => {
    const bindings = [{ controller: 1, moduleId: 'osc', paramId: 'level' }]
    const original = serializePatch(buildPatch(), { name: 'Round' }, bindings)
    const { graph, midiBindings } = loadPatch(stubContext(), original)
    expect(midiBindings).toEqual(bindings)
    const again = serializePatch(graph, { name: 'Round', created: original.meta.created }, midiBindings)
    expect(again).toEqual(original)
  })

  it('an old-format file with no midiBindings field loads cleanly and reports an empty list', () => {
    const oldFormatFile: PatchFile = {
      version: 1,
      meta: { name: 'Pre-MIDI', created: '2026-01-01T00:00:00.000Z', author: '' },
      modules: [{ id: 'osc', type: 'vco', slot: [0, 0], params: { level: 0.5 } }],
      cables: [],
    }
    expect(oldFormatFile).not.toHaveProperty('midiBindings')
    const { graph, ghosts, midiBindings } = loadPatch(stubContext(), oldFormatFile)
    expect(ghosts).toEqual([])
    expect(midiBindings).toEqual([])
    expect(graph.getParams('osc')['level']).toBe(0.5)
  })

  it('mutating the file after serialization does not leak back into the graph\'s bindings', () => {
    const bindings = [{ controller: 1, moduleId: 'osc', paramId: 'level' }]
    const file = serializePatch(buildPatch(), {}, bindings)
    bindings.push({ controller: 2, moduleId: 'osc', paramId: 'level' })
    expect(file.midiBindings).toHaveLength(1)
  })
})

/**
 * The generic `state` channel `ModuleInstance.serializeState`/
 * `restoreState` (types.ts) added for the Sampler -- see that module's own
 * doc comment for why embedding audio needed a second, non-numeric
 * persistence path at all. Exercised here against a plain stub rather than
 * a real Sampler instance because building one needs a real `AudioContext`
 * (an `AudioWorkletNode`), which this plain-Node suite never constructs
 * (the same reason tests/node/preset-bank.test.ts stubs every real
 * descriptor's `create()`) -- but the round-trip machinery under test here
 * is entirely `patch.ts`/`graph.ts`'s own, oblivious to what a module's
 * `state` payload actually means, so a stub proves it completely.
 */
function statefulDescriptor(type: string, initialState: unknown): ModuleDescriptor {
  return {
    ...stubDescriptor(type),
    create(): ModuleInstance {
      let state = initialState
      const restoreCalls: unknown[] = []
      const node = stubNode() as unknown as AudioNode
      return {
        inputs: new Map([['in', node]]),
        outputs: new Map([['out', node]]),
        setParam: () => {},
        dispose: () => {},
        serializeState: () => state,
        restoreState: (data: unknown) => {
          state = data
          restoreCalls.push(data)
        },
        // Exposed for assertions only, not part of the interface.
        ...({ __restoreCalls: restoreCalls } as object),
      }
    },
  }
}

describe('patch format: module state (Sampler-motivated)', () => {
  beforeEach(() => {
    clearRegistry()
    registerModule(stubDescriptor('vco'))
    registerModule(statefulDescriptor('stateful', { blob: 'hello', n: 42 }))
  })

  it('omits the state field entirely for a module with no serializeState', () => {
    const graph = new PatchGraph(stubContext())
    graph.addModule('vco', 'osc')
    const file = serializePatch(graph)
    expect(file.modules[0]).not.toHaveProperty('state')
    expect(JSON.stringify(file)).not.toContain('"state"')
  })

  it('serializes a stateful module\'s own state alongside its numeric params', () => {
    const graph = new PatchGraph(stubContext())
    graph.addModule('stateful', 'sub')
    const file = serializePatch(graph)
    expect(file.modules[0]!.state).toEqual({ blob: 'hello', n: 42 })
  })

  it('round-trips state through save -> load -> save unchanged', () => {
    const graph = new PatchGraph(stubContext())
    graph.addModule('stateful', 'sub')
    const first = serializePatch(graph)

    const { graph: reloaded } = loadPatch(stubContext(), first)
    const second = serializePatch(reloaded)
    expect(second.modules[0]!.state).toEqual(first.modules[0]!.state)
  })

  it('calls restoreState with exactly what serializeState produced, after params are applied', () => {
    const file: PatchFile = {
      version: 1,
      meta: { name: 'State', created: '2026-08-20T00:00:00.000Z', author: '' },
      modules: [{ id: 'sub', type: 'stateful', slot: [0, 0], params: { level: 0.9 }, state: { blob: 'restored', n: 7 } }],
      cables: [],
    }
    const { graph } = loadPatch(stubContext(), file)
    const instance = graph.getInstance('sub') as unknown as { __restoreCalls: unknown[] }
    expect(instance.__restoreCalls).toEqual([{ blob: 'restored', n: 7 }])
    expect(graph.getExtraState('sub')).toEqual({ blob: 'restored', n: 7 })
  })

  it('a ghost (unregistered type) preserves its opaque state through a round trip', () => {
    const file: PatchFile = {
      version: 1,
      meta: { name: 'Future', created: '2026-08-20T00:00:00.000Z', author: '' },
      modules: [{ id: 'x', type: 'quantum-sampler', slot: [0, 0], params: {}, state: { audio: 'base64...' } }],
      cables: [],
    }
    const { graph, ghosts } = loadPatch(stubContext(), file)
    expect(ghosts).toEqual(['quantum-sampler'])
    expect(serializePatch(graph, file.meta)).toEqual(file)
  })
})
