import { describe, it, expect, beforeEach } from 'vitest'
import { renderPatch } from '../../src/engine/render'
import { registerAllModules } from '../../src/engine/modules'
import { clearRegistry } from '../../src/engine/registry'
import type { PatchFile } from '../../src/engine/patch'
import { fftMagnitude } from '../../src/engine/analysis/fft'
import { db, rms, rmsEnvelope } from '../../src/engine/analysis/features'

import ringBellsRaw from '../../presets/patches/ring-bells.sinp?raw'
import jetSweepRaw from '../../presets/patches/jet-sweep.sinp?raw'
import ensemblePadRaw from '../../presets/patches/ensemble-pad.sinp?raw'
import sidechainPumpRaw from '../../presets/patches/sidechain-pump.sinp?raw'

/**
 * `preset-bank.test.ts` proves every bank entry makes *sound* the instant it
 * loads. That is a necessary bar and not a sufficient one: a preset named
 * for a module can pass it while that module sits in the chain doing
 * nothing at all -- a compressor that never reaches its threshold, a chorus
 * at mix 0, a flanger that is not sweeping. Sound is not evidence of the
 * effect.
 *
 * So these four presets, the ones that exist specifically to demonstrate
 * ROADMAP section 1's effects rung, each get a measurement of the thing
 * they are named for. Where the claim is "this module is doing the work,"
 * the test renders the patch twice -- once as shipped, once with that one
 * module neutralised -- and asserts the difference, which is the only way
 * to show the module is load-bearing rather than decorative.
 */

const SAMPLE_RATE = 48000

beforeEach(() => {
  clearRegistry()
  registerAllModules()
})

const parse = (raw: string): PatchFile => JSON.parse(raw) as PatchFile

/** A copy of a preset with one module's params overridden. */
function withParams(raw: string, moduleId: string, params: Record<string, number>): PatchFile {
  const patch = parse(raw)
  const target = patch.modules.find((m) => m.id === moduleId)
  if (!target) throw new Error(`no module "${moduleId}" in this preset`)
  target.params = { ...target.params, ...params }
  return patch
}

function magAt(mags: Float32Array, hz: number, halfWidth = 12): number {
  const perBin = SAMPLE_RATE / (mags.length * 2)
  const lo = Math.max(0, Math.floor((hz - halfWidth) / perBin))
  const hi = Math.min(mags.length - 1, Math.ceil((hz + halfWidth) / perBin))
  let peak = 0
  for (let i = lo; i <= hi; i++) peak = Math.max(peak, mags[i]!)
  return peak
}

function spectrumOf(buf: Float32Array, from: number, size = 32768): Float32Array {
  return fftMagnitude(new Float32Array(buf.subarray(from, from + size)), 'blackman-harris')
}

describe('Ring Bells demonstrates ring modulation', () => {
  it('produces the sum and difference tones and suppresses both originals', async () => {
    // VCO sine at 440, carrier at 761 -> sidebands at 321 and 1201. A
    // tremolo or an AM stage would leave 440 and 761 standing; a ring
    // modulator cancels them, and that is the whole reason for the preset.
    const out = await renderPatch(parse(ringBellsRaw), 1.2)
    const mags = spectrumOf(out, 4800)

    const lower = magAt(mags, 321)
    const upper = magAt(mags, 1201)
    const note = magAt(mags, 440)
    const carrier = magAt(mags, 761)
    const sideband = Math.max(lower, upper)

    // eslint-disable-next-line no-console
    console.log(
      `Ring Bells: sidebands 321Hz/1201Hz = ${lower.toFixed(4)}/${upper.toFixed(4)}, ` +
        `note 440Hz ${db(note / sideband).toFixed(1)} dB, carrier 761Hz ${db(carrier / sideband).toFixed(1)} dB`,
    )

    expect(sideband).toBeGreaterThan(0.01)
    expect(db(note / sideband)).toBeLessThan(-30)
    expect(db(carrier / sideband)).toBeLessThan(-30)
  })

  it('uses an inharmonic carrier, which is what makes it a bell and not a pitch', async () => {
    const patch = parse(ringBellsRaw)
    const ring = patch.modules.find((m) => m.id === 'ring-1')!
    const ratio = (ring.params.freq as number) / 440
    // eslint-disable-next-line no-console
    console.log(`Ring Bells: carrier/note ratio ${ratio.toFixed(4)}`)
    // Comfortably clear of every simple ratio a harmonic partial would sit on.
    for (const harmonic of [0.5, 1, 1.5, 2, 2.5, 3]) {
      expect(Math.abs(ratio - harmonic)).toBeGreaterThan(0.08)
    }
  })
})

