import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { ViteDevServer } from 'vite'
import { createIsolatedServer, closeIsolatedServer } from './support/e2e-server'
import { chromium, type Browser, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'

/**
 * Drives the real rack page for constrained-challenge, the academy's third
 * grading mode -- same real-Chromium, real-AudioContext pattern as
 * rack-academy.test.ts (build-this-patch) and rack-match-sound.test.ts
 * (match-this-sound). Proves the two things unique to this mode that no
 * automated real-DSP test can, because they live in the UI, not the
 * grader: the live module counter tracks every add/remove and flags going
 * over the limit *before* a Check (Section: "show the player their count
 * against the limit while they build, or they will not know they have
 * broken the rule until they check"), and a real Check on a real patch
 * passes or fails with player-facing feedback naming an actual property,
 * never a bare number -- the same bar match-this-sound was held to.
 * tests/browser/analysis/rubric-render.test.ts already proves the grader
 * itself (structural + feature bounds) against real DSP; this proves the
 * UI wired on top of it.
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

const LEVELS_BEFORE_THUMP = [
  '01-first-sound', '02-shape-it', '03-play-notes', '04-modulate', '05-resonance',
  '06-match-pluck', '07-match-waveform', '08-match-resonance',
]

async function powerOnWithThumpUnlocked(page: Page): Promise<void> {
  await page.addInitScript((completed: string[]) => {
    localStorage.setItem('sinsthesis:academy-progress:v1', JSON.stringify({ completed }))
  }, LEVELS_BEFORE_THUMP)

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

async function enterLevel(page: Page, levelId: string): Promise<void> {
  await page.getByTestId('mode-academy').click()
  await page.getByTestId('academy-panel').waitFor({ state: 'visible' })
  await page.getByTestId(`academy-level-${levelId}`).click()
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

/** Same technique as rack-match-sound.test.ts's own `setParam`: precise,
 *  where hitting an exact target value via simulated pixel-drag math would
 *  not be, and what's graded is the graph's live param state at Check
 *  time, not how a value got there. */
async function setParam(page: Page, moduleId: string, paramId: string, value: number): Promise<void> {
  await page.evaluate(
    ({ moduleId, paramId, value }) => {
      const hook = (window as unknown as { __sinsthesis: { graph: { setParam(id: string, p: string, v: number): void } } }).__sinsthesis
      hook.graph.setParam(moduleId, paramId, value)
    },
    { moduleId, paramId, value },
  )
}

describe('academy: constrained-challenge', () => {
  it('the module counter tracks every add live and flags going over the limit', async () => {
    const page: Page = await browser.newPage()
    await powerOnWithThumpUnlocked(page)
    await enterLevel(page, '09-thump')

    const counter = page.getByTestId('academy-module-counter')
    await counter.waitFor({ state: 'visible' })
    expect(await counter.textContent()).toContain('Modules: 0 / 3')
    expect(await counter.getAttribute('class')).not.toContain('academy-module-counter-over')

    await addFromPalette(page, 'vco')
    await addFromPalette(page, 'adsr')
    await addFromPalette(page, 'vca')
    await expect.poll(async () => await counter.textContent()).toContain('Modules: 3 / 3')
    expect(await counter.getAttribute('class')).not.toContain('academy-module-counter-over')

    // Output never counts against the budget (inspector.ts's own rule).
    await addFromPalette(page, 'output')
    await expect.poll(async () => await counter.textContent()).toContain('Modules: 3 / 3')

    // A fourth real module pushes it over -- the counter should say so
    // before the player ever presses Check.
    await addFromPalette(page, 'vco')
    await expect.poll(async () => await counter.textContent()).toContain('Modules: 4 / 3')
    expect(await counter.textContent()).toContain('over the limit')
    await expect.poll(async () => await counter.getAttribute('class')).toContain('academy-module-counter-over')

    await page.close()
  })

  it('a patch missing the pitch envelope fails naming the right property, then the fixed patch passes and unlocks the next level', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOnWithThumpUnlocked(page)
    await enterLevel(page, '09-thump')

    // Correct topology and amplitude envelope, but no pitch envelope at
    // all (a plausible half-finished "boop": the player patched the VCA's
    // envelope and stopped there) -- exactly the kind of near-miss this
    // mode's feedback has to name specifically, not just fail silently.
    await addFromPalette(page, 'vco')
    await addFromPalette(page, 'adsr')
    await addFromPalette(page, 'vca')
    await addFromPalette(page, 'output')
    await dragCable(page, 'jack-vco-1-out', 'jack-vca-1-in')
    await dragCable(page, 'jack-adsr-1-out', 'jack-vca-1-cv')
    await dragCable(page, 'jack-vca-1-out', 'jack-output-1-in')

    await setParam(page, 'vco-1', 'octave', -3)
    await setParam(page, 'vco-1', 'shape', 3)
    await setParam(page, 'vco-1', 'fmAmount', 0) // <- the miss: no pitch envelope
    await setParam(page, 'adsr-1', 'attack', 0.002)
    await setParam(page, 'adsr-1', 'decay', 0.15)
    await setParam(page, 'adsr-1', 'sustain', 0)
    await setParam(page, 'adsr-1', 'release', 0.05)
    await setParam(page, 'vca-1', 'level', 0)
    await setParam(page, 'vca-1', 'cvAmount', 1)

    const checkBtn = page.getByTestId('academy-check')
    await checkBtn.click()
    await expect.poll(async () => await checkBtn.textContent()).toContain('Check my patch')

    const feedback = page.getByTestId('academy-feedback')
    await feedback.waitFor({ state: 'visible' })
    expect(await feedback.getAttribute('class')).toContain('academy-feedback-fail')
    const failText = await feedback.textContent()
    expect(failText).toMatch(/pitch|FM/i)
    expect(failText).not.toMatch(/^\s*\d+(\.\d+)?\s*%?\s*$/)

    // Now patch the same envelope into the VCO's FM jack too and turn the
    // FM knob up -- the fix the feedback itself names -- and re-Check.
    await dragCable(page, 'jack-adsr-1-out', 'jack-vco-1-fm')
    await setParam(page, 'vco-1', 'fmAmount', 2)

    await checkBtn.click()
    await expect.poll(async () => await checkBtn.textContent()).toContain('Check my patch')
    await expect.poll(async () => await feedback.textContent()).toContain('Level complete')
    expect(await feedback.getAttribute('class')).toContain('academy-feedback-pass')

    // Unlocked the next level (10-drift, immediately after 09-thump in
    // play order).
    const nextEntry = page.getByTestId('academy-level-10-drift')
    await expect.poll(async () => await nextEntry.isEnabled()).toBe(true)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })
})
