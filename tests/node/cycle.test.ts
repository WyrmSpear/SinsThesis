import { describe, it, expect } from 'vitest'
import { createsCycle } from '../../src/engine/cycle'

describe('createsCycle', () => {
  it('permits an edge in an empty graph', () => {
    expect(createsCycle([], 'a', 'b')).toBe(false)
  })

  it('detects a direct self-connection', () => {
    expect(createsCycle([], 'a', 'a')).toBe(true)
  })

  it('detects a two-module loop', () => {
    expect(createsCycle([['a', 'b']], 'b', 'a')).toBe(true)
  })

  it('detects a long loop', () => {
    const edges = [['a', 'b'], ['b', 'c'], ['c', 'd']] as const
    expect(createsCycle(edges, 'd', 'a')).toBe(true)
  })

  it('permits a diamond, which is not a cycle', () => {
    const edges = [['a', 'b'], ['a', 'c'], ['b', 'd']] as const
    expect(createsCycle(edges, 'c', 'd')).toBe(false)
  })

  it('permits a second cable between the same pair in the same direction', () => {
    expect(createsCycle([['a', 'b']], 'a', 'b')).toBe(false)
  })

  it('ignores unrelated branches', () => {
    const edges = [['x', 'y'], ['y', 'z']] as const
    expect(createsCycle(edges, 'a', 'b')).toBe(false)
  })
})
