import type { ParamSpec } from '../src/engine/types'
import { toNormalized, fromNormalized, formatValue } from './curve'

/**
 * A real knob: vertical drag to turn, the convention every synth uses.
 * Shift for fine adjustment, double-click resets to the descriptor's
 * default, and the value is shown continuously (emphasized while dragging).
 *
 * Sweep is a 270-degree arc (-135deg at the minimum to +135deg at the
 * maximum), the standard synth-knob throw. Position along the arc always
 * honors `spec.curve` via `curve.ts` -- an exponential param (e.g. a
 * cutoff) still turns at a constant angular rate per drag pixel, but that
 * rate maps to a curved change in the underlying value, exactly like a
 * real knob wired to a log-taper pot.
 */

const FULL_SWEEP_PX = 180 // vertical pixels of drag for the full 0..1 range
const FINE_DIVISOR = 6 // shift-drag is this much slower
const MIN_ANGLE = -135
const MAX_ANGLE = 135

export interface KnobHandle {
  readonly el: HTMLElement
  setValue(value: number): void
  getValue(): number
}

export function buildKnob(spec: ParamSpec, initial: number, onChange: (value: number) => void): KnobHandle {
  let value = initial
  let t = toNormalized(value, spec)

  const wrap = document.createElement('div')
  wrap.className = 'knob-wrap'
  wrap.dataset['param'] = spec.id

  const label = document.createElement('span')
  label.className = 'knob-label'
  label.textContent = spec.label

  const dial = document.createElement('div')
  dial.className = 'knob-dial'
  dial.dataset['testid'] = `knob-${spec.id}`
  dial.tabIndex = 0
  dial.setAttribute('role', 'slider')
  dial.setAttribute('aria-label', spec.label)
  dial.setAttribute('aria-valuemin', String(spec.min))
  dial.setAttribute('aria-valuemax', String(spec.max))

  const indicator = document.createElement('div')
  indicator.className = 'knob-indicator'
  dial.append(indicator)

  const readout = document.createElement('span')
  readout.className = 'knob-readout'
  readout.dataset['testid'] = `readout-${spec.id}`

  function angleFor(tt: number): number {
    return MIN_ANGLE + tt * (MAX_ANGLE - MIN_ANGLE)
  }

  function render(): void {
    dial.style.setProperty('--knob-angle', `${angleFor(t)}deg`)
    readout.textContent = formatValue(value, spec.unit)
    dial.setAttribute('aria-valuenow', String(value))
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
    dial.setPointerCapture(e.pointerId)
    wrap.classList.add('dragging')
    e.preventDefault()
  }

  function onPointerMove(e: PointerEvent): void {
    if (!dragging) return
    const divisor = e.shiftKey ? FULL_SWEEP_PX * FINE_DIVISOR : FULL_SWEEP_PX
    const deltaT = (startY - e.clientY) / divisor
    t = Math.min(1, Math.max(0, startT + deltaT))
    value = fromNormalized(t, spec)
    render()
    onChange(value)
  }

  function onPointerUp(e: PointerEvent): void {
    if (!dragging) return
    dragging = false
    dial.releasePointerCapture(e.pointerId)
    wrap.classList.remove('dragging')
  }

  dial.addEventListener('pointerdown', onPointerDown)
  dial.addEventListener('pointermove', onPointerMove)
  dial.addEventListener('pointerup', onPointerUp)
  dial.addEventListener('pointercancel', onPointerUp)
  dial.addEventListener('dblclick', () => {
    setValue(spec.default)
    onChange(spec.default)
  })
  dial.addEventListener('keydown', (e) => {
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
  wrap.append(label, dial, readout)
  return { el: wrap, setValue, getValue: () => value }
}
