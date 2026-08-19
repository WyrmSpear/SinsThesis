import { trackPitch, dominantPitchHz, type PitchFrame } from '../src/engine/analysis/pitch-track'
import { hzToMidi, midiToHz, hzToNoteName, formatNoteName } from '../src/engine/analysis/note'

/**
 * The visual for a recorded or bounced buffer -- "a visual of the WAV
 * showing frequency, octave, pitch and note", in the project owner's own
 * words. Lives in the studio transport area (`rack/main.ts`'s
 * `renderStudio`, driving the `#pitch-display` element index.html places
 * right after `#studio-panel`), not as a further expansion of the scope
 * module, for two reasons: the scope's fixed 3U panel already has no
 * headroom left (see its own doc comment's height accounting), and this
 * needs a *finished* buffer -- the whole point is scrubbing back over what
 * was just captured, not another live trace. The studio transport is the
 * one place in this app that already holds such a buffer
 * (`lastCapture` in `rack/main.ts`).
 *
 * Three pieces, all from theme tokens read live via `getComputedStyle`
 * (the same technique `rack/scope-panel.ts` and `rack/match-sound-panel.ts`
 * already use -- a `<canvas>` has no CSS cascade of its own):
 *
 * - the waveform (a min/max-per-pixel envelope over the whole buffer, not
 *   a triggered live trace -- there is no "now" to trigger against once
 *   the buffer is finished)
 * - the pitch contour, `trackPitch`'s frame-wise estimate plotted against
 *   a note-labelled vertical axis with gridlines at each octave (each C),
 *   which is what turns "the pitch drifted" from a claim into something a
 *   player can actually see
 * - a readout of the dominant pitch (`dominantPitchHz`, confidence-weighted
 *   in log-frequency space): "329.6 Hz · E4 −2¢"
 *
 * A silent or entirely unvoiced buffer draws "no pitch detected" rather
 * than a flat line at some arbitrary height -- inventing a contour where
 * `trackPitch` found none would be exactly the lie the engine module's own
 * doc comment warns against.
 */

const WAVE_WIDTH = 480
const WAVE_HEIGHT = 64
const PITCH_WIDTH = 480
const PITCH_HEIGHT = 160

/** Below this per-point confidence, a pitch-contour segment is still
 *  drawn (a low-confidence reading is still real information, unlike an
 *  unvoiced frame, which has none) but faded, so a shaky reading reads as
 *  shaky rather than as certain as a clean tone. */
const MIN_SEGMENT_ALPHA = 0.3

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function drawWaveform(cctx: CanvasRenderingContext2D, samples: Float32Array): void {
  const { width, height } = cctx.canvas
  cctx.fillStyle = token('--surface-recess')
  cctx.fillRect(0, 0, width, height)

  cctx.strokeStyle = token('--panel-border')
  cctx.beginPath()
  cctx.moveTo(0, height / 2)
  cctx.lineTo(width, height / 2)
  cctx.stroke()

  cctx.strokeStyle = token('--text-accent')
  cctx.lineWidth = 1
  cctx.beginPath()
  const samplesPerPixel = Math.max(1, samples.length / width)
  for (let x = 0; x < width; x++) {
    const start = Math.floor(x * samplesPerPixel)
    const end = Math.min(samples.length, Math.floor((x + 1) * samplesPerPixel))
    if (start >= end) continue
    let min = Infinity
    let max = -Infinity
    for (let i = start; i < end; i++) {
      const v = samples[i]!
      if (v < min) min = v
      if (v > max) max = v
    }
    const yMin = height / 2 - min * (height / 2) * 0.92
    const yMax = height / 2 - max * (height / 2) * 0.92
    cctx.moveTo(x + 0.5, yMin)
    cctx.lineTo(x + 0.5, yMax)
  }
  cctx.stroke()
}

/** Nearest C at or below `midi` (MIDI note numbers are 0 = C-1, so "is
 *  this a C" is exactly `midi % 12 === 0`) -- gridlines land on octave
 *  boundaries, the landmark a musician actually reads a pitch height
 *  against, rather than on an arbitrary round Hz number. */
function floorToC(midi: number): number {
  const m = Math.round(midi)
  return m - (((m % 12) + 12) % 12)
}

/** The vertical range to display, in MIDI note numbers, padded two
 *  semitones past the loudest-confidence pitches actually seen and
 *  snapped out to whole octaves so every gridline is a C. Falls back to
 *  two octaves around middle C when nothing was voiced, so the axis still
 *  reads as a musical scale instead of collapsing to a zero-height range. */
function pitchRange(frames: readonly PitchFrame[]): { minMidi: number; maxMidi: number } {
  let min = Infinity
  let max = -Infinity
  for (const f of frames) {
    if (f.hz === undefined) continue
    const midi = hzToMidi(f.hz)
    if (midi < min) min = midi
    if (midi > max) max = midi
  }
  if (!Number.isFinite(min)) return { minMidi: 48, maxMidi: 72 } // C3..C5
  const low = floorToC(min - 2)
  const high = Math.max(floorToC(max + 2) + 12, low + 12)
  return { minMidi: low, maxMidi: high }
}

