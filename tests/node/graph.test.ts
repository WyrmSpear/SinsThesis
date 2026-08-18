import { describe, it, expect, beforeEach } from 'vitest'
import { PatchGraph, type Cable } from '../../src/engine/graph'
import { registerModule, clearRegistry } from '../../src/engine/registry'
import { stubDescriptor, stubContext, type StubNode } from '../helpers/stub-instance'
import { multipleDescriptor } from '../../src/engine/modules/multiple'
import { mixerDescriptor } from '../../src/engine/modules/mixer'

function nodeOf(graph: PatchGraph, moduleId: string, port: string): StubNode {
  const inst = graph.getInstance(moduleId)!
  return (inst.outputs.get(port) ?? inst.inputs.get(port)) as unknown as StubNode
}

describe('PatchGraph', () => {
  let graph: PatchGraph

  beforeEach(() => {
    clearRegistry()
    registerModule(stubDescriptor('vco'))
    registerModule(stubDescriptor('vcf'))
    graph = new PatchGraph(stubContext())
  })

  it('adds a module and returns its id', () => {
    const id = graph.addModule('vco')
    expect(typeof id).toBe('string')
    expect(graph.moduleIds).toContain(id)
    expect(graph.getType(id)).toBe('vco')
  })

  it('honors an explicit id', () => {
    expect(graph.addModule('vco', 'osc1')).toBe('osc1')
  })

  it('refuses an unregistered type', () => {
    expect(() => graph.addModule('nonexistent')).toThrow(/unknown module type/)
  })

  it('refuses a duplicate id', () => {
    graph.addModule('vco', 'osc1')
    expect(() => graph.addModule('vco', 'osc1')).toThrow(/already in the patch/)
  })

  it('connects two modules and wires the underlying nodes', () => {
    const a = graph.addModule('vco', 'a')
    const b = graph.addModule('vcf', 'b')
    const cable = graph.connect([a, 'out'], [b, 'in'])
    expect(cable.delayed).toBe(false)
    expect(cable.active).toBe(true)
    expect(graph.cables).toHaveLength(1)
    expect(nodeOf(graph, 'a', 'out').connections).toHaveLength(1)
  })

  it('refuses a cable to an unknown port', () => {
    graph.addModule('vco', 'a')
    graph.addModule('vcf', 'b')
    expect(() => graph.connect(['a', 'nope'], ['b', 'in'])).toThrow(/no output port/)
    expect(() => graph.connect(['a', 'out'], ['b', 'nope'])).toThrow(/no input port/)
  })

  it('marks a feedback cable as delayed and routes it through a delay node', () => {
    graph.addModule('vco', 'a')
    graph.addModule('vcf', 'b')
    graph.connect(['a', 'out'], ['b', 'in'])
    const feedback = graph.connect(['b', 'out'], ['a', 'in'])
    expect(feedback.delayed).toBe(true)
    // The output feeds the delay, not the destination directly.
    expect(nodeOf(graph, 'b', 'out').connections).toHaveLength(1)
  })

  it('disconnects a cable and unwires the nodes', () => {
    graph.addModule('vco', 'a')
    graph.addModule('vcf', 'b')
    const cable = graph.connect(['a', 'out'], ['b', 'in'])
    graph.disconnect(cable.id)
    expect(graph.cables).toHaveLength(0)
    expect(nodeOf(graph, 'a', 'out').connections).toHaveLength(0)
  })

  it('removes a module along with every cable touching it', () => {
    graph.addModule('vco', 'a')
    graph.addModule('vcf', 'b')
    graph.connect(['a', 'out'], ['b', 'in'])
    graph.removeModule('a')
    expect(graph.cables).toHaveLength(0)
    expect(graph.moduleIds).not.toContain('a')
  })

  it('permits any signal type to reach any other', () => {
    // Voltage is voltage: audio into a CV input is a technique, not an error.
    const a = graph.addModule('vco', 'a')
    const b = graph.addModule('vcf', 'b')
    expect(() => graph.connect([a, 'out'], [b, 'in'])).not.toThrow()
  })

  it('holds ghost modules without wiring them', () => {
    graph.addModule('vco', 'a')
    graph.addGhost('mystery', 'quantum-vco', { drift: 0.7 })
    const cable = graph.connect(['a', 'out'], ['mystery', 'in'])
    expect(cable.active).toBe(false)
    expect(graph.getType('mystery')).toBe('quantum-vco')
    expect(nodeOf(graph, 'a', 'out').connections).toHaveLength(0)
  })

  it('removes a module that sits at both ends of different cables', () => {
    graph.addModule('vco', 'a')
    graph.addModule('vcf', 'b')
    graph.addModule('vco', 'c')
    graph.connect(['a', 'out'], ['b', 'in'])
    graph.connect(['b', 'out'], ['c', 'in'])
    graph.removeModule('b')
    expect(graph.cables).toHaveLength(0)
    expect([...graph.moduleIds].sort()).toEqual(['a', 'c'])
  })

  it('drops the delay node when a feedback cable is removed', () => {
    graph.addModule('vco', 'a')
    graph.addModule('vcf', 'b')
    graph.connect(['a', 'out'], ['b', 'in'])
    const feedback = graph.connect(['b', 'out'], ['a', 'in'])
    expect(feedback.delayed).toBe(true)
    graph.removeModule('b')
    expect(graph.cables).toHaveLength(0)
    // A second feedback cable must get a fresh delay, not a stale one.
    graph.addModule('vcf', 'b2')
    graph.connect(['a', 'out'], ['b2', 'in'])
    expect(graph.connect(['b2', 'out'], ['a', 'in']).delayed).toBe(true)
  })

  // A3: outNode.disconnect(inNode) removes *every* connection between that
  // node pair, not just the one cable being removed. Reachable today
  // because all four `multiple` outputs are the same GainNode -- two
  // cables from one mult landing on the same mixer input share an
  // (outNode, inNode) endpoint pair, so disconnecting either used to kill
  // both while `cableList` still listed the survivor.
  it('disconnecting one cable does not sever a sibling cable sharing the same endpoint pair', () => {
    clearRegistry()
    registerModule(multipleDescriptor)
    registerModule(mixerDescriptor)
    const g = new PatchGraph(stubContext())

    const mult = g.addModule('multiple', 'm')
    const mix = g.addModule('mixer', 'mix')
    // out1 and out2 are the *same* underlying GainNode (see multiple.ts),
    // both landing on mixer in1 -- the exact repro from the finding.
    const cableA = g.connect([mult, 'out1'], [mix, 'in1'])
    const cableB = g.connect([mult, 'out2'], [mix, 'in1'])

    g.disconnect(cableA.id)

    expect(g.cables.map((c) => c.id)).toEqual([cableB.id])

    const multOut = nodeOf(g, mult, 'out1')
    const mixIn1 = nodeOf(g, mix, 'in1')
    // The survivor's own path (mult -> its passthrough -> mixer in1) must
    // still be intact: exactly one outgoing connection remains on the
    // mult's node, and it still reaches mixIn1 through its passthrough.
    expect(multOut.connections).toHaveLength(1)
    const survivorPass = multOut.connections[0] as StubNode
    expect(survivorPass.connections).toContain(mixIn1)
  })

  it('genuinely disconnects the delay node when a feedback cable is removed, not just drops it from bookkeeping', () => {
    graph.addModule('vco', 'a')
    graph.addModule('vcf', 'b')
    graph.connect(['a', 'out'], ['b', 'in'])
    const feedback = graph.connect(['b', 'out'], ['a', 'in'])
    expect(feedback.delayed).toBe(true)

    const bOut = nodeOf(graph, 'b', 'out')
    expect(bOut.connections).toHaveLength(1) // b.out -> delay
    const delayNode = bOut.connections[0] as StubNode

    graph.disconnect(feedback.id)

    // Not just removed from the cable list -- the delay node's own
    // outgoing connection into a.in must be gone too, and b.out must no
    // longer reach the (now stale) delay node at all.
    expect(delayNode.connections).toHaveLength(0)
    expect(bOut.connections).toHaveLength(0)
  })

  it('does not expose its internal cable array', () => {
    graph.addModule('vco', 'a')
    graph.addModule('vcf', 'b')
    graph.connect(['a', 'out'], ['b', 'in'])
    ;(graph.cables as Cable[]).length = 0
    expect(graph.cables).toHaveLength(1)
  })
})
