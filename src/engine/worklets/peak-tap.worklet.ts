/**
 * A measurement-only worklet for the startup-thump regression test
 * (tests/browser/startup-thump.test.ts). Runs on the audio thread, not the
 * main thread -- the whole reason it exists is that main-thread polling
 * (ScriptProcessorNode, requestAnimationFrame) measurably misses this class
 * of transient (2/42 vs 30/30 in the investigation this fixes).
 *
 * Every render quantum it receives, it posts a copy of the input block back
 * to the main thread verbatim, tagged with `currentFrame` (audio-thread
 * sample counter, stable from the moment the node starts processing) so the
 * caller can reconstruct exactly when each sample was rendered relative to
 * graph construction. It never writes to its output -- silent passthrough,
 * zeros only -- so it is safe to wire all the way to `ctx.destination`
 * without risking real audible output from a test run.
 */
class PeakTapProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0]
    const output = outputs[0]?.[0]
    if (output) output.fill(0)
    if (input && input.length > 0) {
      this.port.postMessage({ frame: currentFrame, samples: input.slice() })
    }
    return true
  }
}

registerProcessor('peak-tap', PeakTapProcessor)
