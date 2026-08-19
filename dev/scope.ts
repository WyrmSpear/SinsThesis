/**
 * Oscilloscope + spectrum, both fed from the same `AnalyserNode` the output
 * module exposes (see `OutputInstance` in `src/engine/modules/output.ts`).
 * The spectrum uses a log-frequency x-axis, labeled, because that is what
 * makes the wavefolder's alias floor visible: cranking `drive` should
 * visibly raise the noise floor across the whole band, not just brighten
 * one peak.
 *
 * Spectrum rendering note (round 2): the original bar-per-pixel renderer
 * picked the *nearest* FFT bin for every pixel column. At 48 kHz with a
 * 2048-point FFT, one bin is ~23 Hz wide -- fine resolution at 5 kHz, but
 * the fundamental of a low note sits inside only a handful of bins that a
 * short window also smears via spectral leakage, and log-x compresses that
 * whole few-hundred-Hz span into the first sixth of the canvas. The result
 * was a flat rectangular "wall" at the low end that looked like a display
 * bug. It is partly real (leakage inherent to a short FFT) and partly a
 * rendering artifact (nearest-bin selection repeats one byte value across
 * many pixels with a hard edge instead of a slope). Both are addressed
 * below: `fftSize` is raised to 8192 for ~4x finer bins, and the renderer
 * now walks the bin array once, converts each bin to its true log-x pixel
 * position, and connects them with a line -- so the low end reads as a
 * curve shaped by real bin values, not a blocky repeat. Bin 0 (DC) is
 * skipped explicitly regardless of whether it would ever land on a pixel.
 */

const FREQ_TICKS_HZ = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]

/** Explicit display range for the spectrum's dB axis. Chosen so the
 *  wavefolder's alias floor (documented as low as -87 dB at drive 3, rising
 *  toward -45 dB at drive 20 -- see docs/CONTINUATION.md) sits comfortably
 *  inside the visible range, with headroom to 0 dB for the fundamental. */
const MAX_DB = 0
const MIN_DB = -100
const DB_TICKS = [0, -20, -40, -60, -80, -100]

export interface Scope {
  stop(): void
}

