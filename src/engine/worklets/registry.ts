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
] as const

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
