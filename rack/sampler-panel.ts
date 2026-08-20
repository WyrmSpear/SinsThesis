import type { PatchGraph } from '../src/engine/graph'
import type { SamplerInstance } from '../src/engine/modules/sampler'

/**
 * The Sampler's bespoke panel content -- the escape hatch `descriptor.
 * customPanel: 'sampler'` names (`src/engine/modules/sampler.ts`).
 * `buildPanel` still draws the tune/start/end knobs and mode/reverse
 * switches, and the pitch/gate/out jacks, from the descriptor's own
 * `layout` the ordinary way; this supplies the one thing no generic
 * `LayoutItem` can express -- loading a file (a picker and a drop target)
 * and a live waveform display with the current start/end trim points drawn
 * on it.
 *
 * Panel-height accounting, the same exercise `rack/scope-panel.ts`'s own
 * doc comment walks through, because this panel carries one more control
 * row than the scope does (five knob/switch columns, one row, versus the
 * scope's two): header (~32px) + one mixed knob/switch row (~73px) + the
 * grid's own row gap (~6px) + one jack row (~42px) + this content's own
 * `margin-top` (~10px) leaves roughly 229px inside the fixed 392px panel.
 * The load row (~28px, a button-height flex row) plus its own gap
 * (~8px via `margin-bottom`) leaves the 140px canvas below room to spare
 * in every theme measured, shorter than the scope's 168px specifically to
 * buy back the extra control row's height.
 */

const CANVAS_WIDTH = 320
const CANVAS_HEIGHT = 140

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

async function decodeFile(graph: PatchGraph, file: File): Promise<{ channels: Float32Array[]; sampleRate: number }> {
  const arrayBuffer = await file.arrayBuffer()
  const audioBuffer = await graph.audioContext.decodeAudioData(arrayBuffer)
  const channels: Float32Array[] = []
  for (let i = 0; i < audioBuffer.numberOfChannels; i++) channels.push(audioBuffer.getChannelData(i))
  return { channels, sampleRate: audioBuffer.sampleRate }
}

