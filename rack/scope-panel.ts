import type { PatchGraph } from '../src/engine/graph'
import type { ScopeInstance } from '../src/engine/modules/scope'
import { peakHz, rms } from '../src/engine/analysis/features'

/**
 * The scope module's bespoke panel content -- the escape hatch
 * `descriptor.customPanel: 'scope'` names (`src/engine/modules/scope.ts`).
 * `buildPanel` still draws the `timebase`/`view` knob-and-switch and the
 * `in`/`thru` jacks from the descriptor's own `layout` the ordinary way;
 * this is the one thing no generic `LayoutItem` can express: a live,
 * continuously redrawn display.
 *
 * Waveform vs. spectrum is a single canvas that swaps content on the
 * `view` switch, not two canvases shown side by side the way the dev
 * harness (`dev/scope.ts`) draws them permanently -- the fixed 3U panel
 * height does not have room for both at once at a legible size, and a
 * hardware scope only ever shows one trace mode at a time regardless of
 * how many buttons it has for picking one.
 *
 * Both draw paths borrow their technique directly from dev/scope.ts,
 * which already solved them: zero-crossing trigger for the waveform (so a
 * steady note sits still instead of sliding), and a log-frequency, labeled
 * dB axis for the spectrum. The one real difference is color: dev/scope.ts
 * is a test-harness page with no theme system, so it hardcodes greens.
 * This panel lives inside the rack's eight themes, so every stroke and
 * fill comes from a CSS custom property read live via `getComputedStyle`
 * at draw time -- there is no other way to get a themed color into a
 * `<canvas>`, which does not participate in the CSS cascade in the first
 * place.
 *
 * Panel-height accounting (measured against the same PANEL_HEIGHT_PX
 * budget rack/panel.ts's own comment documents): header (~32px) + one
 * knob/switch row (~73px) + one jack row (~42px) + the grid's own row gap
 * (~6px) + this content's `margin-top` (~10px, `.custom-panel-content`)
 * leaves roughly 205px inside the fixed 392px panel for the readout line
 * and canvas below -- a 168px-tall canvas plus a ~16px text line fits with
 * a few pixels to spare in every theme measured (Reaktor Dark, Phosphor
 * Lab, Casiotone).
 */

const CANVAS_WIDTH = 272
const CANVAS_HEIGHT = 168

const MAX_DB = 0
const MIN_DB = -100
const DB_TICKS = [0, -20, -40, -60, -80, -100]
const FREQ_TICKS_HZ = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** Index of a rising zero crossing in the first `searchEnd` samples, or -1
 *  if the signal never crosses -- silence, DC, or a level that never dips
 *  negative. Same technique as dev/scope.ts's `findTrigger`: without
 *  locking the draw window to this point, a steady tone slides across the
 *  display instead of sitting still, because each frame's buffer otherwise
 *  ends at "now" with no relation to the waveform's own phase. */
function findTrigger(data: Float32Array, searchEnd: number): number {
  for (let i = 0; i < searchEnd; i++) {
    const prev = data[i] ?? 0
    const next = data[i + 1] ?? 0
    if (prev < 0 && next >= 0) return i
  }
  return -1
}

function drawWave(
  cctx: CanvasRenderingContext2D,
  timeData: Float32Array,
  drawSamples: number,
): void {
  const { width, height } = cctx.canvas
  cctx.fillStyle = token('--surface-recess')
  cctx.fillRect(0, 0, width, height)

  cctx.strokeStyle = token('--panel-border')
  cctx.beginPath()
  cctx.moveTo(0, height / 2)
  cctx.lineTo(width, height / 2)
  cctx.stroke()

  const searchEnd = Math.max(0, timeData.length - drawSamples)
  const trigger = findTrigger(timeData, searchEnd)
  const start = trigger === -1 ? 0 : trigger
  const count = trigger === -1 ? Math.min(drawSamples, timeData.length) : drawSamples

  cctx.strokeStyle = token('--text-accent')
  cctx.lineWidth = 1.5
  cctx.beginPath()
  for (let i = 0; i < count; i++) {
    const x = (i / Math.max(1, count - 1)) * width
    const y = height / 2 - (timeData[start + i] ?? 0) * (height / 2) * 0.92
    if (i === 0) cctx.moveTo(x, y)
    else cctx.lineTo(x, y)
  }
  cctx.stroke()
}

