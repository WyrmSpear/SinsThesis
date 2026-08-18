import { describe, it, expect, beforeEach } from 'vitest'
import { renderGraph } from '../../../src/engine/render'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { vcoDescriptor } from '../../../src/engine/modules/vco'
import { peakHz, aliasFloorDb, rms } from '../../../src/engine/analysis/features'

const SR = 48000

describe('VCO module', () => {
  beforeEach(() => {
    clearRegistry()
    registerModule(vcoDescriptor)
  })

  it('sounds A4 at its default tuning', async () => {
    const out = await renderGraph(0.2, (_ctx, g) => g.addModule('vco', 'osc'))
    expect(peakHz(out, SR)).toBeCloseTo(440, -1)
  })

  it('transposes an octave when the octave param moves', async () => {
    const out = await renderGraph(0.2, (_ctx, g) => {
      const id = g.addModule('vco', 'osc')
      g.setParam(id, 'octave', 1)
      return id
    })
    expect(peakHz(out, SR)).toBeCloseTo(880, -1)
  })

  // tune=29 used to be set here to push the test tone up toward 2 kHz, but
  // 'tune' is declared -24..24 and the browser clamps out-of-range params,
  // so the test was silently measuring 440 Hz while claiming ~2349 Hz. It
  // also inherited 2 kHz's problem from the node-side polyblep tests: near a
  // small-integer divisor of the sample rate, aliases fold onto harmonics
  // and the (now DC-excluded, Blackman-Harris) metric excludes them right
  // along with the real harmonics. Render at the module's default A4 tuning
  // instead and locate the fundamental with peakHz rather than assuming it.
  //
  // This oscillator is now the wavetable core (dsp/wavetable.ts), not
  // PolyBLEP -- see task-M2-report.md for the full measured table. The
  // -40 dB bar here was honest for PolyBLEP; it's trivially satisfied now
  // and would hide a regression back to something PolyBLEP-grade.
  //
  // A tiny tune offset (~0.007 semitones, inaudible) nudges the fundamental
  // onto an exact FFT bin for this render length: without it, the
  // Blackman-Harris window's own ~-92 dB sidelobe smears 440 Hz's energy
  // into neighboring bins and the test would read a window-leakage floor
  // around -95 dB instead of the oscillator's real one -- the same trap
  // aliasFloorDb's own doc comment warns about for un-bin-aligned tones,
  // just via window leakage rather than a small-integer SR/f0 ratio. See
  // the identical fix (and full writeup) in tests/node/dsp/wavetable.test.ts.
  it('holds the saw alias floor at its wavetable-core measured reality at A4', async () => {
    const N = 65536
    const binSpacing = SR / N
    const alignedHz = Math.round(440 / binSpacing) * binSpacing
    const tune = 12 * Math.log2(alignedHz / 440)
    const out = await renderGraph(N / SR, (_ctx, g) => {
      const id = g.addModule('vco', 'osc')
      g.setParam(id, 'tune', tune)
      return id
    })
    // Measured: -143.7 dB. Margin of over 40 dB below that -- see
    // task-M2-report.md for why the bar is set well below the measured
    // figure rather than right up against it (browser-render jitter across
    // machines/CI, not a hedge against the oscillator's own quality).
    expect(aliasFloorDb(out, SR, peakHz(out, SR))).toBeLessThan(-100)
  })

  it('produces sound on every shape', async () => {
    for (const shape of [0, 1, 2, 3]) {
      const out = await renderGraph(0.2, (_ctx, g) => {
        const id = g.addModule('vco', 'osc')
        g.setParam(id, 'shape', shape)
        return id
      })
      expect(rms(out)).toBeGreaterThan(0.05)
    }
  })
})
