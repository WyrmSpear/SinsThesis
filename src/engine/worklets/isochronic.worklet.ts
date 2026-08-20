import { createIsoState, isoSample, resetGatePhase } from '../dsp/isochronic'
import { createSyncState, updateSync, isSyncLocked, lockedRateHz } from '../dsp/clock-sync'

/** Thin shell. All the math lives in dsp/isochronic (the gate + shaped
 *  envelope + carrier) and dsp/clock-sync (the division-lock math), both
 *  Node-tested directly. The clock-sync integration here is a deliberate,
 *  line-for-line mirror of segment.worklet.ts's LfoProcessor -- same
 *  "Free routes around the sync tracking, any division locks and hard-
 *  resets phase only on the sample lock is newly acquired" shape, because
 *  it's the same problem (a synced periodic generator) with the same
 *  answer already measured there (0.003-0.006% locked-rate error). */
class IsochronicProcessor extends AudioWorkletProcessor {
  private readonly state = createIsoState()
  private lastSync = 0
  private readonly sync = createSyncState()

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'carrier', defaultValue: 200, minValue: 20, maxValue: 2000, automationRate: 'a-rate' },
      // k-rate, matching lfo's own 'rate' -- a per-block constant a player
      // turns, not something modulated sample-by-sample.
      { name: 'rate', defaultValue: 8, minValue: 0.1, maxValue: 40, automationRate: 'k-rate' },
      { name: 'duty', defaultValue: 0.5, minValue: 0.05, maxValue: 0.95, automationRate: 'a-rate' },
      // Milliseconds -- converted to seconds below.
      { name: 'edge', defaultValue: 8, minValue: 1, maxValue: 50, automationRate: 'a-rate' },
      // Discrete, like the LFO's own division -- see dsp/clock-sync.ts's
      // DIVISION_LABELS.
      { name: 'division', defaultValue: 0, minValue: 0, maxValue: 15, automationRate: 'k-rate' },
    ]
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0]
    if (!out) return true

    const sync = inputs[0]?.[0]
    const carrierArr = params.carrier!
    const rate = params.rate![0]!
    const dutyArr = params.duty!
    const edgeArr = params.edge!
    const divisionIndex = Math.round(params.division![0]!)

    for (let i = 0; i < out.length; i++) {
      const s = sync?.[i] ?? 0
      let effectiveRate = rate

      if (divisionIndex === 0) {
        // Free: the Hz knob, hard-reset the gate cycle on every rising
        // edge of sync (a no-op when nothing is patched).
        if (s >= 0.5 && this.lastSync < 0.5) resetGatePhase(this.state)
      } else {
        const wasLocked = isSyncLocked(this.sync, sampleRate)
        updateSync(this.sync, s, sampleRate)
        const isLocked = isSyncLocked(this.sync, sampleRate)
        if (!wasLocked && isLocked) resetGatePhase(this.state)
        if (isLocked) effectiveRate = lockedRateHz(this.sync, divisionIndex)
      }
      this.lastSync = s

      const carrier = carrierArr.length > 1 ? carrierArr[i]! : carrierArr[0]!
      const duty = dutyArr.length > 1 ? dutyArr[i]! : dutyArr[0]!
      const edgeMs = edgeArr.length > 1 ? edgeArr[i]! : edgeArr[0]!

      out[i] = isoSample(
        this.state,
        { carrierHz: carrier, rateHz: effectiveRate, duty, edgeSeconds: edgeMs / 1000 },
        sampleRate,
      )
    }
    return true
  }
}

registerProcessor('isochronic', IsochronicProcessor)
