import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'
import { tryCreateWorkletNode } from './worklet-fallback'

const SVF_FALLBACK_TYPES: Record<'lp' | 'bp' | 'hp' | 'notch', BiquadFilterType> = {
  lp: 'lowpass',
  bp: 'bandpass',
  hp: 'highpass',
  notch: 'notch',
}

/**
 * Native fallback for when `svf.js` didn't load. Four `BiquadFilterNode`s
 * in parallel, one per `BiquadFilterType` that matches this module's own
 * four simultaneous outputs, is a genuinely real fallback for "simultaneous
 * lp/bp/hp/notch from one cutoff" -- see vcf.ts's own fallback doc comment
 * for why `BiquadFilterNode` earns that word rather than being a token
 * gesture, and `types.ts`'s `fallback` doc comment for the honesty rule
 * this follows. What's genuinely different, and said in the badge: two-pole
 * (−12 dB/oct) rather than this module's real two-pole-but-differently-
 * voiced Oberheim-style topology (`dsp/svf.ts`'s own doc comment), and each
 * output is its own independent filter rather than four taps on one shared
 * state -- audibly close for a steady cutoff, not identical under fast
 * modulation. `cutoffCv` still tracks genuinely exponentially through
 * `detune` (cents), the same mechanism vco.ts's and vcf.ts's own fallbacks
 * use, applied to all four filters in lockstep so they stay in tune with
 * each other.
 */
function buildSvfFallback(ctx: BaseAudioContext): ModuleInstance {
  const input = ctx.createGain()
  const cvFront = ctx.createGain()
  const cvDepths: GainNode[] = []
  const filters = new Map<'lp' | 'bp' | 'hp' | 'notch', BiquadFilterNode>()
  const outs = new Map<'lp' | 'bp' | 'hp' | 'notch', GainNode>()

  for (const key of Object.keys(SVF_FALLBACK_TYPES) as (keyof typeof SVF_FALLBACK_TYPES)[]) {
    const filter = ctx.createBiquadFilter()
    filter.type = SVF_FALLBACK_TYPES[key]
    filter.frequency.value = 1000
    filter.Q.value = 0.7
    input.connect(filter)

    const cvDepth = ctx.createGain()
    cvDepth.gain.value = 0
    cvFront.connect(cvDepth)
    cvDepth.connect(filter.detune)
    cvDepths.push(cvDepth)

    // R29's own reasoning applies here too: front every output with its
    // own GainNode so this module's four simultaneous outputs stay
    // distinct nodes a cable can address independently.
    const out = ctx.createGain()
    filter.connect(out)

    filters.set(key, filter)
    outs.set(key, out)
  }

  return {
    inputs: new Map<string, AudioNode | AudioParam>([['in', input], ['cutoffCv', cvFront]]),
    outputs: new Map<string, AudioNode>([
      ['lp', outs.get('lp')!],
      ['bp', outs.get('bp')!],
      ['hp', outs.get('hp')!],
      ['notch', outs.get('notch')!],
    ]),
    fallback: {
      level: 'degraded',
      reason:
        "The state-variable filter worklet didn't load, so this is four independent native " +
        'two-pole filters instead. Close for a steady cutoff, not identical under fast modulation.',
    },
    setParam(id, value, atTime) {
      if (id === 'cutoff') {
        for (const filter of filters.values()) scheduleParam(filter.frequency, value, ctx, atTime)
      } else if (id === 'resonance') {
        const q = 0.7 + value * 20
        for (const filter of filters.values()) scheduleParam(filter.Q, q, ctx, atTime)
      } else if (id === 'cutoffCvAmount') {
        for (const depth of cvDepths) depth.gain.value = value * 1200
      }
    },
    dispose() {
      input.disconnect()
      cvFront.disconnect()
      for (const depth of cvDepths) depth.disconnect()
      for (const filter of filters.values()) filter.disconnect()
      for (const out of outs.values()) out.disconnect()
    },
  }
}

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
    const node = tryCreateWorkletNode(ctx, 'svf', {
      numberOfInputs: 2,
      numberOfOutputs: 4,
      outputChannelCount: [1, 1, 1, 1],
    })
    if (!node) return buildSvfFallback(ctx)
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
