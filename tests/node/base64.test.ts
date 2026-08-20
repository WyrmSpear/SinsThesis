import { describe, it, expect } from 'vitest'
import { bytesToBase64, base64ToBytes } from '../../src/engine/base64'

describe('base64 codec', () => {
  it('round-trips arbitrary byte lengths (0..2 padding cases and beyond)', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 6, 7, 100, 1000]) {
      const bytes = new Uint8Array(len)
      for (let i = 0; i < len; i++) bytes[i] = (i * 37 + 11) % 256
      const roundTripped = base64ToBytes(bytesToBase64(bytes))
      expect(Array.from(roundTripped)).toEqual(Array.from(bytes))
    }
  })

  it('round-trips every single byte value 0-255', () => {
    const bytes = new Uint8Array(256)
    for (let i = 0; i < 256; i++) bytes[i] = i
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes))
  })

  it('matches a known base64 vector', () => {
    const bytes = new TextEncoder().encode('SinsThesis sampler')
    expect(bytesToBase64(bytes)).toBe('U2luc1RoZXNpcyBzYW1wbGVy')
  })

  it('decodes with or without "=" padding present', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const withPadding = bytesToBase64(bytes)
    expect(withPadding.endsWith('=')).toBe(true)
    const withoutPadding = withPadding.replace(/=+$/, '')
    expect(Array.from(base64ToBytes(withoutPadding))).toEqual(Array.from(bytes))
  })
})
