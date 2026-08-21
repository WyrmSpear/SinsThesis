import { describe, it, expect, beforeEach } from 'vitest'
import { renderGraph } from '../../../src/engine/render'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { ringDescriptor } from '../../../src/engine/modules/ring'
import { fftMagnitude } from '../../../src/engine/analysis/fft'
import { db, rms } from '../../../src/engine/analysis/features'

/** Both are this codebase's stated-safe test frequencies (CONTINUATION.md
 *  trap 1): 48000/441 and 48000/1109 are nowhere near integers, so nothing
 *  folds onto an exact harmonic and hides in a bin the metric excludes. */
const SIGNAL_HZ = 441
const CARRIER_HZ = 1109
/** A ring modulator's whole output: sum and difference, carrier gone. */
const LOWER_SIDEBAND_HZ = CARRIER_HZ - SIGNAL_HZ // 668
const UPPER_SIDEBAND_HZ = CARRIER_HZ + SIGNAL_HZ // 1550

const FFT_SIZE = 32768
const SAMPLE_RATE = 48000
/** Start the analysis window well past scheduleParam's 8 ms ramp on every
 *  continuous param (B3), the same settling allowance native.test.ts makes. */
const WINDOW_START = 14400 // 0.3 s

beforeEach(() => {
  clearRegistry()
  registerModule(ringDescriptor)
})

function spectrum(out: Float32Array): Float32Array {
  const slice = out.subarray(WINDOW_START, WINDOW_START + FFT_SIZE)
  // Blackman-Harris, not Hann: carrier suppression is a floor measurement and
  // Hann's -31.5 dB first sidelobe cannot see past its own window (trap 2).
  return fftMagnitude(new Float32Array(slice), 'blackman-harris')
}

/** Peak magnitude within +/- 8 Hz of a target -- wide enough to cover
 *  Blackman-Harris's ~4-bin mainlobe at 1.46 Hz/bin, tight enough that 441,
 *  668, 1109 and 1550 never overlap each other. */
function magAt(mags: Float32Array, hz: number): number {
  const perBin = SAMPLE_RATE / FFT_SIZE
  const lo = Math.max(0, Math.floor((hz - 8) / perBin))
  const hi = Math.min(mags.length - 1, Math.ceil((hz + 8) / perBin))
  let peak = 0
  for (let i = lo; i <= hi; i++) peak = Math.max(peak, mags[i]!)
  return peak
}

/** Drive the module's `in` from a raw OscillatorNode rather than a VCO, so
 *  the test states an exact frequency instead of inheriting the VCO's
 *  tune/octave mapping -- this is a measurement of the multiply, not of
 *  anything upstream of it. */
function renderRing(
  seconds: number,
  setup: (graph: import('../../../src/engine/graph').PatchGraph, id: string) => void,
  externalCarrierHz?: number,
): Promise<Float32Array> {
  return renderGraph(seconds, (ctx, g) => {
    const ring = g.addModule('ring', 'ring')

    const signal = ctx.createOscillator()
    signal.type = 'sine'
    signal.frequency.value = SIGNAL_HZ
    signal.start()
    signal.connect(g.getInstance(ring)!.inputs.get('in') as AudioNode)

    if (externalCarrierHz !== undefined) {
      const carrier = ctx.createOscillator()
      carrier.type = 'sine'
      carrier.frequency.value = externalCarrierHz
      carrier.start()
      carrier.connect(g.getInstance(ring)!.inputs.get('carrier') as AudioNode)
    }

    setup(g, ring)
    return ring
  })
}

