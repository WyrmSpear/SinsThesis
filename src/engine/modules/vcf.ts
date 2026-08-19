import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'

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
    const node = new AudioWorkletNode(ctx, 'ladder', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
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
