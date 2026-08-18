/** Proves the worklet build and loader before any DSP depends on them. */
class PassthroughProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0]
    const output = outputs[0]?.[0]
    if (output) {
      if (input) output.set(input)
      else output.fill(0)
    }
    return true
  }
}

registerProcessor('passthrough', PassthroughProcessor)
