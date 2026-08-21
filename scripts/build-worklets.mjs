// Builds every AudioWorklet processor into its own self-contained ES module
// in public/worklets/, which is what audioWorklet.addModule() loads.
//
// This used to be one multi-entry `vite build --config vite.worklets.config.ts`
// invocation, entries listed in a single `lib.entry` map. That broke the day
// a pure module (src/engine/dsp/wavetable.ts) became a dependency of more
// than one worklet (vco.worklet.ts, and the LFO processor inside
// segment.worklet.ts): Rollup's default behavior for a multi-entry build is
// to split code shared by two or more entries into its own chunk with a
// content-hashed filename, imported cross-file from each entry bundle --
// e.g. vco.js gaining `import { ... } from "./wavetable-CgMSUNjQ.js"`. That
// works in the Chromium this project's browser tests run against, but
// defeats the reason this file exists in the first place (see the original
// comment, preserved below) and is fragile in ways not worth finding out
// about from a user's browser instead of here: AudioWorkletGlobalScope's
// module support is newer and less uniformly implemented than the main
// thread's, and a hashed chunk filename is one more thing that can go stale
// or fail to resolve.
//
// The fix is one Rollup build PER worklet, each with its own module graph,
// so a shared pure module gets fully duplicated into every bundle that uses
// it instead of factored out. Vite's CLI doesn't support an array-exporting
// config file for `vite build` (only the dev server reads arrays), so this
// drives Vite's JS build() API directly in a loop instead of shelling out
// once per entry from package.json.
//
// To add a new worklet: add one line to WORKLETS below, and its name to
// WORKLET_MODULES in src/engine/worklets/registry.ts. That's the same
// two-edit contract vite.worklets.config.ts had.
import { build } from 'vite'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'

const entry = (path) => fileURLToPath(new URL(path, import.meta.url))

const WORKLETS = {
  passthrough: entry('../src/engine/worklets/passthrough.worklet.ts'),
  vco: entry('../src/engine/worklets/vco.worklet.ts'),
  ladder: entry('../src/engine/worklets/ladder.worklet.ts'),
  svf: entry('../src/engine/worklets/svf.worklet.ts'),
  wavefolder: entry('../src/engine/worklets/wavefolder.worklet.ts'),
  drive: entry('../src/engine/worklets/drive.worklet.ts'),
  segment: entry('../src/engine/worklets/segment.worklet.ts'),
  pingpong: entry('../src/engine/worklets/pingpong.worklet.ts'),
  width: entry('../src/engine/worklets/width.worklet.ts'),
  'peak-tap': entry('../src/engine/worklets/peak-tap.worklet.ts'),
  recorder: entry('../src/engine/worklets/recorder.worklet.ts'),
  sampler: entry('../src/engine/worklets/sampler.worklet.ts'),
  bitcrusher: entry('../src/engine/worklets/bitcrusher.worklet.ts'),
  flanger: entry('../src/engine/worklets/flanger.worklet.ts'),
  binaural: entry('../src/engine/worklets/binaural.worklet.ts'),
  isochronic: entry('../src/engine/worklets/isochronic.worklet.ts'),
  'cpu-meter': entry('../src/engine/worklets/cpu-meter.worklet.ts'),
}

const OUT_DIR = fileURLToPath(new URL('../public/worklets', import.meta.url))
rmSync(OUT_DIR, { recursive: true, force: true })

for (const [name, entryPath] of Object.entries(WORKLETS)) {
  await build({
    configFile: false,
    // Worklet output lands in public/, which Vite would otherwise try to
    // copy into itself during this build.
    publicDir: false,
    logLevel: 'warn',
    build: {
      outDir: 'public/worklets',
      emptyOutDir: false, // already cleared once, above, for the whole set
      lib: {
        entry: entryPath,
        formats: ['es'],
        fileName: () => `${name}.js`,
      },
    },
  })
}