describe('Ring Modulator', () => {
  it('suppresses both the carrier and the input at shape 0 -- the figure that separates a ring modulator from a tremolo', async () => {
    const out = await renderRing(1.0, (g, id) => {
      g.setParam(id, 'freq', CARRIER_HZ)
      g.setParam(id, 'shape', 0)
      g.setParam(id, 'mix', 1)
    })
    const mags = spectrum(out)

    const lower = magAt(mags, LOWER_SIDEBAND_HZ)
    const upper = magAt(mags, UPPER_SIDEBAND_HZ)
    const sideband = Math.max(lower, upper)
    const carrierLeak = magAt(mags, CARRIER_HZ)
    const signalLeak = magAt(mags, SIGNAL_HZ)

    const carrierDb = db(carrierLeak / sideband)
    const signalDb = db(signalLeak / sideband)
    // eslint-disable-next-line no-console
    console.log(
      `ring shape=0: sidebands ${lower.toFixed(4)}/${upper.toFixed(4)}, ` +
        `carrier leak ${carrierDb.toFixed(1)} dB, input leak ${signalDb.toFixed(1)} dB`,
    )

    // Both sidebands present and balanced: a real four-quadrant multiply
    // splits the signal evenly, it does not favour one side.
    expect(lower).toBeGreaterThan(0.2)
    expect(upper).toBeGreaterThan(0.2)
    expect(Math.abs(db(lower / upper))).toBeLessThan(1)

    // The actual claim. An AM/tremolo stage leaves the carrier and the input
    // at full strength; a ring modulator cancels both.
    expect(carrierDb).toBeLessThan(-60)
    expect(signalDb).toBeLessThan(-60)
  })

  it('keeps the input present at shape 1, which is what makes it AM rather than ring modulation', async () => {
    const out = await renderRing(1.0, (g, id) => {
      g.setParam(id, 'freq', CARRIER_HZ)
      g.setParam(id, 'shape', 1)
      g.setParam(id, 'mix', 1)
    })
    const mags = spectrum(out)

    const signal = magAt(mags, SIGNAL_HZ)
    const sideband = Math.max(magAt(mags, LOWER_SIDEBAND_HZ), magAt(mags, UPPER_SIDEBAND_HZ))
    // eslint-disable-next-line no-console
    console.log(`ring shape=1: input ${signal.toFixed(4)}, sideband ${sideband.toFixed(4)}`)

    // in * (1 + carrier) -- the input survives at full strength alongside the
    // sidebands, the exact opposite of the shape=0 case above.
    expect(signal).toBeGreaterThan(0.2)
    expect(db(signal / sideband)).toBeGreaterThan(3)
  })

  it('morphs continuously between the two rather than switching', async () => {
    const leakAt = async (shape: number): Promise<number> => {
      const out = await renderRing(1.0, (g, id) => {
        g.setParam(id, 'freq', CARRIER_HZ)
        g.setParam(id, 'shape', shape)
        g.setParam(id, 'mix', 1)
      })
      const mags = spectrum(out)
      return magAt(mags, SIGNAL_HZ)
    }
    const [a, b, c] = await Promise.all([leakAt(0.25), leakAt(0.5), leakAt(0.75)])
    // eslint-disable-next-line no-console
    console.log(`ring shape sweep: 0.25=${a.toFixed(4)} 0.5=${b.toFixed(4)} 0.75=${c.toFixed(4)}`)
    // Monotonic in the input's own survival: no step, no plateau.
    expect(b).toBeGreaterThan(a * 1.2)
    expect(c).toBeGreaterThan(b * 1.2)
  })

  it('does not double in level across the shape sweep -- the trim earns its place', async () => {
    const levelAt = async (shape: number): Promise<number> => {
      const out = await renderRing(1.0, (g, id) => {
        g.setParam(id, 'freq', CARRIER_HZ)
        g.setParam(id, 'shape', shape)
        g.setParam(id, 'mix', 1)
      })
      return rms(out.subarray(WINDOW_START))
    }
    const [dry, wetEnd] = await Promise.all([levelAt(0), levelAt(1)])
    // eslint-disable-next-line no-console
    console.log(`ring level: shape=0 rms ${dry.toFixed(4)}, shape=1 rms ${wetEnd.toFixed(4)}`)
    // Without the 1/(1+shape) trim this ratio is ~2x and the shape knob is
    // secretly a volume knob. Generous bound -- the spectra genuinely differ,
    // this only has to catch a doubling.
    expect(wetEnd / dry).toBeLessThan(1.6)
    expect(wetEnd / dry).toBeGreaterThan(0.625)
  })

  it('takes an external carrier when source is switched to Ext, and ignores the internal one', async () => {
    const EXT_HZ = 1760 // the third of this codebase's safe frequencies
    const out = await renderRing(
      1.0,
      (g, id) => {
        // Internal carrier deliberately parked somewhere else entirely: if the
        // switch does not actually mute it, its sidebands show up and fail.
        g.setParam(id, 'freq', CARRIER_HZ)
        g.setParam(id, 'source', 1) // Ext
        g.setParam(id, 'shape', 0)
        g.setParam(id, 'mix', 1)
      },
      EXT_HZ,
    )
    const mags = spectrum(out)

    const extSideband = magAt(mags, EXT_HZ - SIGNAL_HZ) // 1319
    const intSideband = magAt(mags, LOWER_SIDEBAND_HZ) // 668, internal-only
    // eslint-disable-next-line no-console
    console.log(
      `ring ext: external sideband ${extSideband.toFixed(4)}, ` +
        `internal sideband ${intSideband.toFixed(4)} (${db(intSideband / extSideband).toFixed(1)} dB)`,
    )

    expect(extSideband).toBeGreaterThan(0.2)
    expect(db(intSideband / extSideband)).toBeLessThan(-60)
  })

  it('passes the input untouched at mix 0', async () => {
    const out = await renderRing(1.0, (g, id) => {
      g.setParam(id, 'freq', CARRIER_HZ)
      g.setParam(id, 'shape', 0)
      g.setParam(id, 'mix', 0)
    })
    const mags = spectrum(out)
    const signal = magAt(mags, SIGNAL_HZ)
    const sideband = Math.max(magAt(mags, LOWER_SIDEBAND_HZ), magAt(mags, UPPER_SIDEBAND_HZ))
    // eslint-disable-next-line no-console
    console.log(`ring mix=0: input ${signal.toFixed(4)}, sideband ${sideband.toFixed(4)}`)

    expect(signal).toBeGreaterThan(0.5)
    expect(db(sideband / signal)).toBeLessThan(-60)
  })
})
