import type { PatchGraph } from '../src/engine/graph'
import type { SequencerInstance } from '../src/engine/modules/sequencer'
import { sequencerDescriptor } from '../src/engine/modules/sequencer'
import { buildKnob } from './knob'
import { buildSlider } from './slider'

/**
 * The sequencer's bespoke panel content -- the escape hatch
 * `descriptor.customPanel: 'sequencer'` names. `buildPanel` still draws the
 * four jacks from the descriptor's own `layout` the ordinary way; everything
 * here is what no generic `LayoutItem` can express: sixteen live step
 * sliders, a playhead, and a `steps` knob that has to grey out sliders past
 * its own count the instant it moves -- a live cross-control reaction the
 * generic grid has no hook for (its knobs only ever call the panel-level
 * `onChange`, never notify a sibling control).
 *
 * `steps` is deliberately drawn here rather than through a `layout` knob
 * entry for exactly that reason: keeping the source of truth and the
 * greyout logic in the same closure is simpler than inventing a
 * cross-control notification channel for one param.
 *
 * One row, not a knob row stacked above a slider row -- the `steps` knob and
 * all sixteen sliders share a single flex row with `align-items: flex-end`,
 * so the knob's shorter stack (label/dial/readout) and each slider's taller
 * one (label/playhead/track/readout) sit on a common baseline the way a real
 * panel's controls share a front face. That is most of how this fits inside
 * the fixed 3U panel height at all -- see
 * .superpowers/sdd/sequencer-reorder-report.md for the measured row-height
 * accounting.
 */

const STEP_COUNT = 16

export function buildSequencerPanel(moduleId: string, graph: PatchGraph, onChange?: () => void): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'sequencer-panel-content'
  const maybeInstance = graph.getInstance(moduleId) as SequencerInstance | undefined
  if (!maybeInstance) return wrap // ghost module: no engine instance to wire up
  const instance: SequencerInstance = maybeInstance

  const row = document.createElement('div')
  row.className = 'sequencer-row'

  const stepsSpec = sequencerDescriptor.params.find((p) => p.id === 'steps')!
  const initialParams = graph.getParams(moduleId)

  const sliders = Array.from({ length: STEP_COUNT }, (_, i) => {
    const id = `step${i + 1}`
    const spec = sequencerDescriptor.params.find((p) => p.id === id)!
    return buildSlider(spec, initialParams[id] ?? spec.default, (value) => {
      graph.setParam(moduleId, id, value)
      onChange?.()
    })
  })

  function applyStepCount(count: number): void {
    const n = Math.min(STEP_COUNT, Math.max(1, Math.round(count)))
    sliders.forEach((s, i) => s.setInRange(i < n))
  }

  const stepsKnob = buildKnob(stepsSpec, initialParams['steps'] ?? stepsSpec.default, (value) => {
    graph.setParam(moduleId, 'steps', value)
    applyStepCount(value)
    onChange?.()
  })
  applyStepCount(initialParams['steps'] ?? stepsSpec.default)
  stepsKnob.el.classList.add('sequencer-steps-knob')

  row.append(stepsKnob.el, ...sliders.map((s) => s.el))
  wrap.append(row)

  // Playhead: the processor reports its step index on the audio thread's
  // message port (segment.worklet.ts), fanned out through `onStep`
  // (sequencer.ts) -- this never polls or re-derives the index itself.
  instance.onStep((step) => {
    sliders.forEach((s, i) => s.setActive(i === step))
  })

  return wrap
}
