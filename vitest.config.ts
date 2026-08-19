import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/node/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'browser',
          include: ['tests/browser/**/*.test.ts'],
          // dev-page.test.ts drives a real page navigation (its own
          // AudioContext, its own trusted user gestures) with the
          // `playwright` package directly, which needs Node's process/fs
          // APIs to spawn a dev server and a Chromium instance -- neither
          // exists inside this project's own sandboxed browser tab. It
          // gets its own "e2e" project below instead.
          exclude: [
            'tests/browser/dev-page.test.ts',
            'tests/browser/startup-thump.test.ts',
            'tests/browser/rack-page.test.ts',
            'tests/browser/theme-geometry.test.ts',
            'tests/browser/rack-sequencer.test.ts',
            'tests/browser/rack-scope.test.ts',
            'tests/browser/rack-academy.test.ts',
            'tests/browser/rack-match-sound.test.ts',
            'tests/browser/studio-record.test.ts',
            'tests/browser/pitch-display.test.ts',
          ],
          browser: {
            enabled: true,
            provider: 'playwright',
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
      {
        test: {
          name: 'e2e',
          environment: 'node',
          include: [
            'tests/browser/dev-page.test.ts',
            'tests/browser/startup-thump.test.ts',
            'tests/browser/rack-page.test.ts',
            'tests/browser/theme-geometry.test.ts',
            'tests/browser/rack-sequencer.test.ts',
            'tests/browser/rack-scope.test.ts',
            'tests/browser/rack-academy.test.ts',
            'tests/browser/rack-match-sound.test.ts',
            'tests/browser/studio-record.test.ts',
            'tests/browser/pitch-display.test.ts',
          ],
          // Boots a Vite dev server and a Chromium instance; slower than
          // the unit-style browser tests above.
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
    ],
  },
})
