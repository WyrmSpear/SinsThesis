import type { ModuleDescriptor, ModuleInstance } from '../types'
import { scheduleParam } from '../param-smoothing'
import { DIVISION_LABELS } from '../dsp/clock-sync'
import { tryCreateWorkletNode, buildFailedInstance } from './worklet-fallback'

const MAX_DELAY_SECONDS = 2

/**
 * Mono in, stereo out, feedback crossing between channels so repeats
 * alternate L/R instead of echoing straight back into one channel --
 * ROADMAP section 1a's second new stereo module. `delay.ts`'s plain mono
 * delay is untouched; this is a new module, not a mode switch on it, because
 * the cross-feedback topology (dsp/pingpong.ts) and the stereo output are
 * genuinely different DSP, not a flag on the same graph.
 *
 * `division` locks the tap to the incoming clock the same way `lfo.ts`'s own
 * `division` does -- reusing `dsp/clock-sync.ts` verbatim, the identical
 * measure-the-pulse-period mechanism, because a delay that only ever runs in
 * free Hz-equivalent seconds drifts out of the beat the moment a track has
 * one; a delay locked to '1/8' or '1/4.' stays musical the way a synced
 * hardware delay does. See pingpong.worklet.ts's own comment for exactly how
 * the LFO's rate-shaped table is reread as a delay time instead.
 */
export const pingpongDescriptor: ModuleDescriptor = {
  type: 'pingpong',
  name: 'Ping-Pong Delay',
  // 12 HP -- one more knob than delay.ts's plain mono delay (division, for
  // the clock lock) and one more jack (stereo needs no extra jack itself,
  // since `out` is a single 2-channel port like every other stereo module
  // here -- see output.ts's doc comment -- but `sync` does), laid out as a
  // 2x2 knob grid over a 2x2 jack grid, the same shape lfo.ts's own
  // rate/shape/depth/division block uses.
  hp: 12,
  group: 'shaping',
  ports: [
    { id: 'in', dir: 'in', signal: 'audio', label: 'In', pos: [0, 2] },
    { id: 'timeCv', dir: 'in', signal: 'cv', label: 'Time CV', pos: [1, 2] },
    { id: 'sync', dir: 'in', signal: 'gate', label: 'Sync', pos: [0, 3] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [1, 3] },
  ],
  params: [
    { id: 'time', label: 'Time', min: 0.001, max: MAX_DELAY_SECONDS, default: 0.3, curve: 'exp', unit: 's' },
    { id: 'feedback', label: 'FB', min: 0, max: 0.95, default: 0.3, curve: 'lin', unit: '' },
    { id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.3, curve: 'lin', unit: '' },
    {
      id: 'division',
      label: 'Div',
      min: 0,
      max: DIVISION_LABELS.length - 1,
      default: 0,
      curve: 'lin',
      unit: '',
      // Index 0 ('Free') is the plain Hz-equivalent `time` knob, unlocked.
      // Any other position locks the tap to the incoming clock's measured
      // period instead -- see pingpong.worklet.ts and dsp/clock-sync.ts.
      labels: DIVISION_LABELS,
    },
  ],
  layout: [
    { kind: 'knob', ref: 'time', x: 0, y: 0 },
    { kind: 'knob', ref: 'feedback', x: 1, y: 0 },
    { kind: 'knob', ref: 'mix', x: 0, y: 1 },
    { kind: 'knob', ref: 'division', x: 1, y: 1 },
    { kind: 'jack', ref: 'in', x: 0, y: 2 },
    { kind: 'jack', ref: 'timeCv', x: 1, y: 2 },
    { kind: 'jack', ref: 'sync', x: 0, y: 3 },
    { kind: 'jack', ref: 'out', x: 1, y: 3 },
  ],
  create(ctx): ModuleInstance {
    const node = tryCreateWorkletNode(ctx, 'pingpong', {
      numberOfInputs: 3,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    })
    // Not in this pass's genuine-fallback set (see
    // `.superpowers/sdd/robustness-report.md`) -- a plain `DelayNode` pair
    // could approximate the cross-feedback topology, but this module's own
    // doc comment already treats getting that topology *exactly* right as
    // the hard, deliberate part of its design (dsp/pingpong.ts); a rushed
    // approximation risked exactly the "sounds impressive, secretly wrong"
    // failure mode this codebase's own audits keep finding by measurement,
    // not by reasoning. Fails loudly instead: the delay is silent, the
    // dry signal it would have mixed with is gone too, and the badge says
    // so -- worse for a Ping-Pong-heavy patch than a partial native delay
    // would be, and honest about that trade-off rather than hiding it.
    if (!node) {
      return buildFailedInstance(
        ctx,
        pingpongDescriptor.ports,
        "The Ping-Pong Delay worklet didn't load, so this module passes no signal. No native fallback was built for its cross-feedback topology.",
      )
    }
    const audioIn = ctx.createGain()
    const timeCvIn = ctx.createGain()
    const syncIn = ctx.createGain()
    audioIn.connect(node, 0, 0)
    timeCvIn.connect(node, 0, 1)
    syncIn.connect(node, 0, 2)

    return {
      inputs: new Map<string, AudioNode | AudioParam>([
        ['in', audioIn],
        ['timeCv', timeCvIn],
        ['sync', syncIn],
      ]),
      outputs: new Map([['out', node as AudioNode]]),
      // time, feedback and mix are continuous and smooth (all a-rate in the
      // worklet, so the browser's own per-sample ramp reaches the DSP
      // directly -- see pingpong.worklet.ts). division indexes a table
      // entry, like the LFO's own division param, so it snaps. B3.
      setParam(id, value, atTime) {
        const param = node.parameters.get(id)
        if (!param) return
        if (id === 'division') param.value = value
        else scheduleParam(param, value, ctx, atTime)
      },
      dispose() {
        node.disconnect()
        audioIn.disconnect()
        timeCvIn.disconnect()
        syncIn.disconnect()
      },
    }
  },
}
