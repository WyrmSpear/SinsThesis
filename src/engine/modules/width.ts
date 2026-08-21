import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'
import { tryCreateWorkletNode, buildFailedInstance } from './worklet-fallback'

/**
 * Stereo in, stereo out -- a mid-side spatialiser, ROADMAP section 1a's
 * fourth new module and the one the roadmap warns hardest about: "the trap
 * to avoid is a widener that sounds impressive in headphones and collapses
 * to thin or hollow in mono." Mid-side (dsp/width.ts) makes that
 * structurally impossible rather than merely tested-for -- `left + right`
 * is provably, algebraically identical to the input's own mono sum at every
 * width setting (see that file's doc comment for the two-line proof), which
 * is exactly what a Haas-delay ("thicken" by offsetting one channel a few
 * milliseconds) cannot promise: a short inter-channel delay is comb
 * filtering waiting to happen the moment two correlated channels are
 * summed, and *how much* cancels depends on delay time and material, not on
 * anything the effect can guarantee up front.
 *
 * Fed a mono signal (both channels identical, `side` already zero -- see
 * output.ts's up-mix trick, used identically here on the `in` jack), this
 * module is a correct no-op at any width: there is no stereo image to
 * widen, so it neither creates one nor breaks anything.
 */
export const widthDescriptor: ModuleDescriptor = {
  type: 'width',
  name: 'Width',
  // 6 HP -- one knob, two jacks, the same compact footprint as output.ts.
  hp: 6,
  group: 'effects',
  ports: [
    { id: 'in', dir: 'in', signal: 'audio', label: 'In', pos: [0, 3] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [0, 4] },
  ],
  params: [
    { id: 'width', label: 'Width', min: 0, max: 2, default: 1, curve: 'lin', unit: '' },
  ],
  layout: [
    { kind: 'knob', ref: 'width', x: 0, y: 0 },
    { kind: 'jack', ref: 'in', x: 0, y: 3 },
    { kind: 'jack', ref: 'out', x: 0, y: 4 },
  ],
  create(ctx): ModuleInstance {
    const input = ctx.createGain()
    // Same up-mix trick as output.ts's `level` node: forces a mono cable
    // into two identical channels before the worklet ever sees it, and
    // leaves a genuinely stereo cable untouched. See that file's doc
    // comment for the full reasoning.
    input.channelCount = 2
    input.channelCountMode = 'explicit'
    input.channelInterpretation = 'speakers'

    const node = tryCreateWorkletNode(ctx, 'width', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    })
    // Not in this pass's genuine-fallback set -- see
    // `.superpowers/sdd/robustness-report.md`. Mid-side widening is
    // actually exact linear algebra (mid +/- side, scaled) that native
    // `ChannelSplitterNode`/`ChannelMergerNode`/`GainNode`s could
    // reproduce losslessly, unlike this file's other approximated
    // fallbacks -- left as a real follow-up rather than attempted under
    // this pass's time budget; failing loudly here is conservative, not a
    // claim that no honest fallback is possible.
    if (!node) {
      input.disconnect()
      return buildFailedInstance(
        ctx,
        widthDescriptor.ports,
        "The Width worklet didn't load, so this module passes no signal. A native fallback wasn't built for it in this pass.",
      )
    }
    input.connect(node)

    return {
      inputs: new Map<string, AudioNode | AudioParam>([['in', input]]),
      outputs: new Map([['out', node as AudioNode]]),
      // width is the only param and it's continuous. B3.
      setParam(id, value, atTime) {
        const param = node.parameters.get(id)
        if (!param) return
        scheduleParam(param, value, ctx, atTime)
      },
      dispose() {
        input.disconnect()
        node.disconnect()
      },
    }
  },
}
