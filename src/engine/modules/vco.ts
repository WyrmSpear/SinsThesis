import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'
import { tryCreateWorkletNode } from './worklet-fallback'

const FALLBACK_SHAPES: OscillatorType[] = ['sawtooth', 'square', 'triangle', 'sine']

/**
 * Native fallback for when `vco.js` didn't load (see
 * `worklet-fallback.ts`'s own doc comment and
 * `.superpowers/sdd/robustness-report.md`). An `OscillatorNode` is a real
 * fallback, not a token gesture: three of the four shapes it draws are
 * the genuine article (no aliasing shortcuts, no wavetable this project's
 * own worklet exists to avoid), and pitch tracking is genuinely
 * exponential, not a linear approximation -- `detune` is defined in cents
 * (`freq = base * 2^(detune/1200)`), so scaling a "1V/oct" CV input by
 * 1200 and feeding it straight into `detune` reproduces real 1V/octave
 * tracking through nothing but WebAudio's own `AudioParam` summing, the
 * same additive-front convention every worklet module in this codebase
 * already uses for its own input ports.
 *
 * What's honestly lost, and said so in the badge: `OscillatorNode` has no
 * pulse-width control (`'square'` is a fixed 50% duty cycle, so `Pulse`
 * plays but `pulseWidth` does nothing) and no hard-sync input (`sync` is
 * accepted -- the port has to exist for cabling and `.sinp` round-trips to
 * keep working -- but wired to nothing, same as this project's real VCO
 * worklet's own documented sync limitation, see `docs/CONTINUATION.md`'s
 * "hard sync... is unsolved in both architectures studied").
 */
function buildVcoFallback(ctx: BaseAudioContext): ModuleInstance {
  const osc = ctx.createOscillator()
  osc.frequency.value = 440
  osc.type = 'sawtooth'
  osc.start()

  // 1200 cents/volt -- see this function's own doc comment for why this
  // is genuine 1V/oct tracking, not an approximation of it.
  const pitchFront = ctx.createGain()
  pitchFront.gain.value = 1200
  pitchFront.connect(osc.detune)

  // fmAmount (a knob, 0-4) scales how many cents of `detune` swing one
  // full-scale volt on the `fm` input produces -- 1200 cents (one octave)
  // per unit, an arbitrary but documented convention for this fallback
  // only; the real worklet's own FM scaling is unrelated and unmatched
  // here on purpose (see the badge reason: this is a different signal
  // path, not a hidden imitation of the original one).
  const fmFront = ctx.createGain()
  const fmDepth = ctx.createGain()
  fmDepth.gain.value = 0
  fmFront.connect(fmDepth)
  fmDepth.connect(osc.detune)

  // No hard sync in this mode -- see doc comment. The port stays present
  // and harmlessly unconnected so cabling and `.sinp` round-trips work.
  const syncFront = ctx.createGain()

  let tune = 0
  let octave = 0
  const applyBaseDetune = (atTime?: number): void => {
    scheduleParam(osc.detune, tune * 100 + octave * 1200, ctx, atTime)
  }

  return {
    inputs: new Map<string, AudioNode | AudioParam>([
      ['pitch', pitchFront],
      ['fm', fmFront],
      ['sync', syncFront],
    ]),
    outputs: new Map([['out', osc as AudioNode]]),
    fallback: {
      level: 'degraded',
      reason:
        "The VCO worklet didn't load, so this is a native oscillator instead. " +
        'Pulse width and hard sync have no effect in this mode; Pulse plays as a fixed 50% square.',
    },
    setParam(id, value, atTime) {
      if (id === 'tune') {
        tune = value
        applyBaseDetune(atTime)
      } else if (id === 'octave') {
        octave = value
        applyBaseDetune(atTime)
      } else if (id === 'shape') {
        osc.type = FALLBACK_SHAPES[Math.round(value)] ?? 'sawtooth'
      } else if (id === 'fmAmount') {
        fmDepth.gain.value = value * 1200
      }
      // pulseWidth: accepted, no effect -- see this instance's own `fallback.reason`.
    },
    dispose() {
      osc.stop()
      osc.disconnect()
      pitchFront.disconnect()
      fmFront.disconnect()
      fmDepth.disconnect()
      syncFront.disconnect()
    },
  }
}