export function startScope(
  analyser: AnalyserNode,
  sampleRate: number,
  waveCanvas: HTMLCanvasElement,
  spectrumCanvas: HTMLCanvasElement,
): Scope {
  analyser.fftSize = 8192
  analyser.smoothingTimeConstant = 0.7
  analyser.minDecibels = MIN_DB
  analyser.maxDecibels = MAX_DB

  const timeData = new Float32Array(analyser.fftSize)
  const freqData = new Float32Array(analyser.frequencyBinCount)

  const waveCtx = waveCanvas.getContext('2d')
  const specCtx = spectrumCanvas.getContext('2d')
  if (!waveCtx || !specCtx) throw new Error('startScope: 2d context unavailable')

  const nyquist = sampleRate / 2
  const minHz = 20
  const logSpan = Math.log(nyquist / minHz)

  function xForFreq(freq: number, width: number): number {
    const clamped = Math.min(Math.max(freq, minHz), nyquist)
    return (Math.log(clamped / minHz) / logSpan) * width
  }

  // How many time-domain samples the wave display draws, once a trigger
  // point is found -- fixed regardless of `fftSize` so raising the FFT
  // size for spectrum resolution doesn't change how many cycles are shown.
  const DRAW_SAMPLES = 2048
  // Search for a rising zero crossing only in the front portion of the
  // buffer, leaving enough tail for DRAW_SAMPLES after whatever trigger
  // point is found -- this bounds the search and guarantees a full-width
  // draw even for a trigger found late in the search window.
  const TRIGGER_SEARCH_END = timeData.length - DRAW_SAMPLES

  /** Index of a rising zero crossing (sample < 0 followed by sample >= 0)
   *  in the first `TRIGGER_SEARCH_END` samples, or -1 if the signal never
   *  crosses -- silence, DC, or a level that never dips negative. Locking
   *  the draw window to this point is what keeps a steady tone visually
   *  still frame to frame, instead of sliding: without it, each animation
   *  frame's buffer ends at "now" with no relation to the waveform's own
   *  phase, so consecutive frames sample a slightly different point in the
   *  cycle. */
  function findTrigger(): number {
    for (let i = 0; i < TRIGGER_SEARCH_END; i++) {
      const prev = timeData[i] ?? 0
      const next = timeData[i + 1] ?? 0
      if (prev < 0 && next >= 0) return i
    }
    return -1
  }

  function drawWave(): void {
    analyser.getFloatTimeDomainData(timeData)
    const { width, height } = waveCanvas
    waveCtx!.fillStyle = '#050805'
    waveCtx!.fillRect(0, 0, width, height)

    waveCtx!.strokeStyle = '#1a2a20'
    waveCtx!.beginPath()
    waveCtx!.moveTo(0, height / 2)
    waveCtx!.lineTo(width, height / 2)
    waveCtx!.stroke()

    const trigger = findTrigger()
    const start = trigger === -1 ? 0 : trigger
    const count = trigger === -1 ? timeData.length : DRAW_SAMPLES

    waveCtx!.strokeStyle = '#3ef07c'
    waveCtx!.lineWidth = 1.5
    waveCtx!.beginPath()
    for (let i = 0; i < count; i++) {
      const x = (i / (count - 1)) * width
      const y = height / 2 - (timeData[start + i] ?? 0) * (height / 2) * 0.92
      if (i === 0) waveCtx!.moveTo(x, y)
      else waveCtx!.lineTo(x, y)
    }
    waveCtx!.stroke()
  }

  function drawSpectrum(): void {
    analyser.getFloatFrequencyData(freqData)
    const { width, height } = spectrumCanvas
    specCtx!.fillStyle = '#050805'
    specCtx!.fillRect(0, 0, width, height)

    // dB gridlines + axis labels (vertical axis).
    specCtx!.font = '9px monospace'
    for (const db of DB_TICKS) {
      const y = ((MAX_DB - db) / (MAX_DB - MIN_DB)) * height
      specCtx!.strokeStyle = db === 0 ? '#223027' : '#152018'
      specCtx!.beginPath()
      specCtx!.moveTo(0, y)
      specCtx!.lineTo(width, y)
      specCtx!.stroke()
      specCtx!.fillStyle = '#6c8a7a'
      // Clamp away from both canvas edges so the 0 dB label (y=0) and the
      // -100 dB label (y=height) don't clip off-canvas or collide with the
      // frequency-axis labels drawn along the bottom edge.
      specCtx!.fillText(`${db}`, 2, Math.min(Math.max(9, y - 2), height - 12))
    }
    specCtx!.save()
    specCtx!.translate(width - 4, 10)
    specCtx!.fillStyle = '#6c8a7a'
    specCtx!.fillText('dB', 0, 0)
    specCtx!.restore()

    // Frequency gridlines + labels (horizontal axis).
    specCtx!.strokeStyle = '#152018'
    specCtx!.fillStyle = '#6c8a7a'
    for (const hz of FREQ_TICKS_HZ) {
      if (hz > nyquist) continue
      const x = xForFreq(hz, width)
      specCtx!.beginPath()
      specCtx!.moveTo(x, 0)
      specCtx!.lineTo(x, height)
      specCtx!.stroke()
      const label = hz >= 1000 ? `${hz / 1000}k` : String(hz)
      specCtx!.fillText(label, Math.min(x + 2, width - 20), height - 3)
    }

    // The curve itself: one point per FFT bin (skipping bin 0, DC), placed
    // at its true log-frequency pixel position and connected with a line.
    // This is what turns the low end from a blocky "wall" -- one repeated
    // byte value stamped across a hundred pixels -- into a curve shaped by
    // the actual, sparser bin values that exist down there.
    const binHz = nyquist / freqData.length
    specCtx!.beginPath()
    let started = false
    for (let bin = 1; bin < freqData.length; bin++) {
      const freq = bin * binHz
      if (freq > nyquist) break
      const x = xForFreq(freq, width)
      const db = freqData[bin] ?? MIN_DB
      const clamped = Math.min(MAX_DB, Math.max(MIN_DB, db))
      const y = ((MAX_DB - clamped) / (MAX_DB - MIN_DB)) * height
      if (!started) {
        specCtx!.moveTo(x, height)
        specCtx!.lineTo(x, y)
        started = true
      } else {
        specCtx!.lineTo(x, y)
      }
    }
    specCtx!.lineTo(width, height)
    specCtx!.closePath()
    specCtx!.fillStyle = 'rgba(62, 240, 124, 0.28)'
    specCtx!.fill()
    specCtx!.strokeStyle = '#3ef07c'
    specCtx!.lineWidth = 1.25
    specCtx!.stroke()
  }

  let raf = 0
  function tick(): void {
    drawWave()
    drawSpectrum()
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  return {
    stop(): void {
      cancelAnimationFrame(raf)
    },
  }
}
