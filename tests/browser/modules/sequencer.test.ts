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

  it('steps a VCO through its programmed pitches', async () => {
    const first = await renderGraph(0.4, (_ctx, g) => {
      const clock = g.addModule('clock', 'clk')
      const seq = g.addModule('seq', 'seq')
      const osc = g.addModule('vco', 'osc')
      g.setParam(clock, 'bpm', 60)
      g.setParam(clock, 'division', 1)
      g.setParam(seq, 'steps', 2)
      g.setParam(seq, 'step1', 0) // A4
      g.setParam(seq, 'step2', 1) // an octave up
      g.connect([clock, 'gate'], [seq, 'clock'])
      g.connect([seq, 'cv'], [osc, 'pitch'])
      return osc
    })
    // The first second holds step 1, so the pitch is A4.
    expect(peakHz(first.subarray(0, 16384), SR)).toBeCloseTo(440, -1)
  })
})
