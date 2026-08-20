import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'

/** The simultaneous lowpass/bandpass/highpass/notch outputs below are Tom
 *  Oberheim's state-variable topology, introduced in his SEM (1974) as the
 *  alternative to Moog's single-output ladder (`vcf.ts`) -- trading one
 *  steep (24 dB/oct) slope for four simultaneous shallower (12 dB/oct)
 *  ones, patchable at once. See `src/engine/dsp/svf.ts`'s own doc comment
 *  for the topology detail this credits. */
export const svfDescriptor: ModuleDescriptor = {
  type: 'svf',
  name: 'State-Variable VCF',
  // 10 HP -- same width as the ladder VCF (vcf.ts), which needed it for a
  // 2x2 knob grid plus a two-jack row; this module's layout is the same
  // shape (a 2x1 knob row over a lone knob, three 2-jack rows) so the same
  // width fits six jacks and three knobs without widening the panel.
  hp: 10,
  group: 'shaping',
  ports: [
    { id: 'in', dir: 'in', signal: 'audio', label: 'In', pos: [0, 2] },
    // Same 'CV' shortening as vcf.ts's cutoffCv, for the same reason: this
    // module has exactly one CV input, so the bare word is unambiguous.
    { id: 'cutoffCv', dir: 'in', signal: 'cv', label: 'CV', pos: [1, 2] },
    { id: 'lp', dir: 'out', signal: 'audio', label: 'LP', pos: [0, 3] },
    { id: 'bp', dir: 'out', signal: 'audio', label: 'BP', pos: [1, 3] },
    { id: 'hp', dir: 'out', signal: 'audio', label: 'HP', pos: [0, 4] },
    // 'Notch' fits comfortably in this jack column at four characters'
    // width or more (this panel's widest jack label is 'Ntch' either way);
    // kept as the full word since 'Sync'/'Gate'/'Thru' (four letters) are
    // already the established floor for jack labels in this codebase.
    { id: 'notch', dir: 'out', signal: 'audio', label: 'Ntch', pos: [1, 4] },
  ],
  // Same 'Cut'/'Res'/'Amt' shortenings as vcf.ts's own params -- this panel
  // is the same width, so the same abbreviations that already cleared
  // truncation there clear it here too.
  params: [
    { id: 'cutoff', label: 'Cut', min: 20, max: 20000, default: 1000, curve: 'exp', unit: 'Hz' },
    { id: 'resonance', label: 'Res', min: 0, max: 1, default: 0, curve: 'lin', unit: '' },
    { id: 'cutoffCvAmount', label: 'Amt', min: -8, max: 8, default: 0, curve: 'lin', unit: 'oct' },
  ],
  layout: [
    { kind: 'knob', ref: 'cutoff', x: 0, y: 0 },
    { kind: 'knob', ref: 'resonance', x: 1, y: 0 },
    { kind: 'knob', ref: 'cutoffCvAmount', x: 0, y: 1 },
    { kind: 'jack', ref: 'in', x: 0, y: 2 },
    { kind: 'jack', ref: 'cutoffCv', x: 1, y: 2 },
    { kind: 'jack', ref: 'lp', x: 0, y: 3 },
    { kind: 'jack', ref: 'bp', x: 1, y: 3 },
    { kind: 'jack', ref: 'hp', x: 0, y: 4 },
    { kind: 'jack', ref: 'notch', x: 1, y: 4 },
  ],
  create(ctx): ModuleInstance {
    const node = new AudioWorkletNode(ctx, 'svf', {
      numberOfInputs: 2,
      numberOfOutputs: 4,
      outputChannelCount: [1, 1, 1, 1],
    })
    const audioIn = ctx.createGain()
    const cvIn = ctx.createGain()
    audioIn.connect(node, 0, 0)
    cvIn.connect(node, 0, 1)

    // R29: a multi-output worklet node needs each output fronted by its own
    // GainNode, mirroring the input-fronting convention every module in
    // this set uses -- the graph's plain two-argument connect() always
    // addresses output index 0, so without this every one of the four
    // simultaneous outputs would collapse onto the same signal. See
    // sequencer.ts's cv/gate outputs for the established precedent.
    const lpOut = ctx.createGain()
    const bpOut = ctx.createGain()
    const hpOut = ctx.createGain()
    const notchOut = ctx.createGain()
    node.connect(lpOut, 0)
    node.connect(bpOut, 1)
    node.connect(hpOut, 2)
    node.connect(notchOut, 3)

    return {
      inputs: new Map<string, AudioNode | AudioParam>([['in', audioIn], ['cutoffCv', cvIn]]),
      outputs: new Map<string, AudioNode>([
        ['lp', lpOut],
        ['bp', bpOut],
        ['hp', hpOut],
        ['notch', notchOut],
      ]),
      // cutoff, resonance and cutoffCvAmount are all continuous -- no
      // discrete/switch param on this module -- so every one smooths. B3.
      setParam(id, value, atTime) {
        const param = node.parameters.get(id)
        if (!param) return
        scheduleParam(param, value, ctx, atTime)
      },
      dispose() {
        node.disconnect()
        audioIn.disconnect()
        cvIn.disconnect()
        lpOut.disconnect()
        bpOut.disconnect()
        hpOut.disconnect()
        notchOut.disconnect()
      },
    }
  },
}
