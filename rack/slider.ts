import type { ParamSpec } from '../src/engine/types'
import { toNormalized, fromNormalized, formatValue } from './curve'

/**
 * A vertical fader -- the sequencer panel's per-step control
 * (rack/sequencer-panel.ts). Sixteen of these read as a real step
 * sequencer's row of sliders; sixteen `buildKnob` dials the same width would
 * not read as a row at all, just a wall of identical circles. Drag gesture,
 * curve handling (`toNormalized`/`fromNormalized`, honoring `spec.curve`)
 * and the shift-for-fine-adjust / double-click-to-reset conventions are
 * deliberately identical to `knob.ts` -- same physical vocabulary, different
 * geometry, not a second design.
 *
 * Every dimension here is a fixed px constant, never a value derived from
 * text metrics -- the same reason `knob-dial`/`jack-socket` are fixed px in
 * rack/style.css. A slider's height stays identical in every theme, which is
 * what keeps the sequencer panel's own total height pixel-identical across
 * all eight themes the way `tests/browser/theme-geometry.test.ts` requires
 * of every other module.
 */

const TRACK_HEIGHT_PX = 200
const FINE_DIVISOR = 6 // shift-drag is this much slower, matching knob.ts

export interface SliderHandle {
  readonly el: HTMLElement
  setValue(value: number): void
  getValue(): number
  /** Lights or dims this step -- the playhead (`.step-active`) and the
   *  steps-past-count greyout (`.step-inactive`) both go through this
   *  rather than the panel reaching into the slider's DOM directly. */
  setActive(active: boolean): void
  setInRange(inRange: boolean): void
}

export function buildSlider(spec: ParamSpec, initial: number, onChange: (value: number) => void): SliderHandle {
  let value = initial
  let t = toNormalized(value, spec)

  const wrap = document.createElement('div')
  wrap.className = 'slider-wrap'
  wrap.dataset['param'] = spec.id

  const label = document.createElement('span')
  label.className = 'slider-label'
  label.textContent = spec.label

  const track = document.createElement('div')
  track.className = 'slider-track'
  track.dataset['testid'] = `slider-${spec.id}`
  track.tabIndex = 0
  track.setAttribute('role', 'slider')
  track.setAttribute('aria-label', spec.label)
  track.setAttribute('aria-orientation', 'vertical')
  track.setAttribute('aria-valuemin', String(spec.min))
  track.setAttribute('aria-valuemax', String(spec.max))

  // The zero line: a fixed tick at t=0.5 for a symmetric -2..2 range, so the
  // resting (unprogrammed) position of every step is visible at a glance
  // even before any fill is drawn above or below it.
  const zeroLine = document.createElement('div')
  zeroLine.className = 'slider-zero'

  const fill = document.createElement('div')
  fill.className = 'slider-fill'

  const thumb = document.createElement('div')
  thumb.className = 'slider-thumb'

  track.append(zeroLine, fill, thumb)

  const readout = document.createElement('span')
  readout.className = 'slider-readout'
  readout.dataset['testid'] = `readout-${spec.id}`

  const playhead = document.createElement('div')
  playhead.className = 'slider-playhead'

  function render(): void {
    // t=0 is the minimum (bottom); the fill grows upward from the zero
    // line toward the thumb, matching a real fader's "up is more" travel.
    const thumbFromBottomPct = t * 100
    thumb.style.bottom = `calc(${thumbFromBottomPct}% - 1px)`
    const zeroT = toNormalized(0, spec)
    const zeroFromBottomPct = zeroT * 100
    const lo = Math.min(thumbFromBottomPct, zeroFromBottomPct)
    const hi = Math.max(thumbFromBottomPct, zeroFromBottomPct)
    fill.style.bottom = `${lo}%`
    fill.style.height = `${hi - lo}%`
    zeroLine.style.bottom = `calc(${zeroFromBottomPct}% - 1px)`
    readout.textContent = formatValue(value, spec.unit)
    track.setAttribute('aria-valuenow', String(value))
  }

  function setValue(v: number): void {
    value = Math.min(spec.max, Math.max(spec.min, v))
    t = toNormalized(value, spec)
    render()
  }

  let dragging = false
  let startY = 0
  let startT = 0

  function onPointerDown(e: PointerEvent): void {
    dragging = true
    startY = e.clientY
    startT = t
    track.setPointerCapture(e.pointerId)
    wrap.classList.add('dragging')
    e.preventDefault()
  }

  function onPointerMove(e: PointerEvent): void {
    if (!dragging) return
    const divisor = e.shiftKey ? TRACK_HEIGHT_PX * FINE_DIVISOR : TRACK_HEIGHT_PX
    const deltaT = (startY - e.clientY) / divisor
    t = Math.min(1, Math.max(0, startT + deltaT))
    value = fromNormalized(t, spec)
    render()
    onChange(value)
  }

  function onPointerUp(e: PointerEvent): void {
    if (!dragging) return
    dragging = false
    track.releasePointerCapture(e.pointerId)
    wrap.classList.remove('dragging')
  }

  track.addEventListener('pointerdown', onPointerDown)
  track.addEventListener('pointermove', onPointerMove)
  track.addEventListener('pointerup', onPointerUp)
  track.addEventListener('pointercancel', onPointerUp)
  track.addEventListener('dblclick', () => {
    setValue(spec.default)
    onChange(spec.default)
  })
  track.addEventListener('keydown', (e) => {
    const step = (spec.max - spec.min) / 100
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      setValue(value + step)
      onChange(value)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      setValue(value - step)
      onChange(value)
    } else {
      return
    }
    e.preventDefault()
  })

  render()
  wrap.append(label, playhead, track, readout)
  return {
    el: wrap,
    setValue,
    getValue: () => value,
    setActive: (active) => wrap.classList.toggle('step-active', active),
    setInRange: (inRange) => wrap.classList.toggle('step-inactive', !inRange),
  }
}