export function buildSamplerPanel(moduleId: string, graph: PatchGraph, onChange?: () => void): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'sampler-panel-content'
  const maybeInstance = graph.getInstance(moduleId) as SamplerInstance | undefined
  if (!maybeInstance) return wrap // ghost module: no engine instance to wire up
  const instance: SamplerInstance = maybeInstance

  const loadRow = document.createElement('div')
  loadRow.className = 'sampler-load-row'

  const loadBtn = document.createElement('button')
  loadBtn.type = 'button'
  loadBtn.className = 'sampler-load-btn'
  loadBtn.textContent = 'Load'
  loadBtn.title = 'Choose an audio file to load'
  loadBtn.dataset['testid'] = `sampler-load-${moduleId}`

  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.accept = 'audio/*'
  fileInput.className = 'sampler-file-input'
  fileInput.dataset['testid'] = `sampler-file-${moduleId}`
  fileInput.hidden = true

  const readout = document.createElement('span')
  readout.className = 'sampler-readout'
  readout.dataset['testid'] = `sampler-readout-${moduleId}`
  readout.textContent = 'No sample loaded'

  const clearBtn = document.createElement('button')
  clearBtn.type = 'button'
  clearBtn.className = 'sampler-clear-btn'
  clearBtn.textContent = 'Clear'
  clearBtn.title = 'Remove the loaded sample'
  clearBtn.hidden = true

  loadBtn.addEventListener('click', () => fileInput.click())
  loadRow.append(loadBtn, readout, clearBtn)

  const canvas = document.createElement('canvas')
  canvas.className = 'sampler-display'
  canvas.width = CANVAS_WIDTH
  canvas.height = CANVAS_HEIGHT
  canvas.dataset['testid'] = `sampler-display-${moduleId}`

  wrap.append(loadRow, canvas, fileInput)

  const cctx = canvas.getContext('2d')

  function draw(): void {
    if (!cctx) return
    const { width, height } = canvas
    cctx.fillStyle = token('--surface-recess')
    cctx.fillRect(0, 0, width, height)
    cctx.strokeStyle = token('--panel-border')
    cctx.strokeRect(0.5, 0.5, width - 1, height - 1)

    const waveform = instance.getWaveform()
    if (!waveform) {
      cctx.fillStyle = token('--text-dim')
      cctx.font = '10px var(--font-mono, monospace)'
      cctx.textAlign = 'center'
      cctx.fillText('Drop a sample here, or click Load', width / 2, height / 2)
      cctx.textAlign = 'left'
      readout.textContent = 'No sample loaded'
      clearBtn.hidden = true
      return
    }

    readout.textContent = `${waveform.fileName || 'sample'} · ${waveform.durationSeconds.toFixed(2)}s`
    clearBtn.hidden = false

    // Min/max envelope drawn as one vertical stroke per bucket -- the
    // standard "peaks" waveform view, cheap because `computeWaveformPeaks`
    // already did the downsampling once at load time (dsp/sampler.ts).
    const mid = height / 2
    cctx.strokeStyle = token('--text-accent')
    cctx.globalAlpha = 0.55
    const n = waveform.min.length
    cctx.beginPath()
    for (let i = 0; i < n; i++) {
      const x = (i / Math.max(1, n - 1)) * width
      const yTop = mid - waveform.max[i]! * mid * 0.92
      const yBot = mid - waveform.min[i]! * mid * 0.92
      cctx.moveTo(x, yTop)
      cctx.lineTo(x, yBot)
    }
    cctx.stroke()
    cctx.globalAlpha = 1

    // Start/end trim markers -- read straight from the graph's live params
    // rather than cached, since the generic knobs (rack/panel.ts) mutate
    // them directly with no hook into this custom panel.
    const params = graph.getParams(moduleId)
    const start = Math.min(Math.max(params['start'] ?? 0, 0), 1)
    const end = Math.min(Math.max(params['end'] ?? 1, 0), 1)
    cctx.strokeStyle = token('--cable-gate')
    cctx.lineWidth = 1.5
    for (const frac of [start, end]) {
      const x = frac * width
      cctx.beginPath()
      cctx.moveTo(x, 0)
      cctx.lineTo(x, height)
      cctx.stroke()
    }
    cctx.lineWidth = 1
  }

  // Polled, the same pattern rack/keyboard-panel.ts's zone-shading loop
  // uses and for the identical reason: start/end are drawn generically
  // (rack/panel.ts's own knobs), so this panel has no onChange hook into
  // them specifically. Self-terminating once the canvas leaves the
  // document (module removed, patch reloaded).
  function tick(): void {
    if (!canvas.isConnected) return
    draw()
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  async function handleFiles(files: FileList | null | undefined): Promise<void> {
    const file = files?.[0]
    if (!file) return
    try {
      const { channels, sampleRate } = await decodeFile(graph, file)
      instance.loadBuffer(channels, sampleRate, file.name)
      draw()
      onChange?.()
    } catch (err) {
      readout.textContent = `Could not load "${file.name}": ${(err as Error).message}`
    }
  }

  fileInput.addEventListener('change', () => {
    void handleFiles(fileInput.files)
    fileInput.value = '' // lets choosing the same file twice re-fire 'change'
  })

  clearBtn.addEventListener('click', () => {
    instance.clearBuffer()
    draw()
    onChange?.()
  })

  // Drag-and-drop straight onto the waveform display -- "ideally
  // drag-and-drop onto the panel" from this task's own brief. Handlers sit
  // on the canvas specifically (not the whole panel) so a cable drag
  // passing over the rest of the module's controls is never mistaken for a
  // file drop.
  canvas.addEventListener('dragover', (e) => {
    e.preventDefault()
    canvas.classList.add('drag-over')
  })
  canvas.addEventListener('dragleave', () => canvas.classList.remove('drag-over'))
  canvas.addEventListener('drop', (e) => {
    e.preventDefault()
    canvas.classList.remove('drag-over')
    void handleFiles(e.dataTransfer?.files)
  })

  return wrap
}
