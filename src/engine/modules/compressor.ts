import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'
import { tryCreateWorkletNode, buildFailedInstance } from './worklet-fallback'
import {
  MIN_THRESHOLD_DB,
  MAX_THRESHOLD_DB,
  MIN_RATIO,
  MAX_RATIO,
  MIN_ATTACK_MS,
  MAX_ATTACK_MS,
  MIN_RELEASE_MS,
  MAX_RELEASE_MS,
  MAX_KNEE_DB,
  MAX_MAKEUP_DB,
} from '../dsp/compressor'

/**
 * A compressor: threshold, ratio, attack, release, soft knee, makeup gain,
 * a key (sidechain) input, and a gain-reduction CV output.
 *
 * **Not a wrapped `DynamicsCompressorNode`,** which would have been much
 * cheaper. The full reasoning is in `dsp/compressor.ts`; the short version
 * is that this codebase expects a module to state a number its own test
 * reproduces, and the native node's knee shape, detector and lookahead are
 * not specified in a way that lets you predict -- and therefore assert --
 * anything. Owning the gain law makes "ratio 4:1 means exactly 4:1 above
 * threshold" a measurement instead of a hope.
 *
 * **Measured, at steady state** (`tests/node/dsp/compressor.test.ts`):
 *
 * | in | 2:1 | 4:1 | 8:1 |
 * |---|---|---|---|
 * | -30 dB | -30.00 | -30.00 | -30.00 |
 * | -20 dB | -20.00 | -20.00 | -20.00 |
 * | -10 dB | -15.00 | -17.50 | -18.75 |
 * | -3 dB | -11.50 | -15.75 | -17.87 |
 *
 * Every figure is the ratio law `threshold + (in - threshold) / ratio` to
 * the digit, and everything at or below the -20 dB threshold is untouched.
 *
 * **Attack and release are true time constants,** measured at 63.2% coverage
 * after exactly one knob-time at 1, 10 and 50 ms -- and, more importantly,
 * **63.2% at every input level from -12 to 0 dB**. That last figure is the
 * one worth keeping: smoothing the *detected level* instead of the *gain
 * reduction* is the classic error, and it makes the attack time drift with
 * how far over the threshold the signal sits, so the knob quietly stops
 * meaning what it says. The test asserts the independence directly.
 *
 * **The knee is quadratic and provably joins both straight segments** at
 * both edges, checked by test, because a knee that does not join is a click.
 *
 * **`key` is a switch, not jack detection,** for the same reason
 * `ring.ts`'s carrier is: `ModuleInstance` has no connect notification and
 * `graph.ts` sends none, so a module cannot tell whether a cable is in its
 * Key jack. A two-position `labels` switch is visible on the panel instead
 * of being invisible magic. Sidechain ducking -- a bass keyed off a kick --
 * is the single most-asked-for compressor behaviour for the material this
 * project's bass track already teaches, so it is here rather than deferred.
 *
 * **`gr` carries the gain reduction in dB** (0 when open, negative while
 * compressing), left in real units rather than normalised to some invented
 * full scale. Patch it to a Scope to see the compressor work, or into any
 * CV destination -- each has its own amount knob to scale it.
 */
