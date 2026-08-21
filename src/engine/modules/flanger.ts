import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'
import { tryCreateWorkletNode } from './worklet-fallback'
import {
  MIN_MANUAL_SECONDS,
  MAX_MANUAL_SECONDS,
  MIN_RATE_HZ,
  MAX_RATE_HZ,
  MAX_FEEDBACK,
  SWEEP_SPAN,
} from '../dsp/flanger'

/**
 * A flanger: the dry signal summed with a short, swept delayed copy, plus
 * regeneration. The jet-plane whoosh.
 *
 * **It is a comb filter, and that is a closed-form claim, not a vibe.** With
 * equal dry and wet and no feedback the transfer function is `|cos(w*d/2)|`,
 * exactly zero at `f = (2k+1) / (2d)` and unity at `f = k/d`. So a 1 ms
 * delay notches at 500, 1500 and 2500 Hz and peaks at 1000 and 2000.
 * `tests/node/dsp/flanger.test.ts` predicts those frequencies from the delay
 * and measures whether the nulls land there rather than asserting that the
 * output sounds swooshy. **Measured: -240 dB at every predicted notch** (the
 * float64 floor -- the cancellation is exact), and **-133 dB at a
 * deliberately fractional 47.5-sample delay**, which is the figure that says
 * the Catmull-Rom read is doing its job where a linear one would smear.
 *
 * **Why this is a worklet when `modules/delay.ts` is not.** See
 * `dsp/flanger.ts`'s doc comment for the full account. Short version: Web
 * Audio must insert a render quantum into any graph cycle, a flanger's
 * regeneration is a cycle, and at flanger delays that quantum is 27% to
 * 2600% of the delay -- so a native flanger's feedback resonates on a
 * completely different comb from its own notches. Measured on the native
 * version: resonance spacing 250-280 Hz where the delay predicts 1000.
 * Owning the delay line fixes it, and the Node suite guards the fix by
 * asserting the resonance spacing reads 1000 Hz (it measures 999.8) and
 * naming 273 Hz as the failure mode to watch for.
 *
 * **Why this is a separate module from Chorus** rather than one module with
 * a mode switch, when both are "a modulated delay": the switch would have to
 * rescale the delay knob by about 100x between the two ranges, so one knob
 * would mean two different things depending on a switch position -- the
 * ambiguity this codebase avoids elsewhere. It also follows the precedent
 * set twice already: the state-variable filter shipped as its own topology
 * rather than a mode on the ladder, and the Ping-Pong Delay is its own panel
 * rather than a mode on Delay.
 *
 * **`feedback` is bipolar on purpose.** Positive regeneration resonates the
 * even series the comb already peaks at; negative regeneration resonates the
 * odd series instead, the hollow, inside-out variant of the same effect.
 * Measured at +/-0.8: **+19.1 dB and -19.1 dB** of tilt between 1000 Hz and
 * 500 Hz -- equal and opposite, which is what makes the sign a real control
 * rather than decoration. It costs one sign bit.
 */
