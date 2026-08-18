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
  // This is the same PolyBLEP saw measured at 441 Hz in the node-side
  // polyblep.test.ts baseline (~-43 dB); a follow-up task will raise it to
  // the professional bar via minBLEP.
  it('holds the saw alias floor at its honest pre-minBLEP baseline at A4', async () => {
    const out = await renderGraph(0.3, (_ctx, g) => g.addModule('vco', 'osc'))
    // Measured: -42.8 dB. Margin of ~3 dB below that.
    expect(aliasFloorDb(out, SR, peakHz(out, SR))).toBeLessThan(-40)
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
