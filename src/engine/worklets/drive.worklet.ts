import { createDriveState, driveSample, type DriveCurve } from '../dsp/drive'

const CURVES: DriveCurve[] = ['soft', 'hard']

/**
 * Thin shell. All the math -- the two curves, ADAA-1, the 4x oversampling
 * FIR, the DC blocker and the Tone filter -- lives in dsp/drive, which
 * Node tests directly. `drive`, `tone`, `level` and `driveCvAmount` are
 * a-rate: drive amount is exactly the kind of thing an envelope sweeps
 * (that's how a growl gets animated), so it needs to move within a render
 * quantum, not just between them. `curve` is discrete -- a value between
 * Soft and Hard is meaningless -- so it stays k-rate, same convention as
 * every other switch-like param in this codebase (e.g. the LFO's `shape`).
 */
class DriveProcessor extends AudioWorkletProcessor {
  private readonly state = createDriveState()

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'drive', defaultValue: 1, minValue: 0.1, maxValue: 20, automationRate: 'a-rate' },
      { name: 'curve', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'tone', defaultValue: 18000, minValue: 200, maxValue: 18000, automationRate: 'a-rate' },
      { name: 'level', defaultValue: 1, minValue: 0, maxValue: 2, automationRate: 'a-rate' },
      { name: 'driveCvAmount', defaultValue: 0, minValue: 0, maxValue: 10, automationRate: 'a-rate' },
      // 0 = Full (4x oversampled), 1 = Performance (native-rate ADAA-1
      // only) -- see dsp/drive.ts's `oversample` parameter doc comment.
      // Discrete, k-rate, same convention as `curve`.
      { name: 'quality', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ]
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0]
    if (!out) return true

    const audio = inputs[0]?.[0]
    const cv = inputs[1]?.[0]
    const driveParam = params.drive!
    const toneParam = params.tone!
    const levelParam = params.level!
    const cvAmountParam = params.driveCvAmount!
    const curve = CURVES[Math.round(params.curve![0]!)] ?? 'soft'
    const oversample = Math.round(params.quality![0]!) === 0

    for (let i = 0; i < out.length; i++) {
      // a-rate params arrive as length 1 (constant this block) or length
      // out.length (one value per sample) -- same convention vco.worklet.ts's
      // tune/pulseWidth use.
      const driveAt = driveParam.length > 1 ? driveParam[i]! : driveParam[0]!
      const cvAmountAt = cvAmountParam.length > 1 ? cvAmountParam[i]! : cvAmountParam[0]!
      const tone = toneParam.length > 1 ? toneParam[i]! : toneParam[0]!
      const level = levelParam.length > 1 ? levelParam[i]! : levelParam[0]!
      const drive = Math.max(driveAt + (cv?.[i] ?? 0) * cvAmountAt, 0.1)
      out[i] = driveSample(this.state, audio?.[i] ?? 0, drive, curve, tone, level, sampleRate, oversample)
    }
    return true
  }
}

registerProcessor('drive', DriveProcessor)
