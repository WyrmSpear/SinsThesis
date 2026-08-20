import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'

/**
 * The output module's own instance, widened with the `AnalyserNode` it
 * builds internally. `ModuleInstance` has no room for a module-specific
 * extra handle (see `KeyboardMidiInstance` for the same pattern with
 * `handleKey`), so a caller that wants to feed a scope or spectrum display
 * -- there is exactly one such caller today, the dev harness -- narrows
 * `PatchGraph.getInstance()`'s return to this type itself.
 */
export interface OutputInstance extends ModuleInstance {
  readonly analyser: AnalyserNode
}

export const outputDescriptor: ModuleDescriptor = {
  type: 'output',
  name: 'Output',
  // 6 HP -- one knob and two jacks, stacked in a single narrow column
  // rather than spread across a wide one.
  hp: 6,
  group: 'utility',
  ports: [
    { id: 'in', dir: 'in', signal: 'audio', label: 'In', pos: [0, 3] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [0, 4] },
  ],
  params: [{ id: 'level', label: 'Level', min: 0, max: 1, default: 1, curve: 'lin', unit: '' }],
  layout: [
    { kind: 'knob', ref: 'level', x: 0, y: 0 },
    { kind: 'jack', ref: 'in', x: 0, y: 3 },
    { kind: 'jack', ref: 'out', x: 0, y: 4 },
  ],
  create(ctx): OutputInstance {
    const level = ctx.createGain()
    level.gain.value = 1
    // Stereo, one jack. ROADMAP 1a's design decision is "stereo appears at
    // the destination" -- the eighteen mono modules stay untouched, and the
    // new stereo modules (panner.ts, pingpong.ts, width.ts) each emit a
    // single 2-channel `out` port rather than the two separate `outL`/`outR`
    // ports real Eurorack hardware would need. That decision is what makes
    // one `in` jack here correct instead of a design gap: a player who
    // patches a mono VCA in plugs one cable, exactly as before, and a player
    // who patches a Panner or Width module in also plugs one cable -- the
    // cable itself already carries however many channels its source
    // produces, which is the one freedom a software patch cable has that a
    // physical one doesn't. Splitting this into `inL`/`inR` would force
    // every stereo module to fan its single output into two cables (and
    // every mono module to needlessly duplicate into a matching pair) for
    // no benefit a WebAudio channel already gives for free.
    //
    // `channelCountMode: 'explicit'` with `channelCount: 2` is what makes
    // that free: WebAudio's up-mix rule for 1 input channel arriving at a
    // node computed to carry 2 (mono -> stereo: L=R=input) fires here
    // automatically, so a mono cable in this jack is duplicated to both
    // channels with no branch in this file that says "if mono" -- and a
    // genuinely stereo cable in the same jack is left alone, since 2 in / 2
    // computed is already an identity. ('max' mode, the GainNode default,
    // would instead just pass through whatever channel count arrived --
    // computedNumberOfChannels tracks the input, not this node's own
    // `channelCount` -- so a mono patch would stay a mono node all the way
    // to `ctx.destination`, which is itself stereo on a live AudioContext
    // and would then silently up-mix late instead of here, where the
    // decision belongs to the module that owns "what does Output emit".)
    level.channelCount = 2
    level.channelCountMode = 'explicit'
    level.channelInterpretation = 'speakers'

    // A tap for Phase 2's meter; the post-level signal itself is exposed
    // directly as the "out" port so the render harness (and any downstream
    // jack) reads the real output regardless of whether anything is
    // listening to the analyser.
    const analyser = ctx.createAnalyser()
    level.connect(analyser)

    return {
      inputs: new Map<string, AudioNode | AudioParam>([['in', level]]),
      outputs: new Map([['out', level as AudioNode]]),
      analyser,
      // The only param, level, is a continuous master fader. B3.
      setParam(id, value, atTime) {
        if (id === 'level') scheduleParam(level.gain, value, ctx, atTime)
      },
      dispose() {
        level.disconnect()
        analyser.disconnect()
      },
    }
  },
}
