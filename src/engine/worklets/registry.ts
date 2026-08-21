/** Base names of every worklet bundle in public/worklets/. */
export const WORKLET_MODULES = [
  'passthrough',
  'vco',
  'ladder',
  'svf',
  'wavefolder',
  'drive',
  'segment',
  'pingpong',
  'width',
  'peak-tap',
  'recorder',
  'sampler',
  'bitcrusher',
  'flanger',
  'compressor',
  'binaural',
  'isochronic',
  'cpu-meter',
] as const

type WorkletBundle = (typeof WORKLET_MODULES)[number]

/**
 * Maps a processor name -- the string a module descriptor's `create()`
 * passes as `new AudioWorkletNode(ctx, name, ...)` -- to the
 * `WORKLET_MODULES` bundle whose `addModule()` call registers it. Most
 * processor names equal their bundle name one-to-one and never need an
 * entry here (see the fallback in `workletAvailable` below); `'segment'`
 * is the one bundle that registers four processor names from a single
 * Rollup entry (see `segment.worklet.ts`'s own four `registerProcessor`
 * calls), so it is the only case that needs spelling out.
 */
const PROCESSOR_BUNDLE: Record<string, WorkletBundle> = {
  adsr: 'segment',
  lfo: 'segment',
  'sample-hold': 'segment',
  sequencer: 'segment',
}

/**
 * Per-context record of which worklet bundles have actually finished
 * loading -- `render.ts`'s `ensureWorklets` is the sole writer (via
 * `markWorkletLoaded`), populated as each individual `addModule()` call
 * resolves, independent of whether the *combined* `ensureWorklets()`
 * promise for that call ultimately resolves or rejects (see its own doc
 * comment: one bundle failing must not erase that three others already
 * loaded). Every worklet-backed module descriptor's `create()` is a reader
 * (via `workletAvailable`), deciding whether to build the real
 * `AudioWorkletNode` -- which throws synchronously if the processor was
 * never registered -- or a native fallback / an honest failure state.
 */
const loadedBundles = new WeakMap<BaseAudioContext, Set<string>>()

export function markWorkletLoaded(ctx: BaseAudioContext, bundleName: string): void {
  let set = loadedBundles.get(ctx)
  if (!set) {
    set = new Set()
    loadedBundles.set(ctx, set)
  }
  set.add(bundleName)
}

export function loadedWorkletBundles(ctx: BaseAudioContext): ReadonlySet<string> {
  return loadedBundles.get(ctx) ?? new Set()
}

/**
 * Whether `new AudioWorkletNode(ctx, processorName, ...)` can be expected
 * to succeed right now. `processorName` may be a bundle name (the common
 * case, where the two are identical) or one of `'segment'`'s four
 * registered processor names (`adsr`/`lfo`/`sample-hold`/`sequencer`) --
 * both resolve through `PROCESSOR_BUNDLE` to the same underlying bundle.
 */
export function workletAvailable(ctx: BaseAudioContext, processorName: string): boolean {
  const bundle = PROCESSOR_BUNDLE[processorName] ?? processorName
  return loadedWorkletBundles(ctx).has(bundle)
}

// `import.meta.env.BASE_URL` is Vite's own answer to "where does this build
// think it's rooted" -- '/' everywhere nothing overrides it (every test
// path: vitest's own dev server, and the e2e suite's `createServer({
// configFile: false })`), and whatever `base` the production `vite.config.ts`
// sets otherwise. That build uses a relative base (see its own comment for
// why), so in the shipped build this resolves to a URL relative to whichever
// HTML page loaded it -- correct at the domain root or nested under any
// subdirectory, without a rebuild. `ctx.audioWorklet.addModule()` resolves a
// relative URL against the document, not the calling module, so this does
// not need `new URL(..., import.meta.url)` gymnastics: the same string
// resolves correctly from index.html and harness.html alike.
export const workletUrl = (name: string): string => `${import.meta.env.BASE_URL}worklets/${name}.js`
