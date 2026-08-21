import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'
import {
  VOICE_PHASES,
  BASE_DELAY_SECONDS,
  MAX_SWEEP_SECONDS,
  MIN_RATE_HZ,
  MAX_RATE_HZ,
  voiceDelaySeconds,
  sinePhaseCoefficients,
} from '../dsp/chorus'

/** Comfortably past the longest a voice can reach (28 ms of spread plus
 *  5 ms of sweep). Sized once per DelayNode at construction. */
const MAX_DELAY_SECONDS = 0.06

/**
 * A chorus: three delayed copies of the input, each gently swept by its own
 * LFO, summed back under the dry signal. The thickening/ensemble effect.
 *
 * **Native nodes, deliberately, and this is the interesting part.** The
 * Flanger next door had to move its delay line into a worklet because Web
 * Audio must insert a render quantum into any graph cycle and a flanger's
 * regeneration is a cycle (see `dsp/flanger.ts` for the measurement). A
 * chorus has **no feedback**, so it has no cycle, so the quantum never
 * appears and `DelayNode` sweeps correctly. The two modules landing on
 * opposite answers is not an inconsistency -- it is the same rule applied
 * to two different graphs.
 *
 * **Why this is its own module rather than a mode on the Flanger**, when
 * both are "a modulated delay": the delay ranges differ by about 100x
 * (0.1-10 ms against 12-28 ms), so a shared Time knob would mean two
 * different things depending on a switch position. Beyond the knob, the
 * circuits genuinely differ -- a flanger is one delay with regeneration, a
 * chorus is three without any -- which is the same reasoning that made the
 * state-variable filter its own topology rather than a mode on the ladder.
 *
 * **Three voices at 120 degrees.** The phase offsets are carried in
 * `PeriodicWave` coefficients rather than by starting three oscillators at
 * staggered times, because a time stagger is a fixed number of seconds and
 * silently stops being a third of a cycle the moment the Rate knob moves.
 * The derivation, and the two wrong workarounds, are in `dsp/chorus.ts`.
 * `tests/browser/modules/chorus.test.ts` measures the realised phases of
 * three oscillators built this way rather than trusting the arithmetic, and
 * checks they hold after a rate change.
 */
