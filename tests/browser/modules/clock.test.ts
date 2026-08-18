import { describe, it, expect, beforeEach } from 'vitest'
import { renderGraph } from '../../../src/engine/render'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { clockDescriptor } from '../../../src/engine/modules/clock-module'
import { rmsEnvelope } from '../../../src/engine/analysis/features'

const SR = 48000

// A2: clock-module.ts used to pre-schedule gate edges out to a fixed
// HORIZON_SECONDS = 60 and never again, so an unattended patch's transport
// silently stopped after a minute. The fix is a rolling horizon that keeps
// topping itself up.
//
// This renders well past that old fixed constant and looks only at the
// tail of the render -- if the clock died at 60s, the tail is flat and
// silent; if it's still running, the tail keeps pulsing at tempo exactly
// like the head does. It would pass identically to the old, buggy code if
// it only checked the first few seconds (see A4's lesson), so it doesn't.
describe('Clock module', () => {
  beforeEach(() => {
    clearRegistry()
    registerModule(clockDescriptor)
  })

  it('keeps pulsing past the old fixed 60 s horizon', async () => {
    const DURATION_SECONDS = 65
    const OLD_HORIZON_SECONDS = 60

    const out = await renderGraph(DURATION_SECONDS, (_ctx, g) => {
      const clock = g.addModule('clock', 'clk')
      g.setParam(clock, 'bpm', 120) // 1 step/beat -> a pulse every 0.5s (2 Hz)
      g.setParam(clock, 'division', 1)
      return ['clk', 'gate']
    })

    const windowSamples = 2400 // 50ms windows
    const env = rmsEnvelope(out, windowSamples)
    const windowsPerSecond = SR / windowSamples

    // Only the last 3 seconds -- comfortably past the old fixed horizon,
    // so a flat tail there can only mean the clock stopped, not that it
    // hasn't reached that point yet.
    const tailStartSeconds = OLD_HORIZON_SECONDS + 2
    const tail = env.slice(Math.floor(tailStartSeconds * windowsPerSecond))
    expect(tail.length).toBeGreaterThan(0)

    let transitions = 0
    for (let i = 1; i < tail.length; i++) {
      const wasHigh = tail[i - 1]! > 0.5
      const isHigh = tail[i]! > 0.5
      if (wasHigh !== isHigh) transitions++
    }
    // At 2 Hz over ~3 seconds, expect roughly 12 transitions (6 pulses);
    // a generous floor that still clearly distinguishes "still running"
    // from "died at 60s" (0 transitions, tail pinned at whatever value it
    // last held).
    expect(transitions).toBeGreaterThanOrEqual(4)
  })
})
