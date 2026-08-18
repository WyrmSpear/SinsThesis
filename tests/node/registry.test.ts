import { describe, it, expect, beforeEach } from 'vitest'
import { registerModule, getModule, listModules, clearRegistry } from '../../src/engine/registry'
import { stubDescriptor } from '../helpers/stub-instance'

describe('registry', () => {
  beforeEach(() => clearRegistry())

  it('returns undefined for an unregistered type', () => {
    expect(getModule('vco')).toBeUndefined()
  })

  it('stores and retrieves a descriptor', () => {
    const d = stubDescriptor('vco')
    registerModule(d)
    expect(getModule('vco')).toBe(d)
  })

  it('lists registered descriptors', () => {
    registerModule(stubDescriptor('vco'))
    registerModule(stubDescriptor('vcf'))
    expect(listModules().map((d) => d.type).sort()).toEqual(['vcf', 'vco'])
  })

  it('rejects a duplicate type', () => {
    registerModule(stubDescriptor('vco'))
    expect(() => registerModule(stubDescriptor('vco'))).toThrow(/already registered/)
  })

  it('rejects duplicate port ids within a module', () => {
    const d = stubDescriptor('bad')
    d.ports = [
      { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [0, 0] },
      { id: 'out', dir: 'in', signal: 'audio', label: 'In', pos: [0, 1] },
    ]
    expect(() => registerModule(d)).toThrow(/duplicate port/)
  })

  it('rejects a param whose default sits outside its range', () => {
    const d = stubDescriptor('bad')
    d.params = [
      { id: 'freq', label: 'Freq', min: 20, max: 20000, default: 0, curve: 'exp', unit: 'Hz' },
    ]
    expect(() => registerModule(d)).toThrow(/default/)
  })

  it('rejects a layout item referencing an unknown port or param', () => {
    const d = stubDescriptor('bad')
    d.layout = [{ kind: 'knob', ref: 'nonexistent', x: 0, y: 0 }]
    expect(() => registerModule(d)).toThrow(/unknown reference/)
  })
})
