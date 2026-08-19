import { describe, it, expect } from 'vitest'
import { encodeWav, decodeWav } from '../../src/engine/wav'

/** Reads the ASCII tag at `offset` -- the same four bytes every RIFF chunk
 *  starts with -- so a test can assert on the raw header directly rather
 *  than trusting `decodeWav` to grade its own encoder's homework. */
function tagAt(buffer: ArrayBuffer, offset: number): string {
  const bytes = new Uint8Array(buffer, offset, 4)
  return String.fromCharCode(...bytes)
}

describe('encodeWav', () => {
  it('writes a correct RIFF/WAVE header for mono PCM16', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1])
    const buffer = encodeWav([samples], 48000, 'pcm16')
    const view = new DataView(buffer)

    expect(tagAt(buffer, 0)).toBe('RIFF')
    expect(tagAt(buffer, 8)).toBe('WAVE')
    expect(tagAt(buffer, 12)).toBe('fmt ')
    expect(view.getUint32(16, true)).toBe(16) // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1) // audio format: PCM
    expect(view.getUint16(22, true)).toBe(1) // channels
    expect(view.getUint32(24, true)).toBe(48000) // sample rate
    expect(view.getUint16(32, true)).toBe(2) // block align: 1 channel * 2 bytes
    expect(view.getUint32(28, true)).toBe(48000 * 2) // byte rate
    expect(view.getUint16(34, true)).toBe(16) // bits per sample
    expect(tagAt(buffer, 36)).toBe('data')

    const dataSize = view.getUint32(40, true)
    expect(dataSize).toBe(samples.length * 2)
    expect(view.getUint32(4, true)).toBe(36 + dataSize) // RIFF size field
    expect(buffer.byteLength).toBe(44 + dataSize)
  })

  it('writes a correct header for stereo float32', () => {
    const left = new Float32Array([0.1, 0.2, 0.3])
    const right = new Float32Array([-0.1, -0.2, -0.3])
    const buffer = encodeWav([left, right], 44100, 'float32')
    const view = new DataView(buffer)

    expect(view.getUint16(20, true)).toBe(3) // audio format: IEEE float
    expect(view.getUint16(22, true)).toBe(2) // channels
    expect(view.getUint32(24, true)).toBe(44100)
    expect(view.getUint16(32, true)).toBe(8) // block align: 2 channels * 4 bytes
    expect(view.getUint16(34, true)).toBe(32) // bits per sample

    const dataSize = view.getUint32(40, true)
    expect(dataSize).toBe(left.length * 8)
  })

  it('rejects channels of mismatched length', () => {
    expect(() => encodeWav([new Float32Array(4), new Float32Array(5)], 48000)).toThrow(/length/)
  })

  it('rejects an empty channel list', () => {
    expect(() => encodeWav([], 48000)).toThrow(/channel/)
  })

  it('clamps out-of-range PCM16 samples instead of wrapping', () => {
    const buffer = encodeWav([new Float32Array([2, -2])], 48000, 'pcm16')
    const decoded = decodeWav(buffer)
    expect(decoded.channels[0]![0]).toBeCloseTo(1, 3)
    expect(decoded.channels[0]![1]).toBeCloseTo(-1, 3)
  })
})

describe('encodeWav / decodeWav round trip', () => {
  it('round-trips a known float32 buffer exactly', () => {
    const original = new Float32Array(1000)
    for (let i = 0; i < original.length; i++) original[i] = Math.sin((i / original.length) * Math.PI * 20) * 0.7
    const buffer = encodeWav([original], 48000, 'float32')
    const decoded = decodeWav(buffer)

    expect(decoded.sampleRate).toBe(48000)
    expect(decoded.format).toBe('float32')
    expect(decoded.channels).toHaveLength(1)
    expect(decoded.channels[0]).toHaveLength(original.length)
    for (let i = 0; i < original.length; i++) {
      expect(decoded.channels[0]![i]).toBeCloseTo(original[i]!, 6)
    }
  })

  it('round-trips a known buffer through PCM16 within quantization tolerance', () => {
    const original = new Float32Array(500)
    for (let i = 0; i < original.length; i++) original[i] = Math.sin((i / original.length) * Math.PI * 8) * 0.9
    const buffer = encodeWav([original], 44100, 'pcm16')
    const decoded = decodeWav(buffer)

    expect(decoded.format).toBe('pcm16')
    expect(decoded.channels[0]).toHaveLength(original.length)
    for (let i = 0; i < original.length; i++) {
      // One quantization step at 16 bits is ~1/32768; allow a couple of steps.
      expect(Math.abs(decoded.channels[0]![i]! - original[i]!)).toBeLessThan(0.001)
    }
  })

  it('preserves sample count exactly, including an odd (non-word-aligned) length', () => {
    const original = new Float32Array(1001) // odd length -> odd PCM16 data size, tests chunk padding
    for (let i = 0; i < original.length; i++) original[i] = (i % 7) / 7 - 0.5
    const buffer = encodeWav([original], 48000, 'pcm16')
    const decoded = decodeWav(buffer)
    expect(decoded.channels[0]).toHaveLength(1001)
  })

  it('round-trips multi-channel data keeping channels independent', () => {
    const left = new Float32Array([0.1, 0.2, 0.3, 0.4])
    const right = new Float32Array([-0.1, -0.2, -0.3, -0.4])
    const buffer = encodeWav([left, right], 48000, 'float32')
    const decoded = decodeWav(buffer)
    expect(decoded.channels).toHaveLength(2)
    for (let i = 0; i < left.length; i++) {
      expect(decoded.channels[0]![i]).toBeCloseTo(left[i]!, 6)
      expect(decoded.channels[1]![i]).toBeCloseTo(right[i]!, 6)
    }
  })
})

describe('decodeWav', () => {
  it('rejects a buffer with no RIFF tag', () => {
    const buffer = new ArrayBuffer(44)
    expect(() => decodeWav(buffer)).toThrow(/RIFF/)
  })

  it('rejects a buffer too short to be a WAV file', () => {
    expect(() => decodeWav(new ArrayBuffer(4))).toThrow(/short/)
  })

  it('rejects an unsupported audio format code', () => {
    const buffer = encodeWav([new Float32Array([0, 0.1])], 48000, 'pcm16')
    const view = new DataView(buffer)
    view.setUint16(20, 6, true) // 6 = WAVE_FORMAT_ALAW, unsupported
    expect(() => decodeWav(buffer)).toThrow(/format/)
  })
})
