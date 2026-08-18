import { PatchGraph } from './graph'
import { WORKLET_MODULES, workletUrl } from './worklets/registry'

const loaded = new WeakSet<BaseAudioContext>()

/** Load every worklet into a context. Safe to call repeatedly. */
export async function ensureWorklets(ctx: BaseAudioContext): Promise<void> {
  if (loaded.has(ctx)) return
  await Promise.all(WORKLET_MODULES.map((name) => ctx.audioWorklet.addModule(workletUrl(name))))
  loaded.add(ctx)
}

/**
 * Render a patch offline and return the mono result.
 *
 * This is the same entry point the test suite and the academy's graders use:
 * build a graph, render it, then measure the buffer with engine/analysis.
 *
 * @param build receives the context and an empty graph, and returns either
 *              the id of the module whose `out` port feeds the destination,
 *              or a `[moduleId, portId]` tuple to address any other port —
 *              needed for modules, like a clock, that have no `out` port.
 */
export async function renderGraph(
  seconds: number,
  build: (ctx: OfflineAudioContext, graph: PatchGraph) => string | [string, string],
  sampleRate = 48000,
): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * sampleRate), sampleRate)
  await ensureWorklets(ctx)

  const graph = new PatchGraph(ctx)
  // A bare module id means its "out" port; a tuple addresses any port by name.
  const result = build(ctx, graph)
  const [outputId, portId] = typeof result === 'string' ? [result, 'out'] : result

  const instance = graph.getInstance(outputId)
  if (!instance) throw new Error(`renderGraph: no module "${outputId}"`)
  const out = instance.outputs.get(portId)
  if (!out) throw new Error(`renderGraph: module "${outputId}" has no "${portId}" port`)
  out.connect(ctx.destination)

  const buffer = await ctx.startRendering()
  return buffer.getChannelData(0)
}