function drawPitchContour(cctx: CanvasRenderingContext2D, frames: readonly PitchFrame[], durationSec: number): void {
  const { width, height } = cctx.canvas
  cctx.fillStyle = token('--surface-recess')
  cctx.fillRect(0, 0, width, height)

  const { minMidi, maxMidi } = pitchRange(frames)
  const yForMidi = (midi: number): number => height - ((midi - minMidi) / (maxMidi - minMidi)) * height

  const gridColor = token('--panel-border')
  const textColor = token('--text-dim')
  cctx.font = '9px var(--font-mono, monospace)'
  for (let midi = minMidi; midi <= maxMidi; midi += 12) {
    const y = yForMidi(midi)
    cctx.strokeStyle = gridColor
    cctx.beginPath()
    cctx.moveTo(0, y)
    cctx.lineTo(width, y)
    cctx.stroke()
    const note = hzToNoteName(midiToHz(midi))
    cctx.fillStyle = textColor
    cctx.fillText(`${note.letter}${note.octave}`, 2, Math.min(Math.max(9, y - 2), height - 2))
  }

  const anyVoiced = frames.some((f) => f.hz !== undefined)
  if (!anyVoiced) {
    cctx.fillStyle = textColor
    cctx.font = '10px var(--font-mono, monospace)'
    cctx.textAlign = 'center'
    cctx.fillText('no pitch detected', width / 2, height / 2)
    cctx.textAlign = 'left'
    return
  }

  // Short line segments between consecutive voiced frames, each alpha'd by
  // its own confidence -- a gap where a frame is unvoiced simply isn't
  // connected across, rather than being bridged by an invented value.
  const accent = token('--text-accent')
  cctx.lineWidth = 1.75
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1]!
    const cur = frames[i]!
    if (prev.hz === undefined || cur.hz === undefined) continue
    const x0 = (prev.timeSec / durationSec) * width
    const y0 = yForMidi(hzToMidi(prev.hz))
    const x1 = (cur.timeSec / durationSec) * width
    const y1 = yForMidi(hzToMidi(cur.hz))
    cctx.strokeStyle = accent
    cctx.globalAlpha = Math.max(MIN_SEGMENT_ALPHA, Math.min(1, (prev.confidence + cur.confidence) / 2))
    cctx.beginPath()
    cctx.moveTo(x0, y0)
    cctx.lineTo(x1, y1)
    cctx.stroke()
  }
  cctx.globalAlpha = 1
}

function formatReadout(frames: readonly PitchFrame[]): string {
  const hz = dominantPitchHz(frames)
  if (hz === undefined) return '— no pitch detected'
  return `${hz.toFixed(1)} Hz · ${formatNoteName(hzToNoteName(hz))}`
}

export interface PitchDisplayCapture {
  samples: Float32Array
  sampleRate: number
}

// Memoized on the samples buffer's own identity: `render*` functions in
// this codebase rebuild their whole DOM subtree on every call (see
// rack/studio-panel.ts's own header comment), and `renderStudio` in
// rack/main.ts calls this every 200ms while a *different* recording is
// live, long after `lastCapture` itself last changed. Recomputing YIN over
// up to several minutes of audio five times a second for a buffer that
// hasn't changed would be pure waste; re-running it whenever the buffer
// reference *does* change (a new recording or bounce just finished) is
// exactly the cost this display is for.
let cachedSamples: Float32Array | undefined
let cachedFrames: PitchFrame[] = []

export function renderPitchDisplay(container: HTMLElement, capture: PitchDisplayCapture | undefined): void {
  container.innerHTML = ''
  container.dataset['testid'] = 'pitch-display'
  container.className = 'pitch-display'

  if (!capture || capture.samples.length === 0) {
    container.hidden = true
    return
  }
  container.hidden = false

  if (capture.samples !== cachedSamples) {
    cachedSamples = capture.samples
    cachedFrames = trackPitch(capture.samples, capture.sampleRate)
  }
  const frames = cachedFrames
  const durationSec = capture.samples.length / capture.sampleRate

  const readout = document.createElement('div')
  readout.className = 'pitch-display-readout'
  readout.dataset['testid'] = 'pitch-display-readout'
  readout.textContent = formatReadout(frames)

  const waveLabel = document.createElement('p')
  waveLabel.className = 'pitch-display-label'
  waveLabel.textContent = 'Waveform'
  const waveCanvas = document.createElement('canvas')
  waveCanvas.className = 'pitch-display-canvas'
  waveCanvas.width = WAVE_WIDTH
  waveCanvas.height = WAVE_HEIGHT
  waveCanvas.dataset['testid'] = 'pitch-display-wave'

  const pitchLabel = document.createElement('p')
  pitchLabel.className = 'pitch-display-label'
  pitchLabel.textContent = 'Pitch over time'
  const pitchCanvas = document.createElement('canvas')
  pitchCanvas.className = 'pitch-display-canvas'
  pitchCanvas.width = PITCH_WIDTH
  pitchCanvas.height = PITCH_HEIGHT
  pitchCanvas.dataset['testid'] = 'pitch-display-contour'

  container.append(readout, waveLabel, waveCanvas, pitchLabel, pitchCanvas)

  const waveCtx = waveCanvas.getContext('2d')
  const pitchCtx = pitchCanvas.getContext('2d')
  if (waveCtx) drawWaveform(waveCtx, capture.samples)
  if (pitchCtx) drawPitchContour(pitchCtx, frames, durationSec)
}
