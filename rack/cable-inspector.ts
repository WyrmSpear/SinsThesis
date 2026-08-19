import { rms } from '../src/engine/analysis/features'
import { singlePitchHz } from '../src/engine/analysis/pitch-track'

/**
 * Click-a-cable-to-see-what-is-on-it: the pedagogy Phase 2's spec actually
 * describes -- signal visualization on the cables themselves, not only
 * where someone remembered to patch a scope module.
 *
 * Tapping without disturbing: an `AnalyserNode` is connected in parallel
 * from the cable's *source* node (`sourceNode.connect(analyser)`), never
 * inserted in series. A `connect()` fan-out changes nothing about what
 * still reaches every one of that node's other destinations -- the same
 * technique `src/engine/modules/output.ts` and `src/engine/modules/
 * scope.ts` already use for their own built-in meters. `rack/cables.ts`
 * calls `close()` the moment a cable is deselected (clicked again, a
 * remove, or a click elsewhere), so an idle cable costs nothing: no
 * analyser exists for it at all except while its inspector is open.
 *
 * Click-to-remove vs. click-to-inspect: before this, clicking a cable
 * removed it outright -- a single accidental click threw away a patch
 * connection with no confirmation and no way to just look. That is
 * reconciled here by splitting the gesture the same way this codebase
 * already splits "select a module" from "remove a module" (`rack/panel.ts`'s
 * own corner `×` button, never the panel body itself): clicking a cable now
 * *selects* it and opens this inspector, which is the only thing a click
 * does. Removing is a deliberate, separately-clicked "Remove cable" button
 * inside the inspector it opens -- discoverable (it's right there the
 * instant you look at the cable), but never one accidental click away.
 */

export interface CableInspectorHandle {
  close(): void
}

// 4096, not 2048: singlePitchHz (audit round two, finding 2) needs at least
// frameSize + sampleRate/minHz samples for one YIN frame to exist at all --
// 2848 at the pitch-tracker's own defaults and 48 kHz -- and 2048 fell
// short of that, which would have made every reading decline as "no pitch"
// regardless of what was on the cable. 4096 clears it with headroom at any
// sample rate this project runs at.
const ANALYSER_FFT_SIZE = 4096
const CANVAS_WIDTH = 220
const CANVAS_HEIGHT = 64

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** Same zero-crossing trigger as rack/scope-panel.ts and dev/scope.ts --
 *  see either's doc comment for why a steady tone needs one to sit still. */
function findTrigger(data: Float32Array, searchEnd: number): number {
  for (let i = 0; i < searchEnd; i++) {
    const prev = data[i] ?? 0
    const next = data[i + 1] ?? 0
    if (prev < 0 && next >= 0) return i
  }
  return -1
}

/**
 * Opens the inspector for one cable: builds the parallel analyser tap,
 * appends a themed popover to `container`, and starts its own draw loop.
 * The caller (`CableLayer`) owns *when* this runs -- attach on selection,
 * `close()` on deselect -- this module only owns *what* it draws.
 */
export function showCableInspector(
  container: HTMLElement,
  ctx: BaseAudioContext,
  sourceNode: AudioNode,
  anchor: { x: number; y: number },
  onRemove: () => void,
): CableInspectorHandle {
  const analyser = ctx.createAnalyser()
  analyser.fftSize = ANALYSER_FFT_SIZE
  sourceNode.connect(analyser)

  const el = document.createElement('div')
  el.className = 'cable-inspector'
  el.dataset['testid'] = 'cable-inspector'
  el.style.left = `${anchor.x}px`
  el.style.top = `${anchor.y}px`
  // A click anywhere inside the inspector (its remove button included)
  // must not bubble to the rack surface's own "click elsewhere closes it"
  // listener (rack/cables.ts) -- otherwise opening it and immediately
  // dismissing it would be the same gesture.
  el.addEventListener('pointerdown', (e) => e.stopPropagation())
  el.addEventListener('click', (e) => e.stopPropagation())

  const readout = document.createElement('div')
  readout.className = 'cable-inspector-readout'
  readout.dataset['testid'] = 'cable-inspector-readout'
  readout.textContent = '—'

  const canvas = document.createElement('canvas')
  canvas.className = 'cable-inspector-wave'
  canvas.width = CANVAS_WIDTH
  canvas.height = CANVAS_HEIGHT
  canvas.dataset['testid'] = 'cable-inspector-wave'

  const removeBtn = document.createElement('button')
  removeBtn.type = 'button'
  removeBtn.className = 'cable-inspector-remove'
  removeBtn.dataset['testid'] = 'cable-inspector-remove'
  removeBtn.textContent = 'Remove cable'
  removeBtn.addEventListener('click', () => onRemove())

  el.append(readout, canvas, removeBtn)
  container.append(el)

  const cctx = canvas.getContext('2d')
  const timeData = new Float32Array(analyser.fftSize)
  const DRAW_SAMPLES = Math.min(500, timeData.length)
  const TRIGGER_SEARCH_END = Math.max(0, timeData.length - DRAW_SAMPLES)

  let raf = 0
  function tick(): void {
    // Same self-terminating pattern as rack/scope-panel.ts: once `close()`
    // has removed this element from the document, stop scheduling more
    // frames rather than drawing into a detached canvas forever.
    if (!canvas.isConnected) return

    analyser.getFloatTimeDomainData(timeData)

    if (cctx) {
      const { width, height } = canvas
      cctx.fillStyle = token('--surface-recess')
      cctx.fillRect(0, 0, width, height)
      cctx.strokeStyle = token('--panel-border')
      cctx.beginPath()
      cctx.moveTo(0, height / 2)
      cctx.lineTo(width, height / 2)
      cctx.stroke()

      const trigger = findTrigger(timeData, TRIGGER_SEARCH_END)
      const start = trigger === -1 ? 0 : trigger
      const count = trigger === -1 ? timeData.length : DRAW_SAMPLES

      cctx.strokeStyle = token('--text-accent')
      cctx.lineWidth = 1.5
      cctx.beginPath()
      for (let i = 0; i < count; i++) {
        const x = (i / Math.max(1, count - 1)) * width
        const y = height / 2 - (timeData[start + i] ?? 0) * (height / 2) * 0.9
        if (i === 0) cctx.moveTo(x, y)
        else cctx.lineTo(x, y)
      }
      cctx.stroke()
    }

    const level = rms(timeData)
    if (level < 1e-6) {
      readout.textContent = '— · RMS 0.000'
    } else {
      // YIN (singlePitchHz), not peakHz -- see rack/scope-panel.ts's own
      // comment on this same audit finding. A cable carrying a bright saw
      // used to read its second harmonic, not its fundamental.
      const hz = singlePitchHz(timeData, ctx.sampleRate)
      readout.textContent = hz === undefined ? `— · RMS ${level.toFixed(3)}` : `${hz.toFixed(1)} Hz · RMS ${level.toFixed(3)}`
    }

    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  return {
    close() {
      cancelAnimationFrame(raf)
      analyser.disconnect()
      sourceNode.disconnect(analyser)
      el.remove()
    },
  }
}
