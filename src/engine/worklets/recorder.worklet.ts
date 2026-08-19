/**
 * Production capture tap for the studio layer's live recording (see
 * src/engine/recorder.ts's `LiveRecorder`, its one caller). Runs on the
 * audio thread, not the main thread -- this project already learned that
 * lesson the hard way (peak-tap.worklet.ts, built for
 * tests/browser/startup-thump.test.ts after main-thread polling measurably
 * missed transients a worklet never does) and live recording needs the
 * identical guarantee for a different reason: a `ScriptProcessorNode` or a
 * `requestAnimationFrame` poll runs on the same thread as the DOM, so a
 * layout, a GC pause, or a slow paint steals cycles from it and drops
 * samples the audio thread itself never missed.
 *
 * Never touches its own output -- silent passthrough, exactly like
 * peak-tap.worklet.ts -- and is wired as a *parallel* tap off the signal
 * the operator is already hearing (see `LiveRecorder`'s doc comment), never
 * inserted in series. That is what keeps recording from being able to
 * degrade the very audio it records: nothing about arming or disarming
 * this node can add latency, alter gain, or touch the sample values
 * reaching the speakers.
 *
 * Batches BATCH_FRAMES samples internally before posting a transferred
 * (zero-copy) chunk back to the main thread, instead of posting every
 * 128-sample render quantum the way peak-tap does. peak-tap only ever runs
 * for a few hundred milliseconds inside a test; this runs for as long as an
 * operator holds a performance, so quantum-by-quantum messaging would mean
 * several hundred `postMessage` calls a second for minutes at a time. The
 * trade is a worst-case BATCH_FRAMES/sampleRate of un-flushed tail audio
 * (~10.7 ms at 48 kHz) if the node is disconnected between flushes --
 * inaudible against a recording measured in seconds to minutes, and far
 * cheaper than the message-rate cost of not batching at all.
 */
const BATCH_FRAMES = 512

class RecorderProcessor extends AudioWorkletProcessor {
  private buffer = new Float32Array(BATCH_FRAMES)
  private filled = 0

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0]
    const output = outputs[0]?.[0]
    if (output) output.fill(0)
    if (!input || input.length === 0) return true

    let offset = 0
    while (offset < input.length) {
      const room = BATCH_FRAMES - this.filled
      const take = Math.min(room, input.length - offset)
      this.buffer.set(input.subarray(offset, offset + take), this.filled)
      this.filled += take
      offset += take
      if (this.filled === BATCH_FRAMES) {
        this.port.postMessage(this.buffer, [this.buffer.buffer])
        this.buffer = new Float32Array(BATCH_FRAMES)
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('recorder', RecorderProcessor)
