import { PatchGraph } from './graph'
import { WORKLET_MODULES, workletUrl } from './worklets/registry'
import { loadPatch, type PatchFile } from './patch'

const loading = new WeakMap<BaseAudioContext, Promise<void>>()

/** Load every worklet into a context. Safe to call repeatedly and concurrently:
 *  overlapping callers share one in-flight load rather than racing to register
 *  the same processor twice. */
export function ensureWorklets(ctx: BaseAudioContext): Promise<void> {
  let inFlight = loading.get(ctx)
  if (!inFlight) {
    inFlight = Promise.all(
      WORKLET_MODULES.map((name) => ctx.audioWorklet.addModule(workletUrl(name))),
    )
      .then(() => undefined)
      .catch((err: unknown) => {
        // A failed load must not poison the context for good: drop the cached
        // rejection so the next caller gets a fresh attempt.
        loading.delete(ctx)
        throw err
      })
    loading.set(ctx, inFlight)
  }
  return inFlight
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

/**
 * Render a full saved patch offline -- the academy's match-this-sound mode
 * uses this for both sides of a Check: the level's own target `.sinp` and
 * whatever the player currently has built, through the *identical*
 * procedure, so a measured difference reflects a real difference in what
 * was patched rather than one side being triggered a few milliseconds
 * earlier than the other, held longer, or rendered at a different sample
 * rate. `renderGraph` above stays the lower-level primitive this is built
 * on (a caller assembling a graph by hand, as every other module's test
 * suite does); this is the one two `PatchFile`s -- both untrusted, since a
 * player's live patch is one of them -- need to render the same way.
 *
 * `opts.gate`, if given, connects a synthetic `ConstantSourceNode` directly
 * into the `gate` input of *every* `adsr` module the patch contains
 * (existential by type, the same "any module of this type" resolution
 * `inspector.ts`'s `ModuleRef` uses, so it doesn't care which id the
 * palette happened to assign). Match-this-sound levels grant no keyboard --
 * there is nothing else that would ever gate an ADSR in one of them -- so
 * this is how a "bright pluck" level's envelope actually gets triggered,
 * identically, on both the target render and every attempt a player makes.
 */
export async function renderPatch(
  patch: PatchFile,
  seconds: number,
  opts: { sampleRate?: number; gate?: { onAt: number; offAt?: number } } = {},
): Promise<Float32Array> {
  const sampleRate = opts.sampleRate ?? 48000
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * sampleRate), sampleRate)
  await ensureWorklets(ctx)

  const { graph } = loadPatch(ctx, patch)

  if (opts.gate) {
    const gate = opts.gate
    for (const id of graph.moduleIds) {
      if (graph.getType(id) !== 'adsr') continue
      const input = graph.getInstance(id)?.inputs.get('gate')
      if (!(input instanceof AudioNode)) continue
      const source = ctx.createConstantSource()
      source.offset.setValueAtTime(1, gate.onAt)
      if (gate.offAt !== undefined) source.offset.setValueAtTime(0, gate.offAt)
      source.start(0)
      source.connect(input)
    }
  }

  const outputId = graph.moduleIds.find((id) => graph.getType(id) === 'output')
  if (!outputId) throw new Error('renderPatch: patch has no output module')
  const out = graph.getInstance(outputId)?.outputs.get('out')
  if (!out) throw new Error('renderPatch: output module has no "out" port')
  out.connect(ctx.destination)

  const buffer = await ctx.startRendering()
  return buffer.getChannelData(0)
}
