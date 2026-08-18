import { createOscState, getWavetableSet, hardSync, oscSample, pitchToFreq, type OscShape } from '../dsp/wavetable'

const SHAPES: OscShape[] = ['saw', 'pulse', 'tri', 'sine']

// Built once, here, at module top level -- this code runs during
// `audioWorklet.addModule()`, before any node exists, which is what makes
// this safe to do at all. `sampleRate` is the AudioWorkletGlobalScope
// global. Building the 24 band-limited tables (millions of trig calls) on
// the audio thread's first non-sine sample was A1: a live AudioContext
// dropped out on the first note. Every VcoProcessor instance in this
// bundle shares this one read-only set.
const wavetableSet = getWavetableSet(sampleRate)

/** Thin shell. All the math lives in dsp/wavetable, which Node tests directly. */
class VcoProcessor extends AudioWorkletProcessor {
  private readonly state = createOscState()
  private lastSync = 0

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      // tune and pulseWidth are a-rate (final review Finding 2): at k-rate
      // a worklet reads params.foo![0] once per 128-sample render quantum,
      // so a scheduleParam ramp -- a real, continuous AudioParam automation
      // -- still reached the DSP as a staircase of block-sized steps, not
      // the smooth glide the automation curve actually describes. a-rate
      // delivers the browser's own per-sample ramp as a Float32Array; see
      // process() below for how it's read. octave, shape and fmAmount stay
      // k-rate: octave is nearly always used in whole steps and fmAmount
      // scales an already-continuous CV input rather than being twiddled
      // on its own, and shape is a discrete table index.
      { name: 'tune', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'a-rate' },
      { name: 'octave', defaultValue: 0, minValue: -4, maxValue: 4, automationRate: 'k-rate' },
      { name: 'shape', defaultValue: 0, minValue: 0, maxValue: 3, automationRate: 'k-rate' },
      { name: 'pulseWidth', defaultValue: 0.5, minValue: 0.01, maxValue: 0.99, automationRate: 'a-rate' },
      { name: 'fmAmount', defaultValue: 0, minValue: 0, maxValue: 4, automationRate: 'k-rate' },
    ]
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0]
    if (!out) return true

    const pitchCv = inputs[0]?.[0]
    const fmCv = inputs[1]?.[0]
    const syncGate = inputs[2]?.[0]

    const tuneArr = params.tune!
    const octave = params.octave![0]!
    const shape = SHAPES[Math.round(params.shape![0]!)] ?? 'saw'
    const pwArr = params.pulseWidth!
    const fmAmount = params.fmAmount![0]!

    for (let i = 0; i < out.length; i++) {
      const sync = syncGate?.[i] ?? 0
      if (sync >= 0.5 && this.lastSync < 0.5) hardSync(this.state)
      this.lastSync = sync

      // a-rate params arrive as length 1 (constant this block) or length
      // `out.length` (one value per sample).
      const tune = tuneArr.length > 1 ? tuneArr[i]! : tuneArr[0]!
      const pw = pwArr.length > 1 ? pwArr[i]! : pwArr[0]!
      // A4 = 440 Hz; pitch CV is 1.0 per octave, tune is in semitones.
      const base = 440 * Math.pow(2, octave + tune / 12)
      const cv = (pitchCv?.[i] ?? 0) + (fmCv?.[i] ?? 0) * fmAmount
      const freq = pitchToFreq(base, cv, sampleRate)
      out[i] = oscSample(this.state, shape, freq, sampleRate, wavetableSet, pw)
    }
    return true
  }
}

registerProcessor('vco', VcoProcessor)
