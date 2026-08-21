import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'
import { tryCreateWorkletNode, buildFailedInstance } from './worklet-fallback'

const STEP_PARAMS = Array.from({ length: 16 }, (_, i) => ({
  id: `step${i + 1}`,
  label: `${i + 1}`,
  min: -2,
  max: 2,
  default: 0,
  curve: 'lin' as const,
  unit: 'oct',
}))

/**
 * Sixteen-step CV/gate sequencer. `cv` and `gate` come off one worklet node
 * with two outputs; each is fronted by its own GainNode so the graph's plain
 * two-argument `connect()` (which always addresses output index 0) cannot
 * collapse them onto the same signal, mirroring the input-fronting
 * convention every other worklet module already uses.
 */
export interface SequencerInstance extends ModuleInstance {
  /**
   * Subscribe to the playhead: the processor (`segment.worklet.ts`) posts
   * `{ step: number }` on its message port whenever the step it just wrote
   * to `cv`/`gate` changes, and this fans that out to every listener a
   * panel registers. Returns an unsubscribe function, the same handle
   * shape `addEventListener`/`removeEventListener` would give a caller,
   * without exposing the raw `AudioWorkletNode` or its port.
   */
  onStep(cb: (step: number) => void): () => void
}

export const sequencerDescriptor: ModuleDescriptor = {
  type: 'seq',
  name: 'Sequencer',
  // 32 HP: sixteen vertical sliders read far better than sixteen knobs for
  // per-step CV (see rack/sequencer-panel.ts), and that is genuinely wide --
  // real hardware 16-step sequencers run 20-40 HP for the same reason. The
  // `steps` knob and all four jacks now live inside the custom panel
  // (`customPanel: 'sequencer'`, registered in rack/main.ts) rather than
  // the generic grid below, which is why `layout` only carries the jacks:
  // see .superpowers/sdd/sequencer-reorder-report.md for the row-by-row
  // 3U height budget this width and layout split were measured against.
  hp: 38,
  group: 'control',
  customPanel: 'sequencer',
  ports: [
    // 'Clock' clipped by a couple of px in the widest-tracking themes
    // (reported live); 'Clk' is the standard sequencer abbreviation.
    { id: 'clock', dir: 'in', signal: 'gate', label: 'Clk', pos: [0, 3] },
    // Same 'Rst' shortening as clock-module.ts's reset port, for the same
    // sub-pixel-overflow reason.
    { id: 'reset', dir: 'in', signal: 'gate', label: 'Rst', pos: [1, 3] },
    { id: 'cv', dir: 'out', signal: 'cv', label: 'CV', pos: [0, 4] },
    { id: 'gate', dir: 'out', signal: 'gate', label: 'Gate', pos: [1, 4] },
  ],
  params: [
    // Discrete and snapped (see setParam below), but deliberately without
    // `labels`: `labels` earns its keep when the *name* carries information
    // a bare index doesn't -- 'Saw' means something '1' does not. Here the
    // step count already reads correctly as a plain integer; a `labels`
    // array would just be ['1', '2', ..., '16'], sixteen strings that
    // restate the value the knob already shows. Stays a continuous-looking
    // (but internally snapped) knob rather than a 16-position switch. Drawn
    // by the custom panel, not a generic `layout` knob entry -- see that
    // file for why (it needs to react live to its own value to grey out
    // steps past the count, which the generic grid has no hook for).
    { id: 'steps', label: 'Steps', min: 1, max: 16, default: 8, curve: 'lin', unit: '' },
    ...STEP_PARAMS,
  ],
  layout: [
    // All four jacks share one row (`y: 3` on every entry) rather than the
    // 2x2 the 8 HP version used -- deliberate, not left over: at 32 HP
    // there is ample width for one row, and collapsing to one row instead
    // of two is most of the vertical budget the sixteen sliders below
    // needed to fit inside the fixed 3U panel height. See
    // .superpowers/sdd/sequencer-reorder-report.md for the measured
    // row-height accounting.
    { kind: 'jack', ref: 'clock', x: 0, y: 3 },
    { kind: 'jack', ref: 'reset', x: 1, y: 3 },
    { kind: 'jack', ref: 'cv', x: 2, y: 3 },
    { kind: 'jack', ref: 'gate', x: 3, y: 3 },
  ],
  create(ctx): SequencerInstance {
    const node = tryCreateWorkletNode(ctx, 'sequencer', {
      numberOfInputs: 2,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    })
    // Same "no honest native equivalent" reasoning as adsr.ts: a sequencer's
    // step-advance logic is exactly `segment.worklet.ts`'s per-sample state
    // machine, with nothing in WebAudio's native node set that reproduces
    // "hold this CV/gate pair for one step, advance on a clock edge."
    if (!node) {
      return {
        ...buildFailedInstance(
          ctx,
          sequencerDescriptor.ports,
          "The sequencer worklet didn't load, so this module is silent. No native fallback exists for step sequencing.",
        ),
        onStep: () => () => {
          // No playhead to subscribe to -- this instance never advances.
        },
      }
    }
    const cvOut = ctx.createGain()
    const gateOut = ctx.createGain()
    node.connect(cvOut, 0)
    node.connect(gateOut, 1)

    const fronts = ['clock', 'reset'].map((_, index) => {
      const gain = ctx.createGain()
      gain.connect(node, 0, index)
      return gain
    })

    const stepListeners = new Set<(step: number) => void>()
    node.port.onmessage = (e: MessageEvent<{ step: number }>) => {
      for (const cb of stepListeners) cb(e.data.step)
    }

    return {
      inputs: new Map<string, AudioNode | AudioParam>([
        ['clock', fronts[0]!],
        ['reset', fronts[1]!],
      ]),
      outputs: new Map<string, AudioNode>([
        ['cv', cvOut],
        ['gate', gateOut],
      ]),
      // Each step's CV is continuous (the same character as a VCO tune
      // knob) and smooths. `steps` is a step count -- the task's own
      // example of a param that must stay instant, since a fractional
      // step count mid-ramp is meaningless to the loop-around logic in
      // dsp/segment.ts. B3.
      setParam(id, value, atTime) {
        const param = node.parameters.get(id)
        if (!param) return
        if (id === 'steps') param.value = value
        else scheduleParam(param, value, ctx, atTime)
      },
      dispose() {
        node.disconnect()
        cvOut.disconnect()
        gateOut.disconnect()
        for (const gain of fronts) gain.disconnect()
        stepListeners.clear()
      },
      onStep(cb) {
        stepListeners.add(cb)
        return () => stepListeners.delete(cb)
      },
    }
  },
}
