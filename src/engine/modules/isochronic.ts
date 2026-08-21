import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'
import { DIVISION_LABELS } from '../dsp/clock-sync'
import { tryCreateWorkletNode, buildFailedInstance } from './worklet-fallback'

/**
 * A sine carrier, amplitude-gated at a precise rate. This is the
 * description of the whole mechanism -- an on/off (with softened edges)
 * multiplication of one tone by a periodic gate -- and, like Binaural
 * (binaural.ts), it makes no claim beyond that: no wording here describes
 * an effect on a listener, only the signal.
 *
 * Unlike Binaural, this is not a stereo/dichotic mechanism -- it is a
 * single mono signal, and it behaves identically on headphones, one
 * speaker, or summed to any mono path, because there is no per-ear
 * structure to lose in the first place.
 *
 * **The click problem, and why this isn't a bare square gate.** Multiplying
 * a tone by an instantaneous on/off square wave creates a genuine step
 * discontinuity at every edge -- broadband transient energy, audible as a
 * click or a buzz depending on the rate, exactly the kind of thing this
 * project measures rather than assumes (see this module's own measured
 * numbers in `.superpowers/sdd/psychoacoustic-report.md`, reported the
 * same way the B3 knob-turn fix reported 0.775 -> 0.029). `dsp/isochronic.ts`
 * reuses `dsp/segment.ts`'s own ADSR envelope core (`envSample`) to shape
 * every edge with an exponential attack/release instead, the same
 * mechanism -- not a new one -- this codebase already measured click-free
 * at ADSR stage transitions.
 *
 * `duty` is the fraction of each cycle the gate is open; `edge` is the
 * attack/release time in milliseconds that shapes how soft the transition
 * is. There is no "hard edge" setting -- `edge`'s own floor (1 ms) is
 * still a real exponential approach, never an instant step, so a click is
 * not something a player can dial back into by accident.
 *
 * `division` locks `rate` to an incoming clock's own pulse division, the
 * same mechanism `lfo.ts` already ships (`dsp/clock-sync.ts`) -- so this
 * module can sit in a rhythmic patch synced to a Clock or Sequencer's gate
 * output, at index 0 ('Free') falling back to the plain `rate` knob.
 */
export const isochronicDescriptor: ModuleDescriptor = {
  type: 'isochronic',
  name: 'Isochronic',
  // 10 HP -- five params (three knob rows: 2+2+1) plus two jacks, the same
  // shape class as vco.ts's own 10 HP panel (5 knobs, 3+1 rows).
  hp: 10,
  group: 'source',
  ports: [
    { id: 'sync', dir: 'in', signal: 'gate', label: 'Sync', pos: [0, 3] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [1, 3] },
  ],
  params: [
    { id: 'carrier', label: 'Carrier', min: 20, max: 2000, default: 200, curve: 'exp', unit: 'Hz' },
    { id: 'rate', label: 'Rate', min: 0.1, max: 40, default: 8, curve: 'exp', unit: 'Hz' },
    { id: 'duty', label: 'Duty', min: 0.05, max: 0.95, default: 0.5, curve: 'lin', unit: '' },
    { id: 'edge', label: 'Edge', min: 1, max: 50, default: 8, curve: 'exp', unit: 'ms' },
    {
      id: 'division',
      label: 'Div',
      min: 0,
      max: DIVISION_LABELS.length - 1,
      default: 0,
      curve: 'lin',
      unit: '',
      labels: DIVISION_LABELS,
    },
  ],
  layout: [
    { kind: 'knob', ref: 'carrier', x: 0, y: 0 },
    { kind: 'knob', ref: 'rate', x: 1, y: 0 },
    { kind: 'knob', ref: 'duty', x: 0, y: 1 },
    { kind: 'knob', ref: 'edge', x: 1, y: 1 },
    { kind: 'knob', ref: 'division', x: 0, y: 2 },
    { kind: 'jack', ref: 'sync', x: 0, y: 3 },
    { kind: 'jack', ref: 'out', x: 1, y: 3 },
  ],
  create(ctx): ModuleInstance {
    const node = tryCreateWorkletNode(ctx, 'isochronic', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    // Not in this pass's genuine-fallback set -- see
    // `.superpowers/sdd/robustness-report.md`. A native `OscillatorNode`
    // gated by a `GainNode` could approximate the carrier/gate mechanism,
    // but this module's own doc comment measures its click-free edges
    // (0.0027 against 1.0000 for a hard gate) as the entire reason it
    // isn't a bare square-wave AM -- a fallback that reintroduced that
    // click would be exactly the "faking a bad approximation" this
    // project's failure-mode brief warns against. Fails loudly instead.
    if (!node) {
      return buildFailedInstance(
        ctx,
        isochronicDescriptor.ports,
        "The Isochronic worklet didn't load, so this module is silent. A native fallback wasn't built for it in this pass.",
      )
    }
    const syncIn = ctx.createGain()
    syncIn.connect(node, 0, 0)

    return {
      inputs: new Map<string, AudioNode | AudioParam>([['sync', syncIn]]),
      outputs: new Map([['out', node as AudioNode]]),
      // carrier, rate, duty and edge are all continuous. division indexes
      // DIVISION_LABELS/DIVISION_MULTIPLIERS directly (a fixed table), so a
      // value between two positions is meaningless -- same B3 split as
      // lfo.ts's own shape/division.
      setParam(id, value, atTime) {
        const param = node.parameters.get(id)
        if (!param) return
        if (id === 'division') param.value = value
        else scheduleParam(param, value, ctx, atTime)
      },
      dispose() {
        node.disconnect()
        syncIn.disconnect()
      },
    }
  },
}