describe('Jet Sweep demonstrates flanging', () => {
  it('sweeps -- its spectrum at one instant differs from another', async () => {
    const out = await renderPatch(parse(jetSweepRaw), 3.0)
    // The preset's Flanger runs at 0.22 Hz, so ~1.1 s apart is close to
    // half a sweep cycle -- the notches should be somewhere quite different.
    const a = spectrumOf(out, 24000, 8192)
    const b = spectrumOf(out, 76800, 8192)

    // Compare the shape of the two spectra across the band the comb lives
    // in, level-normalised so this measures the notches moving rather than
    // any overall loudness change.
    const perBin = SAMPLE_RATE / 16384
    const lo = Math.floor(300 / perBin)
    const hi = Math.floor(5000 / perBin)
    let sumA = 0
    let sumB = 0
    for (let i = lo; i < hi; i++) {
      sumA += a[i]!
      sumB += b[i]!
    }
    let difference = 0
    for (let i = lo; i < hi; i++) {
      difference += Math.abs(a[i]! / sumA - b[i]! / sumB)
    }

    // eslint-disable-next-line no-console
    console.log(`Jet Sweep: normalised spectral difference between two instants = ${difference.toFixed(4)}`)
    expect(difference).toBeGreaterThan(0.1)
  })

  it('goes still when the Flanger stops sweeping, proving the motion is the Flanger', async () => {
    const frozen = await renderPatch(withParams(jetSweepRaw, 'flanger-1', { depth: 0 }), 3.0)
    const a = spectrumOf(frozen, 24000, 8192)
    const b = spectrumOf(frozen, 76800, 8192)

    const perBin = SAMPLE_RATE / 16384
    const lo = Math.floor(300 / perBin)
    const hi = Math.floor(5000 / perBin)
    let sumA = 0
    let sumB = 0
    for (let i = lo; i < hi; i++) {
      sumA += a[i]!
      sumB += b[i]!
    }
    let difference = 0
    for (let i = lo; i < hi; i++) difference += Math.abs(a[i]! / sumA - b[i]! / sumB)

    // eslint-disable-next-line no-console
    console.log(`Jet Sweep with depth 0: normalised spectral difference = ${difference.toFixed(4)}`)
    // The two oscillators sit an exact octave apart with no detune, so the
    // source is strictly periodic and a frozen Flanger leaves the spectrum
    // genuinely still. That is deliberate: an earlier version of this
    // preset detuned them slightly, and their beating alone scored 0.3510
    // here against 0.3573 for the swept case -- meaning the "it sweeps"
    // test above was passing on oscillator drift, not on the Flanger. This
    // control is what caught that.
    expect(difference).toBeLessThan(0.05)
  })
})

describe('Ensemble Pad demonstrates chorusing', () => {
  it('moves over time in a way the same patch without the Chorus does not', async () => {
    // The three swept taps beat against the dry signal, so the summed level
    // wanders. Bypassing the Chorus leaves three free-running oscillators
    // whose beating is far slower and shallower.
    const [wet, dry] = await Promise.all([
      renderPatch(parse(ensemblePadRaw), 3.0),
      renderPatch(withParams(ensemblePadRaw, 'chorus-1', { mix: 0 }), 3.0),
    ])

    const spread = (buf: Float32Array): number => {
      const env = rmsEnvelope(buf.subarray(24000), 2400) // 50 ms windows
      let lo = Infinity
      let hi = 0
      for (const v of env) {
        if (v <= 0) continue
        lo = Math.min(lo, v)
        hi = Math.max(hi, v)
      }
      return db(hi / lo)
    }

    const wetSpread = spread(wet)
    const drySpread = spread(dry)
    // eslint-disable-next-line no-console
    console.log(`Ensemble Pad: level movement wet ${wetSpread.toFixed(2)} dB vs bypassed ${drySpread.toFixed(2)} dB`)
    expect(wetSpread).toBeGreaterThan(drySpread)
  })

  it('runs its three voices at full spread, so they are genuinely separate taps', async () => {
    const patch = parse(ensemblePadRaw)
    const chorus = patch.modules.find((m) => m.id === 'chorus-1')!
    expect(chorus.params.spread).toBe(1)
    expect(chorus.params.depth as number).toBeGreaterThan(0.3)
  })
})

