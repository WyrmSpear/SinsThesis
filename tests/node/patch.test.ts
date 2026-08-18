import { describe, it, expect, beforeEach } from 'vitest'
import { serializePatch, loadPatch, type PatchFile } from '../../src/engine/patch'
import { PatchGraph } from '../../src/engine/graph'
import { registerModule, clearRegistry } from '../../src/engine/registry'
import { stubDescriptor, stubContext } from '../helpers/stub-instance'

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
