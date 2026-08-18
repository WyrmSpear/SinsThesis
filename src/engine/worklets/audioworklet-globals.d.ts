/**
 * Ambient declarations for AudioWorkletGlobalScope.
 *
 * TypeScript's built-in libs declare neither `AudioWorkletProcessor` nor
 * `registerProcessor`, and pulling in the `webworker` lib alongside this
 * project's `DOM` lib collides on about thirty global-scope names. So we
 * declare the handful of things worklets actually need.
 *
 * The cost: `declare global` reaches the whole program, so `sampleRate` and
 * `currentTime` typecheck in ordinary engine files that have no such global at
 * runtime. Scoping this properly would need a separate tsconfig and project
 * references. Instead, tests/node/boundaries.test.ts asserts these names appear
 * only in *.worklet.ts files.
 */
declare global {
  interface AudioWorkletProcessor {
    readonly port: MessagePort
    process(
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      parameters: Record<string, Float32Array>,
    ): boolean
  }

  // eslint-disable-next-line no-var
  var AudioWorkletProcessor: {
    prototype: AudioWorkletProcessor
    new (options?: AudioWorkletNodeOptions): AudioWorkletProcessor
  }

  interface AudioParamDescriptor {
    name: string
    automationRate?: AutomationRate
    minValue?: number
    maxValue?: number
    defaultValue?: number
  }

  function registerProcessor(
    name: string,
    processorCtor: (new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor) & {
      parameterDescriptors?: AudioParamDescriptor[]
    },
  ): void

  /** Sample rate of the owning BaseAudioContext; read-only inside the worklet. */
  const sampleRate: number
  /** Render-quantum-aligned sample counter; read-only inside the worklet. */
  const currentFrame: number
  /** Context time in seconds; read-only inside the worklet. */
  const currentTime: number
}

export {}
