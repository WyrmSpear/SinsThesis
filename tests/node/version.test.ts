import { describe, it, expect } from 'vitest'
import { ENGINE_VERSION } from '../../src/engine/version'

describe('engine version', () => {
  it('reports a semver string', () => {
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
