import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'

const DEFAULT_CARRIER_HZ = 220

/**
 * Ring modulation -- a four-quadrant multiply of two signals, producing only
 * their sum and difference frequencies and suppressing both originals. The
 * clangorous, inharmonic, bell-and-Dalek texture, and ROADMAP section 1's
 * "nearly free, sonically enormous, highest value-to-effort ratio on the
 * list". That estimate was right, for a reason worth writing down.
 *
 * **No worklet, and no `dsp/` file, because Web Audio already does the hard
 * part exactly.** `GainNode.gain` is an a-rate `AudioParam`, and a connected
 * signal *sums into* it rather than replacing it. So a gain node whose
 * intrinsic `gain.value` is 0, with a bipolar carrier connected to `gain`,
 * multiplies its input by that carrier sample-for-sample in float -- a true
 * four-quadrant multiply, not an approximation of one. There is nothing here
 * to antialias, either: multiplying two band-limited signals produces sum and
 * difference components, and the sources feeding this module are already
 * band-limited by whatever made them. That is why this module has no
 * measured alias floor while the wavefolder and Drive both need one -- a
 * multiply creates no new harmonics beyond the two it is handed, where a
 * fold or a saturation curve creates an infinite series of them.
 *
 * **`shape` is a morph, not a mode switch.** The output is
 * `in * (shape + carrier)`:
 *
 * - At `shape = 0` the multiplier is purely bipolar, so the carrier and the
 *   input both cancel completely and only the sidebands survive. That is
 *   ring modulation, and `tests/browser/modules/ring.test.ts` measures the
 *   suppression as a number rather than asserting it in prose -- it is the
 *   one figure that separates this module from a tremolo. **Measured, 441 Hz
 *   through a 1109 Hz carrier: carrier suppressed to -128.0 dB and the input
 *   to -145.1 dB, both relative to the surviving sidebands, with the
 *   sideband pair balanced to within 0.06 dB of each other (0.4999 /
 *   0.4966 against a theoretical 0.5).**
 * - At `shape = 1` the multiplier is `1 + carrier`, which never goes
 *   negative, so the input survives alongside its sidebands. That is
 *   amplitude modulation.
 * - Everything between is a genuine blend of the two, which is why this is
 *   one continuous knob rather than the two-position switch a mode would
 *   need. A player sweeping it hears the fundamental fade in, not a click.
 *
 * **The trim is not cosmetic.** `in * (1 + carrier)` swings to twice the
 * amplitude of `in * carrier`, so without compensation the `shape` knob
 * would also be a hidden volume knob -- the exact "one knob means two
 * things" problem this codebase avoids elsewhere. An output stage at
 * `1 / (1 + shape)` cancels it, and the test suite asserts the level ratio
 * across the full sweep rather than trusting the arithmetic. That assertion
 * was verified load-bearing the way this codebase verifies them (see the
 * Sampler's clipping fix in docs/CONTINUATION.md): with the trim forced to
 * 1 the ratio measures **1.7315**, a clean 2x on top of the RMS the shapes
 * legitimately differ by, and the test goes red.
 *
 * **`source` is a switch because the engine cannot detect a patched jack.**
 * `ModuleInstance` has no connect notification and `graph.ts` sends none, so
 * a module genuinely cannot know whether its `carrier` input has a cable in
 * it. Rather than add that hook to the contract for one module's benefit,
 * this uses a two-position `labels` switch -- already supported, already
 * used by the VCO's waveform -- which has the side benefit of being visible
 * on the panel instead of being invisible magic that surprises a player who
 * patches a cable and hears nothing change.
 */