describe('Sidechain Pump demonstrates compression', () => {
  /**
   * The claim in the preset's own description: the bass never stops
   * playing, and the kick reaches in through the Key jack and turns it
   * down. Rendering it once only shows a patch that makes noise -- so this
   * renders it twice, the second time with the Compressor neutralised at
   * ratio 1, and asserts the ducking exists in one and not the other.
   */
  it('ducks the bass on every kick, and stops doing so when the Compressor is bypassed', async () => {
    const [pumped, flat] = await Promise.all([
      renderPatch(parse(sidechainPumpRaw), 3.0),
      renderPatch(withParams(sidechainPumpRaw, 'compressor-1', { ratio: 1, makeup: 8 }), 3.0),
    ])

    // 124 BPM -> a kick every ~484 ms. Measure how deeply the level dips
    // between kicks relative to its own ceiling.
    const duckDepth = (buf: Float32Array): number => {
      const env = rmsEnvelope(buf.subarray(48000), 1200) // 25 ms windows, second half
      const values = Array.from(env).filter((v) => v > 0)
      values.sort((a, b) => a - b)
      const low = values[Math.floor(values.length * 0.1)]!
      const high = values[Math.floor(values.length * 0.9)]!
      return db(high / low)
    }

    const pumpedDepth = duckDepth(pumped)
    const flatDepth = duckDepth(flat)
    // eslint-disable-next-line no-console
    console.log(
      `Sidechain Pump: level swing ${pumpedDepth.toFixed(2)} dB compressed vs ${flatDepth.toFixed(2)} dB bypassed`,
    )

    // The compressed render must swing measurably harder than the bypassed
    // one -- that difference *is* the pumping.
    expect(pumpedDepth).toBeGreaterThan(flatDepth + 2)
  })

  it('keys the Compressor externally, which is the only way a kick can duck a bass', async () => {
    const patch = parse(sidechainPumpRaw)
    const comp = patch.modules.find((m) => m.id === 'compressor-1')!
    expect(comp.params.keySource).toBe(1)
    // And a cable really does feed that jack from the kick's VCA.
    const keyed = patch.cables.some((c) => c.to[0] === 'compressor-1' && c.to[1] === 'key')
    expect(keyed).toBe(true)
    // The bass path must not pass through the kick's VCA -- if it did, the
    // "ducking" would just be the kick's own envelope.
    const bassIntoComp = patch.cables.some((c) => c.to[0] === 'compressor-1' && c.to[1] === 'in')
    expect(bassIntoComp).toBe(true)
  })

  it('leaves the bass free-running, so there is something sustained to duck', async () => {
    const patch = parse(sidechainPumpRaw)
    // vco-1 is the bass. Nothing may gate it -- no VCA in its path to the
    // compressor -- or the preset would demonstrate an envelope, not a
    // compressor.
    const bassChain = patch.cables.filter((c) => c.from[0] === 'vco-1')
    expect(bassChain).toHaveLength(1)
    expect(bassChain[0]!.to[0]).toBe('vcf-1')
    const out = await renderPatch(parse(sidechainPumpRaw), 2.0)
    // Never fully silent between kicks.
    const env = rmsEnvelope(out.subarray(48000), 1200)
    const quietest = Math.min(...Array.from(env).filter((v) => v > 0))
    // eslint-disable-next-line no-console
    console.log(`Sidechain Pump: quietest 25 ms window ${db(quietest).toFixed(1)} dBFS (bass never stops)`)
    expect(quietest).toBeGreaterThan(0.005)
    expect(rms(out)).toBeGreaterThan(0.02)
  })
})
