import type { ModuleDescriptor, ModuleInstance } from '../types'
import { rollingHorizonEdges } from '../clock'

/**
 * A2 fix: the clock used to pre-schedule gate edges out to a fixed 60 s
 * horizon at creation, rescheduling only on a param change -- so an
 * unattended patch's transport silently stopped after a minute (spec
 * acceptance criterion 5, "patches evolve unattended", was false past that
 * point).
 *
 * The fix is a rolling horizon (`rollingHorizonEdges` in ../clock, the
 * pure math this module is a thin shell over): keep `LOOKAHEAD_SECONDS` of
 * gate edges always scheduled ahead of "now", topped up by a JS timer that
 * fires every `TOPUP_INTERVAL_MS`. What makes this safe under the hard
 * constraint ("scheduling stays on the audio clock, never a JS timer
 * generating audio") is that the timer's callback, `topUp`, does nothing
 * but call `setValueAtTime` for future times -- it never touches `.value`
 * directly and never runs synchronously with sample generation. The timer
 * decides only *when* to ask for more schedule, never what gets played
 * *when*.
 *
 * Offline rendering is a special case, handled separately below rather
 * than by the timer: an `OfflineAudioContext` renders as fast as the CPU
 * allows, not in real time, and measured directly (90 s of audio rendered
 * in ~19 ms of wall time in this project's own browser harness) a periodic
 * JS timer never gets a chance to fire during the render at all -- so
 * relying on one would silently reintroduce the exact bug this fixes, just
 * for offline renders instead of live ones. An offline context's total
 * length is knowable up front (`ctx.length`), so that whole (bounded, by
 * construction) duration is scheduled in one shot instead.
 *
 * Drift: none, by construction. Every edge keeps the exact audio-clock time
 * `topUp` computed for it (`epoch + step * stepDuration`, inside
 * `rollingHorizonEdges`), independent of how late the JS timer that
 * requested it fired. A slow or delayed tick doesn't shift any
 * already-scheduled edge -- it can only delay how far into the future new
 * edges get added.
 *
 * Backgrounding: browsers throttle a hidden tab's timers, typically to
 * 1/second, and Chrome's "intensive throttling" can drop that to as
 * infrequently as once a minute after several minutes hidden. If a tick is
 * late enough that `ctx.currentTime` catches up to `scheduledUntil` before
 * the next one fires, the gate simply holds its last scheduled value --
 * playback stalls rather than desyncs -- until the next tick refills the
 * horizon starting from exactly where the step grid left off (anchored to
 * `epoch`, not to wall-clock time), so tempo and phase are unaffected, only
 * momentarily paused. `LOOKAHEAD_SECONDS` is sized well above the common
 * 1/second throttle so an ordinary backgrounded tab never audibly gaps;
 * only the rarer extreme-throttling regime can still produce one.
 */
const LOOKAHEAD_SECONDS = 5
const TOPUP_INTERVAL_MS = 1000

function offlineDurationSeconds(ctx: BaseAudioContext): number | undefined {
  return typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext
    ? ctx.length / ctx.sampleRate
    : undefined
}

export const clockDescriptor: ModuleDescriptor = {
  type: 'clock',
  name: 'Clock',
  hp: 6,
  ports: [
    { id: 'gate', dir: 'out', signal: 'gate', label: 'Gate', pos: [0, 3] },
    { id: 'reset', dir: 'out', signal: 'gate', label: 'Reset', pos: [1, 3] },
  ],
  params: [
    { id: 'bpm', label: 'BPM', min: 20, max: 300, default: 120, curve: 'lin', unit: '' },
    { id: 'division', label: 'Div', min: 1, max: 8, default: 1, curve: 'lin', unit: '' },
    { id: 'pulseWidth', label: 'Width', min: 0.05, max: 0.95, default: 0.5, curve: 'lin', unit: '' },
  ],
  layout: [
    { kind: 'knob', ref: 'bpm', x: 0, y: 0 },
    { kind: 'knob', ref: 'division', x: 1, y: 0 },
    { kind: 'knob', ref: 'pulseWidth', x: 2, y: 0 },
    { kind: 'jack', ref: 'gate', x: 0, y: 3 },
    { kind: 'jack', ref: 'reset', x: 1, y: 3 },
  ],
  create(ctx): ModuleInstance {
    const gateSource = new ConstantSourceNode(ctx, { offset: 0 })
    const resetSource = new ConstantSourceNode(ctx, { offset: 0 })
    gateSource.start()
    resetSource.start()

    const settings = { bpm: 120, division: 1, pulseWidth: 0.5 }
    const offlineDuration = offlineDurationSeconds(ctx)

    // Everything up to (and including) this audio-clock time already has
    // its edges scheduled. `epoch` anchors the step grid so a top-up
    // continues the same phase instead of restarting it every tick.
    let epoch = ctx.currentTime
    let scheduledUntil = epoch

    /** Extend scheduled gate edges out to the current target horizon,
     *  continuing from wherever `scheduledUntil` left off. Everything this
     *  does is `setValueAtTime` on the audio clock -- safe to call from a
     *  JS timer because it only ever schedules future audio, never
     *  produces it. */
    function topUp(): void {
      const target = offlineDuration !== undefined
        ? epoch + offlineDuration
        : ctx.currentTime + LOOKAHEAD_SECONDS
      const result = rollingHorizonEdges(
        epoch, scheduledUntil, target, settings.bpm, settings.division, settings.pulseWidth,
      )
      for (const edge of result.edges) {
        gateSource.offset.setValueAtTime(1, edge.on)
        gateSource.offset.setValueAtTime(0, edge.off)
      }
      scheduledUntil = result.scheduledUntil
    }

    /** Full reset: cancel everything not yet played and restart the step
     *  grid from now. Used at creation and whenever a param changes --
     *  matches the pre-fix behavior of an immediate, audible tempo change
     *  rather than finishing the current step at the old tempo. */
    function rescheduleGate(): void {
      const now = ctx.currentTime
      gateSource.offset.cancelScheduledValues(now)
      epoch = now
      scheduledUntil = now
      topUp()
    }

    // One-shot pulse when the transport (re)starts, so a freshly patched
    // sequencer begins at step 1 without waiting for the first clock edge.
    resetSource.offset.setValueAtTime(1, ctx.currentTime)
    resetSource.offset.setValueAtTime(0, ctx.currentTime + 0.001)

    rescheduleGate()
    // An offline render's length is known and finite, so the whole thing
    // was just scheduled above in one shot -- nothing left to top up, and
    // (measured) a timer would never get a turn to fire before the render
    // finished anyway. Only a live context needs the periodic top-up.
    const timer: ReturnType<typeof setInterval> | undefined =
      offlineDuration === undefined ? setInterval(topUp, TOPUP_INTERVAL_MS) : undefined

    return {
      inputs: new Map(),
      outputs: new Map<string, AudioNode>([
        ['gate', gateSource],
        ['reset', resetSource],
      ]),
      setParam(id, value) {
        if (id === 'bpm') settings.bpm = value
        else if (id === 'division') settings.division = value
        else if (id === 'pulseWidth') settings.pulseWidth = value
        else return
        rescheduleGate()
      },
      dispose() {
        if (timer !== undefined) clearInterval(timer)
        gateSource.stop()
        resetSource.stop()
        gateSource.disconnect()
        resetSource.disconnect()
      },
    }
  },
}
