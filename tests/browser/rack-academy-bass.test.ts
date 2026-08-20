import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'

/**
 * Drives the real rack page for the bass track, the academy's second
 * selectable sequence -- same real-Chromium, real-AudioContext pattern as
 * rack-academy.test.ts (which proved the main track is reachable from the
 * UI) and rack-academy-constrained.test.ts (which proved constrained-
 * challenge's live counter and offline-gated Check). What's unique to this
 * file: that a track picker exists and actually switches which level list
 * is shown (Section: "design how tracks are presented and selected"), that
 * a player can jump straight into the bass track without completing the
 * main track first, and that both grading modes the bass track uses
 * (build and constrained) work end to end on real levels.
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
  // Taller than rack-academy.test.ts's own 1150px: this file's academy
  // panel carries an extra row (the track picker) above the level list and
  // brief, which pushes the rack itself further down the page -- at 1150px
  // a freshly-added module's jacks can land below the viewport's bottom
  // edge, where `page.mouse.move` (unlike locator actions) never
  // auto-scrolls to reach them, and a drag silently lands on nothing.
  await page.setViewportSize({ width: 2000, height: 1500 })
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

async function addFromPalette(page: Page, type: string): Promise<void> {
  await page.getByTestId('palette-toggle').click()
  await page.getByTestId(`palette-add-${type}`).click()
}

async function setParam(page: Page, moduleId: string, paramId: string, value: number): Promise<void> {
  await page.evaluate(
    ({ moduleId, paramId, value }) => {
      const hook = (window as unknown as { __sinsthesis: { graph: { setParam(id: string, p: string, v: number): void } } }).__sinsthesis
      hook.graph.setParam(moduleId, paramId, value)
    },
    { moduleId, paramId, value },
  )
}

describe('academy: bass track', () => {
  it('the track picker switches from the main track to the bass track, and back', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)
    await enterAcademy(page)

    // Entering the academy for the first time defaults to the main track's
    // first level.
    expect(await page.getByTestId('academy-brief').textContent()).toContain('First Sound')
    expect(await page.getByTestId('academy-level-01-first-sound').isVisible()).toBe(true)
    expect(await page.getByTestId('academy-level-bass-01-layers').count()).toBe(0)

    await page.getByTestId('academy-track-bass').click()
    await page.waitForTimeout(150)

    // Switching tracks drops into that track's own first level, and the
    // level list now shows only that track's levels.
    expect(await page.getByTestId('academy-brief').textContent()).toContain('Layer Two Basses')
    expect(await page.getByTestId('academy-level-bass-01-layers').isVisible()).toBe(true)
    expect(await page.getByTestId('academy-level-01-first-sound').count()).toBe(0)

    await page.getByTestId('academy-track-main').click()
    await page.waitForTimeout(150)
    expect(await page.getByTestId('academy-level-01-first-sound').isVisible()).toBe(true)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })

  it('a player can jump straight into the bass track without completing the main track first', async () => {
    const page: Page = await browser.newPage()
    await powerOn(page)
    await enterAcademy(page)
    await page.getByTestId('academy-track-bass').click()
    await page.waitForTimeout(150)

    const level1 = page.getByTestId('academy-level-bass-01-layers')
    expect(await level1.isDisabled()).toBe(false)
    const level2 = page.getByTestId('academy-level-bass-02-reese')
    expect(await level2.isDisabled()).toBe(true) // locked until bass-01 is complete

    await page.close()
  })

  it('bass-01-layers: an unwired patch fails Check, then layering two VCOs through a Mixer passes and unlocks the next level', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)
    await enterAcademy(page)
    await page.getByTestId('academy-track-bass').click()
    await page.getByTestId('academy-brief').waitFor({ state: 'visible' })

    // Add every granted module, but leave them unpatched.
    await addFromPalette(page, 'vco')
    await addFromPalette(page, 'vco')
    await addFromPalette(page, 'mixer')
    await addFromPalette(page, 'output')

    await page.getByTestId('academy-check').click()
    const feedback = page.getByTestId('academy-feedback')
    await feedback.waitFor({ state: 'visible' })
    expect(await feedback.getAttribute('class')).toContain('academy-feedback-fail')

    // Wire it: two VCOs into the Mixer's first two inputs, Mixer out to Output.
    await dragCable(page, 'jack-vco-1-out', 'jack-mixer-1-in1')
    await dragCable(page, 'jack-vco-2-out', 'jack-mixer-1-in2')
    await dragCable(page, 'jack-mixer-1-out', 'jack-output-1-in')

    await page.getByTestId('academy-check').click()
    await page.waitForTimeout(100)
    expect(await feedback.getAttribute('class')).toContain('academy-feedback-pass')
    expect(await feedback.textContent()).toContain('Level complete')

    const level2 = page.getByTestId('academy-level-bass-02-reese')
    expect(await level2.isDisabled()).toBe(false)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })

  it('bass-05-finish: the module counter tracks the budget, a boop without pitch-drop fails, and the fixed patch passes', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await page.addInitScript((completed: string[]) => {
      localStorage.setItem('sinsthesis:academy-progress:v1', JSON.stringify({ completed, currentTrack: 'bass' }))
    }, ['bass-01-layers', 'bass-02-reese', 'bass-03-wobble', 'bass-04-growl'])

    await powerOn(page)
    await enterAcademy(page)
    await page.getByTestId('academy-level-bass-05-finish').click()
    await page.getByTestId('academy-brief').waitFor({ state: 'visible' })

    const counter = page.getByTestId('academy-module-counter')
    await counter.waitFor({ state: 'visible' })
    expect(await counter.textContent()).toContain('Modules: 0 / 3')

    await addFromPalette(page, 'vco')
    await addFromPalette(page, 'adsr')
    await addFromPalette(page, 'vca')
    await addFromPalette(page, 'output')
    await expect.poll(async () => await counter.textContent()).toContain('Modules: 3 / 3')

    await dragCable(page, 'jack-vco-1-out', 'jack-vca-1-in')
    await dragCable(page, 'jack-adsr-1-out', 'jack-vca-1-cv')
    await dragCable(page, 'jack-vca-1-out', 'jack-output-1-in')

    await setParam(page, 'vco-1', 'octave', -3)
    await setParam(page, 'vco-1', 'shape', 3)
    await setParam(page, 'vco-1', 'fmAmount', 0) // <- the miss: no pitch envelope
    await setParam(page, 'adsr-1', 'attack', 0.002)
    await setParam(page, 'adsr-1', 'decay', 0.4)
    await setParam(page, 'adsr-1', 'sustain', 0)
    await setParam(page, 'adsr-1', 'release', 0.2)
    await setParam(page, 'vca-1', 'level', 0)
    await setParam(page, 'vca-1', 'cvAmount', 1)

    const checkBtn = page.getByTestId('academy-check')
    await checkBtn.click()
    await expect.poll(async () => await checkBtn.textContent()).toContain('Check my patch')

    const feedback = page.getByTestId('academy-feedback')
    await feedback.waitFor({ state: 'visible' })
    expect(await feedback.getAttribute('class')).toContain('academy-feedback-fail')
    expect(await feedback.textContent()).toMatch(/pitch|FM/i)

    // Patch the same envelope into the VCO's FM jack and turn FM up -- the
    // fix the feedback itself names.
    await dragCable(page, 'jack-adsr-1-out', 'jack-vco-1-fm')
    await setParam(page, 'vco-1', 'fmAmount', 2.5)

    await checkBtn.click()
    await expect.poll(async () => await checkBtn.textContent()).toContain('Check my patch')
    await expect.poll(async () => await feedback.textContent()).toContain('Level complete')
    expect(await feedback.getAttribute('class')).toContain('academy-feedback-pass')

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })
})
