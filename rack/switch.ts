import type { ParamSpec } from '../src/engine/types'

/**
 * The switch/selector `buildPanel` (panel.ts) draws for any param that
 * carries `labels` (src/engine/types.ts) instead of the continuous knob
 * `knob.ts` draws for everything else. This is Part 2 of closing the
 * contract gap `labels` exists to fix: a four-position waveform switch drawn
 * as a 270-degree knob is honest about its *range* but dishonest about its
 * *shape* -- there is no meaningful value "between" Saw and Pulse the way
 * there is between 900 Hz and 1000 Hz. This widget has no drag gesture and
 * no continuous arc; a segmented indicator lights the current position and
 * the readout always shows the position's name, never a raw index.
 *
 * Click advances to the next position and wraps from the last back to the
 * first, same as turning a real rotary switch past its final detent on some
 * hardware, and the simplest single gesture that needs no drag distance or
 * direction convention to discover.
 */

export interface SwitchHandle {
  readonly el: HTMLElement
  setValue(value: number): void
  getValue(): number
}

export function buildSwitch(spec: ParamSpec, initial: number, onChange: (value: number) => void): SwitchHandle {
  const labels = spec.labels
  if (!labels) throw new Error(`buildSwitch: param "${spec.id}" has no labels`)

  let value = Math.min(spec.max, Math.max(spec.min, Math.round(initial)))

  const wrap = document.createElement('div')
  wrap.className = 'switch-wrap'
  wrap.dataset['param'] = spec.id

  const label = document.createElement('span')
  label.className = 'switch-label'
  label.textContent = spec.label

  const control = document.createElement('div')
  control.className = 'switch-control'
  control.dataset['testid'] = `switch-${spec.id}`
  control.tabIndex = 0
  control.setAttribute('role', 'radiogroup')
  control.setAttribute('aria-label', spec.label)
  control.setAttribute('aria-valuemin', String(spec.min))
  control.setAttribute('aria-valuemax', String(spec.max))

  const ticks = labels.map(() => {
    const tick = document.createElement('span')
    tick.className = 'switch-tick'
    control.append(tick)
    return tick
  })

  const readout = document.createElement('span')
  readout.className = 'switch-readout'
  readout.dataset['testid'] = `readout-${spec.id}`

  function render(): void {
    const index = value - spec.min
    ticks.forEach((tick, i) => tick.classList.toggle('active', i === index))
    readout.textContent = labels![index] ?? String(value)
    control.setAttribute('aria-valuenow', String(value))
    control.title = `${spec.label}: ${labels![index] ?? value}`
  }

  function setValue(v: number): void {
    value = Math.min(spec.max, Math.max(spec.min, Math.round(v)))
    render()
  }

  function step(delta: number): void {
    const span = spec.max - spec.min + 1
    const index = ((value - spec.min + delta) % span + span) % span
    setValue(spec.min + index)
    onChange(value)
  }

  control.addEventListener('click', () => step(1))
  control.addEventListener('dblclick', (e) => {
    e.stopPropagation()
    setValue(spec.default)
    onChange(value)
  })
  control.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      step(1)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      step(-1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      step(1)
    } else {
      return
    }
    e.preventDefault()
  })

  render()
  wrap.append(label, control, readout)
  return { el: wrap, setValue, getValue: () => value }
}
