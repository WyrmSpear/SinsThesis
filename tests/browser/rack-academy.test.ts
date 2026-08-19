import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'

/**
 * Drives the real rack page in an actual Chromium tab, same pattern and
 * reasons as rack-page.test.ts: a real user gesture for the AudioContext,
 * real pointer events for a cable drag, and a real localStorage for
 * progress persistence across an actual page reload -- nothing here is
 * simulated.
 *
 * What this proves that tests/node/academy-levels.test.ts cannot: that the
 * academy is reachable from the rack UI at all (Section 3's "academy mode
 * in the rack"), that entering a level really does filter the palette
 * (Section 12's "a level can grant four modules and withhold the rest"),
 * that a failed Check surfaces player-facing feedback rather than a bare
 * score (Section 4: "show the miss") -- built by academy/feedback.ts from
 * `inspect`'s structured result, in the module names and port labels the
 * brief itself uses, not `inspect`'s own engine-facing id sentence -- and
 * that completing a level persists and unlocks the next one across a
 * reload.
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
  await page.waitForTimeout(200)
}

async function enterAcademy(page: Page): Promise<void> {
  await page.getByTestId('mode-academy').click()
  await page.getByTestId('academy-panel').waitFor({ state: 'visible' })
  await page.getByTestId('academy-brief').waitFor({ state: 'visible' })
}

/** Drags a real cable from one jack to another, mirroring rack-page.test.ts's
 *  own drag technique -- a midpoint move first, since pointer-capture-driven
 *  drags in this app read every pointermove and a single jump can land
 *  before the drag-preview element exists. */
async function dragCable(page: Page, fromTestId: string, toTestId: string): Promise<void> {
  const source = page.getByTestId(fromTestId)
  const target = page.getByTestId(toTestId)
  await source.waitFor({ state: 'visible' })
  await target.waitFor({ state: 'visible' })
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) throw new Error('jack has no bounding box')
  const sx = sourceBox.x + sourceBox.width / 2
  const sy = sourceBox.y + sourceBox.height / 2
  const tx = targetBox.x + targetBox.width / 2
  const ty = targetBox.y + targetBox.height / 2

  await page.mouse.move(sx, sy)
  await page.mouse.down()
  await page.mouse.move((sx + tx) / 2, (sy + ty) / 2, { steps: 5 })
  await page.mouse.move(tx, ty, { steps: 5 })
  await page.mouse.up()
}

describe('academy mode', () => {
  it('entering level one filters the palette to only its granted modules', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)
    await enterAcademy(page)

    expect(await page.getByTestId('academy-brief').textContent()).toContain('First Sound')

    await page.getByTestId('palette-toggle').click()
    await page.getByTestId('palette-drawer').waitFor({ state: 'visible' })

    // Level one grants only vco + output -- every other registered module
    // (the palette otherwise lists fifteen) must be withheld.
    expect(await page.getByTestId('palette-add-vco').isVisible()).toBe(true)
    expect(await page.getByTestId('palette-add-output').isVisible()).toBe(true)
    expect(await page.getByTestId('palette-add-noise').count()).toBe(0)
    expect(await page.getByTestId('palette-add-vcf').count()).toBe(0)
    expect(await page.getByTestId('palette-add-sequencer').count()).toBe(0)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })

  it('an incomplete patch fails Check with player-facing feedback, and the right patch passes', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)
    await enterAcademy(page)

    // Add both modules the level grants, but leave them unpatched.
    await page.getByTestId('palette-toggle').click()
    await page.getByTestId('palette-add-vco').click()
    await page.getByTestId('palette-toggle').click()
    await page.getByTestId('palette-add-output').click()

    await page.getByTestId('academy-check').click()
    const feedback = page.getByTestId('academy-feedback')
    await feedback.waitFor({ state: 'visible' })
    expect(await feedback.getAttribute('class')).toContain('academy-feedback-fail')
    // Player-facing text -- module display names and port labels, the
    // words the brief itself used, not `inspect`'s own id-based sentence
    // and not a bare score.
    expect(await feedback.textContent()).toContain(
      `patch the VCO's "Out" jack into the Output's "In" jack`,
    )
    expect(await feedback.textContent()).not.toMatch(/vco-1|output-1/)

    // The failing module panels are visibly flagged.
    expect(await page.locator('.module-panel-flag-miss').count()).toBeGreaterThan(0)

    // Now actually patch it: vco.out -> output.in.
    await dragCable(page, 'jack-vco-1-out', 'jack-output-1-in')

    await page.getByTestId('academy-check').click()
    await page.waitForTimeout(100)
    expect(await feedback.getAttribute('class')).toContain('academy-feedback-pass')
    expect(await feedback.textContent()).toContain('Level complete')

    // The flag clears on a pass.
    expect(await page.locator('.module-panel-flag-miss').count()).toBe(0)

    // Completing level one unlocks level two.
    const level2 = page.getByTestId('academy-level-02-shape-it')
    expect(await level2.isDisabled()).toBe(false)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })

  it('progress persists across a reload, and free play is untouched by academy edits', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)

    // Free play's own starter patch, before ever touching the academy.
    const freePlayModuleCount = (await page.evaluate(
      () => (window as unknown as { __sinsthesis: { graph: { moduleIds: readonly string[] } } })
        .__sinsthesis.graph.moduleIds.length,
    )) as number
    expect(freePlayModuleCount).toBe(7) // the seven-module starter patch

    await enterAcademy(page)
    await page.getByTestId('palette-toggle').click()
    await page.getByTestId('palette-add-vco').click()
    await page.getByTestId('palette-toggle').click()
    await page.getByTestId('palette-add-output').click()
    await dragCable(page, 'jack-vco-1-out', 'jack-output-1-in')
    await page.getByTestId('academy-check').click()
    await page.getByTestId('academy-feedback').waitFor({ state: 'visible' })

    // Leaving the academy restores free play exactly as it was -- "a mode,
    // not a replacement" -- rather than leaving the level's two modules
    // sitting in what free play sees.
    await page.getByTestId('mode-freeplay').click()
    await page.waitForTimeout(100)
    const restoredModuleCount = (await page.evaluate(
      () => (window as unknown as { __sinsthesis: { graph: { moduleIds: readonly string[] } } })
        .__sinsthesis.graph.moduleIds.length,
    )) as number
    expect(restoredModuleCount).toBe(freePlayModuleCount)

    // Reload the whole page: a fresh AudioContext, fresh in-memory state,
    // only localStorage survives -- exactly what "persists across a
    // reload" has to mean.
    await powerOn(page)
    await enterAcademy(page)

    const level1 = page.getByTestId('academy-level-01-first-sound')
    expect(await level1.getAttribute('class')).toContain('academy-level-complete')
    const level2 = page.getByTestId('academy-level-02-shape-it')
    expect(await level2.isDisabled()).toBe(false)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })
})
