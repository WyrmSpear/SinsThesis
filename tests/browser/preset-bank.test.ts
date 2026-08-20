import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'
import { PRESET_BANK } from '../../presets/bank'

/**
 * Drives the real rack page in an actual Chromium tab, same pattern as
 * rack-page.test.ts and for the same reason: a real user gesture is what
 * satisfies the browser's autoplay gate on `AudioContext`, so this is the
 * only way to prove a preset actually produces audio, not just that it
 * loaded into the DOM without erroring.
 *
 * The claim under test is the patch bank's own headline promise --
 * "immediately playable... a patch that needs three knob turns before it
 * makes a sound has failed" -- so this asserts with the audio-thread tap
 * (`__sinsthesis.rms()`, the same hook rack-page.test.ts's own "makes sound
 * on a real keydown" test uses) rather than any DOM state: an `AudioNode`
 * graph can be fully wired and still silent (a closed VCA, an unpatched
 * cable), and only reading real samples off the output's analyser proves
 * otherwise.
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

interface DebugHook {
  graph: { moduleIds: readonly string[] }
  rms(): number
}

async function powerOn(page: Page): Promise<void> {
  await page.setViewportSize({ width: 2000, height: 1150 })
  await page.goto(baseUrl + '/', { waitUntil: 'load' })
  const powerBtn = page.getByTestId('power')
  await powerBtn.waitFor({ state: 'visible' })
  await powerBtn.click()
  await page.waitForFunction(() => Boolean((window as unknown as { __sinsthesis?: unknown }).__sinsthesis))
  const app = page.getByTestId('app')
  await app.waitFor({ state: 'visible' })
  await page.waitForTimeout(200)
}

function rmsOf(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __sinsthesis: DebugHook }).__sinsthesis.rms())
}

describe('patch bank', () => {
  it('the toolbar button opens a drawer listing every bank entry', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)

    const drawer = page.getByTestId('preset-bank-drawer')
    expect(await drawer.isHidden()).toBe(true)
    await page.getByTestId('preset-bank-toggle').click()
    await drawer.waitFor({ state: 'visible' })

    for (const preset of PRESET_BANK) {
      expect(await page.getByTestId(`preset-entry-${preset.id}`).isVisible()).toBe(true)
    }

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })

  for (const preset of PRESET_BANK) {
    it(`"${preset.name}" produces audio the instant it loads, with no further interaction`, async () => {
      const page: Page = await browser.newPage()
      const consoleErrors: string[] = []
      page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
      page.on('pageerror', (err) => consoleErrors.push(String(err)))

      await powerOn(page)

      await page.getByTestId('preset-bank-toggle').click()
      await page.getByTestId(`preset-entry-${preset.id}`).waitFor({ state: 'visible' })
      await page.getByTestId(`preset-load-${preset.id}`).click()

      // The drawer closes itself on load -- also proves the click actually
      // landed rather than silently missing the button.
      await expect.poll(() => page.getByTestId('preset-bank-drawer').isHidden()).toBe(true)

      const moduleIds = await page.evaluate(
        () => (window as unknown as { __sinsthesis: DebugHook }).__sinsthesis.graph.moduleIds,
      )
      expect(moduleIds.length).toBe(preset.file.modules.length)

      // No keypress, no click, no knob turn -- just wait, then read the
      // real audio-thread tap. Long enough to cross even the slower
      // self-triggering presets' own clock period (808 Sub's is ~0.83s).
      await page.waitForTimeout(1200)
      const level = await rmsOf(page)
      expect(level, `"${preset.name}" is silent ${1200}ms after loading`).toBeGreaterThan(0.01)

      expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
      await page.close()
    })
  }

  it('loading a preset replaces the previous patch, not merges with it', async () => {
    const page: Page = await browser.newPage()
    await powerOn(page)

    const starterCount = (
      await page.evaluate(() => (window as unknown as { __sinsthesis: DebugHook }).__sinsthesis.graph.moduleIds)
    ).length

    const reese = PRESET_BANK.find((p) => p.id === 'reese')!
    await page.getByTestId('preset-bank-toggle').click()
    await page.getByTestId(`preset-load-${reese.id}`).click()
    await page.waitForTimeout(200)

    const afterLoad = await page.evaluate(
      () => (window as unknown as { __sinsthesis: DebugHook }).__sinsthesis.graph.moduleIds,
    )
    expect(afterLoad.length).toBe(reese.file.modules.length)
    expect(afterLoad.length).not.toBe(starterCount)

    await page.close()
  })
})
