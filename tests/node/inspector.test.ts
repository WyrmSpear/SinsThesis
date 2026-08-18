import { describe, it, expect, beforeEach } from 'vitest'
import { inspect } from '../../src/engine/analysis/inspector'
import { PatchGraph } from '../../src/engine/graph'
import { registerModule, clearRegistry } from '../../src/engine/registry'
import { stubDescriptor, stubContext } from '../helpers/stub-instance'

function patch(): PatchGraph {
  const g = new PatchGraph(stubContext())
  g.addModule('vco', 'osc')
  g.addModule('vcf', 'filter')
  g.setParam('filter', 'level', 0.5)
  g.connect(['osc', 'out'], ['filter', 'in'])
  return g
}

describe('inspect', () => {
  beforeEach(() => {
    clearRegistry()
    registerModule(stubDescriptor('vco'))
    registerModule(stubDescriptor('vcf'))
  })

  it('passes when every requirement holds', () => {
    const result = inspect(patch(), {
      hasModule: ['vco', 'vcf'],
      connected: [['osc', 'out', 'filter', 'in']],
      params: [{ module: 'filter', param: 'level', value: 0.5 }],
    })
    expect(result).toEqual({ pass: true, failures: [] })
  })

  it('names the missing module type', () => {
    const result = inspect(patch(), { hasModule: ['vca'] })
    expect(result.pass).toBe(false)
    expect(result.failures[0]).toMatch(/vca/)
  })

  it('names the missing connection', () => {
    const result = inspect(patch(), { connected: [['filter', 'out', 'osc', 'in']] })
    expect(result.pass).toBe(false)
    expect(result.failures[0]).toMatch(/filter/)
  })

  it('accepts a param within tolerance', () => {
    const result = inspect(patch(), {
      params: [{ module: 'filter', param: 'level', value: 0.52, tolerance: 0.05 }],
    })
    expect(result.pass).toBe(true)
  })

  it('rejects a param outside tolerance', () => {
    const result = inspect(patch(), {
      params: [{ module: 'filter', param: 'level', value: 0.9, tolerance: 0.05 }],
    })
    expect(result.pass).toBe(false)
  })

  it('collects every failure rather than stopping at the first', () => {
    const result = inspect(patch(), {
      hasModule: ['vca', 'delay'],
      params: [{ module: 'filter', param: 'level', value: 0.9 }],
    })
    expect(result.failures.length).toBe(3)
  })
})