function drawSpectrum(
  cctx: CanvasRenderingContext2D,
  freqData: Float32Array,
  nyquist: number,
): void {
  const { width, height } = cctx.canvas
  cctx.fillStyle = token('--surface-recess')
  cctx.fillRect(0, 0, width, height)

  const minHz = 20
  const logSpan = Math.log(nyquist / minHz)
  const xForFreq = (freq: number): number => {
    const clamped = Math.min(Math.max(freq, minHz), nyquist)
    return (Math.log(clamped / minHz) / logSpan) * width
  }

  cctx.font = '8px var(--font-mono, monospace)'
  const gridColor = token('--panel-border')
  const textColor = token('--text-dim')
  for (const db of DB_TICKS) {
    const y = ((MAX_DB - db) / (MAX_DB - MIN_DB)) * height
    cctx.strokeStyle = gridColor
    cctx.beginPath()
    cctx.moveTo(0, y)
    cctx.lineTo(width, y)
    cctx.stroke()
    cctx.fillStyle = textColor
    cctx.fillText(`${db}`, 1, Math.min(Math.max(8, y - 1), height - 10))
  }

  cctx.strokeStyle = gridColor
  cctx.fillStyle = textColor
  for (const hz of FREQ_TICKS_HZ) {
    if (hz > nyquist) continue
    const x = xForFreq(hz)
    cctx.beginPath()
    cctx.moveTo(x, 0)
    cctx.lineTo(x, height)
    cctx.stroke()
    const label = hz >= 1000 ? `${hz / 1000}k` : String(hz)
    cctx.fillText(label, Math.min(x + 1, width - 16), height - 2)
  }

  const binHz = nyquist / freqData.length
  cctx.beginPath()
  let started = false
  for (let bin = 1; bin < freqData.length; bin++) {
    const freq = bin * binHz
    if (freq > nyquist) break
    const x = xForFreq(freq)
    const db = freqData[bin] ?? MIN_DB
    const clamped = Math.min(MAX_DB, Math.max(MIN_DB, db))
    const y = ((MAX_DB - clamped) / (MAX_DB - MIN_DB)) * height
    if (!started) {
      cctx.moveTo(x, height)
      cctx.lineTo(x, y)
      started = true
    } else {
      cctx.lineTo(x, y)
    }
  }
  cctx.lineTo(width, height)
  cctx.closePath()
  cctx.fillStyle = token('--text-accent')
  cctx.globalAlpha = 0.28
  cctx.fill()
  cctx.globalAlpha = 1
  cctx.strokeStyle = token('--text-accent')
  cctx.lineWidth = 1.25
  cctx.stroke()
}

export function buildScopePanel(moduleId: string, graph: PatchGraph): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'scope-panel-content'
  const maybeInstance = graph.getInstance(moduleId) as ScopeInstance | undefined
  if (!maybeInstance) return wrap // ghost module: no engine instance to wire up
  const instance: ScopeInstance = maybeInstance

  const readout = document.createElement('div')
  readout.className = 'scope-readout'
  readout.dataset['testid'] = `scope-readout-${moduleId}`
  readout.textContent = '—'

  const canvas = document.createElement('canvas')
  canvas.className = 'scope-display'
  canvas.width = CANVAS_WIDTH
  canvas.height = CANVAS_HEIGHT
  canvas.dataset['testid'] = `scope-display-${moduleId}`

  wrap.append(readout, canvas)

  const cctx = canvas.getContext('2d')
  const analyser = instance.analyser
  const sampleRate = analyser.context.sampleRate
  const timeData = new Float32Array(analyser.fftSize)
  const freqData = new Float32Array(analyser.frequencyBinCount)

  function tick(): void {
    // Self-terminating: once this panel's canvas leaves the document (the
    // module was removed, or a patch load rebuilt the whole rack), there
    // is nothing left to draw into and nothing schedules another frame --
    // the alternative would be a `requestAnimationFrame` loop that outlives
    // its own DOM forever, one per scope ever added to a session.
    if (!canvas.isConnected || !cctx) return

    const params = graph.getParams(moduleId)
    const view = Math.round(params['view'] ?? 0)
    const timebaseMs = params['timebase'] ?? 10

    analyser.getFloatTimeDomainData(timeData)

    if (view === 0) {
      const drawSamples = Math.max(32, Math.round((timebaseMs / 1000) * sampleRate))
      drawWave(cctx, timeData, drawSamples)
    } else {
      analyser.getFloatFrequencyData(freqData)
      drawSpectrum(cctx, freqData, sampleRate / 2)
    }

    const level = rms(timeData)
    if (level < 1e-6) {
      readout.textContent = '— · RMS 0.000'
    } else {
      readout.textContent = `${peakHz(timeData, sampleRate).toFixed(1)} Hz · RMS ${level.toFixed(3)}`
    }

    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  return wrap
}
