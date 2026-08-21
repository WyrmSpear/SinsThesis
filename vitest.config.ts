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
            'tests/browser/theme-migration.test.ts',
            'tests/browser/rack-sequencer.test.ts',
            'tests/browser/rack-scope.test.ts',
            'tests/browser/rack-academy.test.ts',
            'tests/browser/rack-match-sound.test.ts',
            'tests/browser/rack-academy-constrained.test.ts',
            'tests/browser/studio-record.test.ts',
            'tests/browser/pitch-display.test.ts',
            'tests/browser/rack-keyboard-zones.test.ts',
            'tests/browser/preset-bank.test.ts',
            'tests/browser/rack-academy-bass.test.ts',
            'tests/browser/rack-academy-history.test.ts',
            'tests/browser/rack-arcade.test.ts',
            'tests/browser/rack-wub.test.ts',
            'tests/browser/cpu-meter.test.ts',
            'tests/browser/rack-midi.test.ts',
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
            'tests/browser/theme-migration.test.ts',
            'tests/browser/rack-sequencer.test.ts',
            'tests/browser/rack-scope.test.ts',
            'tests/browser/rack-academy.test.ts',
            'tests/browser/rack-match-sound.test.ts',
            'tests/browser/rack-academy-constrained.test.ts',
            'tests/browser/studio-record.test.ts',
            'tests/browser/pitch-display.test.ts',
            'tests/browser/rack-keyboard-zones.test.ts',
            'tests/browser/preset-bank.test.ts',
            'tests/browser/rack-academy-bass.test.ts',
            'tests/browser/rack-academy-history.test.ts',
            'tests/browser/rack-arcade.test.ts',
            'tests/browser/rack-wub.test.ts',
            'tests/browser/cpu-meter.test.ts',
            'tests/browser/rack-midi.test.ts',
          ],
          // Boots a Vite dev server and a Chromium instance; slower than
          // the unit-style browser tests above.
          testTimeout: 30000,
          hookTimeout: 30000,
          // Every `expect.poll` in these files waits on a real offline
          // audio render to finish and hand the UI back (the academy's
          // "Check my patch" button returning to its idle label, the
          // match-this-sound target finishing playback). Vitest's default
          // poll budget is 1000ms, which is fine for one of these files on
          // its own and not fine for twenty of them rendering audio in
          // parallel Chromiums -- `rack-match-sound.test.ts` timed out at
          // roughly one full-suite run in ten with "Matcher did not succeed
          // in time" while the render itself was healthy. This is a
          // ceiling, not an expectation: the polls still fail if the render
          // never completes, they just stop failing when the machine is
          // merely busy.
          expect: { poll: { timeout: 20000, interval: 100 } },
        },
      },
    ],
  },
})
