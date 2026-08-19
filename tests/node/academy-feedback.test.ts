import { describe, it, expect, beforeEach } from 'vitest'
import { PatchGraph } from '../../src/engine/graph'
import { registerModule, clearRegistry } from '../../src/engine/registry'
import { inspect } from '../../src/engine/analysis/inspector'
import { describeFailures } from '../../academy/feedback'
import { stubContext, stubNode } from '../helpers/stub-instance'
import { vcoDescriptor } from '../../src/engine/modules/vco'
import { vcfDescriptor } from '../../src/engine/modules/vcf'
import { outputDescriptor } from '../../src/engine/modules/output'
import type { ModuleDescriptor, ModuleInstance } from '../../src/engine/types'

/**
 * `academy/feedback.ts` is the presentation layer for a failed Check: it
 * turns `inspect`'s structured `detail` into the sentences a beginner
 * actually reads, in the words the level's own brief uses -- a
 * descriptor's display `name`, a port's `label`, "the second VCO" rather
 * than an internal id, and a param's own units. This suite exercises it
 * against the *real* module descriptors (for their real names/labels),
 * the same way tests/node/academy-levels.test.ts does, with `create()`
 * stubbed out so no real AudioContext is needed.
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

describe('describeFailures', () => {
  beforeEach(() => {
    clearRegistry()
    registerModule(stubbedFrom(vcoDescriptor))
    registerModule(stubbedFrom(vcfDescriptor))
    registerModule(stubbedFrom(outputDescriptor))
  })

  it('phrases a missing module with its display name and correct article', () => {
    const g = new PatchGraph(stubContext())
    const result = inspect(g, {
      connected: [[{ type: 'vco' }, 'out', { type: 'output' }, 'in']],
    })
    expect(describeFailures(result, g)).toEqual([
      'add a VCO module',
      'add an Output module',
    ])
  })

  it('phrases a missing connection with display names and port labels, not ids', () => {
    const g = new PatchGraph(stubContext())
    g.addModule('vco')
    g.addModule('output')
    const result = inspect(g, {
      connected: [[{ type: 'vco' }, 'out', { type: 'output' }, 'in']],
    })
    const [line] = describeFailures(result, g)
    expect(line).toBe(`patch the VCO's "Out" jack into the Output's "In" jack`)
    expect(line).not.toMatch(/vco-1|output-1/)
  })

  it('disambiguates by ordinal, not by id, when more than one instance exists', () => {
    const g = new PatchGraph(stubContext())
    const vco1 = g.addModule('vco')
    const vco2 = g.addModule('vco')
    const output1 = g.addModule('output')
    // vco1 stays unpatched; vco2 is the one that's actually wrong here.
    g.connect([vco1, 'out'], [output1, 'in'])
    const result = inspect(g, {
      connected: [
        [vco2, 'out', output1, 'in'],
      ],
    })
    expect(result.pass).toBe(false)
    const [line] = describeFailures(result, g)
    expect(line).toBe(`patch the second VCO's "Out" jack into the Output's "In" jack`)
  })

  it('says nothing about the second VCO when only one instance exists', () => {
    const g = new PatchGraph(stubContext())
    g.addModule('vco')
    g.addModule('output')
    const result = inspect(g, {
      connected: [[{ type: 'vco' }, 'out', { type: 'output' }, 'in']],
    })
    const [line] = describeFailures(result, g)
    expect(line).toContain('the VCO')
    expect(line).not.toContain('second')
  })

  it('phrases a param mismatch in the panel\'s own units', () => {
    const g = new PatchGraph(stubContext())
    const vcf1 = g.addModule('vcf')
    g.setParam(vcf1, 'resonance', 0.2)
    const result = inspect(g, {
      params: [{ module: { type: 'vcf' }, param: 'resonance', value: 0.95, tolerance: 0.05 }],
    })
    expect(result.pass).toBe(false)
    const [line] = describeFailures(result, g)
    expect(line).toBe(`turn the Ladder VCF's "Res" to about 0.95 -- it's at 0.2 now`)
  })

  it('produces no line at all when the check passes', () => {
    const g = new PatchGraph(stubContext())
    const vco1 = g.addModule('vco')
    const output1 = g.addModule('output')
    g.connect([vco1, 'out'], [output1, 'in'])
    const result = inspect(g, {
      connected: [[{ type: 'vco' }, 'out', { type: 'output' }, 'in']],
    })
    expect(result.pass).toBe(true)
    expect(describeFailures(result, g)).toEqual([])
  })
})