export const ringDescriptor: ModuleDescriptor = {
  type: 'ring',
  name: 'Ring Mod',
  // 8 HP -- the VCA's width (vca.ts), and for the same reason: three knobs
  // and a switch over three jacks fits a 2x2 control grid without the extra
  // column Drive and the Bitcrusher need for their CV-amount pairs.
  hp: 8,
  group: 'shaping',
  ports: [
    { id: 'in', dir: 'in', signal: 'audio', label: 'In', pos: [0, 3] },
    { id: 'carrier', dir: 'in', signal: 'audio', label: 'Carr', pos: [1, 3] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [0, 4] },
  ],
  params: [
    // Spans sub-audio to well into the audible band on purpose: below ~20 Hz
    // this is a tremolo, above it the sidebands separate and it becomes the
    // clangorous effect the module is named for. Exp, because the ear hears
    // frequency logarithmically -- the same curve every other frequency
    // param in this codebase uses.
    { id: 'freq', label: 'Freq', min: 0.1, max: 8000, default: DEFAULT_CARRIER_HZ, curve: 'exp', unit: 'Hz' },
    // Default 0 -- pure ring modulation, the thing on the label. See this
    // file's doc comment for what the sweep to 1 actually does.
    { id: 'shape', label: 'Shape', min: 0, max: 1, default: 0, curve: 'lin', unit: '' },
    // Default 1 (fully wet), unlike delay.ts's 0.3. A ring modulator blended
    // back under its own dry signal mostly sounds like the dry signal, so
    // the useful default is the effect itself.
    { id: 'mix', label: 'Mix', min: 0, max: 1, default: 1, curve: 'lin', unit: '' },
    { id: 'source', label: 'Carrier', min: 0, max: 1, default: 0, curve: 'lin', unit: '', labels: ['Int', 'Ext'] },
  ],
  layout: [
    { kind: 'knob', ref: 'freq', x: 0, y: 0 },
    { kind: 'knob', ref: 'shape', x: 1, y: 0 },
    { kind: 'knob', ref: 'mix', x: 0, y: 1 },
    { kind: 'switch', ref: 'source', x: 1, y: 1 },
    { kind: 'jack', ref: 'in', x: 0, y: 3 },
    { kind: 'jack', ref: 'carrier', x: 1, y: 3 },
    { kind: 'jack', ref: 'out', x: 0, y: 4 },
  ],
  create(ctx): ModuleInstance {
    const input = ctx.createGain()
    input.gain.value = 1

    // The multiplier. `gain.value = 0` is load-bearing, not a default: it is
    // what makes the connected carrier the *entire* gain, so the product is
    // four-quadrant. Anything non-zero here leaks the input through.
    const ring = ctx.createGain()
    ring.gain.value = 0
    input.connect(ring)

    // `shape` rides into the same param the carrier does, which is exactly
    // how it becomes `in * (shape + carrier)` with no branching.
    const shapeOffset = ctx.createConstantSource()
    shapeOffset.offset.value = 0
    shapeOffset.connect(ring.gain)
    shapeOffset.start()

    const internal = ctx.createOscillator()
    internal.type = 'sine'
    internal.frequency.value = DEFAULT_CARRIER_HZ
    internal.start()

    // Two gates, only one ever open, driven by the `source` switch.
    const internalGate = ctx.createGain()
    internalGate.gain.value = 1
    internal.connect(internalGate)
    internalGate.connect(ring.gain)

    const externalFront = ctx.createGain()
    externalFront.gain.value = 1
    const externalGate = ctx.createGain()
    externalGate.gain.value = 0
    externalFront.connect(externalGate)
    externalGate.connect(ring.gain)

    // Cancels the 2x swing the AM end of `shape` introduces. See doc comment.
    const trim = ctx.createGain()
    trim.gain.value = 1
    ring.connect(trim)

    const dry = ctx.createGain()
    dry.gain.value = 0
    input.connect(dry)

    const wet = ctx.createGain()
    wet.gain.value = 1
    trim.connect(wet)

    const out = ctx.createGain()
    out.gain.value = 1
    dry.connect(out)
    wet.connect(out)

    return {
      inputs: new Map<string, AudioNode | AudioParam>([
        ['in', input],
        ['carrier', externalFront],
      ]),
      outputs: new Map([['out', out as AudioNode]]),
      setParam(id, value, atTime) {
        if (id === 'freq') {
          scheduleParam(internal.frequency, value, ctx, atTime)
        } else if (id === 'shape') {
          // Both halves of the morph move together: the offset that decides
          // how much input survives, and the trim that stops that decision
          // from also changing the level. B3 -- continuous, so both smooth.
          scheduleParam(shapeOffset.offset, value, ctx, atTime)
          scheduleParam(trim.gain, 1 / (1 + value), ctx, atTime)
        } else if (id === 'mix') {
          scheduleParam(wet.gain, value, ctx, atTime)
          scheduleParam(dry.gain, 1 - value, ctx, atTime)
        } else if (id === 'source') {
          // Discrete: an instant swap, never a crossfade. Same "discrete
          // stays instant" rule as the VCO's waveform and the Frequency
          // Bank's switches (B3); `atTime` is accepted but unused, as there.
          const ext = Math.round(value) === 1
          internalGate.gain.value = ext ? 0 : 1
          externalGate.gain.value = ext ? 1 : 0
        }
      },
      dispose() {
        internal.stop()
        internal.disconnect()
        shapeOffset.stop()
        shapeOffset.disconnect()
        input.disconnect()
        ring.disconnect()
        internalGate.disconnect()
        externalFront.disconnect()
        externalGate.disconnect()
        trim.disconnect()
        dry.disconnect()
        wet.disconnect()
        out.disconnect()
      },
    }
  },
}
