import { fftMagnitude } from '../src/engine/analysis/fft'
import { rmsEnvelope, db as toDb } from '../src/engine/analysis/features'

/**
 * The "show the miss" overlay for match-this-sound: the player's render
 * plotted against the target's, spectrum and envelope both -- never a bare
 * pass/fail number on its own (Section 4). Two static canvases (not a live
 * animated scope; both buffers are already fully rendered by the time this
 * draws), but the technique -- canvas 2D, dB gridlines, a log-frequency
 * x-axis, every color read live from a CSS custom property via
 * `getComputedStyle` because a `<canvas>` does not participate in the CSS
 * cascade -- is taken directly from `rack/scope-panel.ts`, which solved it
 * first for a single live trace. This reuses that solved shape for two
 * static ones instead of reinventing it: the target trace dashed and dim
 * (a ghost to aim at), the player's trace solid in the theme's accent
 * color (the same one every other live signal in this rack draws in).
 */

const SPEC_WIDTH = 320
const SPEC_HEIGHT = 140
const ENV_WIDTH = 320
const ENV_HEIGHT = 90

const MAX_DB = 0
const MIN_DB = -100
const DB_TICKS = [0, -20, -40, -60, -80, -100]
const FREQ_TICKS_HZ = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
const ENV_WINDOW_MS = 20

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function largestPow2(n: number): number {
  let p = 1
  while (p * 2 <= n) p *= 2
  return p
}

/** A representative window for a spectrum snapshot: skips the first 20% of
 *  the buffer (a pluck's attack transient smears a spectrum, the way it
 *  would on a real scope too) and takes up to 8192 samples from there --
 *  the same FFT size `dev/scope.ts` uses for its own spectrum resolution. */
function representativeWindow(samples: Float32Array): Float32Array {
  const size = Math.min(8192, largestPow2(samples.length))
  const start = Math.min(Math.floor(samples.length * 0.2), Math.max(0, samples.length - size))
  return samples.subarray(start, start + size)
}

function magnitudeDb(samples: Float32Array, window: 'hann' | 'blackman-harris' = 'blackman-harris'): Float32Array {
  const frame = representativeWindow(samples)
  const mags = fftMagnitude(frame, window)
  const out = new Float32Array(mags.length)
  for (let i = 0; i < mags.length; i++) out[i] = toDb(mags[i]!)
  return out
}

function drawSpectrumOverlay(
  cctx: CanvasRenderingContext2D, target: Float32Array, player: Float32Array, sampleRate: number,
): void {
  const { width, height } = cctx.canvas
  cctx.fillStyle = token('--surface-recess')
  cctx.fillRect(0, 0, width, height)

  const nyquist = sampleRate / 2
  const minHz = 20
  const logSpan = Math.log(nyquist / minHz)
  const xForFreq = (freq: number): number => {
    const clamped = Math.min(Math.max(freq, minHz), nyquist)
    return (Math.log(clamped / minHz) / logSpan) * width
  }

  cctx.font = '8px var(--font-mono, monospace)'
  const gridColor = token('--panel-border')
  const textColor = token('--text-dim')
  for (const dbVal of DB_TICKS) {
    const y = ((MAX_DB - dbVal) / (MAX_DB - MIN_DB)) * height
    cctx.strokeStyle = gridColor
    cctx.beginPath()
    cctx.moveTo(0, y)
    cctx.lineTo(width, y)
    cctx.stroke()
    cctx.fillStyle = textColor
    cctx.fillText(`${dbVal}`, 1, Math.min(Math.max(8, y - 1), height - 10))
  }
  for (const hz of FREQ_TICKS_HZ) {
    if (hz > nyquist) continue
    const x = xForFreq(hz)
    cctx.strokeStyle = gridColor
    cctx.beginPath()
    cctx.moveTo(x, 0)
    cctx.lineTo(x, height)
    cctx.stroke()
    cctx.fillStyle = textColor
    const label = hz >= 1000 ? `${hz / 1000}k` : String(hz)
    cctx.fillText(label, Math.min(x + 1, width - 16), height - 2)
  }

  function trace(mags: Float32Array, color: string, dashed: boolean): void {
    const binHz = nyquist / mags.length
    cctx.strokeStyle = color
    cctx.lineWidth = dashed ? 1.25 : 1.5
    cctx.setLineDash(dashed ? [4, 3] : [])
    cctx.beginPath()
    let started = false
    for (let bin = 1; bin < mags.length; bin++) {
      const freq = bin * binHz
      if (freq > nyquist) break
      const x = xForFreq(freq)
      const clamped = Math.min(MAX_DB, Math.max(MIN_DB, mags[bin] ?? MIN_DB))
      const y = ((MAX_DB - clamped) / (MAX_DB - MIN_DB)) * height
      if (!started) { cctx.moveTo(x, y); started = true } else cctx.lineTo(x, y)
    }
    cctx.stroke()
    cctx.setLineDash([])
  }

  trace(magnitudeDb(target), token('--text-dim'), true)
  trace(magnitudeDb(player), token('--text-accent'), false)
}

