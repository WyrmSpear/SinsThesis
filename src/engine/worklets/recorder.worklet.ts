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
 * Captures two channels, always -- ROADMAP section 1a's stereo work means
 * whatever this taps (an Output module's `out`) may now genuinely be
 * stereo (Panner, Ping-Pong Delay or Width feeding it), and a recorder that
 * silently kept only one channel would be exactly the "silent data-loss
 * bug" that section warns about. `LiveRecorder.start()` forces
 * `channelCount: 2, channelCountMode: 'explicit'` on this node, so a mono
 * source arrives already up-mixed to two identical channels (the same trick
 * output.ts's own `in` jack uses) -- `inputs[0]` here always has exactly 2
 * channels, never a variable count this file would need to branch on.
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

export interface RecorderChunk {
  left: Float32Array
  right: Float32Array
}

class RecorderProcessor extends AudioWorkletProcessor {
  private bufferL = new Float32Array(BATCH_FRAMES)
  private bufferR = new Float32Array(BATCH_FRAMES)
  private filled = 0

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const inputL = inputs[0]?.[0]
    const inputR = inputs[0]?.[1] ?? inputL // mono up-mix belt-and-braces: see doc comment
    const output = outputs[0]?.[0]
    if (output) output.fill(0)
    if (!inputL || inputL.length === 0) return true

    let offset = 0
    while (offset < inputL.length) {
      const room = BATCH_FRAMES - this.filled
      const take = Math.min(room, inputL.length - offset)
      this.bufferL.set(inputL.subarray(offset, offset + take), this.filled)
      this.bufferR.set((inputR ?? inputL).subarray(offset, offset + take), this.filled)
      this.filled += take
      offset += take
      if (this.filled === BATCH_FRAMES) {
        const chunk: RecorderChunk = { left: this.bufferL, right: this.bufferR }
        this.port.postMessage(chunk, [this.bufferL.buffer, this.bufferR.buffer])
        this.bufferL = new Float32Array(BATCH_FRAMES)
        this.bufferR = new Float32Array(BATCH_FRAMES)
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('recorder', RecorderProcessor)
