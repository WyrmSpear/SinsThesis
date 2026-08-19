import type { ParamSpec } from '../src/engine/types'

/**
 * Descriptor-driven slider builder. This is the load-bearing proof of the
 * declarative-panel idea the spec is built on: every range, default, curve
 * and unit shown on screen comes from the module's own `ParamSpec`, not
 * from a number typed into this file. A hardcoded `min="20" max="20000"`
 * on the cutoff slider would drift the day someone tunes the ladder's
 * range in `vcf.ts` and nobody remembered this file existed.
 */

const STEPS = 1000

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t))
}

/** Maps a real param value to a [0, 1] slider position, honoring `curve`. */
export function toNormalized(value: number, spec: Pick<ParamSpec, 'min' | 'max' | 'curve'>): number {
  const { min, max, curve } = spec
  if (curve === 'exp') {
    const lo = Math.max(min, 1e-9)
    const v = Math.max(value, lo)
    return clamp01(Math.log(v / lo) / Math.log(max / lo))
  }
  return clamp01((value - min) / (max - min))
}

/** Inverse of `toNormalized`. */
export function fromNormalized(t: number, spec: Pick<ParamSpec, 'min' | 'max' | 'curve'>): number {
  const { min, max, curve } = spec
  const tt = clamp01(t)
  if (curve === 'exp') {
    const lo = Math.max(min, 1e-9)
    return lo * Math.pow(max / lo, tt)
  }
  return min + tt * (max - min)
}

function defaultFormat(value: number, spec: ParamSpec): string {
  const abs = Math.abs(value)
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3
  const unit = spec.unit ? ` ${spec.unit}` : ''
  return `${value.toFixed(digits)}${unit}`
}

export interface SliderHandle {
  readonly el: HTMLElement
  setValue(value: number): void
}

export function buildSlider(spec: ParamSpec, initial: number, onChange: (value: number) => void): SliderHandle {
  const wrap = document.createElement('div')
  wrap.className = 'ctl'
  wrap.dataset['param'] = spec.id

  const labelRow = document.createElement('div')
  labelRow.className = 'ctl-label-row'
  const label = document.createElement('span')
  label.className = 'ctl-label'
  label.textContent = spec.label
  const readout = document.createElement('span')
  readout.className = 'ctl-readout'
  readout.dataset['testid'] = `readout-${spec.id}`
  labelRow.append(label, readout)

  const input = document.createElement('input')
  input.type = 'range'
  input.className = 'ctl-slider'
  input.dataset['testid'] = `slider-${spec.id}`

  // `spec.labels` is the single source of truth for "this param is discrete,
  // not continuous" (src/engine/types.ts) -- there is no separate ad-hoc
  // flag here anymore, so a module's descriptor is the only place that
  // decision gets made.
  const discrete = spec.labels !== undefined
  if (discrete) {
    input.min = String(spec.min)
    input.max = String(spec.max)
    input.step = '1'
  } else {
    input.min = '0'
    input.max = String(STEPS)
    input.step = '1'
  }

  function render(value: number): void {
    readout.textContent = discrete
      ? (spec.labels![Math.round(value) - spec.min] ?? String(Math.round(value)))
      : defaultFormat(value, spec)
  }

  function setValue(value: number): void {
    input.value = discrete ? String(Math.round(value)) : String(Math.round(toNormalized(value, spec) * STEPS))
    render(value)
  }

  input.addEventListener('input', () => {
    const raw = Number(input.value)
    const value = discrete ? raw : fromNormalized(raw / STEPS, spec)
    render(value)
    onChange(value)
  })

  setValue(initial)
  wrap.append(labelRow, input)
  return { el: wrap, setValue }
}

export interface ToggleHandle {
  readonly el: HTMLElement
  setChecked(value: boolean): void
}

export function buildToggle(
  labelText: string,
  initial: boolean,
  onChange: (checked: boolean) => void,
  testId?: string,
): ToggleHandle {
  const wrap = document.createElement('label')
  wrap.className = 'ctl-toggle'
  if (initial) wrap.classList.add('active')

  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = initial
  if (testId) input.dataset['testid'] = testId

  const span = document.createElement('span')
  span.textContent = labelText

  input.addEventListener('change', () => {
    wrap.classList.toggle('active', input.checked)
    onChange(input.checked)
  })

  wrap.append(input, span)
  return {
    el: wrap,
    setChecked(value: boolean): void {
      input.checked = value
      wrap.classList.toggle('active', value)
    },
  }
}
