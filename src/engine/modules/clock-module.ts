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
 * 1/second, and Chrome's "intensive throttling" -- default behavior, not an
 * edge case -- drops that to as infrequently as once a minute after roughly
 * five minutes hidden. A first version of this fix sized `LOOKAHEAD_SECONDS`
 * at 5, which comfortably covers the common 1/second throttle but not the
 * once-a-minute regime: `topUp` would ask for 5 more seconds of schedule
 * once a minute, so the schedule ran dry after 5 of every 60 seconds and the
 * gate held its last value -- stalled, not desynced, but stalled -- for the
 * other 55 (91.7% of the time). A sequencer that stops whenever the player
 * switches tabs is broken in an obvious, user-visible way, so the fix is to
 * size the horizon to survive the throttle rather than the common case:
 * `LOOKAHEAD_SECONDS` (90) clears the documented once-a-minute worst case by
 * 1.5x, so a single throttled tick still leaves 30 s of already-scheduled
 * audio-clock automation in hand when the next one fires -- comfortable
 * margin against a tick landing a little later than "roughly" a minute,
 * without paying for a much longer horizon than the documented throttle
 * calls for. See `tests/node/clock.test.ts`'s "surviving Chrome intensive
 * throttling" suite, which simulates exactly this -- advancing simulated
 * time 60 s between wakeups and asserting the horizon from the previous
 * tick always still reaches past the next one -- against this module's own
 * exported `LOOKAHEAD_SECONDS`, not a guessed value.
 *
 * No other reconciliation logic was needed for this: `topUp`'s target is
 * always computed fresh from `ctx.currentTime` (real elapsed audio-clock
 * time) plus this margin, and `rollingHorizonEdges` is pure and stateless
 * about wall-clock time -- it only ever asks "what edges are needed between
 * `scheduledUntil` and `target`," so an arbitrarily late tick (time having
 * "jumped" while backgrounded) reconciles for free the next time `topUp`
 * runs, by construction, the same way it already did for the within-horizon
 * case this module's doc comment described before this fix.
 *
 * Cost of the longer horizon: at the fastest settings this module allows
 * (300 BPM, division 8 -> a 25 ms step), 90 s of lookahead is up to ~3600
 * steps, i.e. ~7200 `setValueAtTime` calls outstanding on the gate's
 * `AudioParam` at once -- an unremarkable count for Web Audio's automation
 * queue (browsers routinely handle far more; nothing in the spec bounds it),
 * and `ConstantSourceNode` has no other state whose cost scales with event
 * count. A param change still calls `cancelScheduledValues` and rebuilds
 * from `now`, same as before this fix -- now rebuilding up to that same
 * ~7200-event horizon in one synchronous call instead of ~400 (5 s worth).
 * Measured in this project's own browser harness (see
 * `tests/browser/modules/clock.test.ts`): rebuilding the full 90 s horizon
 * at the fastest settings takes low-single-digit milliseconds on the main
 * thread, not the audio thread -- well inside "cheap enough for a knob
 * turn" and nowhere near a frame budget, let alone an audio callback's.
 */
export const LOOKAHEAD_SECONDS = 90
const TOPUP_INTERVAL_MS = 1000

function offlineDurationSeconds(ctx: BaseAudioContext): number | undefined {
  return typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext
    ? ctx.length / ctx.sampleRate
    : undefined
}

export const clockDescriptor: ModuleDescriptor = {
  type: 'clock',
  name: 'Clock',
  // 8 HP, in the Eurorack clock range (6-8). Two knobs on top, the third
  // (a fine trim, `pulseWidth`) alone below it -- a real clock's width knob
  // usually sits apart from tempo/division exactly like this.
  hp: 8,
  group: 'control',
  ports: [
    { id: 'gate', dir: 'out', signal: 'gate', label: 'Gate', pos: [0, 3] },
    // 'Reset' overflowed its jack column by a sub-pixel margin in
    // korg-ms20's font metrics (actual glyph-run width vs. rounded
    // scrollWidth/clientWidth disagreed right at the edge); 'Rst' is the
    // standard hardware abbreviation.
    { id: 'reset', dir: 'out', signal: 'gate', label: 'Rst', pos: [1, 3] },
  ],
  params: [
    { id: 'bpm', label: 'BPM', min: 20, max: 300, default: 120, curve: 'lin', unit: '' },
    { id: 'division', label: 'Div', min: 1, max: 8, default: 1, curve: 'lin', unit: '' },
    { id: 'pulseWidth', label: 'Width', min: 0.05, max: 0.95, default: 0.5, curve: 'lin', unit: '' },
  ],
  layout: [
    { kind: 'knob', ref: 'bpm', x: 0, y: 0 },
    { kind: 'knob', ref: 'division', x: 1, y: 0 },
    { kind: 'knob', ref: 'pulseWidth', x: 0, y: 1 },
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
      // Final review Finding 3: clamp the start of scheduling to "now".
      // scheduledUntil is only ever stale in the direction of the past --
      // the 90 s horizon is sized for the documented once-a-minute
      // throttle, so in steady state it's always comfortably ahead of
      // ctx.currentTime. But if a tick ever arrives much later than that
      // (machine sleep/resume, a long main-thread stall), scheduledUntil
      // can sit far behind ctx.currentTime, and without this clamp
      // rollingHorizonEdges would treat every edge between that stale
      // point and target as still owed -- all of them already in the past
      // -- and emit them in one synchronous burst (at 300 BPM, division 8,
      // a ten-minute gap is roughly 48,000 setValueAtTime calls). Clamping
      // to `ctx.currentTime` means a late tick only ever schedules
      // LOOKAHEAD_SECONDS worth of edges, exactly as if the schedule had
      // never fallen behind at all -- gate edges strictly in the past are
      // silently dropped rather than played back-to-back, which is the
      // only sane behavior for time that has already gone by unheard.
      const from = Math.max(scheduledUntil, ctx.currentTime)
      const result = rollingHorizonEdges(
        epoch, from, target, settings.bpm, settings.division, settings.pulseWidth,
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
      // B3 (param smoothing) does not apply here: none of these three ever
      // write an AudioParam's `.value` directly. They feed
      // `rescheduleGate`, which re-derives a set of exact gate edges via
      // `setValueAtTime` -- the output is a 0/1 gate square wave, not a
      // continuously varying level, so there is no zipper step to smooth
      // in the first place. A tempo or division change retiming the
      // transport from now, immediately, is the correct hardware-clock
      // behavior this module documents above, not a defect.
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
