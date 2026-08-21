import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { ViteDevServer } from 'vite'
import { createIsolatedServer, closeIsolatedServer } from './support/e2e-server'
import { chromium, type Browser, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'

/**
 * Rack-level proof for ROADMAP 3a's second arcade prototype, the wub
 * disruptor (`rack/wub-panel.ts`, `arcade/wub-game.ts`,
 * `arcade/rate-detect.ts`, wired into rack/main.ts as a second selectable
 * game inside Arcade mode alongside the pan paddle). Same real-Chromium-tab
 * pattern as `tests/browser/rack-arcade.test.ts`, for the same reason: this
 * suite exists to prove the *live* parallel analyser tap, the real
 * autocorrelation-based rate detector, and a real rAF-driven target
 * lifecycle all work end to end -- `tests/node/arcade-wub-game.test.ts` and
 * `tests/node/arcade-rate-detect.test.ts` already cover the pure logic in
 * isolation, and `tests/browser/wub-rate-detect.test.ts` already proves the
 * detector against real offline-rendered DSP; what's new here is that a
 * player patching a real LFO into a real VCF's cutoff CV, live, in the rack,
 * actually destroys a target.
 */

const root = fileURLToPath(new URL('../..', import.meta.url))

let server: ViteDevServer
let browser: Browser
let baseUrl: string

beforeAll(async () => {
  server = await createIsolatedServer(root)
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('dev server did not report a port')
  baseUrl = `http://localhost:${address.port}`

  browser = await chromium.launch()
}, 30000)

afterAll(async () => {
  await browser?.close()
  await closeIsolatedServer(server)
})

async function powerOn(page: Page): Promise<void> {
  await page.setViewportSize({ width: 2000, height: 1150 })
  await page.goto(baseUrl + '/', { waitUntil: 'load' })
  const powerBtn = page.getByTestId('power')
  await powerBtn.waitFor({ state: 'visible' })
  await powerBtn.click()
  await page.waitForFunction(() => Boolean((window as unknown as { __sinsthesis?: unknown }).__sinsthesis))
  const app = page.getByTestId('app')
  await app.waitFor({ state: 'visible' })
  await page.waitForTimeout(250)
}

async function addModule(page: Page, type: string): Promise<void> {
  await page.getByTestId('palette-toggle').click()
  await page.getByTestId(`palette-add-${type}`).click()
  await page.waitForTimeout(50)
}

async function dragJackToJack(page: Page, fromTestId: string, toTestId: string): Promise<void> {
  const from = page.getByTestId(fromTestId)
  const to = page.getByTestId(toTestId)
  await from.waitFor({ state: 'visible' })
  await to.waitFor({ state: 'visible' })
  const fromBox = await from.boundingBox()
  const toBox = await to.boundingBox()
  if (!fromBox || !toBox) throw new Error('jack has no bounding box')
  const sx = fromBox.x + fromBox.width / 2
  const sy = fromBox.y + fromBox.height / 2
  const tx = toBox.x + toBox.width / 2
  const ty = toBox.y + toBox.height / 2
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  await page.mouse.move((sx + tx) / 2, (sy + ty) / 2, { steps: 5 })
  await page.mouse.move(tx, ty, { steps: 5 })
  await page.mouse.up()
}

type GraphHandle = {
  moduleIds: readonly string[]
  getType(id: string): string
  setParam(id: string, param: string, value: number, atTime?: number): void
}

async function firstIdOfType(page: Page, type: string): Promise<string> {
  return page.evaluate((t) => {
    const g = (window as unknown as { __sinsthesis: { graph: GraphHandle } }).__sinsthesis.graph
    const id = g.moduleIds.find((m) => g.getType(m) === t)
    if (!id) throw new Error(`no module of type "${t}"`)
    return id
  }, type)
}

async function setParam(page: Page, moduleId: string, param: string, value: number): Promise<void> {
  await page.evaluate(
    ({ moduleId, param, value }) => {
      const win = window as unknown as { __sinsthesis: { graph: GraphHandle; ctx: AudioContext } }
      win.__sinsthesis.graph.setParam(moduleId, param, value, win.__sinsthesis.ctx.currentTime)
    },
    { moduleId, param, value },
  )
}

async function score(page: Page): Promise<number> {
  const value = await page.getByTestId('wub-hud').getAttribute('data-score')
  return value === null ? 0 : Number(value)
}

async function targetHz(page: Page): Promise<number | undefined> {
  const value = await page.getByTestId('wub-display').getAttribute('data-target-hz')
  return value === null || value === '' ? undefined : Number(value)
}

describe('rack wub disruptor', () => {
  it('is reachable via the game picker inside Arcade mode, alongside the pan paddle', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)
    await page.getByTestId('mode-arcade').click()
    await page.waitForTimeout(100)
    // Defaults to the pan paddle -- the first-shipped game keeps its place
    // as the default so returning players see the game they already know.
    expect(await page.getByTestId('arcade-display').isVisible()).toBe(true)

    await page.getByTestId('wub-game-wub').click()
    await page.waitForTimeout(100)
    expect(await page.getByTestId('wub-display').isVisible()).toBe(true)
    expect(await page.getByTestId('wub-hud').isVisible()).toBe(true)
    // The rack itself stays mounted underneath, same "overlay, not a
    // replacement" claim rack-arcade.test.ts makes for the paddle.
    expect(await page.getByTestId('rack-modules').isVisible()).toBe(true)

    // And switching back to the paddle tears the wub loop down cleanly --
    // no leftover console errors from two rAF loops/analyser taps racing.
    await page.getByTestId('wub-game-paddle').click()
    await page.waitForTimeout(100)
    expect(await page.getByTestId('arcade-display').isVisible()).toBe(true)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  }, 20000)

  it('a real LFO-modulated filter cutoff, tuned to a spawned target\'s own rate, destroys it', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)
    await addModule(page, 'vco')
    await addModule(page, 'vcf')
    await addModule(page, 'lfo')
    const vcoId = await firstIdOfType(page, 'vco')
    const vcfId = await firstIdOfType(page, 'vcf')
    const lfoId = await firstIdOfType(page, 'lfo')
    const outputId = await firstIdOfType(page, 'output')

    // A continuously-droning tone (VCO free-runs, no gate needed) through
    // a filter whose cutoff the LFO modulates -- the exact technique the
    // preset bank's own "Tempo-Locked Wobble" entry teaches
    // (academy/levels/bass-03-wobble.sinp), wired by hand here instead of
    // loaded from the bank so the LFO's rate can be set to match whatever
    // target actually spawns (see below).
    await dragJackToJack(page, `jack-${vcoId}-out`, `jack-${vcfId}-in`)
    await dragJackToJack(page, `jack-${vcfId}-out`, `jack-${outputId}-in`)
    await dragJackToJack(page, `jack-${lfoId}-out`, `jack-${vcfId}-cutoffCv`)
    await setParam(page, vcfId, 'cutoff', 500)
    await setParam(page, vcfId, 'cutoffCvAmount', 4.5)
    await setParam(page, lfoId, 'shape', 3) // sine
    await setParam(page, lfoId, 'depth', 1)

    await page.getByTestId('mode-arcade').click()
    await page.getByTestId('wub-game-wub').click()
    await page.getByTestId('wub-display').waitFor({ state: 'visible' })

    // Wait for a target to actually be on screen, then read its own
    // required rate and dial the LFO to match exactly -- deterministic,
    // rather than trying to guess or sweep across the whole target set the
    // way rack-arcade.test.ts's LFO-sweep trick worked for the paddle
    // (that trick doesn't generalize here: a wrong rate doesn't just miss
    // spatially, it reads as a *different, wrong* measurement).
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="wub-display"]')
        return el instanceof HTMLElement && (el.dataset['targetHz'] ?? '') !== ''
      },
      undefined,
      { timeout: 5000, polling: 100 },
    )
    const hz = await targetHz(page)
    if (hz === undefined) throw new Error('no target spawned')
    await setParam(page, lfoId, 'rate', hz)

    // Poll for a nonzero score. Generous timeout: arcade/wub-game.ts's own
    // lifetimeMs already budgets for the detector's window-fill time plus
    // sustained-charge time per target, and the slowest rate in the game's
    // requiredRatesHz (1 Hz) needs the most of both -- see that file's
    // header comment for why this is a real physical floor, not slack to
    // trim.
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="wub-hud"]')
        return el instanceof HTMLElement && Number(el.dataset['score'] ?? '0') > 0
      },
      undefined,
      { timeout: 20000, polling: 200 },
    )

    expect(await score(page)).toBeGreaterThan(0)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  }, 30000)
})
