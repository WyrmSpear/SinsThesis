/**
 * Ping-pong delay: mono in, stereo out, feedback crossing between channels
 * so repeats alternate L/R/L/R rather than echoing straight back into the
 * same channel the way delay.ts's plain mono delay does.
 *
 * Two delay lines, cross-fed:
 *
 *   lineA.write(n) = input[n] + feedback * lineB.read(n)
 *   lineB.write(n) = feedback * lineA.read(n)
 *   outL[n] = dry*input[n] + wet*lineA.read(n)
 *   outR[n] = dry*input[n] + wet*lineB.read(n)
 *
 * where `read(n)` means "the sample written `delaySamples` ago", taken
 * *before* this sample's write -- that ordering is what keeps the cross
 * feedback from being a same-sample cycle: `lineB`'s new value depends only
 * on what `lineA` already held, never on what `lineA` is about to become.
 * The first echo lands on L (`lineA`) one delay time after the input, the
 * second on R (`lineB`) one delay time after that (it was fed from `lineA`'s
 * echo), the third back on L, and so on -- ping, pong, ping, pong, decaying
 * by `feedback` on every bounce. The dry signal is panned center (equal
 * weight on both channels) so only the wet repeats actually alternate.
 *
 * `delaySamples` may be fractional -- linear interpolation between the two
 * neighboring integer positions in the circular buffer -- so a smoothly
 * changing delay time (an a-rate param ramping, or clock-lock reacting to a
 * tempo change) doesn't produce the same 1-sample-quantized zipper a naive
 * integer-only read would.
 *
 * Pure per-sample state and a step function, exactly like dsp/svf.ts and
 * dsp/wavefolder.ts -- Node-testable without a browser, with
 * pingpong.worklet.ts as the thin shell that calls this in a loop.
 */

export interface PingPongState {
  bufferA: Float32Array
  bufferB: Float32Array
  writeIndex: number
}

/** `maxDelaySeconds` sizes both circular buffers; `delaySamples` passed to
 *  `pingPongSample` must never exceed `maxDelaySeconds * sampleRate` or the
 *  read wraps into not-yet-overwritten future samples instead of the past. */
export function createPingPongState(maxDelaySeconds: number, sampleRate: number): PingPongState {
  // +2 for interpolation headroom at the boundary (reading `index + 1` at
  // the oldest legal position must still land inside the buffer).
  const size = Math.ceil(maxDelaySeconds * sampleRate) + 2
  return { bufferA: new Float32Array(size), bufferB: new Float32Array(size), writeIndex: 0 }
}

/** Linearly interpolated read `delaySamples` behind the current write
 *  position, wrapping through the circular buffer. */
function readDelayed(buffer: Float32Array, writeIndex: number, delaySamples: number): number {
  const size = buffer.length
  const back = Math.max(0, Math.min(size - 1.001, delaySamples))
  const pos = (writeIndex - back + size * 2) % size
  const i0 = Math.floor(pos)
  const i1 = (i0 + 1) % size
  const frac = pos - i0
  return buffer[i0]! * (1 - frac) + buffer[i1]! * frac
}

export interface PingPongOutput {
  left: number
  right: number
}

/**
 * Advances the delay by one sample and returns the stereo output.
 * `delaySamples` may change from call to call (a-rate automation or a
 * clock-locked division recalculated per sample) -- each line reads at
 * whatever `delaySamples` is *this* sample, so a changing delay time glides
 * the tap position rather than requiring a separate crossfade mechanism.
 */
export function pingPongSample(
  state: PingPongState,
  input: number,
  delaySamples: number,
  feedback: number,
  mix: number,
  out: PingPongOutput,
): PingPongOutput {
  const readA = readDelayed(state.bufferA, state.writeIndex, delaySamples)
  const readB = readDelayed(state.bufferB, state.writeIndex, delaySamples)

  state.bufferA[state.writeIndex] = input + feedback * readB
  state.bufferB[state.writeIndex] = feedback * readA
  state.writeIndex = (state.writeIndex + 1) % state.bufferA.length

  const dry = 1 - mix
  out.left = dry * input + mix * readA
  out.right = dry * input + mix * readB
  return out
}
