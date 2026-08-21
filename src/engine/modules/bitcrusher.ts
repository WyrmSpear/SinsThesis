import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'
import { tryCreateWorkletNode, buildFailedInstance } from './worklet-fallback'

/**
 * Bit-depth and sample-rate reduction -- the Speak & Spell/SP-1200/early-
 * sampler texture, and the lo-fi/circuit-bent tool most requested alongside
 * the Sampler (see docs/CONTINUATION.md). All the math, including the
 * deliberate choice **not** to antialias, lives in dsp/bitcrusher.ts --
 * read that file's doc comment before touching this one; the aliasing this
 * module produces is the entire point, not a defect this codebase's usual
 * measured-alias-floor discipline missed.
 *
 * `bits` and `rate` each get their own CV input and amount, the same
 * `xCv`/`xCvAmount` pair every other modulatable-amount param in this
 * codebase uses (wavefolder.ts's `foldCv`, drive.ts's `driveCv`) -- an
 * envelope sweeping bit depth down over a note's decay, or an LFO wobbling
 * the crush rate, are exactly the "CV over both" this module's task named.
 */
export const bitcrusherDescriptor: ModuleDescriptor = {
  type: 'bitcrusher',
  name: 'Bitcrusher',
  // 10 HP -- same width as Drive (drive.ts), for the same reason: five
  // params (three knobs plus two CV amounts) over four jacks needs a 2x3
  // knob grid plus a 2x2 jack grid, not the narrower wavefolder/VCA shape.
  hp: 10,
  group: 'shaping',
  ports: [
    { id: 'in', dir: 'in', signal: 'audio', label: 'In', pos: [0, 3] },
    { id: 'bitsCv', dir: 'in', signal: 'cv', label: 'Bits CV', pos: [1, 3] },
    { id: 'rateCv', dir: 'in', signal: 'cv', label: 'Rate CV', pos: [0, 4] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [1, 4] },
  ],
  params: [
    // Default 16 -- inaudibly transparent (see quantize's own doc comment),
    // the same "knob at its neutral position is a bypass" convention
    // drive.ts's drive=1/wavefolder.ts's drive=1 both use.
    { id: 'bits', label: 'Bits', min: 1, max: 16, default: 16, curve: 'lin', unit: 'bit' },
    // Default the top of the range -- captures every sample, i.e.
    // transparent, the decimator's own "off" position.
    { id: 'rate', label: 'Rate', min: 100, max: 48000, default: 48000, curve: 'exp', unit: 'Hz' },
    { id: 'bend', label: 'Bend', min: 0, max: 1, default: 0, curve: 'lin', unit: '' },
    { id: 'bitsCvAmount', label: 'Bits Amt', min: 0, max: 16, default: 0, curve: 'lin', unit: '' },
    { id: 'rateCvAmount', label: 'Rate Amt', min: 0, max: 48000, default: 0, curve: 'lin', unit: '' },
  ],
  layout: [
    { kind: 'knob', ref: 'bits', x: 0, y: 0 },
    { kind: 'knob', ref: 'rate', x: 1, y: 0 },
    { kind: 'knob', ref: 'bend', x: 0, y: 1 },
    { kind: 'knob', ref: 'bitsCvAmount', x: 1, y: 1 },
    { kind: 'knob', ref: 'rateCvAmount', x: 0, y: 2 },
    { kind: 'jack', ref: 'in', x: 0, y: 3 },
    { kind: 'jack', ref: 'bitsCv', x: 1, y: 3 },
    { kind: 'jack', ref: 'rateCv', x: 0, y: 4 },
    { kind: 'jack', ref: 'out', x: 1, y: 4 },
  ],
  create(ctx): ModuleInstance {
    const node = tryCreateWorkletNode(ctx, 'bitcrusher', {
      numberOfInputs: 3,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    // No honest native equivalent, and deliberately not attempted: this
    // module's whole reason to exist is its specific, deliberately
    // unfiltered aliasing (see this file's own doc comment and `dsp/
    // bitcrusher.ts`'s), and no built-in WebAudio node reproduces true
    // bit-depth/sample-rate decimation -- a `WaveShaperNode` quantizes
    // amplitude but cannot hold samples across time the way a
    // sample-and-hold-style rate reduction needs. Fails loudly rather than
    // shipping a different-sounding "lo-fi-ish" substitute with no warning.
    if (!node) {
      return buildFailedInstance(
        ctx,
        bitcrusherDescriptor.ports,
        "The Bitcrusher worklet didn't load, so this module is silent. No native fallback exists for bit/rate decimation.",
      )
    }
    const fronts = ['in', 'bitsCv', 'rateCv'].map((_, index) => {
      const gain = ctx.createGain()
      gain.connect(node, 0, index)
      return gain
    })

    return {
      inputs: new Map<string, AudioNode | AudioParam>([
        ['in', fronts[0]!],
        ['bitsCv', fronts[1]!],
        ['rateCv', fronts[2]!],
      ]),
      outputs: new Map([['out', node as AudioNode]]),
      // Every param here is continuous (bits and rate sweep smoothly by
      // design -- see dsp/bitcrusher.ts's own doc comment on why `bits`
      // is not an integer switch), so every one smooths through
      // scheduleParam (B3). No discrete/switch param on this module at
      // all, unlike most others in this set.
      setParam(id, value, atTime) {
        const param = node.parameters.get(id)
        if (!param) return
        scheduleParam(param, value, ctx, atTime)
      },
      dispose() {
        node.disconnect()
        for (const gain of fronts) gain.disconnect()
      },
    }
  },
}
