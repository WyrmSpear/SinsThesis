/**
 * A hand-written WAV (RIFF/WAVE) encoder and decoder. Pure data in, data
 * out -- no DOM, no dependency on anything but `ArrayBuffer`/`DataView` --
 * because a WAV file is exactly what its name says: a short fixed header
 * (see `encodeWav` below) followed by raw sample data. A dependency is not
 * worth it for that.
 *
 * Lives in the engine, not the studio-layer UI that first needed it,
 * because it operates on the same `Float32Array` shape
 * `renderGraph`/`renderPatch` (render.ts) already produce and a live
 * recording tap (recorder.ts) captures -- and because the academy or a
 * future share feature will want the identical encoder to turn a rendered
 * buffer into a portable file, not a second one written from scratch.
 *
 * Two sample formats: 32-bit IEEE float (format code 3), which keeps every
 * bit of what the engine actually computed, and 16-bit signed PCM (format
 * code 1), which halves the file at the cost of quantization noise -- for
 * this engine's own numbers (see docs/CONTINUATION.md's measured-quality
 * table) that noise sits far below the patch's own DSP noise floor. Both
 * are ordinary, universally-supported WAV variants; anything fancier
 * (extensible format, non-PCM codecs) is out of scope on purpose.
 */

export type WavFormat = 'float32' | 'pcm16'

export interface WavData {
  channels: Float32Array[]
  sampleRate: number
  format: WavFormat
}

const HEADER_BYTES = 44 // 12 (RIFF/WAVE) + 8 + 16 (fmt chunk) + 8 (data chunk header)

/**
 * Encodes one or more equal-length channels as a WAV file. Samples are
 * clamped to [-1, 1] before quantizing to PCM16 -- float samples above
 * unity (a hot patch) would otherwise wrap instead of clip.
 */
export function encodeWav(channels: Float32Array[], sampleRate: number, format: WavFormat = 'pcm16'): ArrayBuffer {
  if (channels.length === 0) throw new Error('encodeWav: at least one channel is required')
  const frames = channels[0]!.length
  for (const channel of channels) {
    if (channel.length !== frames) throw new Error('encodeWav: every channel must have the same length')
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error(`encodeWav: invalid sample rate ${sampleRate}`)

  const numChannels = channels.length
  const bitsPerSample = format === 'float32' ? 32 : 16
  const bytesPerSample = bitsPerSample / 8
  const blockAlign = numChannels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = frames * blockAlign
  const audioFormat = format === 'float32' ? 3 : 1 // WAVE_FORMAT_IEEE_FLOAT / WAVE_FORMAT_PCM

  const buffer = new ArrayBuffer(HEADER_BYTES + dataSize)
  const view = new DataView(buffer)
  let offset = 0
  const writeAscii = (s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset++, s.charCodeAt(i))
  }
  const writeU32 = (v: number): void => {
    view.setUint32(offset, v, true)
    offset += 4
  }
  const writeU16 = (v: number): void => {
    view.setUint16(offset, v, true)
    offset += 2
  }

  writeAscii('RIFF')
  writeU32(36 + dataSize) // total file size minus the 8 bytes of "RIFF" + this field
  writeAscii('WAVE')

  writeAscii('fmt ')
  writeU32(16) // fmt chunk body size -- 16 for plain PCM/IEEE-float, no extension
  writeU16(audioFormat)
  writeU16(numChannels)
  writeU32(sampleRate)
  writeU32(byteRate)
  writeU16(blockAlign)
  writeU16(bitsPerSample)

  writeAscii('data')
  writeU32(dataSize)

  if (format === 'float32') {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numChannels; c++) {
        view.setFloat32(offset, channels[c]![i]!, true)
        offset += 4
      }
    }
  } else {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numChannels; c++) {
        const clamped = Math.max(-1, Math.min(1, channels[c]![i]!))
        // Standard asymmetric PCM16 scaling: negative samples reach the
        // full -32768, positive samples stop at 32767 (two's complement
        // has one more negative value than positive).
        view.setInt16(offset, Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), true)
        offset += 2
      }
    }
  }

  return buffer
}

/** Reads the tag/chunks a `decodeWav` caller needs back out of a buffer
 *  `encodeWav` (or any standard WAV writer) produced. Walks chunks rather
 *  than assuming `fmt ` precedes `data` at fixed offsets, so a file with
 *  extra metadata chunks (as many real-world WAV files have) still parses. */
export function decodeWav(buffer: ArrayBuffer): WavData {
  const view = new DataView(buffer)
  if (view.byteLength < 12) throw new Error('decodeWav: buffer too short to be a WAV file')
  if (readTag(view, 0) !== 'RIFF') throw new Error('decodeWav: missing "RIFF" tag')
  if (readTag(view, 8) !== 'WAVE') throw new Error('decodeWav: missing "WAVE" tag')

  let offset = 12
  let fmt: { audioFormat: number; numChannels: number; sampleRate: number; bitsPerSample: number } | undefined
  let dataOffset = -1
  let dataSize = 0

  while (offset + 8 <= view.byteLength) {
    const tag = readTag(view, offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (tag === 'fmt ') {
      fmt = {
        audioFormat: view.getUint16(body, true),
        numChannels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      }
    } else if (tag === 'data') {
      dataOffset = body
      dataSize = size
    }
    offset = body + size + (size % 2) // RIFF chunks are word-aligned; odd sizes carry a pad byte
  }

  if (!fmt) throw new Error('decodeWav: missing "fmt " chunk')
  if (dataOffset < 0) throw new Error('decodeWav: missing "data" chunk')
  if (fmt.audioFormat !== 1 && fmt.audioFormat !== 3) {
    throw new Error(`decodeWav: unsupported audio format code ${fmt.audioFormat} (only PCM and IEEE float are read)`)
  }
  if (fmt.bitsPerSample !== 16 && fmt.bitsPerSample !== 32) {
    throw new Error(`decodeWav: unsupported bit depth ${fmt.bitsPerSample}`)
  }

  const bytesPerSample = fmt.bitsPerSample / 8
  const frames = Math.floor(dataSize / (bytesPerSample * fmt.numChannels))
  const channels: Float32Array[] = Array.from({ length: fmt.numChannels }, () => new Float32Array(frames))

  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.numChannels; c++) {
      const at = dataOffset + (i * fmt.numChannels + c) * bytesPerSample
      if (fmt.audioFormat === 3) {
        channels[c]![i] = view.getFloat32(at, true)
      } else {
        const sample = view.getInt16(at, true)
        channels[c]![i] = sample < 0 ? sample / 0x8000 : sample / 0x7fff
      }
    }
  }

  return { channels, sampleRate: fmt.sampleRate, format: fmt.audioFormat === 3 ? 'float32' : 'pcm16' }
}

function readTag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  )
}
