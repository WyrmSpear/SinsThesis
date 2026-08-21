import { describe, it, expect, beforeEach } from 'vitest'
import { ccToParamValue, MidiLearnController, type MidiBinding } from '../../src/engine/midi-learn'
import { PatchGraph } from '../../src/engine/graph'
import { registerModule, clearRegistry } from '../../src/engine/registry'
import { stubDescriptor, stubContext } from '../helpers/stub-instance'
import type { ParamSpec } from '../../src/engine/types'

/**
 * `ccToParamValue`'s own mapping math: a raw MIDI CC byte (0-127) reaches
 * this function already normalized to [0, 1] (`parseMidiMessage`'s
 * `value: b / 127` for a `cc` event) -- so a test scenario "CC value 0/64/
 * 127" is expressed here as `0/127`, `64/127`, `127/127`, exactly what a
 * real controller sending those three bytes would produce.
 */
describe('ccToParamValue', () => {
  const LIN: Pick<ParamSpec, 'min' | 'max' | 'curve'> = { min: 20, max: 220, curve: 'lin' }
  const EXP: Pick<ParamSpec, 'min' | 'max' | 'curve'> = { min: 20, max: 20000, curve: 'exp' }

  it('linear: CC 0 lands on min', () => {
    expect(ccToParamValue(0 / 127, LIN)).toBeCloseTo(20, 9)
  })

  it('linear: CC 127 lands on max', () => {
    expect(ccToParamValue(127 / 127, LIN)).toBeCloseTo(220, 9)
  })

  it('linear: CC 64 lands proportionally, not at the exact midpoint (127 is not evenly divisible by 2)', () => {
    const t = 64 / 127
    expect(ccToParamValue(t, LIN)).toBeCloseTo(20 + t * (220 - 20), 9)
    // Sanity check on the asymmetry itself -- 64/127 is measurably off center.
    expect(t).not.toBeCloseTo(0.5, 3)
  })

  it('exponential: CC 0 lands on min', () => {
    expect(ccToParamValue(0 / 127, EXP)).toBeCloseTo(20, 6)
  })

  it('exponential: CC 127 lands on max', () => {
    expect(ccToParamValue(127 / 127, EXP)).toBeCloseTo(20000, 3)
  })

  it('exponential: CC 64 lands on the geometric (not linear) interpolation', () => {
    const t = 64 / 127
    const expected = 20 * Math.pow(20000 / 20, t)
    expect(ccToParamValue(t, EXP)).toBeCloseTo(expected, 6)
    // A linear parameter and an exponential one must disagree at the same
    // CC value -- otherwise the curve isn't doing anything.
    expect(ccToParamValue(t, EXP)).not.toBeCloseTo(ccToParamValue(t, LIN), 0)
  })

  it('clamps an out-of-range normalized value rather than extrapolating', () => {
    expect(ccToParamValue(-0.5, LIN)).toBeCloseTo(20, 9)
    expect(ccToParamValue(1.5, LIN)).toBeCloseTo(220, 9)
  })
})

const EXP_PARAM: ParamSpec = { id: 'cutoff', label: 'Cutoff', min: 20, max: 20000, default: 1000, curve: 'exp', unit: 'Hz' }
const LIN_PARAM: ParamSpec = { id: 'level', label: 'Level', min: 0, max: 1, default: 0.5, curve: 'lin', unit: '' }

function buildGraph(): PatchGraph {
  clearRegistry()
  registerModule(stubDescriptor('vcf', { params: [EXP_PARAM] }))
  registerModule(stubDescriptor('vca', { params: [LIN_PARAM] }))
  const graph = new PatchGraph(stubContext())
  graph.addModule('vcf', 'filter')
  graph.addModule('vca', 'amp')
  return graph
}

