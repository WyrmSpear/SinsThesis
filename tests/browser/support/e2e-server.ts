import { createServer, type ViteDevServer } from 'vite'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'

/**
 * The root cause behind this project's intermittent `test:browser` failure
 * (see docs/CONTINUATION.md's flaky-test section, `.superpowers/sdd/
 * arcade-audio-report.md` for the full investigation). Every "e2e" test
 * file (`rack-arcade.test.ts`, `rack-page.test.ts`, `preset-bank.test.ts`,
 * and seventeen others -- the whole `e2e` vitest project) boots its own
 * real Vite dev server plus its own real Chromium instance in `beforeAll`,
 * and vitest runs that project's ~20 files in parallel by default (this
 * repo's 32 cores mean nothing stops all ~20 from starting at once). Every
 * one of those files used to call plain `createServer({ root, configFile:
 * false, server: { port: 0 } })` -- `configFile: false` skips reading
 * `vite.config.ts`, so nothing overrides Vite's own default `cacheDir`,
 * which is `<root>/node_modules/.vite`. All ~20 concurrently-booting
 * servers were therefore pointed at the exact same on-disk dependency-
 * optimization cache, each independently deciding it needed to
 * (re)optimize deps and racing the others to write/clear that shared
 * directory -- caught directly, not inferred, by reproducing the race
 * outside vitest entirely (a standalone script launching several
 * `createServer` calls against this same root) and observing `Error:
 * ENOTEMPTY: directory not empty, rmdir '.../node_modules/.vite/deps'`.
 * That race is a plausible source of the *assorted*, seemingly-unrelated
 * failures the intermittent run produced (whichever file's server happened
 * to be mid-request when the shared cache got rewritten out from under
 * it) -- CPU-throttling the page itself (via CDP's
 * `Emulation.setCPUThrottlingRate`, up to 8x, and separately running eight
 * real parallel instances of the same scenario) reproduced nothing, which
 * ruled out plain "the machine is slow" as the mechanism.
 *
 * The fix: every e2e file's dev server gets its own private `cacheDir`
 * (an OS temp directory, unique per server instance via `randomUUID()`) so
 * concurrent servers never share, and therefore never race on, the same
 * path. This is what makes the fix deterministic rather than a wider
 * timeout -- the underlying defect (concurrent writers to one shared
 * directory) is gone, not just given more time to not collide.
 */
export async function createIsolatedServer(root: string): Promise<ViteDevServer> {
  const cacheDir = join(tmpdir(), `sinsthesis-vite-e2e-${randomUUID()}`)
  return createServer({ root, configFile: false, cacheDir, server: { port: 0 } })
}

/**
 * Symmetric teardown for `createIsolatedServer`: closes the dev server and
 * removes its private cache directory, so a long-lived CI runner doesn't
 * accumulate one throwaway `os.tmpdir()` directory per e2e test file per
 * run. `server.config.cacheDir` is Vite's own resolved value -- reading it
 * back off the server rather than threading the path through every
 * caller's own state.
 */
export async function closeIsolatedServer(server: ViteDevServer | undefined): Promise<void> {
  if (!server) return
  const cacheDir = server.config.cacheDir
  await server.close()
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true })
}