export const flangerDescriptor: ModuleDescriptor = {
  type: 'flanger',
  name: 'Flanger',
  // 10 HP -- Delay's width (delay.ts), for the same reason: five knobs need
  // a 2x3 grid, and "Manual"/"FB" want the column room.
  hp: 10,
  group: 'shaping',
  ports: [
    { id: 'in', dir: 'in', signal: 'audio', label: 'In', pos: [0, 3] },
    { id: 'rateCv', dir: 'in', signal: 'cv', label: 'Rate CV', pos: [1, 3] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [0, 4] },
  ],
  params: [
    // 0.1-10 ms: the classic flanger window. Below ~0.5 ms the first notch
    // is above 1 kHz and the effect turns metallic; at the top it blurs into
    // chorus territory, which is what the Chorus module is for.
    {
      id: 'manual',
      label: 'Manual',
      min: MIN_MANUAL_SECONDS,
      max: MAX_MANUAL_SECONDS,
      default: 0.002,
      curve: 'exp',
      unit: 's',
    },
    { id: 'rate', label: 'Rate', min: MIN_RATE_HZ, max: MAX_RATE_HZ, default: 0.3, curve: 'exp', unit: 'Hz' },
    { id: 'depth', label: 'Depth', min: 0, max: 1, default: 0.5, curve: 'lin', unit: '' },
    // Bipolar -- see this file's doc comment. 'FB' rather than 'Feedback'
    // for the same column-width reason delay.ts abbreviates it.
    { id: 'feedback', label: 'FB', min: -MAX_FEEDBACK, max: MAX_FEEDBACK, default: 0.3, curve: 'lin', unit: '' },
    // 0.5 is where the comb is deepest: the notch is a true null only when
    // dry and wet cancel exactly.
    { id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.5, curve: 'lin', unit: '' },
  ],
  layout: [
    { kind: 'knob', ref: 'manual', x: 0, y: 0 },
    { kind: 'knob', ref: 'rate', x: 1, y: 0 },
    { kind: 'knob', ref: 'depth', x: 0, y: 1 },
    { kind: 'knob', ref: 'feedback', x: 1, y: 1 },
    { kind: 'knob', ref: 'mix', x: 0, y: 2 },
    { kind: 'jack', ref: 'in', x: 0, y: 3 },
    { kind: 'jack', ref: 'rateCv', x: 1, y: 3 },
    { kind: 'jack', ref: 'out', x: 0, y: 4 },
  ],
  create(ctx): ModuleInstance {
    const node = tryCreateWorkletNode(ctx, 'flanger', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    if (!node) return createNativeFlanger(ctx)

    const fronts = ['in', 'rateCv'].map((_, index) => {
      const gain = ctx.createGain()
      gain.connect(node, 0, index)
      return gain
    })

    return {
      inputs: new Map<string, AudioNode | AudioParam>([
        ['in', fronts[0]!],
        ['rateCv', fronts[1]!],
      ]),
      outputs: new Map([['out', node as AudioNode]]),
      // Every param is continuous -- no switch on this module -- so all of
      // them smooth through scheduleParam. B3.
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

/**
 * Native fallback: a real comb, built from a `DelayNode`, **with no
 * regeneration at all**.
 *
 * This is `'degraded'` rather than `'failed'` because the part that survives
 * is genuinely correct rather than an approximation. Without a feedback
 * path there is no cycle, so Web Audio inserts no render quantum, so the
 * notches land exactly where the delay says -- the swept comb and its sweep
 * are the real thing. What is lost is precisely the part that cannot be
 * done natively at these delays: the regeneration, which a `DelayNode` in a
 * cycle would place on the wrong comb (see this file's doc comment). A
 * hollow-sounding flanger that is honest about missing its resonance beats
 * one that quietly resonates at the wrong frequencies.
 */
function createNativeFlanger(ctx: BaseAudioContext): ModuleInstance {
  const input = ctx.createGain()
  input.gain.value = 1

  const delay = ctx.createDelay(0.05)
  delay.delayTime.value = 0
  input.connect(delay)

  const centre = ctx.createConstantSource()
  centre.offset.value = 0.002
  centre.connect(delay.delayTime)
  centre.start()

  const lfo = ctx.createOscillator()
  lfo.type = 'sine'
  lfo.frequency.value = 0.3
  lfo.start()

  // Unipolar sweep upward from `manual`, matching dsp/flanger.ts's own
  // SWEEP_SPAN geometry so the fallback sweeps the same range the worklet
  // would. A ConstantSource supplies the +0.5 offset that makes the sine
  // unipolar.
  const sweepDepth = ctx.createGain()
  sweepDepth.gain.value = 0.002 * SWEEP_SPAN * 0.5 * 0.5
  lfo.connect(sweepDepth)
  sweepDepth.connect(delay.delayTime)

  const sweepBias = ctx.createConstantSource()
  sweepBias.offset.value = 1
  const sweepBiasDepth = ctx.createGain()
  sweepBiasDepth.gain.value = 0.002 * SWEEP_SPAN * 0.5 * 0.5
  sweepBias.connect(sweepBiasDepth)
  sweepBiasDepth.connect(delay.delayTime)
  sweepBias.start()

  const rateCvFront = ctx.createGain()
  rateCvFront.gain.value = 1
  rateCvFront.connect(lfo.frequency)

  const dry = ctx.createGain()
  dry.gain.value = 0.5
  input.connect(dry)

  const wet = ctx.createGain()
  wet.gain.value = 0.5
  delay.connect(wet)

  const out = ctx.createGain()
  out.gain.value = 1
  dry.connect(out)
  wet.connect(out)

  let manual = 0.002
  let depth = 0.5
  const applySweep = (atTime?: number): void => {
    const half = manual * SWEEP_SPAN * depth * 0.5
    scheduleParam(sweepDepth.gain, half, ctx, atTime)
    scheduleParam(sweepBiasDepth.gain, half, ctx, atTime)
  }

  return {
    inputs: new Map<string, AudioNode | AudioParam>([
      ['in', input],
      ['rateCv', rateCvFront],
    ]),
    outputs: new Map([['out', out as AudioNode]]),
    fallback: {
      level: 'degraded',
      reason:
        "The Flanger worklet didn't load, so this is a native delay line instead. " +
        'The swept comb is exact, but the Feedback knob has no effect in this mode — ' +
        'browser-provided delay lines add a render quantum inside a feedback loop, ' +
        'which would put the resonance on a different comb from the notches.',
    },
    setParam(id, value, atTime) {
      if (id === 'manual') {
        manual = value
        scheduleParam(centre.offset, value, ctx, atTime)
        applySweep(atTime)
      } else if (id === 'depth') {
        depth = value
        applySweep(atTime)
      } else if (id === 'rate') {
        scheduleParam(lfo.frequency, value, ctx, atTime)
      } else if (id === 'mix') {
        scheduleParam(wet.gain, value, ctx, atTime)
        scheduleParam(dry.gain, 1 - value, ctx, atTime)
      }
      // feedback: accepted, no effect -- see this instance's fallback.reason.
    },
    dispose() {
      lfo.stop()
      lfo.disconnect()
      centre.stop()
      centre.disconnect()
      sweepBias.stop()
      sweepBias.disconnect()
      input.disconnect()
      delay.disconnect()
      sweepDepth.disconnect()
      sweepBiasDepth.disconnect()
      rateCvFront.disconnect()
      dry.disconnect()
      wet.disconnect()
      out.disconnect()
    },
  }
}
