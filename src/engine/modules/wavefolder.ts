import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'
import { tryCreateWorkletNode } from './worklet-fallback'

const FALLBACK_CURVE_LENGTH = 1024

/**
 * Native fallback for when `wavefolder.js` didn't load. A `WaveShaperNode`
 * is a real fallback for folding, not a token gesture -- see `types.ts`'s
 * `fallback` doc comment's honesty rule -- but a genuinely simpler one:
 * the curve is a fixed `sin(x * drive * pi/2)`, rebuilt whenever `drive`
 * or `symmetry` changes (a knob turn, not an audio-rate event, so
 * regenerating a 1024-sample `Float32Array` costs microseconds, not
 * something a player would ever notice), which folds more times as
 * `drive` climbs the same way the real ADAA-antialiased fold does, but
 * with none of `dsp/wavefolder.ts`'s antialiasing -- a `WaveShaperNode`'s
 * static-curve lookup aliases hard at any real drive, audibly so above
 * roughly drive 3-4. That is said plainly in the badge, not discovered by
 * a player's ears with no explanation, matching this project's own
 * measured-not-assumed standard for the real module (see `docs/
 * CONTINUATION.md`'s wavefolder alias-floor table).
 */
function buildWavefolderFallback(ctx: BaseAudioContext): ModuleInstance {
  // Unity by default -- `drive` shapes the fold via the curve itself
  // (`rebuildCurve` below), not by scaling the signal into it; this node's
  // only job is being a summing point `foldCv` can add onto.
  const inputMix = ctx.createGain()
  const shaper = ctx.createWaveShaper()
  const outGain = ctx.createGain()
  inputMix.connect(shaper)
  shaper.connect(outGain)

  let drive = 1
  let symmetry = 0
  const rebuildCurve = (): void => {
    const curve = new Float32Array(FALLBACK_CURVE_LENGTH)
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1
      curve[i] = Math.sin((x + symmetry * 0.3) * drive * (Math.PI / 2))
    }
    shaper.curve = curve
  }
  rebuildCurve()

  const cvFront = ctx.createGain()
  cvFront.connect(inputMix.gain)

  return {
    inputs: new Map<string, AudioNode | AudioParam>([['in', inputMix], ['foldCv', cvFront]]),
    outputs: new Map([['out', outGain as AudioNode]]),
    fallback: {
      level: 'degraded',
      reason:
        "The wavefolder worklet didn't load, so this is a native waveshaper fold instead. " +
        'It aliases audibly above roughly drive 3-4, well before the real module does.',
    },
    setParam(id, value) {
      if (id === 'drive') {
        drive = value
        rebuildCurve()
      } else if (id === 'symmetry') {
        symmetry = value
        rebuildCurve()
      } else if (id === 'foldCvAmount') {
        cvFront.gain.value = value
      }
    },
    dispose() {
      inputMix.disconnect()
      shaper.disconnect()
      outGain.disconnect()
      cvFront.disconnect()
    },
  }
}

/** Wavefolding -- reflecting a signal back down instead of clipping or
 *  filtering it -- is the signature "West Coast" idea, tracing to Don
 *  Buchla's touchplate-era instruments (the Buchla 100 series' dual-
 *  oscillator modules, built for the San Francisco Tape Music Center in
 *  1963-64): shape a complex timbre by folding a simple waveform, rather
 *  than the "East Coast" approach of `vcf.ts`'s ladder filter, which
 *  removes content from an already-complex one. See
 *  `docs/history-of-synthesis-research.md` for the fuller East/West Coast
 *  account this is drawn from. */
export const wavefolderDescriptor: ModuleDescriptor = {
  type: 'wavefolder',
  name: 'Wavefolder',
  // 8 HP, in line with the other 3-knob shaping modules.
  hp: 8,
  group: 'shaping',
  ports: [
    { id: 'in', dir: 'in', signal: 'audio', label: 'In', pos: [0, 3] },
    // Same 'CV' shortening as vcf.ts's cutoffCv, for the same reason: this
    // module has exactly one CV input, so the bare word is unambiguous
    // and 'Fold CV' clipped at this jack column's width.
    { id: 'foldCv', dir: 'in', signal: 'cv', label: 'CV', pos: [1, 3] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [0, 4] },
  ],
  params: [
    { id: 'drive', label: 'Drive', min: 0.1, max: 20, default: 1, curve: 'exp', unit: '' },
    { id: 'symmetry', label: 'Sym', min: -1, max: 1, default: 0, curve: 'lin', unit: '' },
    // Same 'Amt' shortening as vca.ts's cvAmount, for the same reason.
    { id: 'foldCvAmount', label: 'Amt', min: 0, max: 10, default: 0, curve: 'lin', unit: '' },
    {
      id: 'quality',
      label: 'Quality',
      min: 0,
      max: 1,
      default: 0,
      curve: 'lin',
      unit: '',
      // Same discrete Full/Fast switch and same default-preserves-current-
      // sound reasoning as drive.ts's own `quality` param -- see that
      // file's comment and dsp/wavefolder.ts's `oversample` doc comment.
      labels: ['Full', 'Fast'],
    },
  ],
  layout: [
    { kind: 'knob', ref: 'drive', x: 0, y: 0 },
    { kind: 'knob', ref: 'symmetry', x: 1, y: 0 },
    { kind: 'knob', ref: 'foldCvAmount', x: 0, y: 1 },
    { kind: 'knob', ref: 'quality', x: 1, y: 1 },
    { kind: 'jack', ref: 'in', x: 0, y: 3 },
    { kind: 'jack', ref: 'foldCv', x: 1, y: 3 },
    { kind: 'jack', ref: 'out', x: 0, y: 4 },
  ],
  create(ctx): ModuleInstance {
    const node = tryCreateWorkletNode(ctx, 'wavefolder', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    if (!node) return buildWavefolderFallback(ctx)
    const audioIn = ctx.createGain()
    const cvIn = ctx.createGain()
    audioIn.connect(node, 0, 0)
    cvIn.connect(node, 0, 1)

    return {
      inputs: new Map<string, AudioNode | AudioParam>([['in', audioIn], ['foldCv', cvIn]]),
      outputs: new Map([['out', node as AudioNode]]),
      // drive, symmetry and foldCvAmount are all continuous, so they
      // smooth, same as every other module with a scheduleParam-eligible
      // param set (B3). This module previously wrote `.value` directly
      // instead, the one module in the set that did: found live, turning
      // the drive knob fast produced an audible step at every animation
      // frame instead of the ramp every other continuous param gets.
      // `quality` is discrete (a value between Full and Fast is
      // meaningless -- same reasoning as drive.ts's `curve`), so it's the
      // one param here that stays instant.
      setParam(id, value, atTime) {
        const param = node.parameters.get(id)
        if (!param) return
        if (id === 'quality') param.value = value
        else scheduleParam(param, value, ctx, atTime)
      },
      dispose() {
        node.disconnect()
        audioIn.disconnect()
        cvIn.disconnect()
      },
    }
  },
}
