import { workletAvailable } from './worklets/registry'

/**
 * Engine-side handle for Section 11's "CPU overload -> load meter" failure
 * mode. See `worklets/cpu-meter.worklet.ts` for the measurement technique
 * and its own cost accounting; this file is just the plumbing that gets a
 * report from the audio thread to whoever wants to draw it (`rack/
 * cpu-meter-panel.ts`), the same split every other engine/UI pair in this
 * codebase already uses (compare `recorder.ts` <-> `studio-panel.ts`).
 *
 * One meter per live session, not per patch: it measures the audio
 * *context's* overall render load, which already includes every module
 * currently mounted, so there is nothing patch-specific to rebuild when
 * `rack/main.ts` swaps graphs (`mountGraph`/`PatchGraph.dispose()`) -- the
 * meter node is created once, in `start()`, alongside `ensureWorklets`, and
 * lives for the whole session.
 */
export interface CpuLoadReport {
  /** Average load fraction across this reporting window (~0.2s -- see the
   *  worklet's own `REPORTS_PER_SECOND`), not a single-quantum peak -- see
   *  `worklets/cpu-meter.worklet.ts`'s own doc comment for why a windowed
   *  average is the honest choice once the time source's resolution turns
   *  out to be coarser than one render quantum. 1.0 means this window's
   *  quanta collectively took exactly their combined wall-clock budget;
   *  above 1.0 means the window ran over on average. */
  avgLoad: number
  /** Count of individual render quanta that ran well over budget (see
   *  `OVERRUN_MULTIPLE` in the worklet) within this reporting window. */
  overruns: number
}

export interface CpuMeterHandle {
  /** Subscribe to periodic reports (about five a second -- see the
   *  worklet's own `REPORTS_PER_SECOND`). Returns an unsubscribe function. */
  onReport(cb: (report: CpuLoadReport) => void): () => void
  dispose(): void
}

/**
 * `undefined` when the `cpu-meter` bundle didn't load -- the meter is
 * instrumentation, not a synth voice a patch depends on, so its own
 * absence is handled the same honest way as everything else in this
 * failure mode: the caller (`rack/main.ts`) simply doesn't show a meter,
 * rather than this throwing or faking a reading it doesn't have.
 */
export function createCpuMeter(ctx: AudioContext): CpuMeterHandle | undefined {
  if (!workletAvailable(ctx, 'cpu-meter')) return undefined

  let node: AudioWorkletNode
  try {
    node = new AudioWorkletNode(ctx, 'cpu-meter', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] })
  } catch {
    return undefined
  }

  // The Web Audio spec only guarantees `process()` keeps getting called
  // for a node that is part of the graph reaching the destination (or
  // that has active inputs) -- a zero-input node with nothing downstream
  // is free to be treated as inactive by an implementation. Routing
  // through a silent (`gain.value = 0`) sink into `ctx.destination` keeps
  // this node genuinely "in the graph" without emitting anything audible;
  // it never carries signal, only keeps the measurement running.
  const sink = ctx.createGain()
  sink.gain.value = 0
  node.connect(sink)
  sink.connect(ctx.destination)

  const listeners = new Set<(report: CpuLoadReport) => void>()
  node.port.onmessage = (event: MessageEvent<CpuLoadReport>): void => {
    for (const cb of listeners) cb(event.data)
  }

  return {
    onReport(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    dispose() {
      node.port.onmessage = null
      node.disconnect()
      sink.disconnect()
      listeners.clear()
    },
  }
}
