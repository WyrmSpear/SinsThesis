import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'

/**
 * Drives the real dev harness page (index.html + dev/main.ts) in an actual
 * Chromium tab, not vitest's own in-page browser project: this needs a
 * real Vite dev server and a real, trusted user gesture to satisfy the
 * browser's autoplay policy on `AudioContext` -- a JS-dispatched
 * `element.click()` or `dispatchEvent(new KeyboardEvent(...))` is not
 * trusted and would leave the context suspended, producing exactly the
 * "typechecks but makes no sound" failure this test exists to catch.
 * Playwright's `page.click()` / `page.keyboard.press()` issue real input
 * through the CDP Input domain, which Chromium does treat as trusted.
 *
 * This is why the file lives in its own "e2e" vitest project
 * (environment: 'node') rather than the "browser" project: it needs
 * `node:child_process`-level access (via `vite` and `playwright`) to spawn
 * a server and a browser, neither of which exists inside a sandboxed
 * browser tab.
 */

const root = fileURLToPath(new URL('../..', import.meta.url))

let server: ViteDevServer
let browser: Browser
let baseUrl: string

beforeAll(async () => {
  server = await createServer({ root, configFile: false, server: { port: 0 } })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('dev server did not report a port')
  baseUrl = `http://localhost:${address.port}`

  browser = await chromium.launch()
}, 30000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
})

describe('dev harness page', () => {
  it('makes sound on a real keydown and returns to silence on keyup', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await page.goto(baseUrl, { waitUntil: 'load' })

    const powerBtn = page.getByTestId('power')
    await powerBtn.waitFor({ state: 'visible' })
    await powerBtn.click()

    // The debug hook is attached once start() finishes building the graph.
    await page.waitForFunction(() => Boolean((window as unknown as { __sinsthesis?: unknown }).__sinsthesis))

    const app = page.getByTestId('app')
    await app.waitFor({ state: 'visible' })

    const silenceBefore = await page.evaluate(
      () => (window as unknown as { __sinsthesis: { rms(): number } }).__sinsthesis.rms(),
    )
    expect(silenceBefore).toBeLessThan(0.001)

    // Focus the page (power button already has it) and press a real key,
    // held, through CDP -- not a synthetic dispatchEvent.
    await page.keyboard.down('KeyA')

    // Default ADSR: attack 0.01s, decay 0.1s -- 300ms clears both stages
    // and lands comfortably in sustain.
    await page.waitForTimeout(300)
    const rmsHeld = await page.evaluate(
      () => (window as unknown as { __sinsthesis: { rms(): number } }).__sinsthesis.rms(),
    )
    expect(rmsHeld).toBeGreaterThan(0.02)

    await page.keyboard.up('KeyA')

    // The envelope decays geometrically toward 0 (src/engine/dsp/segment.ts,
    // envSample): level(t) = sustain * exp(-t / release), and the stage
    // only flips to 'idle' once that drops under its 0.001 "close enough"
    // floor. With the defaults (release 0.2s, sustain 0.7) that requires
    // t > release * ln(sustain / 0.001) = 0.2 * ln(700) ≈ 1.31s, not the
    // release time itself -- 2s clears it with margin for real-time jitter.
    await page.waitForTimeout(2000)
    const rmsAfterRelease = await page.evaluate(
      () => (window as unknown as { __sinsthesis: { rms(): number } }).__sinsthesis.rms(),
    )
    expect(rmsAfterRelease).toBeLessThan(0.001)

    console.log(
      `dev-page.test.ts RMS: silence(before)=${silenceBefore.toExponential(3)} ` +
        `held=${rmsHeld.toExponential(3)} silence(after release)=${rmsAfterRelease.toExponential(3)}`,
    )

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])

    await page.close()
  })
})
