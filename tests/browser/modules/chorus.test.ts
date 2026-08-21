import { describe, it, expect, beforeEach } from 'vitest'
import { renderGraph } from '../../../src/engine/render'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { chorusDescriptor } from '../../../src/engine/modules/chorus'
import { VOICE_PHASES, sinePhaseCoefficients, voiceDelaySeconds } from '../../../src/engine/dsp/chorus'
import { rms } from '../../../src/engine/analysis/features'
import type { PatchGraph } from '../../../src/engine/graph'

const SAMPLE_RATE = 48000
const IMPULSE_AT = 9600 // 0.2 s -- past scheduleParam's 8 ms ramp (B3)

beforeEach(() => {
  clearRegistry()
  registerModule(chorusDescriptor)
})

/** Phase of a rendered signal at a given frequency, in degrees, via direct
 *  DFT. This is how the LFO phase claim gets measured rather than trusted. */
function phaseDegreesAt(buf: Float32Array, hz: number, sampleRate = SAMPLE_RATE): number {
  let re = 0
  let im = 0
  for (let n = 0; n < buf.length; n++) {
    const w = (-2 * Math.PI * hz * n) / sampleRate
    re += buf[n]! * Math.cos(w)
    im += buf[n]! * Math.sin(w)
  }
  const deg = (Math.atan2(im, re) * 180) / Math.PI
  return ((deg % 360) + 360) % 360
}

/** Smallest signed separation between two angles, in degrees. */
function angleDelta(a: number, b: number): number {
  let d = ((a - b + 540) % 360) - 180
  if (d === -180) d = 180
  return d
}

/** Render one bare oscillator carrying a given phase, exactly the way the
 *  Chorus builds its three LFOs. */
function renderPhasedOscillator(phase: number, hz: number, seconds = 1.0): Promise<Float32Array> {
  return renderGraph(seconds, (ctx, g) => {
    // A module still has to exist for renderGraph to have something to
    // return, but the measurement is on the raw oscillator patched past it.
    const ch = g.addModule('chorus', 'ch')
    const osc = ctx.createOscillator()
    const { real, imag } = sinePhaseCoefficients(phase)
    osc.setPeriodicWave(ctx.createPeriodicWave(real, imag, { disableNormalization: true }))
    osc.frequency.value = hz
    osc.start()
    g.setParam(ch, 'mix', 1)
    osc.connect(g.getInstance(ch)!.inputs.get('in') as AudioNode)
    // Bypass the chorus for this measurement: read the oscillator itself.
    const probe = ctx.createGain()
    osc.connect(probe)
    g.getInstance(ch)!.outputs.set('probe', probe)
    return [ch, 'probe']
  })
}

function impulseResponse(setup: (graph: PatchGraph, id: string) => void, length = 8192): Promise<Float32Array> {
  return renderGraph(1.0, (ctx, g) => {
    const ch = g.addModule('chorus', 'ch')
    const buffer = ctx.createBuffer(1, SAMPLE_RATE, SAMPLE_RATE)
    buffer.getChannelData(0)[IMPULSE_AT] = 1
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.start()
    source.connect(g.getInstance(ch)!.inputs.get('in') as AudioNode)
    setup(g, ch)
    return ch
  }).then((out) => new Float32Array(out.subarray(IMPULSE_AT, IMPULSE_AT + length)))
}

describe('Chorus LFO phases', () => {
  /**
   * The claim the whole module rests on. Three voices sweeping in phase
   * would be one louder voice, not an ensemble. Measured on real rendered
   * oscillators built exactly as the module builds them -- not asserted
   * from the coefficient arithmetic, which the Node suite already covers.
   */
  it('realises three LFOs genuinely 120 degrees apart', async () => {
    const RATE = 4 // fast enough to resolve cleanly in a 1 s render
    const rendered = await Promise.all(VOICE_PHASES.map((p) => renderPhasedOscillator(p, RATE)))
    const phases = rendered.map((buf) => phaseDegreesAt(buf, RATE))

    const d1 = angleDelta(phases[1]!, phases[0]!)
    const d2 = angleDelta(phases[2]!, phases[0]!)
    // eslint-disable-next-line no-console
    console.log(
      `chorus LFO phases: ${phases.map((p) => p.toFixed(1)).join(', ')} deg; ` +
        `offsets ${d1.toFixed(1)}, ${d2.toFixed(1)} (want 120, -120)`,
    )

    expect(Math.abs(d1 - 120)).toBeLessThan(2)
    expect(Math.abs(d2 + 120)).toBeLessThan(2)
  })

  /**
   * The reason the offsets live in PeriodicWave coefficients rather than in
   * staggered start times. A time stagger is a fixed number of seconds, so
   * it is only a third of a cycle at one particular rate; change the Rate
   * knob and it silently becomes something else. Phase carried in the
   * waveform is rate-independent by construction, and this proves it by
   * measuring the same offsets at a different rate entirely.
   */
  it('holds those offsets at a completely different rate', async () => {
    const RATE = 7
    const rendered = await Promise.all(VOICE_PHASES.map((p) => renderPhasedOscillator(p, RATE)))
    const phases = rendered.map((buf) => phaseDegreesAt(buf, RATE))

    const d1 = angleDelta(phases[1]!, phases[0]!)
    const d2 = angleDelta(phases[2]!, phases[0]!)
    // eslint-disable-next-line no-console
    console.log(`chorus LFO phases @${RATE}Hz: offsets ${d1.toFixed(1)}, ${d2.toFixed(1)} (want 120, -120)`)

    expect(Math.abs(d1 - 120)).toBeLessThan(2)
    expect(Math.abs(d2 + 120)).toBeLessThan(2)
  })

  it('gives each voice the same amplitude, so a phase offset is not secretly a depth difference', async () => {
    const rendered = await Promise.all(VOICE_PHASES.map((p) => renderPhasedOscillator(p, 4)))
    const levels = rendered.map((buf) => rms(buf))
    // eslint-disable-next-line no-console
    console.log(`chorus LFO amplitudes: ${levels.map((l) => l.toFixed(5)).join(', ')}`)
    for (const l of levels) expect(l).toBeCloseTo(levels[0]!, 3)
  })
})

