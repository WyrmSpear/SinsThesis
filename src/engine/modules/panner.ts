import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'

/**
 * Mono in, stereo out. The first of the three new stereo modules ROADMAP
 * section 1a calls for (Output already updated to receive them -- see
 * output.ts's doc comment on why one `in` jack, not `inL`/`inR`, is what a
 * player actually patches).
 *
 * Built on the native `StereoPannerNode` rather than a hand-rolled pair of
 * gain nodes: it is specified to implement exactly the equal-power law
 * dsp/pan.ts documents and tests independently (`tests/node/dsp/pan.test.ts`),
 * it is one node instead of a small graph, and -- unlike every other
 * signal-shaping module in this codebase -- there is no DSP left to write:
 * WebAudio already ships a correct one. `dsp/pan.ts` exists anyway, because
 * "the browser's implementation is presumably correct" is exactly the kind
 * of claim this project's own traps section (docs/CONTINUATION.md) warns
 * against accepting without an independent, Node-runnable check.
 */
export const pannerDescriptor: ModuleDescriptor = {
  type: 'panner',
  name: 'Panner',
  // 8 HP -- one knob, three jacks, the same footprint as vca.ts's own
  // one-knob-plus-CV shape with an extra jack column for the stereo out.
  hp: 8,
  group: 'shaping',
  ports: [
    { id: 'in', dir: 'in', signal: 'audio', label: 'In', pos: [0, 3] },
    // 'Pan CV' overflowed this 8 HP panel's jack column and rendered as an
    // ellipsis (caught by an actual screenshot, not just the geometry
    // test, which only asserts pixel-identical *dimensions* across themes,
    // not that a given label fits inside them). 'CV' alone is unambiguous
    // here -- this module has exactly one CV input -- the same shortening
    // vcf.ts's and svf.ts's own `cutoffCv` jacks already use for the
    // identical reason.
    { id: 'panCv', dir: 'in', signal: 'cv', label: 'CV', pos: [1, 3] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [0, 4] },
  ],
  params: [
    { id: 'pan', label: 'Pan', min: -1, max: 1, default: 0, curve: 'lin', unit: '' },
  ],
  layout: [
    { kind: 'knob', ref: 'pan', x: 0, y: 0 },
    { kind: 'jack', ref: 'in', x: 0, y: 3 },
    { kind: 'jack', ref: 'panCv', x: 1, y: 3 },
    { kind: 'jack', ref: 'out', x: 0, y: 4 },
  ],
  create(ctx): ModuleInstance {
    const panner = ctx.createStereoPanner()
    panner.pan.value = 0

    // panCv rides on top of the pan knob, the same additive pattern every
    // other module's CV input uses (delay.ts's timeCv, vca.ts's cv): an
    // audio-rate connection into an AudioParam sums with whatever the knob
    // itself has scheduled there, so an LFO patched here auto-pans around
    // wherever the knob is currently centered rather than replacing it.
    const panCvFront = ctx.createGain()
    panCvFront.gain.value = 1
    panCvFront.connect(panner.pan)

    return {
      inputs: new Map<string, AudioNode | AudioParam>([['in', panner], ['panCv', panCvFront]]),
      outputs: new Map([['out', panner as AudioNode]]),
      // pan is the only param and it's continuous -- an LFO or a hand on
      // the knob should glide, never step. B3.
      setParam(id, value, atTime) {
        if (id === 'pan') scheduleParam(panner.pan, value, ctx, atTime)
      },
      dispose() {
        panner.disconnect()
        panCvFront.disconnect()
      },
    }
  },
}
