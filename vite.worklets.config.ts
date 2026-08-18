import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

const entry = (path: string) => fileURLToPath(new URL(path, import.meta.url))

/**
 * Worklets build separately from the app: each becomes one self-contained ES
 * module in public/worklets/, which is what audioWorklet.addModule() loads.
 * Bundling each to a single file avoids import resolution inside
 * AudioWorkletGlobalScope, where the usual module graph is not available.
 */
export default defineConfig({
  // Worklet output lands in public/, which Vite would otherwise try to copy
  // into itself during this build.
  publicDir: false,
  build: {
    outDir: 'public/worklets',
    emptyOutDir: true,
    lib: {
      entry: { passthrough: entry('./src/engine/worklets/passthrough.worklet.ts') },
      formats: ['es'],
    },
    rollupOptions: { output: { entryFileNames: '[name].js' } },
  },
})