function drawEnvelopeOverlay(
  cctx: CanvasRenderingContext2D, target: Float32Array, player: Float32Array, sampleRate: number,
): void {
  const { width, height } = cctx.canvas
  cctx.fillStyle = token('--surface-recess')
  cctx.fillRect(0, 0, width, height)

  const windowSize = Math.max(1, Math.round((ENV_WINDOW_MS / 1000) * sampleRate))

  function normalized(samples: Float32Array): Float32Array {
    const env = rmsEnvelope(samples, windowSize)
    let peak = 0
    for (const v of env) peak = Math.max(peak, v)
    if (peak <= 0) return env
    const out = new Float32Array(env.length)
    for (let i = 0; i < env.length; i++) out[i] = env[i]! / peak
    return out
  }

  const gridColor = token('--panel-border')
  cctx.strokeStyle = gridColor
  for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
    const y = height - frac * height
    cctx.beginPath()
    cctx.moveTo(0, y)
    cctx.lineTo(width, y)
    cctx.stroke()
  }

  function trace(env: Float32Array, color: string, dashed: boolean): void {
    if (env.length === 0) return
    cctx.strokeStyle = color
    cctx.lineWidth = dashed ? 1.25 : 1.5
    cctx.setLineDash(dashed ? [4, 3] : [])
    cctx.beginPath()
    for (let i = 0; i < env.length; i++) {
      const x = (i / Math.max(1, env.length - 1)) * width
      const y = height - Math.min(1, Math.max(0, env[i]!)) * height
      if (i === 0) cctx.moveTo(x, y)
      else cctx.lineTo(x, y)
    }
    cctx.stroke()
    cctx.setLineDash([])
  }

  trace(normalized(target), token('--text-dim'), true)
  trace(normalized(player), token('--text-accent'), false)
}

/** Builds the whole overlay -- a legend, a labeled spectrum comparison, and
 *  a labeled envelope comparison -- into `container`, replacing whatever it
 *  held. Called once per Check result, not animated: both buffers are
 *  fixed renders by the time this runs. */
export function renderMatchOverlay(
  container: HTMLElement, target: Float32Array, player: Float32Array, sampleRate: number,
): void {
  container.innerHTML = ''
  container.className = 'match-overlay'
  container.dataset['testid'] = 'academy-match-overlay'

  const legend = document.createElement('div')
  legend.className = 'match-overlay-legend'
  legend.innerHTML =
    '<span class="match-legend-target">- - -  target</span>' +
    '<span class="match-legend-player">&mdash; your patch</span>'

  const specLabel = document.createElement('p')
  specLabel.className = 'match-overlay-label'
  specLabel.textContent = 'Spectrum'
  const specCanvas = document.createElement('canvas')
  specCanvas.className = 'match-overlay-canvas'
  specCanvas.width = SPEC_WIDTH
  specCanvas.height = SPEC_HEIGHT
  specCanvas.dataset['testid'] = 'academy-match-spectrum'

  const envLabel = document.createElement('p')
  envLabel.className = 'match-overlay-label'
  envLabel.textContent = 'Envelope'
  const envCanvas = document.createElement('canvas')
  envCanvas.className = 'match-overlay-canvas'
  envCanvas.width = ENV_WIDTH
  envCanvas.height = ENV_HEIGHT
  envCanvas.dataset['testid'] = 'academy-match-envelope'

  container.append(legend, specLabel, specCanvas, envLabel, envCanvas)

  const specCtx = specCanvas.getContext('2d')
  const envCtx = envCanvas.getContext('2d')
  if (specCtx) drawSpectrumOverlay(specCtx, target, player, sampleRate)
  if (envCtx) drawEnvelopeOverlay(envCtx, target, player, sampleRate)
}
