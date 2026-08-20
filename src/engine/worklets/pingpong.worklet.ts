import { createPingPongState, pingPongSample, type PingPongOutput } from '../dsp/pingpong'
import { createSyncState, updateSync, isSyncLocked, DIVISION_MULTIPLIERS } from '../dsp/clock-sync'

const MAX_DELAY_SECONDS = 2

/** Thin shell. All the math lives in dsp/pingpong, which Node tests
 *  directly -- same split as ladder.worklet.ts, svf.worklet.ts, etc. */
class PingPongProcessor extends AudioWorkletProcessor {
  private readonly state = createPingPongState(MAX_DELAY_SECONDS, sampleRate)
  private readonly out: PingPongOutput = { left: 0, right: 0 }
  // Clock-division lock, identical mechanism to segment.worklet.ts's
  // LfoProcessor -- see dsp/clock-sync.ts's module doc comment for the
  // first-pulse/stopped-clock/tempo-change handling this reuses verbatim.
  private readonly sync = createSyncState()

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'time', defaultValue: 0.3, minValue: 0.001, maxValue: MAX_DELAY_SECONDS, automationRate: 'a-rate' },
      { name: 'feedback', defaultValue: 0.3, minValue: 0, maxValue: 0.95, automationRate: 'a-rate' },
      { name: 'mix', defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      // Discrete, like the LFO's own division param -- see
      // dsp/clock-sync.ts's DIVISION_LABELS and lfo.ts's doc comment.
      { name: 'division', defaultValue: 0, minValue: 0, maxValue: 15, automationRate: 'k-rate' },
    ]
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]
    const outL = out?.[0]
    const outR = out?.[1]
    if (!outL || !outR) return true

    const input = inputs[0]?.[0]
    const timeCv = inputs[1]?.[0]
    const sync = inputs[2]?.[0]

    const timeArr = params.time!
    const feedbackArr = params.feedback!
    const mixArr = params.mix!
    const divisionIndex = Math.round(params.division![0]!)

    for (let i = 0; i < outL.length; i++) {
      const s = sync?.[i] ?? 0
      // a-rate params arrive as length 1 (constant this block) or
      // length `outL.length` (one value per sample) -- see vco.worklet.ts.
      const knobTime = timeArr.length > 1 ? timeArr[i]! : timeArr[0]!
      const feedback = feedbackArr.length > 1 ? feedbackArr[i]! : feedbackArr[0]!
      const mix = mixArr.length > 1 ? mixArr[i]! : mixArr[0]!

      let timeSeconds = knobTime + (timeCv?.[i] ?? 0)

      if (divisionIndex !== 0) {
        // Clock-division: track the pulse period continuously (never
        // frozen by which mode is currently selected, so a mode switch
        // mid-patch doesn't need to "warm up" again) and only override the
        // knob's own time while locked -- unlocked, this degrades to plain
        // Free-mode behavior rather than a frozen or undefined delay time.
        updateSync(this.sync, s, sampleRate)
        if (isSyncLocked(this.sync, sampleRate)) {
          // The LFO's lockedRateHz inverts this same product to get a
          // *rate*; a delay wants the period itself, so this multiplies
          // rather than divides -- "1/4" here means a delay tap of one
          // quarter note, the same musical reading a clocked hardware
          // delay gives it. DIVISION_MULTIPLIERS express an LFO's period as
          // a multiple of the measured (assumed-quarter-note) clock period,
          // which is exactly the note-value arithmetic a delay time needs
          // too: an eighth-note delay is half the quarter-note period, a
          // half-note delay is twice it, straight/triplet/dotted alike.
          timeSeconds = this.sync.periodSeconds * DIVISION_MULTIPLIERS[divisionIndex]!
        }
      }
      const delaySamples = Math.max(1, Math.min(this.state.bufferA.length - 2, timeSeconds * sampleRate))

      pingPongSample(this.state, input?.[i] ?? 0, delaySamples, feedback, mix, this.out)
      outL[i] = this.out.left
      outR[i] = this.out.right
    }
    return true
  }
}

registerProcessor('pingpong', PingPongProcessor)
