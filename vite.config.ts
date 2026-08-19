import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

const entry = (path: string) => fileURLToPath(new URL(path, import.meta.url))

// This is the app build (index.html + harness.html). It does NOT build the
// worklets -- those are one self-contained Rollup bundle each, produced by
// scripts/build-worklets.mjs with its own configFile: false build() calls
// that never see this file. `npm run build` runs both in sequence.
export default defineConfig({
  // Relative base, not the default absolute "/". The whole point of this
  // build is a directory that can be dropped at the domain root or a
  // subdirectory (e.g. /portfolio/sinsthesis/) without touching it, and
  // Vite's HTML plugin rewrites every script/link tag it emits (and
  // `import.meta.env.BASE_URL`, which src/engine/worklets/registry.ts reads
  // to build worklet URLs) using whatever `base` is set to. An absolute
  // base bakes in "serve me from the domain root"; a relative one makes
  // every emitted reference resolve against wherever the HTML file that
  // loaded it actually sits, so the same build works at any depth. This is
  // the one documented, deployment-target-agnostic knob the deploy plumbing
  // needs -- it is never a specific subpath, so it never needs touching
  // per deploy.
  base: './',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: entry('./index.html'),
        harness: entry('./harness.html'),
      },
    },
  },
})
