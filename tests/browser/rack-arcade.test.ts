import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'

/**
 * Rack-level proof for ROADMAP 3a's pan-paddle prototype
 * (rack/arcade-panel.ts, wired into rack/main.ts as a third top-level
 * mode). Same real-Chromium-tab pattern as rack-scope.test.ts and for the
 * same reason: this suite exists to prove the *live* stereo-balance tap
 * moves the paddle and a *live* rAF-driven collision registers, not that
 * the pure logic in arcade/game.ts is correct in isolation --
 * tests/node/arcade-game.test.ts already covers that half with no DOM or
 * Web Audio involved at all.
 *
 * Two things proved here:
 * 1. Changing the *measured stereo output* (not a knob value read
 *    directly) moves the paddle -- driven through a real Panner module
 *    patched into a real Output, read back off `arcade-display`'s
 *    `data-paddle-x` hook (rack/arcade-panel.ts's own test instrumentation
 *    comment explains why a dataset number instead of a pixel diff).
 * 2. A real block, falling in the real rAF loop, registers a catch against
 *    `arcade-hud`'s `data-score` -- driven by patching an LFO into the
 *    Panner's CV jack so the paddle sweeps the whole playfield while a
 *    block falls, the same modulation path the design brief calls out as
 *    the interesting way to play this game (rack/arcade-panel.ts's header
 *    comment).
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

async function paddleX(page: Page): Promise<number> {
  const value = await page.getByTestId('arcade-display').getAttribute('data-paddle-x')
  if (value === null) throw new Error('arcade-display has no data-paddle-x yet')
  return Number(value)
}

async function score(page: Page): Promise<number> {
  const value = await page.getByTestId('arcade-hud').getAttribute('data-score')
  return value === null ? 0 : Number(value)
}

describe('rack arcade (pan paddle)', () => {
  it('is reachable as a third top-level mode, alongside the rack it leaves visible', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)
    await page.getByTestId('mode-arcade').click()
    await page.waitForTimeout(100)

    expect(await page.getByTestId('arcade-panel').isVisible()).toBe(true)
    expect(await page.getByTestId('arcade-display').isVisible()).toBe(true)
    // The rack itself -- the starter patch's modules -- stays mounted and
    // visible underneath: Arcade is an overlay on free play, not a
    // replacement of it (ROADMAP 3a: "the rack does not disappear").
    expect(await page.getByTestId('rack-modules').isVisible()).toBe(true)
    const starterKeyboard = await firstIdOfType(page, 'keyboard')
    expect(await page.locator(`.module-panel[data-module="${starterKeyboard}"]`).isVisible()).toBe(true)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  }, 20000)

  it('the paddle follows a real measured change in stereo output position', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)
    await addModule(page, 'vco')
    await addModule(page, 'panner')
    const vcoId = await firstIdOfType(page, 'vco')
    const pannerId = await firstIdOfType(page, 'panner')
    const outputId = await firstIdOfType(page, 'output')

    // A continuously-droning tone (VCO free-runs with no gate needed)
    // routed through the Panner and into the rack's existing Output --
    // additively alongside the starter patch's own (silent, ungated) VCA
    // cable, which is exactly how a player would add a Panner to an
    // existing patch rather than building a dedicated test rig.
    await dragJackToJack(page, `jack-${vcoId}-out`, `jack-${pannerId}-in`)
    await dragJackToJack(page, `jack-${pannerId}-out`, `jack-${outputId}-in`)

    await page.getByTestId('mode-arcade').click()
    await page.getByTestId('arcade-display').waitFor({ state: 'visible' })
    // Let the balance tap and a few rAF frames settle on "centered."
    await page.waitForTimeout(300)
    const centered = await paddleX(page)

    await setParam(page, pannerId, 'pan', -1)
    await page.waitForTimeout(400)
    const left = await paddleX(page)

    await setParam(page, pannerId, 'pan', 1)
    await page.waitForTimeout(400)
    const right = await paddleX(page)

    // 420px-wide playfield: centered should sit near the middle, hard-left
    // should read well left of center, hard-right well right of it. Not
    // exact-pixel -- the follow-smoothing in arcade/game.ts's
    // `paddleFollow` deliberately never snaps instantly -- just clearly
    // responsive to the real measured change.
    expect(centered).toBeGreaterThan(150)
    expect(centered).toBeLessThan(270)
    expect(left).toBeLessThan(centered - 50)
    expect(right).toBeGreaterThan(centered + 50)
    expect(right).toBeGreaterThan(left)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  }, 20000)

  it('a real falling block registers a catch when the paddle sweeps under it', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)
    await addModule(page, 'vco')
    await addModule(page, 'panner')
    await addModule(page, 'lfo')
    const vcoId = await firstIdOfType(page, 'vco')
    const pannerId = await firstIdOfType(page, 'panner')
    const outputId = await firstIdOfType(page, 'output')
    const lfoId = await firstIdOfType(page, 'lfo')

    await dragJackToJack(page, `jack-${vcoId}-out`, `jack-${pannerId}-in`)
    await dragJackToJack(page, `jack-${pannerId}-out`, `jack-${outputId}-in`)
    // The interesting way to play this game: modulation, not direct
    // manipulation. The LFO sweeps the Panner's CV fast enough that the
    // paddle crosses the whole 420px playfield well within the several
    // seconds a block takes to fall, so a real spawn (at whatever x the
    // game's own rng picks) is virtually guaranteed a pass under the
    // paddle before it reaches the bottom.
    await dragJackToJack(page, `jack-${lfoId}-out`, `jack-${pannerId}-panCv`)
    await setParam(page, lfoId, 'rate', 0.6)
    await setParam(page, lfoId, 'depth', 1)
    await setParam(page, pannerId, 'pan', 0)

    await page.getByTestId('mode-arcade').click()
    await page.getByTestId('arcade-display').waitFor({ state: 'visible' })

    // Poll for a nonzero score rather than a fixed sleep -- the first
    // spawn's exact x is randomized (arcade/game.ts's `spawnBlock`), so
    // this waits for whichever sweep actually intercepts it instead of
    // asserting a specific timing.
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="arcade-hud"]')
        return el instanceof HTMLElement && Number(el.dataset['score'] ?? '0') > 0
      },
      undefined,
      { timeout: 15000, polling: 100 },
    )

    expect(await score(page)).toBeGreaterThan(0)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  }, 25000)
})
