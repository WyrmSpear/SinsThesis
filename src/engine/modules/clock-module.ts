import type { ModuleDescriptor, ModuleInstance } from '../types'
import { stepDuration, scheduleSteps } from '../clock'

/** How far ahead the gate is pre-scheduled, in seconds. Native nodes, so this
 *  is cheap; rescheduling on a param change just cancels and rebuilds from
 *  the current time. */
const HORIZON_SECONDS = 60

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

    /** Sample-accurate gate: alternate 1 and 0 at the step times
     *  `scheduleSteps` returns, out to `ctx.currentTime + HORIZON_SECONDS`,
     *  rather than depending on a JS timer to flip an AudioParam late. */
    function rescheduleGate(): void {
      const now = ctx.currentTime
      gateSource.offset.cancelScheduledValues(now)
      const dur = stepDuration(settings.bpm, settings.division)
      const count = Math.ceil(HORIZON_SECONDS / dur) + 1
      for (const t of scheduleSteps(now, count, settings.bpm, settings.division)) {
        if (t > now + HORIZON_SECONDS) break
        gateSource.offset.setValueAtTime(1, t)
        gateSource.offset.setValueAtTime(0, t + dur * settings.pulseWidth)
      }
    }

    // One-shot pulse when the transport (re)starts, so a freshly patched
    // sequencer begins at step 1 without waiting for the first clock edge.
    resetSource.offset.setValueAtTime(1, ctx.currentTime)
    resetSource.offset.setValueAtTime(0, ctx.currentTime + 0.001)

    rescheduleGate()

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
        gateSource.stop()
        resetSource.stop()
        gateSource.disconnect()
        resetSource.disconnect()
      },
    }
  },
}