export const compressorDescriptor: ModuleDescriptor = {
  type: 'compressor',
  name: 'Compressor',
  // 12 HP -- the widest module in the shaping group, and it needs to be:
  // six knobs plus a switch over four jacks wants three columns, and at
  // HP_PX = 16 that is 192px / 3 = 64px per track, comfortably above the
  // ~38px a knob dial needs (see rack/panel.ts's hp audit note).
  hp: 12,
  group: 'shaping',
  ports: [
    { id: 'in', dir: 'in', signal: 'audio', label: 'In', pos: [0, 3] },
    { id: 'key', dir: 'in', signal: 'audio', label: 'Key', pos: [1, 3] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [2, 3] },
    { id: 'gr', dir: 'out', signal: 'cv', label: 'GR', pos: [0, 4] },
  ],
  params: [
    {
      id: 'threshold',
      label: 'Thresh',
      min: MIN_THRESHOLD_DB,
      max: MAX_THRESHOLD_DB,
      default: -20,
      curve: 'lin',
      unit: 'dB',
    },
    // Exp: the ear hears the step from 2:1 to 4:1 as far larger than the one
    // from 18:1 to 20:1, and the useful settings crowd the low end.
    { id: 'ratio', label: 'Ratio', min: MIN_RATIO, max: MAX_RATIO, default: 4, curve: 'exp', unit: ':1' },
    { id: 'attack', label: 'Attack', min: MIN_ATTACK_MS, max: MAX_ATTACK_MS, default: 5, curve: 'exp', unit: 'ms' },
    {
      id: 'release',
      label: 'Release',
      min: MIN_RELEASE_MS,
      max: MAX_RELEASE_MS,
      default: 100,
      curve: 'exp',
      unit: 'ms',
    },
    { id: 'knee', label: 'Knee', min: 0, max: MAX_KNEE_DB, default: 6, curve: 'lin', unit: 'dB' },
    { id: 'makeup', label: 'Makeup', min: 0, max: MAX_MAKEUP_DB, default: 0, curve: 'lin', unit: 'dB' },
    { id: 'keySource', label: 'Key', min: 0, max: 1, default: 0, curve: 'lin', unit: '', labels: ['Int', 'Ext'] },
  ],
  layout: [
    { kind: 'knob', ref: 'threshold', x: 0, y: 0 },
    { kind: 'knob', ref: 'ratio', x: 1, y: 0 },
    { kind: 'knob', ref: 'knee', x: 2, y: 0 },
    { kind: 'knob', ref: 'attack', x: 0, y: 1 },
    { kind: 'knob', ref: 'release', x: 1, y: 1 },
    { kind: 'knob', ref: 'makeup', x: 2, y: 1 },
    { kind: 'switch', ref: 'keySource', x: 0, y: 2 },
    { kind: 'jack', ref: 'in', x: 0, y: 3 },
    { kind: 'jack', ref: 'key', x: 1, y: 3 },
    { kind: 'jack', ref: 'out', x: 2, y: 3 },
    { kind: 'jack', ref: 'gr', x: 0, y: 4 },
  ],
  create(ctx): ModuleInstance {
    const node = tryCreateWorkletNode(ctx, 'compressor', {
      numberOfInputs: 2,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    })
    // No native fallback attempted. `DynamicsCompressorNode` exists, but
    // substituting it would silently swap this module's measured gain law,
    // knee and time constants for a different, unspecified set -- the exact
    // "fabricated approximation that behaves differently with nothing
    // telling the player" that worklet-fallback.ts's `'failed'` level is
    // for. It also has no sidechain input and no gain-reduction output, so
    // two of this module's four jacks would silently do nothing.
    if (!node) {
      return buildFailedInstance(
        ctx,
        compressorDescriptor.ports,
        "The Compressor worklet didn't load, so this module is silent. The browser's own compressor was not " +
          'substituted: its gain law, knee and timing differ from this one in ways nothing would tell you, ' +
          'and it has no sidechain or gain-reduction jack.',
      )
    }

    // R29: a worklet node with several outputs needs a fronting GainNode per
    // output, mirroring the input convention -- same as sequencer.ts.
    const audioOut = ctx.createGain()
    const reductionOut = ctx.createGain()
    node.connect(audioOut, 0)
    node.connect(reductionOut, 1)

    const fronts = ['in', 'key'].map((_, index) => {
      const gain = ctx.createGain()
      gain.connect(node, 0, index)
      return gain
    })

    return {
      inputs: new Map<string, AudioNode | AudioParam>([
        ['in', fronts[0]!],
        ['key', fronts[1]!],
      ]),
      outputs: new Map<string, AudioNode>([
        ['out', audioOut],
        ['gr', reductionOut],
      ]),
      setParam(id, value, atTime) {
        const param = node.parameters.get(id)
        if (!param) return
        if (id === 'keySource') {
          // Discrete: an instant swap, never a ramp. Half-way between the
          // input and the key signal is not a meaningful detector source.
          // Same "discrete stays instant" rule as ring.ts's own source
          // switch and the VCO's waveform (B3).
          param.value = Math.round(value)
          return
        }
        scheduleParam(param, value, ctx, atTime)
      },
      dispose() {
        node.disconnect()
        audioOut.disconnect()
        reductionOut.disconnect()
        for (const gain of fronts) gain.disconnect()
      },
    }
  },
}
