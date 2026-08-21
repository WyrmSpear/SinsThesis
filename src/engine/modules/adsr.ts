import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'
import { tryCreateWorkletNode, buildFailedInstance } from './worklet-fallback'

export const adsrDescriptor: ModuleDescriptor = {
  type: 'adsr',
  name: 'ADSR',
  // 8 HP -- matches the Doepfer A-140 ADSR. Four knobs stack 2x2 rather
  // than spreading across one row (see rack/panel.ts and
  // .superpowers/sdd/hp-layout-report.md): a physical ADSR is tall and
  // narrow, not a single wide strip of pots.
  hp: 8,
  group: 'modulation',
  ports: [
    { id: 'gate', dir: 'in', signal: 'gate', label: 'Gate', pos: [0, 3] },
    { id: 'out', dir: 'out', signal: 'cv', label: 'Out', pos: [1, 3] },
  ],
  // Labels are the standard three-letter synth abbreviations (ATT/DEC/SUS/
  // REL), not the spelled-out param names -- a real ADSR panel says "SUS",
  // never "SUSTAIN", because panel space is scarce. At this panel's actual
  // column width (~50px at hp=8), "Sustain" and "Release" clipped to
  // "SUSTA…"/"RELEA…" (reported live); the full words never fit at a
  // legible type size, so the fix is honest labels, not a smaller font.
  params: [
    { id: 'attack', label: 'Att', min: 0.001, max: 10, default: 0.01, curve: 'exp', unit: 's' },
    { id: 'decay', label: 'Dec', min: 0.001, max: 10, default: 0.1, curve: 'exp', unit: 's' },
    { id: 'sustain', label: 'Sus', min: 0, max: 1, default: 0.7, curve: 'lin', unit: '' },
    { id: 'release', label: 'Rel', min: 0.001, max: 10, default: 0.2, curve: 'exp', unit: 's' },
  ],
  layout: [
    { kind: 'knob', ref: 'attack', x: 0, y: 0 },
    { kind: 'knob', ref: 'decay', x: 1, y: 0 },
    { kind: 'knob', ref: 'sustain', x: 0, y: 1 },
    { kind: 'knob', ref: 'release', x: 1, y: 1 },
    { kind: 'jack', ref: 'gate', x: 0, y: 3 },
    { kind: 'jack', ref: 'out', x: 1, y: 3 },
  ],
  create(ctx): ModuleInstance {
    const node = tryCreateWorkletNode(ctx, 'adsr', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    // No honest native equivalent: an envelope's attack/decay/release
    // shape and its exact retrigger behavior are exactly the per-sample
    // state machine `segment.worklet.ts` implements -- there is no
    // built-in WebAudio node that reproduces it, and approximating an
    // envelope generator with, say, a mistimed `setTargetAtTime` chain
    // would be the "wrong envelope is more confusing than a clear error"
    // case this project's own failure-mode brief warns against. Fails
    // loudly instead: silent output, an honest badge, everything else in
    // the patch keeps running. See `types.ts`'s `fallback` doc comment.
    if (!node) {
      return buildFailedInstance(
        ctx,
        adsrDescriptor.ports,
        "The ADSR worklet didn't load, so this module is silent. No native fallback exists for an envelope generator.",
      )
    }
    const gateIn = ctx.createGain()
    gateIn.connect(node, 0, 0)

    return {
      inputs: new Map<string, AudioNode | AudioParam>([['gate', gateIn]]),
      outputs: new Map([['out', node as AudioNode]]),
      // All four params (attack/decay/sustain/release) are continuous --
      // times and a level, none of them a discrete switch -- so every one
      // of them smooths through scheduleParam. B3.
      setParam(id, value, atTime) {
        const param = node.parameters.get(id)
        if (!param) return
        scheduleParam(param, value, ctx, atTime)
      },
      dispose() {
        node.disconnect()
        gateIn.disconnect()
      },
    }
  },
}