export const chorusDescriptor: ModuleDescriptor = {
  type: 'chorus',
  name: 'Chorus',
  // 10 HP -- Delay's width (delay.ts). Four knobs over two jacks fits a 2x2
  // grid with room for "Spread".
  hp: 10,
  group: 'effects',
  ports: [
    { id: 'in', dir: 'in', signal: 'audio', label: 'In', pos: [0, 3] },
    { id: 'rateCv', dir: 'in', signal: 'cv', label: 'Rate CV', pos: [1, 3] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [0, 4] },
  ],
  params: [
    // Slower than the Flanger's range: a chorus that sweeps fast reads as
    // vibrato rather than as an ensemble.
    { id: 'rate', label: 'Rate', min: MIN_RATE_HZ, max: MAX_RATE_HZ, default: 0.6, curve: 'exp', unit: 'Hz' },
    { id: 'depth', label: 'Depth', min: 0, max: 1, default: 0.5, curve: 'lin', unit: '' },
    // How far apart the three voices sit. At 0 they collapse onto one
    // delay and the module becomes a single swept copy; at 1 they sit at
    // 12, 20 and 28 ms.
    { id: 'spread', label: 'Spread', min: 0, max: 1, default: 0.5, curve: 'lin', unit: '' },
    // 0.5 rather than the Ring Mod's 1: a chorus is an effect you hear
    // *around* the dry signal, and fully wet loses the anchor it thickens.
    { id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.5, curve: 'lin', unit: '' },
  ],
  layout: [
    { kind: 'knob', ref: 'rate', x: 0, y: 0 },
    { kind: 'knob', ref: 'depth', x: 1, y: 0 },
    { kind: 'knob', ref: 'spread', x: 0, y: 1 },
    { kind: 'knob', ref: 'mix', x: 1, y: 1 },
    { kind: 'jack', ref: 'in', x: 0, y: 3 },
    { kind: 'jack', ref: 'rateCv', x: 1, y: 3 },
    { kind: 'jack', ref: 'out', x: 0, y: 4 },
  ],
  create(ctx): ModuleInstance {
    const input = ctx.createGain()
    input.gain.value = 1

    const rateCvFront = ctx.createGain()
    rateCvFront.gain.value = 1

    const wet = ctx.createGain()
    wet.gain.value = 0.5

    const voices = VOICE_PHASES.map((phase, index) => {
      const delay = ctx.createDelay(MAX_DELAY_SECONDS)
      // Intrinsic 0; the centre delay and the sweep both arrive as connected
      // signals and sum into the param. Same pattern ring.ts uses to let two
      // sources share one AudioParam with no branching.
      delay.delayTime.value = 0
      input.connect(delay)

      const centre = ctx.createConstantSource()
      centre.offset.value = voiceDelaySeconds(index, 0.5)
      centre.connect(delay.delayTime)
      centre.start()

      const lfo = ctx.createOscillator()
      const { real, imag } = sinePhaseCoefficients(phase)
      // disableNormalization: the coefficients already describe a unit sine,
      // and normalisation would rescale it by a factor that depends on the
      // phase -- which would turn a phase offset into a depth difference.
      lfo.setPeriodicWave(ctx.createPeriodicWave(real, imag, { disableNormalization: true }))
      lfo.frequency.value = 0.6
      lfo.start()
      rateCvFront.connect(lfo.frequency)

      const sweep = ctx.createGain()
      sweep.gain.value = 0.5 * MAX_SWEEP_SECONDS
      lfo.connect(sweep)
      sweep.connect(delay.delayTime)

      // Each voice contributes a third, so three voices at full mix sum to
      // the same level one voice would -- the Spread knob changes the
      // texture, never the loudness.
      const voiceGain = ctx.createGain()
      voiceGain.gain.value = 1 / VOICE_PHASES.length
      delay.connect(voiceGain)
      voiceGain.connect(wet)

      return { delay, centre, lfo, sweep, voiceGain }
    })

    const dry = ctx.createGain()
    dry.gain.value = 0.5
    input.connect(dry)

    const out = ctx.createGain()
    out.gain.value = 1
    dry.connect(out)
    wet.connect(out)

    return {
      inputs: new Map<string, AudioNode | AudioParam>([
        ['in', input],
        ['rateCv', rateCvFront],
      ]),
      outputs: new Map([['out', out as AudioNode]]),
      // Every param is continuous -- no switch on this module -- so all of
      // them smooth through scheduleParam. B3.
      setParam(id, value, atTime) {
        if (id === 'rate') {
          for (const v of voices) scheduleParam(v.lfo.frequency, value, ctx, atTime)
        } else if (id === 'depth') {
          for (const v of voices) scheduleParam(v.sweep.gain, value * MAX_SWEEP_SECONDS, ctx, atTime)
        } else if (id === 'spread') {
          voices.forEach((v, index) => {
            scheduleParam(v.centre.offset, voiceDelaySeconds(index, value), ctx, atTime)
          })
        } else if (id === 'mix') {
          scheduleParam(wet.gain, value, ctx, atTime)
          scheduleParam(dry.gain, 1 - value, ctx, atTime)
        }
      },
      dispose() {
        for (const v of voices) {
          v.lfo.stop()
          v.lfo.disconnect()
          v.centre.stop()
          v.centre.disconnect()
          v.delay.disconnect()
          v.sweep.disconnect()
          v.voiceGain.disconnect()
        }
        input.disconnect()
        rateCvFront.disconnect()
        dry.disconnect()
        wet.disconnect()
        out.disconnect()
      },
    }
  },
}

/** Re-exported so a caller reading this module does not have to know the
 *  geometry lives next door in `dsp/`. */
export { BASE_DELAY_SECONDS }
