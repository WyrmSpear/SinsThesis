/**
 * A hand-written base64 codec, `Uint8Array <-> string`, for exactly one
 * reason: `modules/sampler.ts` needs to embed a loaded sample's PCM bytes
 * inside a `.sinp` (plain JSON, so binary data has to become text somehow)
 * and this file is required to work in three different environments that
 * don't all agree on what's ambient -- the browser main thread (`btoa`/
 * `atob` exist but are `string`-only, deprecated-adjacent APIs built for
 * Latin-1 text, not bytes), Node's Vitest runner (`Buffer` exists, `btoa`/
 * `atob` also exist as of Node 16+ but with the same string-only shape),
 * and this project's own boundary rule that `src/engine` reaches for no
 * platform global it hasn't deliberately chosen (`docs/CONTINUATION.md`
 * trap 3 is the AudioWorklet-flavored version of the same principle). A
 * plain, dependency-free `Uint8Array` encoder/decoder sidesteps all three
 * without picking an environment-specific API and needing a second path
 * for the others.
 */

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += CHARS[(n >> 18) & 0x3f]! + CHARS[(n >> 12) & 0x3f]! + CHARS[(n >> 6) & 0x3f]! + CHARS[n & 0x3f]!
  }
  const remaining = bytes.length - i
  if (remaining === 1) {
    const n = bytes[i]! << 16
    out += CHARS[(n >> 18) & 0x3f]! + CHARS[(n >> 12) & 0x3f]! + '=='
  } else if (remaining === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += CHARS[(n >> 18) & 0x3f]! + CHARS[(n >> 12) & 0x3f]! + CHARS[(n >> 6) & 0x3f]! + '='
  }
  return out
}

const CHAR_INDEX = new Map(CHARS.split('').map((c, i) => [c, i]))

export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, '') // strip padding/whitespace
  const byteLen = Math.floor((clean.length * 6) / 8)
  const out = new Uint8Array(byteLen)
  let bitBuffer = 0
  let bitCount = 0
  let outIndex = 0
  for (const ch of clean) {
    const value = CHAR_INDEX.get(ch)
    if (value === undefined) continue
    bitBuffer = (bitBuffer << 6) | value
    bitCount += 6
    if (bitCount >= 8) {
      bitCount -= 8
      out[outIndex++] = (bitBuffer >> bitCount) & 0xff
    }
  }
  return out
}
