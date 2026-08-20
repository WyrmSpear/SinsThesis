import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'

/**
 * Two sine oscillators, one hard-panned to each ear, offset by a settable
 * frequency difference around a settable center. That is the entire
 * mechanism: a small, controlled difference between what the left ear and
 * the right ear each receive.
 *
 * **What this module does not do.** It makes no claim about brainwave
 * entrainment, mood, relaxation, or any clinical or therapeutic outcome.
 * Nothing in this file, its panel labels, or its params describes an
 * effect on a listener -- only the signal: a carrier frequency, and a beat
 * frequency that is the arithmetic difference between the two channels.
 * What a listener's auditory system does with two channel-separated tones
 * is not something this module measures, produces, or asserts anything
 * about.
 *
 * **Headphones are not a suggestion, they change what mechanism is
 * operating.** What this module's own name refers to is specifically a
 * *per-ear* signal difference, presented to two separate ears with nothing
 * in between to mix them. Play its output on a single speaker (or any
 * mono-summing path) instead, and `left + right` become two sine waves
 * physically superposed -- measured directly in
 * `tests/browser/modules/binaural.test.ts`, this is a real, full-depth
 * amplitude modulation at exactly the `beat` rate (`sin(a) + sin(b) =
 * 2*sin((a+b)/2)*cos((a-b)/2)`, the same interference a piano tuner
 * listens for), not silence and not nothing. It is, however, a genuinely
 * different, unrelated phenomenon from separate-ear delivery -- ordinary
 * two-tone acoustic interference, indistinguishable by measurement from
 * mixing any two independent oscillators at the same two frequencies with
 * no "binaural" module involved at all (that comparison is exactly what
 * the mono-sum test proves). This is stated here because it directly
 * explains behavior a player would otherwise read as a bug: on a laptop
 * speaker this module still audibly pulses, but that pulsing is ordinary
 * physics, not the separate-ear mechanism the module exists to provide.
 *
 * Mono in would be meaningless for this module -- there is no single input
 * signal to derive two channels' worth of anything from, this *is* a
 * stereo source, one of the two-channel generators the stereo output stage
 * (ROADMAP section 1a, `output.ts`) made possible in the first place. See
 * `dsp/binaural.ts` for the carrier/beat -> left/right derivation and the
 * phase-accumulation precision this module depends on for sub-hertz `beat`
 * settings to be exact rather than approximate.
 */
export const binauralDescriptor: ModuleDescriptor = {
  type: 'binaural',
  name: 'Binaural',
  // 8 HP -- three knobs (2+1) and two jacks, the same footprint class as
  // lfo.ts's own 4-knob/2-jack 8 HP panel.
  hp: 8,
  group: 'source',
  ports: [
    // Single CV input, so the bare 'CV' label is unambiguous -- same
    // shortening precedent as panner.ts's panCv / svf.ts's cutoffCv.
    { id: 'beatCv', dir: 'in', signal: 'cv', label: 'CV', pos: [0, 3] },
    // One stereo `out`, not `outL`/`outR` -- the same convention
    // panner.ts/pingpong.ts/width.ts already established: a cable carries
    // however many channels its source produces, and this module produces
    // two. See output.ts's doc comment for the up-mix/pass-through
    // reasoning that makes one jack correct here too.
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [1, 3] },
  ],
  params: [
    // 'Carrier' overflowed this 8 HP panel's knob column and rendered as
    // an ellipsis ("CARRI…", caught by an actual screenshot -- the same
    // failure mode panner.ts's own doc comment documents for 'Pan CV').
    // 'Carr' clears it, the same floor 'Sync'/'Gate'/'Thru' already
    // establish for jack labels in this codebase.
    { id: 'carrier', label: 'Carr', min: 20, max: 2000, default: 220, curve: 'exp', unit: 'Hz' },
    // Down to 0.01 Hz -- a fraction of a hertz, per this module's own
    // reason to exist -- up to 40 Hz, past which the two channels read as
    // two distinct pitches rather than one wavering tone.
    { id: 'beat', label: 'Beat', min: 0.01, max: 40, default: 4, curve: 'exp', unit: 'Hz' },
    // 'Amt' -- same abbreviation and same "Hz of swing per unit of CV"
    // convention as svf.ts's cutoffCvAmount (there in octaves) and
    // drive.ts's driveCvAmount (there unitless): the knob scales whatever
    // is patched into `beatCv` rather than beatCv acting directly on an
    // AudioParam the way panCv/timeCv do, because "beat" needs a clamp at
    // zero (see dsp/binaural.ts's deriveChannelFreqs) that a bare additive
    // AudioParam connection can't express.
    { id: 'beatCvAmount', label: 'Amt', min: 0, max: 20, default: 0, curve: 'lin', unit: 'Hz' },
  ],
  layout: [
    { kind: 'knob', ref: 'carrier', x: 0, y: 0 },
    { kind: 'knob', ref: 'beat', x: 1, y: 0 },
    { kind: 'knob', ref: 'beatCvAmount', x: 0, y: 1 },
    { kind: 'jack', ref: 'beatCv', x: 0, y: 3 },
    { kind: 'jack', ref: 'out', x: 1, y: 3 },
  ],
  create(ctx): ModuleInstance {
    const node = new AudioWorkletNode(ctx, 'binaural', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    })
    const beatCvFront = ctx.createGain()
    beatCvFront.connect(node, 0, 0)

    return {
      inputs: new Map<string, AudioNode | AudioParam>([['beatCv', beatCvFront]]),
      outputs: new Map([['out', node as AudioNode]]),
      // carrier, beat and beatCvAmount are all continuous -- there is no
      // discrete/switch param on this module -- so every one smooths. B3.
      setParam(id, value, atTime) {
        const param = node.parameters.get(id)
        if (!param) return
        scheduleParam(param, value, ctx, atTime)
      },
      dispose() {
        node.disconnect()
        beatCvFront.disconnect()
      },
    }
  },
}
