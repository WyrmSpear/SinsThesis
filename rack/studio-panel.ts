import type { WavFormat } from '../src/engine/wav'

/**
 * The studio layer's transport: live recording and offline bounce, plus
 * the export step that turns whichever one just ran into a `.wav` (and
 * optionally a `.sinp` alongside it). Built the same declarative,
 * rebuild-on-every-change way `rack/academy-panel.ts` draws its panel --
 * this module owns only *what* to draw; `rack/main.ts` owns the
 * `LiveRecorder` instance, the bounce render, and every side effect.
 *
 * Two capture mechanisms, because they serve different needs (see
 * src/engine/recorder.ts and src/engine/render.ts's own doc comments for
 * why each is built the way it is):
 *
 * - **Record** taps the live instrument while the player performs, via
 *   `LiveRecorder` -- keyboard notes, knob turns, timing and mistakes
 *   included, which is the point.
 * - **Bounce** renders the current patch offline through `renderPatch`,
 *   faster than real time, to a fixed length -- the tool for a sequenced
 *   patch playing itself, with no dropout risk because nothing here runs
 *   against a real-time deadline.
 *
 * Only one capture is ever "the current export" at a time: starting the
 * other kind replaces it, exactly like a DAW's single last-bounce slot.
 */

export interface StudioPanelState {
  recording: boolean
  elapsedSeconds: number
  maxSeconds: number
  bounceBusy: boolean
  bounceLengthSeconds: number
  /** True once a recording or bounce is sitting ready to export. */
  hasCapture: boolean
  captureSource: 'recording' | 'bounce' | undefined
  captureSeconds: number
  /** True if the *current* capture was cut short by LiveRecorder's length
   *  cap rather than an explicit Stop. */
  truncated: boolean
  wavFormat: WavFormat
  saveSinpAlongside: boolean
  /** A short status line -- "Exported lead-pluck.wav", "Recording capped
   *  at 5:00" -- or undefined for none. Not an error; use the existing
   *  status banner for that. */
  statusMessage: string | undefined
}

