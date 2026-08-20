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
    expect(result).toEqual({ pass: true, failures: [], detail: [] })
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

  it('uses "an" before a vowel-leading module type', () => {
    const result = inspect(patch(), { hasModule: ['output'] })
    expect(result.failures).toContain('the patch needs an output module')
  })
})

describe('inspect - maxModules', () => {
  beforeEach(() => {
    clearRegistry()
    registerModule(stubDescriptor('vco'))
    registerModule(stubDescriptor('vca'))
    registerModule(stubDescriptor('output'))
  })

  it('passes when the module count is at or under the cap', () => {
    const g = new PatchGraph(stubContext())
    g.addModule('vco')
    g.addModule('vca')
    g.addModule('output')
    const result = inspect(g, { maxModules: 2 })
    expect(result.pass).toBe(true)
    expect(result.detail).toEqual([])
  })

  it('fails, with a tooManyModules detail entry, once the count exceeds the cap', () => {
    const g = new PatchGraph(stubContext())
    g.addModule('vco')
    g.addModule('vco')
    g.addModule('vca')
    g.addModule('output')
    const result = inspect(g, { maxModules: 2 })
    expect(result.pass).toBe(false)
    expect(result.detail).toEqual([{ kind: 'tooManyModules', count: 3, max: 2 }])
  })

  it('never counts an Output module against the cap', () => {
    const g = new PatchGraph(stubContext())
    g.addModule('vco')
    g.addModule('output')
    g.addModule('output')
    g.addModule('output')
    // Three Output modules, one VCO -- the cap only ever sees the one VCO.
    const result = inspect(g, { maxModules: 1 })
    expect(result.pass).toBe(true)
  })

  it('is independent of connected/params checks -- both kinds of failure are reported together', () => {
    const g = new PatchGraph(stubContext())
    g.addModule('vco')
    g.addModule('vca')
    g.addModule('output')
    const result = inspect(g, { maxModules: 1, hasModule: ['output'] })
    expect(result.pass).toBe(false)
    expect(result.detail).toEqual([{ kind: 'tooManyModules', count: 2, max: 1 }])
  })
})

describe('inspect - type-based addressing', () => {
  beforeEach(() => {
    clearRegistry()
    registerModule(stubDescriptor('vco'))
    registerModule(stubDescriptor('output'))
    registerModule(stubDescriptor('vca'))
  })

  it('passes an existential connection check even with an unpatched duplicate present', () => {
    // The motivating bug: a level rubric written against a specific id
    // (`vco-1`) breaks the moment a second instance of the same type
    // exists, even when a real VCO is correctly patched to a real Output.
    const g = new PatchGraph(stubContext())
    g.addModule('vco') // vco-1, left unpatched
    const vco2 = g.addModule('vco') // vco-2, the one actually wired
    const output1 = g.addModule('output')
    g.connect([vco2, 'out'], [output1, 'in'])

    const result = inspect(g, {
      connected: [[{ type: 'vco' }, 'out', { type: 'output' }, 'in']],
    })
    expect(result.pass).toBe(true)
    expect(result.failures).toEqual([])
  })

  it('does not let two different instances each satisfy one half of a query', () => {
    // Two VCAs, one wired for CV, a different one wired for audio: no
    // single VCA actually does both jobs, so this must still fail even
    // though each clause alone has *some* satisfying instance.
    registerModule(stubDescriptor('adsr'))
    const g = new PatchGraph(stubContext())
    const vco1 = g.addModule('vco')
    const output1 = g.addModule('output')
    const adsr1 = g.addModule('adsr')
    const vcaCvOnly = g.addModule('vca')
    const vcaAudioOnly = g.addModule('vca')
    g.connect([adsr1, 'out'], [vcaCvOnly, 'in'])
    g.connect([vco1, 'out'], [vcaAudioOnly, 'in'])
    g.connect([vcaAudioOnly, 'out'], [output1, 'in'])

    const result = inspect(g, {
      connected: [
        [{ type: 'adsr' }, 'out', { type: 'vca' }, 'in'],
        [{ type: 'vca' }, 'out', { type: 'output' }, 'in'],
      ],
    })
    expect(result.pass).toBe(false)
  })

  it('passes the cross-clause case once one instance satisfies every clause', () => {
    registerModule(stubDescriptor('adsr'))
    const g = new PatchGraph(stubContext())
    const output1 = g.addModule('output')
    const adsr1 = g.addModule('adsr')
    const vca1 = g.addModule('vca')
    g.connect([adsr1, 'out'], [vca1, 'in'])
    g.connect([vca1, 'out'], [output1, 'in'])

    const result = inspect(g, {
      connected: [
        [{ type: 'adsr' }, 'out', { type: 'vca' }, 'in'],
        [{ type: 'vca' }, 'out', { type: 'output' }, 'in'],
      ],
    })
    expect(result.pass).toBe(true)
  })

  it('reports a missing-module sentence, not a bogus id, when a type has no instance at all', () => {
    const result = inspect(new PatchGraph(stubContext()), {
      connected: [[{ type: 'vco' }, 'out', { type: 'output' }, 'in']],
    })
    expect(result.pass).toBe(false)
    expect(result.failures).toEqual([
      'the patch needs a vco module',
      'the patch needs an output module',
    ])
  })

  it('still supports a plain id ref alongside a type ref', () => {
    const g = new PatchGraph(stubContext())
    const vco1 = g.addModule('vco', 'vco-1')
    const output1 = g.addModule('output', 'output-1')
    g.connect([vco1, 'out'], [output1, 'in'])

    const result = inspect(g, {
      connected: [['vco-1', 'out', { type: 'output' }, 'in']],
    })
    expect(result.pass).toBe(true)
  })
})