/**
 * Every input port is fronted by its own GainNode, so the graph connects with
 * a plain two-argument connect() and never needs to know that the worklet has
 * three numbered inputs.
 */
export const vcoDescriptor: ModuleDescriptor = {
  type: 'vco',
  name: 'VCO',
  // 10 HP -- Eurorack VCOs run 10-12; five knobs stack across three rows of
  // two (the fifth, fmAmount, alone in its own row) rather than spreading
  // across one row of five.
  hp: 10,
  group: 'source',
  ports: [
    { id: 'pitch', dir: 'in', signal: 'cv', label: '1V/Oct', pos: [0, 3] },
    { id: 'fm', dir: 'in', signal: 'cv', label: 'FM', pos: [1, 3] },
    { id: 'sync', dir: 'in', signal: 'gate', label: 'Sync', pos: [0, 4] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [1, 4] },
  ],
  params: [
    { id: 'tune', label: 'Tune', min: -24, max: 24, default: 0, curve: 'lin', unit: 'st' },
    { id: 'octave', label: 'Octave', min: -4, max: 4, default: 0, curve: 'lin', unit: '' },
    {
      id: 'shape',
      label: 'Shape',
      min: 0,
      max: 3,
      default: 0,
      curve: 'lin',
      unit: '',
      // Same 'Tri' shortening as lfo.ts, and for the same reason: the
      // switch readout's column is not wide enough for "Triangle" at a
      // legible size.
      labels: ['Saw', 'Pulse', 'Tri', 'Sine'],
    },
    { id: 'pulseWidth', label: 'Width', min: 0.01, max: 0.99, default: 0.5, curve: 'lin', unit: '' },
    { id: 'fmAmount', label: 'FM', min: 0, max: 4, default: 0, curve: 'lin', unit: '' },
  ],
  layout: [
    { kind: 'knob', ref: 'tune', x: 0, y: 0 },
    { kind: 'knob', ref: 'octave', x: 1, y: 0 },
    { kind: 'knob', ref: 'shape', x: 0, y: 1 },
    { kind: 'knob', ref: 'pulseWidth', x: 1, y: 1 },
    { kind: 'knob', ref: 'fmAmount', x: 0, y: 2 },
    { kind: 'jack', ref: 'pitch', x: 0, y: 3 },
    { kind: 'jack', ref: 'fm', x: 1, y: 3 },
    { kind: 'jack', ref: 'sync', x: 0, y: 4 },
    { kind: 'jack', ref: 'out', x: 1, y: 4 },
  ],
  create(ctx): ModuleInstance {
    const node = tryCreateWorkletNode(ctx, 'vco', {
      numberOfInputs: 3,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    if (!node) return buildVcoFallback(ctx)

    const fronts = ['pitch', 'fm', 'sync'].map((_, index) => {
      const gain = ctx.createGain()
      gain.connect(node, 0, index)
      return gain
    })

    return {
      inputs: new Map<string, AudioNode | AudioParam>([
        ['pitch', fronts[0]!],
        ['fm', fronts[1]!],
        ['sync', fronts[2]!],
      ]),
      outputs: new Map([['out', node as AudioNode]]),
      // tune, octave, pulseWidth and fmAmount all feed continuous math in
      // the worklet (octave in particular is never rounded -- see
      // vco.worklet.ts -- so fractional values already glide the pitch
      // correctly), and all smooth. shape indexes a fixed waveform table
      // (SHAPES[Math.round(shape)]) -- a value between two shapes is
      // meaningless -- so it stays instant. B3.
      setParam(id, value, atTime) {
        const param = node.parameters.get(id)
        if (!param) return
        if (id === 'shape') param.value = value
        else scheduleParam(param, value, ctx, atTime)
      },
      dispose() {
        node.disconnect()
        for (const gain of fronts) gain.disconnect()
      },
    }
  },
}
