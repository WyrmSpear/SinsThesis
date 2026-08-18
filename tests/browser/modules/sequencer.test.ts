import { describe, it, expect, beforeEach } from 'vitest'
import { renderGraph } from '../../../src/engine/render'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { clockDescriptor } from '../../../src/engine/modules/clock-module'
import { sequencerDescriptor } from '../../../src/engine/modules/sequencer'
import { vcoDescriptor } from '../../../src/engine/modules/vco'
import { peakHz, rmsEnvelope } from '../../../src/engine/analysis/features'

const SR = 48000

beforeEach(() => {
  clearRegistry()
  for (const d of [clockDescriptor, sequencerDescriptor, vcoDescriptor]) registerModule(d)
})

describe('Clock and Sequencer', () => {
  it('pulses the gate at the tempo', async () => {
    const out = await renderGraph(2, (_ctx, g) => {
      const clock = g.addModule('clock', 'clk')
      g.setParam(clock, 'bpm', 120)
      g.setParam(clock, 'division', 1)
      return ['clk', 'gate']
    })
    // 120 BPM with one step per beat is 2 Hz. Measure gate-high windows.
    const env = rmsEnvelope(out, 2400) // 50 ms windows
    let transitions = 0
    for (let i = 1; i < env.length; i++) {
      const wasHigh = env[i - 1]! > 0.5
      const isHigh = env[i]! > 0.5
      if (wasHigh !== isHigh) transitions++
    }
    expect(transitions).toBeGreaterThanOrEqual(6)
    expect(transitions).toBeLessThanOrEqual(10)
  })

  // A4: this used to render 0.4s at 60 BPM (1s/step) and check only step 1
  // -- it passed identically whether or not the sequencer ever advanced,
  // because the render never reached the second step's boundary. `steps`
  // and `step2` were set and never read back. Render across the step1 ->
  // step2 boundary at t=1s (and back to step1 at t=2s, confirming the
  // 2-step wrap) and sample a window inside each holding period, clear of
  // the boundary on both sides.
  it('steps a VCO through its programmed pitches', async () => {
    const STEP_SECONDS = 1 // 60 BPM, division 1
    const WINDOW = 16384
    const MARGIN = 0.2 // seconds clear of a step boundary, either side

    const out = await renderGraph(2, (_ctx, g) => {
      const clock = g.addModule('clock', 'clk')
      const seq = g.addModule('seq', 'seq')
      const osc = g.addModule('vco', 'osc')
      g.setParam(clock, 'bpm', 60)
      g.setParam(clock, 'division', 1)
      g.setParam(seq, 'steps', 2)
      g.setParam(seq, 'step1', 0) // A4 -- 440 Hz
      g.setParam(seq, 'step2', 1) // an octave up -- 880 Hz
      g.connect([clock, 'gate'], [seq, 'clock'])
      g.connect([seq, 'cv'], [osc, 'pitch'])
      return osc
    })

    const windowAt = (seconds: number) => {
      const start = Math.floor(seconds * SR)
      return out.subarray(start, start + WINDOW)
    }

    // [0, 1s) holds step 1.
    expect(peakHz(windowAt(MARGIN), SR)).toBeCloseTo(440, -1)
    // [1s, 2s) holds step 2 -- this is the assertion the old test never
    // made, and the one that actually proves the sequencer advances.
    expect(peakHz(windowAt(STEP_SECONDS + MARGIN), SR)).toBeCloseTo(880, -1)
  })
})