describe('Chorus voices', () => {
  /**
   * With depth 0 the sweep is frozen, so the module is linear and
   * time-invariant and its impulse response shows the three voices as
   * discrete taps. Their positions are a direct read of the Spread knob
   * reaching the audio graph.
   */
  it('places its three delay taps where the Spread knob says', async () => {
    const ir = await impulseResponse((g, id) => {
      g.setParam(id, 'spread', 1)
      g.setParam(id, 'depth', 0)
      g.setParam(id, 'rate', 0.05)
      g.setParam(id, 'mix', 1)
    })

    const expected = [0, 1, 2].map((i) => voiceDelaySeconds(i, 1))
    for (const seconds of expected) {
      const centre = Math.round(seconds * SAMPLE_RATE)
      // Peak within +/-3 samples: the tap is at an exact sample offset, but
      // DelayNode interpolation can split it across neighbours.
      let peak = 0
      for (let n = centre - 3; n <= centre + 3; n++) peak = Math.max(peak, Math.abs(ir[n]!))
      // eslint-disable-next-line no-console
      console.log(`chorus tap @${(seconds * 1000).toFixed(0)}ms (sample ${centre}): ${peak.toFixed(4)}`)
      expect(peak).toBeGreaterThan(0.15)
    }
  })

  it('collapses the three taps onto one at spread 0', async () => {
    const ir = await impulseResponse((g, id) => {
      g.setParam(id, 'spread', 0)
      g.setParam(id, 'depth', 0)
      g.setParam(id, 'rate', 0.05)
      g.setParam(id, 'mix', 1)
    })
    const centre = Math.round(voiceDelaySeconds(0, 0) * SAMPLE_RATE)
    let atCentre = 0
    for (let n = centre - 3; n <= centre + 3; n++) atCentre = Math.max(atCentre, Math.abs(ir[n]!))

    // The full-spread outer tap positions must now be empty.
    const outer = Math.round(voiceDelaySeconds(0, 1) * SAMPLE_RATE)
    let atOuter = 0
    for (let n = outer - 3; n <= outer + 3; n++) atOuter = Math.max(atOuter, Math.abs(ir[n]!))

    // eslint-disable-next-line no-console
    console.log(`chorus spread=0: centre tap ${atCentre.toFixed(4)}, 12ms position ${atOuter.toFixed(5)}`)
    // All three voices stacked -- close to full amplitude at one place.
    expect(atCentre).toBeGreaterThan(0.8)
    expect(atOuter).toBeLessThan(0.01)
  })

  it('does not change level when Spread moves -- it changes texture', async () => {
    const at = (spread: number) =>
      renderGraph(1.0, (ctx, g) => {
        const ch = g.addModule('chorus', 'ch')
        const frames = SAMPLE_RATE
        const buffer = ctx.createBuffer(1, frames, SAMPLE_RATE)
        const data = buffer.getChannelData(0)
        let seed = 4242
        for (let i = 0; i < frames; i++) {
          seed = (seed * 1664525 + 1013904223) >>> 0
          data[i] = (seed / 0x100000000) * 2 - 1
        }
        const src = ctx.createBufferSource()
        src.buffer = buffer
        src.start()
        src.connect(g.getInstance(ch)!.inputs.get('in') as AudioNode)
        g.setParam(ch, 'spread', spread)
        g.setParam(ch, 'depth', 0.5)
        g.setParam(ch, 'mix', 1)
        return ch
      }).then((out) => rms(out.subarray(14400)))

    const [none, full] = await Promise.all([at(0), at(1)])
    // eslint-disable-next-line no-console
    console.log(`chorus level vs spread: 0 -> ${none.toFixed(4)}, 1 -> ${full.toFixed(4)}`)
    // Each voice carries 1/3, so stacking or spreading them must not change
    // the summed level much. Noise decorrelates across taps, so allow room.
    expect(full / none).toBeGreaterThan(0.4)
    expect(full / none).toBeLessThan(1.1)
  })

  it('passes the input untouched at mix 0', async () => {
    const ir = await impulseResponse((g, id) => {
      g.setParam(id, 'spread', 1)
      g.setParam(id, 'depth', 0.5)
      g.setParam(id, 'mix', 0)
    })
    expect(ir[0]).toBeCloseTo(1, 4)
    let tail = 0
    for (let n = 1; n < 4000; n++) tail = Math.max(tail, Math.abs(ir[n]!))
    // eslint-disable-next-line no-console
    console.log(`chorus mix=0: impulse ${ir[0]!.toFixed(5)}, largest tail ${tail.toExponential(2)}`)
    expect(tail).toBeLessThan(1e-4)
  })
})
