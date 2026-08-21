import { workletAvailable } from '../worklets/registry'
import type { ModuleInstance, PortSpec } from '../types'

/**
 * The shared half of every worklet-backed descriptor's failure handling
 * (see `types.ts`'s `ModuleInstance.fallback` doc comment for the two
 * buckets a module lands in, and `.superpowers/sdd/robustness-report.md`
 * for which module is which and why). Two things live here rather than
 * being duplicated across every descriptor:
 *
 * 1. `tryCreateWorkletNode` -- the one safe way to attempt building the
 *    real `AudioWorkletNode`. Constructing one for a processor name that
 *    was never registered throws *synchronously* (an `InvalidStateError`),
 *    and that throw happens inside `PatchGraph.addModule`, which
 *    `loadPatch` calls once per module while rebuilding a whole patch --
 *    an uncaught throw there does not fail just the one module, it aborts
 *    the entire patch load, taking every module that *would* have built
 *    fine down with it. Checking `workletAvailable` first avoids the
 *    throw in the expected case (a bundle that never loaded); the
 *    `try`/`catch` around the construction itself is defense in depth for
 *    the unexpected case (some other reason the browser refuses the
 *    node), so a module's `create()` never needs its own copy of this
 *    guard.
 * 2. `buildFailedInstance` -- the generic "no honest fallback exists"
 *    stub every fail-loud module (the segment-based ADSR/LFO/S&H/
 *    Sequencer family, and the Bitcrusher) returns instead. Its ports
 *    exist -- as bare `GainNode`s, one per port -- so cabling still works
 *    structurally (a patch that names this module's ports in a cable
 *    still loads and round-trips) and so `PatchGraph.connect` never has
 *    to special-case a fallback instance's missing ports. No `GainNode`
 *    here is ever connected to another, so no signal actually passes
 *    through: an honest silence, not a fabricated approximation of what
 *    the real DSP would have done.
 */
export function tryCreateWorkletNode(
  ctx: BaseAudioContext,
  processorName: string,
  options: AudioWorkletNodeOptions,
): AudioWorkletNode | null {
  if (!workletAvailable(ctx, processorName)) return null
  try {
    return new AudioWorkletNode(ctx, processorName, options)
  } catch {
    return null
  }
}

export function buildFailedInstance(
  ctx: BaseAudioContext,
  ports: readonly Pick<PortSpec, 'id' | 'dir'>[],
  reason: string,
): ModuleInstance {
  const inputs = new Map<string, AudioNode | AudioParam>()
  const outputs = new Map<string, AudioNode>()
  const nodes: GainNode[] = []
  for (const p of ports) {
    const gain = ctx.createGain()
    nodes.push(gain)
    if (p.dir === 'in') inputs.set(p.id, gain)
    else outputs.set(p.id, gain)
  }
  return {
    inputs,
    outputs,
    fallback: { level: 'failed', reason },
    setParam() {
      // Nothing is listening -- every port above is an inert GainNode with
      // no `AudioParam` this module's own params were ever wired to.
    },
    dispose() {
      for (const n of nodes) n.disconnect()
    },
  }
}
