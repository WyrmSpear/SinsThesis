/**
 * TypeScript's built-in libs do not declare AudioWorkletGlobalScope: the DOM
 * lib mentions `AudioWorkletProcessor` only in passing doc comments, and the
 * "webworker" lib actually conflicts with "DOM" in the same tsc program (this
 * project's tsconfig loads DOM for the app code, and a worklet file living
 * under the same `src` include cannot get its own program). So every worklet
 * shell needs these declared by hand, once, here.
 *
 * These names are only ever valid inside AudioWorkletGlobalScope, but
 * TypeScript has no mechanism to scope ambient globals to one directory —
 * they leak into the whole program's global namespace. That is an accepted,
 * deliberate trade-off: nothing outside `worklets/*.worklet.ts` references
 * `AudioWorkletProcessor` or `registerProcessor`, so the leak is inert.
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