describe('MidiLearnController', () => {
  beforeEach(() => {
    clearRegistry()
  })

  it('starts with no bindings and nothing armed', () => {
    const c = new MidiLearnController()
    expect(c.all).toEqual([])
    expect(c.bindingFor('filter', 'cutoff')).toBeUndefined()
    expect(c.isArmed('filter', 'cutoff')).toBe(false)
  })

  it('arming a target and then routing a CC completes the binding and applies the value', () => {
    const graph = buildGraph()
    const c = new MidiLearnController()
    c.arm('filter', 'cutoff')
    expect(c.isArmed('filter', 'cutoff')).toBe(true)

    const touched = c.handleCc(graph, 74, 64 / 127)
    expect(touched).toEqual([{ controller: 74, moduleId: 'filter', paramId: 'cutoff' }])
    expect(c.isArmed('filter', 'cutoff')).toBe(false) // disarmed once bound
    expect(c.bindingFor('filter', 'cutoff')).toEqual({ controller: 74, moduleId: 'filter', paramId: 'cutoff' })

    const expected = 20 * Math.pow(20000 / 20, 64 / 127)
    expect(graph.getParams('filter')['cutoff']).toBeCloseTo(expected, 6)
  })

  it('a bound controller drives the param on every later message, through the same curve', () => {
    const graph = buildGraph()
    const c = new MidiLearnController([{ controller: 10, moduleId: 'amp', paramId: 'level' }])

    c.handleCc(graph, 10, 0)
    expect(graph.getParams('amp')['level']).toBeCloseTo(0, 9)

    c.handleCc(graph, 10, 1)
    expect(graph.getParams('amp')['level']).toBeCloseTo(1, 9)

    c.handleCc(graph, 10, 64 / 127)
    expect(graph.getParams('amp')['level']).toBeCloseTo(64 / 127, 9)
  })

  it('a CC message for an unbound controller changes nothing', () => {
    const graph = buildGraph()
    const c = new MidiLearnController([{ controller: 10, moduleId: 'amp', paramId: 'level' }])
    const before = graph.getParams('amp')['level']
    const touched = c.handleCc(graph, 99, 1)
    expect(touched).toEqual([])
    expect(graph.getParams('amp')['level']).toBe(before)
  })

  it('re-learning a controller onto a new target steals it from the old one', () => {
    const graph = buildGraph()
    const c = new MidiLearnController([{ controller: 10, moduleId: 'amp', paramId: 'level' }])
    c.arm('filter', 'cutoff')
    c.handleCc(graph, 10, 1)
    expect(c.bindingFor('filter', 'cutoff')).toEqual({ controller: 10, moduleId: 'filter', paramId: 'cutoff' })
    expect(c.bindingFor('amp', 'level')).toBeUndefined() // stolen away
    expect(c.all).toHaveLength(1)
  })

  it('re-learning a target that already had a different controller replaces it, not adds a second', () => {
    const graph = buildGraph()
    const c = new MidiLearnController([{ controller: 5, moduleId: 'filter', paramId: 'cutoff' }])
    c.arm('filter', 'cutoff')
    c.handleCc(graph, 10, 0.5)
    expect(c.all).toEqual([{ controller: 10, moduleId: 'filter', paramId: 'cutoff' }])
  })

  it('unbind removes exactly the named binding', () => {
    const c = new MidiLearnController([
      { controller: 1, moduleId: 'filter', paramId: 'cutoff' },
      { controller: 2, moduleId: 'amp', paramId: 'level' },
    ])
    c.unbind('filter', 'cutoff')
    expect(c.all).toEqual([{ controller: 2, moduleId: 'amp', paramId: 'level' }])
  })

  it('unbindModule removes every binding addressed to that module', () => {
    const bindings: MidiBinding[] = [
      { controller: 1, moduleId: 'filter', paramId: 'cutoff' },
      { controller: 2, moduleId: 'filter', paramId: 'resonance' },
      { controller: 3, moduleId: 'amp', paramId: 'level' },
    ]
    const c = new MidiLearnController(bindings)
    c.unbindModule('filter')
    expect(c.all).toEqual([{ controller: 3, moduleId: 'amp', paramId: 'level' }])
  })

  it('a CC message naming an unregistered module type is ignored, not thrown', () => {
    const graph = buildGraph()
    const c = new MidiLearnController([{ controller: 1, moduleId: 'ghost-module', paramId: 'x' }])
    expect(() => c.handleCc(graph, 1, 0.5)).not.toThrow()
  })

  it('the constructor takes a defensive copy: mutating the input array does not affect the controller', () => {
    const bindings: MidiBinding[] = [{ controller: 1, moduleId: 'filter', paramId: 'cutoff' }]
    const c = new MidiLearnController(bindings)
    bindings.push({ controller: 2, moduleId: 'amp', paramId: 'level' })
    expect(c.all).toHaveLength(1)
  })
})
