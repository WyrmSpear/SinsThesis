/**
 * Oscilloscope + spectrum, both fed from the same `AnalyserNode` the output
 * module exposes (see `OutputInstance` in `src/engine/modules/output.ts`).
 * The spectrum uses a log-frequency x-axis, labeled, because that is what
 * makes the wavefolder's alias floor visible: cranking `drive` should
 * visibly raise the noise floor across the whole band, not just brighten
 * one peak.
 */

const FREQ_TICKS_HZ = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]

export interface Scope {
  stop(): void
}

export function startScope(
  analyser: AnalyserNode,
  sampleRate: number,
  waveCanvas: HTMLCanvasElement,
  spectrumCanvas: HTMLCanvasElement,
): Scope {
  analyser.fftSize = 2048
  analyser.smoothingTimeConstant = 0.7

  const timeData = new Float32Array(analyser.fftSize)
  const freqData = new Uint8Array(analyser.frequencyBinCount)

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

    waveCtx!.strokeStyle = '#3ef07c'
    waveCtx!.lineWidth = 1.5
    waveCtx!.beginPath()
    for (let i = 0; i < timeData.length; i++) {
      const x = (i / (timeData.length - 1)) * width
      const y = height / 2 - (timeData[i] ?? 0) * (height / 2) * 0.92
      if (i === 0) waveCtx!.moveTo(x, y)
      else waveCtx!.lineTo(x, y)
    }
    waveCtx!.stroke()
  }

  function drawSpectrum(): void {
    analyser.getByteFrequencyData(freqData)
    const { width, height } = spectrumCanvas
    specCtx!.fillStyle = '#050805'
    specCtx!.fillRect(0, 0, width, height)

    // Grid + labels along the frequency axis.
    specCtx!.strokeStyle = '#152018'
    specCtx!.fillStyle = '#6c8a7a'
    specCtx!.font = '9px monospace'
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

    // Bars: one canvas pixel column per x, nearest FFT bin.
    specCtx!.fillStyle = '#3ef07c'
    const binHz = nyquist / freqData.length
    for (let x = 0; x < width; x++) {
      const freq = minHz * Math.exp((x / width) * logSpan)
      const bin = Math.min(freqData.length - 1, Math.round(freq / binHz))
      const mag = freqData[bin] ?? 0
      const barHeight = (mag / 255) * height
      specCtx!.fillRect(x, height - barHeight, 1, barHeight)
    }
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
