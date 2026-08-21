import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'
import { tryCreateWorkletNode } from './worklet-fallback'

/**
 * Native fallback for when `ladder.js` didn't load. `BiquadFilterNode`'s
 * `'lowpass'` type is a real fallback -- see `types.ts`'s `fallback` doc
 * comment's honesty rule -- but a genuinely different one from the real
 * four-pole ladder: two-pole (−12 dB/oct, not the ladder's four-pole
 * −24 dB/oct passing through the same −18-to−68 dB/oct curve `dsp/
 * ladder.ts` measures), no self-oscillation at any resonance, and no
 * transistor-style saturation on the resonant loop -- the badge says so
 * rather than pretending this is the same filter. `cutoffCv` still tracks
 * genuinely exponentially: `BiquadFilterNode.detune` is cents, same as
 * `OscillatorNode.detune` (see vco.ts's own fallback doc comment for the
 * mechanism), so scaling the CV input by `cutoffCvAmount * 1200` and
 * summing it into `detune` reproduces real octave-per-volt tracking
 * through nothing but `AudioParam` summing. `drive` becomes a plain
 * pre-filter gain into a fixed `tanh`-shaped `WaveShaperNode` -- audibly
 * "more drive = more grit," not a calibrated match for the ladder's own
 * measured alias floor.
 */
function buildLadderFallback(ctx: BaseAudioContext): ModuleInstance {
  const preGain = ctx.createGain()
  const shaper = ctx.createWaveShaper()
  const curve = new Float32Array(1024)
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1
    curve[i] = Math.tanh(x)
  }
  shaper.curve = curve
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 1000
  filter.Q.value = 0.7

  preGain.connect(shaper)
  shaper.connect(filter)

  const cvFront = ctx.createGain()
  const cvDepth = ctx.createGain()
  cvDepth.gain.value = 0
  cvFront.connect(cvDepth)
  cvDepth.connect(filter.detune)

  return {
    inputs: new Map<string, AudioNode | AudioParam>([['in', preGain], ['cutoffCv', cvFront]]),
    outputs: new Map([['out', filter as AudioNode]]),
    fallback: {
      level: 'degraded',
      reason:
        "The ladder filter worklet didn't load, so this is a native two-pole lowpass instead. " +
        'No self-oscillation and a shallower slope than the real four-pole ladder.',
    },
    setParam(id, value, atTime) {
      if (id === 'cutoff') scheduleParam(filter.frequency, value, ctx, atTime)
      else if (id === 'resonance') scheduleParam(filter.Q, 0.7 + value * 20, ctx, atTime)
      else if (id === 'cutoffCvAmount') cvDepth.gain.value = value * 1200
      else if (id === 'drive') preGain.gain.value = value
    },
    dispose() {
      preGain.disconnect()
      shaper.disconnect()
      filter.disconnect()
      cvFront.disconnect()
      cvDepth.disconnect()
    },
  }
}

/** This module's four-pole lowpass topology traces to Robert Moog's
 *  transistor-ladder filter, filed October 10, 1966 and granted as US
 *  Patent 3,475,623 on October 28, 1969 -- the defining "East Coast"
 *  subtractive design (start from a harmonic-rich waveform, remove content
 *  with a filter) this module's own cutoff calibration (see
 *  `src/engine/dsp/ladder.ts` and trap 5 in `docs/CONTINUATION.md`) already
 *  treats as a real reference point. Named descriptively here rather than
 *  after the patent holder, matching the same nominative-fair-use register
 *  as this comment itself -- a real lineage described in prose, not
 *  borrowed as a product name (see
 *  `.superpowers/sdd/theme-rename-report.md`). */
export const vcfDescriptor: ModuleDescriptor = {
  type: 'vcf',
  name: 'Ladder VCF',
  // 10 HP, not the Doepfer A-120's 8 -- the two extra HP go to
  // cutoffCvAmount's readout column. At hp=8 that knob's default reading,
  // "0.00 oct", still clipped in two of the eight themes' font metrics
  // (phosphor-lab, circuit-pcb; reported live via automated per-theme
  // truncation measurement) even after every other label/readout on this
  // panel was shortened -- "oct" is already the standard unit abbreviation
  // and cutoffCvAmount's own +/-8 range needs the sign digit room, so
  // there was nothing left to shorten there. Matches vco.ts's own 10 HP,
  // which grew for the identical reason (a switch-kind control's readout
  // needing more column room than the 8 HP floor gives).
  hp: 10,
  group: 'shaping',
  ports: [
    { id: 'in', dir: 'in', signal: 'audio', label: 'In', pos: [0, 3] },
    // 'Cutoff CV' clipped to "CUTOFF C…" at this jack column's width
    // (reported live); this module has exactly one CV input, so a bare
    // 'CV' is unambiguous -- it's what distinguishes this jack from the
    // audio 'In'/'Out' pair beside it, nothing more needs saying.
    { id: 'cutoffCv', dir: 'in', signal: 'cv', label: 'CV', pos: [1, 3] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [0, 4] },
  ],
  // "Cutoff" clipped to "CUTO…" at this panel's ~50px column (reported
  // live); "Cut" is the standard synth-panel abbreviation and reads
  // unambiguously next to Res/CV Amt/Drive.
  params: [
    { id: 'cutoff', label: 'Cut', min: 20, max: 20000, default: 1000, curve: 'exp', unit: 'Hz' },
    { id: 'resonance', label: 'Res', min: 0, max: 1, default: 0, curve: 'lin', unit: '' },
    // Same 'Amt' shortening as vca.ts's cvAmount, for the same reason.
    { id: 'cutoffCvAmount', label: 'Amt', min: -8, max: 8, default: 0, curve: 'lin', unit: 'oct' },
    { id: 'drive', label: 'Drive', min: 0.1, max: 8, default: 1, curve: 'exp', unit: '' },
  ],
  layout: [
    { kind: 'knob', ref: 'cutoff', x: 0, y: 0 },
    { kind: 'knob', ref: 'resonance', x: 1, y: 0 },
    { kind: 'knob', ref: 'cutoffCvAmount', x: 0, y: 1 },
    { kind: 'knob', ref: 'drive', x: 1, y: 1 },
    { kind: 'jack', ref: 'in', x: 0, y: 3 },
    { kind: 'jack', ref: 'cutoffCv', x: 1, y: 3 },
    { kind: 'jack', ref: 'out', x: 0, y: 4 },
  ],
  create(ctx): ModuleInstance {
    const node = tryCreateWorkletNode(ctx, 'ladder', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    if (!node) return buildLadderFallback(ctx)
    const audioIn = ctx.createGain()
    const cvIn = ctx.createGain()
    audioIn.connect(node, 0, 0)
    cvIn.connect(node, 0, 1)

    return {
      inputs: new Map<string, AudioNode | AudioParam>([['in', audioIn], ['cutoffCv', cvIn]]),
      outputs: new Map([['out', node as AudioNode]]),
      // cutoff, resonance, cutoffCvAmount and drive are all continuous --
      // no discrete/switch param on this module -- so every one smooths. B3.
      setParam(id, value, atTime) {
        const param = node.parameters.get(id)
        if (!param) return
        scheduleParam(param, value, ctx, atTime)
      },
      dispose() {
        node.disconnect()
        audioIn.disconnect()
        cvIn.disconnect()
      },
    }
  },
}