export interface StudioPanelCallbacks {
  onRecordToggle(): void
  onBounceLengthChange(seconds: number): void
  onBounce(): void
  onFormatChange(format: WavFormat): void
  onSaveSinpToggle(checked: boolean): void
  onExport(): void
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function renderStudioPanel(container: HTMLElement, state: StudioPanelState, cb: StudioPanelCallbacks): void {
  container.innerHTML = ''
  container.dataset['testid'] = 'studio-panel'
  container.className = 'studio-panel'

  // ---- record transport ----
  const recordGroup = document.createElement('div')
  recordGroup.className = 'studio-group studio-record-group'

  const recordBtn = document.createElement('button')
  recordBtn.type = 'button'
  recordBtn.dataset['testid'] = 'record-btn'
  recordBtn.className = 'toolbar-btn studio-record-btn' + (state.recording ? ' studio-record-btn-active' : '')
  recordBtn.setAttribute('aria-pressed', String(state.recording))
  recordBtn.disabled = state.bounceBusy
  recordBtn.append(dot(state.recording), document.createTextNode(state.recording ? ' Stop' : ' Record'))
  recordBtn.addEventListener('click', () => cb.onRecordToggle())
  recordGroup.append(recordBtn)

  const elapsed = document.createElement('span')
  elapsed.dataset['testid'] = 'record-elapsed'
  elapsed.className = 'studio-elapsed' + (state.recording ? ' studio-elapsed-live' : '')
  elapsed.textContent = `${formatClock(state.elapsedSeconds)} / ${formatClock(state.maxSeconds)} max`
  recordGroup.append(elapsed)

  container.append(recordGroup)

  // ---- offline bounce ----
  const bounceGroup = document.createElement('div')
  bounceGroup.className = 'studio-group studio-bounce-group'

  const lengthLabel = document.createElement('label')
  lengthLabel.className = 'studio-bounce-label'
  lengthLabel.textContent = 'Bounce'
  const lengthInput = document.createElement('input')
  lengthInput.type = 'number'
  lengthInput.min = '0.1'
  lengthInput.max = '120'
  lengthInput.step = '0.1'
  lengthInput.value = String(state.bounceLengthSeconds)
  lengthInput.dataset['testid'] = 'bounce-length'
  lengthInput.className = 'studio-bounce-length'
  lengthInput.setAttribute('aria-label', 'Bounce length in seconds')
  lengthInput.addEventListener('change', () => {
    const value = Number(lengthInput.value)
    if (Number.isFinite(value) && value > 0) cb.onBounceLengthChange(Math.min(120, value))
  })
  lengthLabel.append(lengthInput, document.createTextNode('s'))
  bounceGroup.append(lengthLabel)

  const bounceBtn = document.createElement('button')
  bounceBtn.type = 'button'
  bounceBtn.dataset['testid'] = 'bounce-btn'
  bounceBtn.className = 'toolbar-btn'
  bounceBtn.textContent = state.bounceBusy ? 'Bouncing…' : 'Render'
  bounceBtn.disabled = state.bounceBusy || state.recording
  bounceBtn.addEventListener('click', () => cb.onBounce())
  bounceGroup.append(bounceBtn)

  container.append(bounceGroup)

  // ---- export: only once there is something to export ----
  if (state.hasCapture) {
    const exportGroup = document.createElement('div')
    exportGroup.className = 'studio-group studio-export-group'
    exportGroup.dataset['testid'] = 'export-panel'

    const summary = document.createElement('span')
    summary.className = 'studio-capture-summary'
    summary.dataset['testid'] = 'capture-summary'
    const sourceLabel = state.captureSource === 'recording' ? 'Recording' : 'Bounce'
    summary.textContent =
      `${sourceLabel}: ${state.captureSeconds.toFixed(1)}s` + (state.truncated ? ' (capped)' : '')
    exportGroup.append(summary)

    const formatSelect = document.createElement('select')
    formatSelect.dataset['testid'] = 'wav-format'
    formatSelect.className = 'studio-format-select'
    formatSelect.setAttribute('aria-label', 'WAV export format')
    for (const [value, label] of [
      ['float32', '32-bit float'],
      ['pcm16', '16-bit PCM'],
    ] as const) {
      const opt = document.createElement('option')
      opt.value = value
      opt.textContent = label
      opt.selected = state.wavFormat === value
      formatSelect.append(opt)
    }
    formatSelect.addEventListener('change', () => cb.onFormatChange(formatSelect.value as WavFormat))
    exportGroup.append(formatSelect)

    const sinpLabel = document.createElement('label')
    sinpLabel.className = 'studio-sinp-label'
    const sinpCheckbox = document.createElement('input')
    sinpCheckbox.type = 'checkbox'
    sinpCheckbox.checked = state.saveSinpAlongside
    sinpCheckbox.dataset['testid'] = 'save-sinp-checkbox'
    sinpCheckbox.addEventListener('change', () => cb.onSaveSinpToggle(sinpCheckbox.checked))
    sinpLabel.append(sinpCheckbox, document.createTextNode(' save .sinp too'))
    exportGroup.append(sinpLabel)

    const exportBtn = document.createElement('button')
    exportBtn.type = 'button'
    exportBtn.dataset['testid'] = 'export-wav-btn'
    exportBtn.className = 'toolbar-btn'
    exportBtn.textContent = 'Export .wav'
    exportBtn.addEventListener('click', () => cb.onExport())
    exportGroup.append(exportBtn)

    container.append(exportGroup)
  }

  if (state.statusMessage) {
    const status = document.createElement('span')
    status.className = 'studio-status'
    status.dataset['testid'] = 'studio-status'
    status.textContent = state.statusMessage
    container.append(status)
  }
}

/** The "armed" indicator (task: "a clear indication it is armed"): a
 *  lamp-warn-colored dot that only pulses while `active`, built from
 *  theme tokens like everything else in this panel -- no hardcoded color. */
function dot(active: boolean): HTMLElement {
  const el = document.createElement('span')
  el.className = 'studio-rec-dot' + (active ? ' studio-rec-dot-active' : '')
  el.setAttribute('aria-hidden', 'true')
  return el
}
