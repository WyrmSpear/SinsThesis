import type { ModuleDescriptor, ModuleInstance } from '../types'
import { FREQ_BANK, freqBankHz } from '../dsp/freq-bank'

/**
 * A source that snaps to one of sixteen specific tuned frequencies rather
 * than a continuous knob -- the Solfeggio set, the Schumann resonance and
 * its first four harmonics, and two reference pitches for A above middle
 * C. See `dsp/freq-bank.ts` for exactly what each entry is, where its
 * number comes from, and this module's own accuracy guarantee. As with
 * Binaural and Isochronic, nothing here describes an effect on a
 * listener -- only the signal this module produces.
 *
 * Built on a native `OscillatorNode` (`type = 'sine'`) rather than a
 * worklet -- the same choice `panner.ts` made for the identical reason:
 * there is no DSP left to write. A sine has no harmonics to band-limit, so
 * `dsp/wavetable.ts`'s mip-mapped machinery would add nothing but a table
 * lookup's own small interpolation error, and a plain sine is exactly what
 * the browser's own oscillator already generates with no antialiasing
 * concern to weigh. `dsp/freq-bank.ts` exists anyway, holding the sixteen
 * frequency values as plain, Node-testable data -- the same "trust but
 * verify the platform" posture `pan.ts`'s doc comment documents for
 * `panner.ts`'s own native-node choice.
 *
 * `frequency` and `octave` are both discrete switches (`ParamSpec.labels`)
 * snapped instantly, never smoothed -- gliding between two named
 * frequencies would pass through infinitely many un-named ones on the way,
 * which is exactly backwards for a module whose entire point is landing
 * exactly on the one selected. Octave shifting stays exact for the same
 * reason `dsp/freq-bank.ts`'s doc comment gives: multiplying by a power of
 * two never erodes float64 precision.
 */
export const freqBankDescriptor: ModuleDescriptor = {
  type: 'freq-bank',
  name: 'Frequency Bank',
  // 8 HP -- two knobs, one jack, comfortably narrower than most sources
  // (compare noise.ts's 6 HP for one knob) since neither knob's readout is
  // wide (frequency labels top out at 4 characters, e.g. 'A432').
  hp: 8,
  group: 'source',
  ports: [{ id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [0, 3] }],
  params: [
    {
      id: 'frequency',
      label: 'Freq',
      min: 0,
      max: FREQ_BANK.length - 1,
      default: 4, // index 4 == '528'
      curve: 'lin',
      unit: '',
      labels: FREQ_BANK.map((e) => e.label),
    },
    {
      id: 'octave',
      label: 'Oct',
      min: -2,
      max: 2,
      default: 0,
      curve: 'lin',
      unit: '',
      labels: ['-2', '-1', '0', '1', '2'],
    },
  ],
  layout: [
    { kind: 'knob', ref: 'frequency', x: 0, y: 0 },
    { kind: 'knob', ref: 'octave', x: 1, y: 0 },
    { kind: 'jack', ref: 'out', x: 0, y: 3 },
  ],
  create(ctx): ModuleInstance {
    const osc = ctx.createOscillator()
    osc.type = 'sine'

    let currentIndex = 4
    let currentOctave = 0
    osc.frequency.value = freqBankHz(currentIndex, currentOctave)
    osc.start()

    return {
      inputs: new Map(),
      outputs: new Map([['out', osc as AudioNode]]),
      // Both params are discrete switches -- an instant snap to the exact
      // named frequency, never a glide. Same B3 "discrete stays instant"
      // rule every other switch-like param in this codebase follows
      // (waveform shape, clock division, ...); `atTime` is accepted but
      // unused for the same reason those ignore it too.
      setParam(id, value) {
        if (id === 'frequency') currentIndex = value
        else if (id === 'octave') currentOctave = value
        else return
        osc.frequency.value = freqBankHz(currentIndex, currentOctave)
      },
      dispose() {
        osc.stop()
        osc.disconnect()
      },
    }
  },
}
