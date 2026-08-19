import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'

/**
 * Drives the real rack page for match-this-sound, the academy's second
 * grading mode -- same real-Chromium, real-AudioContext, real-pointer-drag
 * pattern as rack-academy.test.ts, which proved build-this-patch is
 * reachable from the UI. This proves the parts that only exist once a
 * whole browser is in the loop: the "Play target sound" button actually
 * renders and plays audio without erroring; a patch that matches the
 * target passes Check and unlocks the next level; a patch that's wired
 * right but tuned wrong fails with a real player-facing sentence naming an
 * actual knob, not a bare number; and the overlay -- the player's spectrum
 * and envelope plotted against the target's -- actually renders onto the
 * page. tests/browser/analysis/compare-render.test.ts already proves the
 * distance metric agrees with real DSP and sets each level's threshold;
 * this proves the UI wired on top of it works end to end.
 *
 * Levels 06-08 come after five build-this-patch levels in play order
 * (`isUnlocked` only cares about the level immediately before it), so this
 * seeds `localStorage` with all five already completed via
 * `page.addInitScript` -- run before any page script, including the one
 * that reads progress on the first academy visit -- rather than replaying
 * five levels' worth of UI just to reach level six.
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

const BUILD_LEVELS_DONE = ['01-first-sound', '02-shape-it', '03-play-notes', '04-modulate', '05-resonance']

async function powerOnWithMatchLevelsUnlocked(page: Page): Promise<void> {
  await page.addInitScript((completed: string[]) => {
    localStorage.setItem('sinsthesis:academy-progress:v1', JSON.stringify({ completed }))
  }, BUILD_LEVELS_DONE)

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

/** Same technique as rack-academy.test.ts's own `dragCable`: a midpoint
 *  move first, since this app's pointer-capture-driven drags read every
 *  pointermove and a single jump can land before the drag-preview element
 *  exists. */
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

/** Sets a live module param directly through the same `PatchGraph.setParam`
 *  a knob drag's `onChange` ultimately calls -- precise, where hitting an
 *  exact target value (e.g. an exponential-curve cutoff of 6000 Hz) via
 *  simulated pixel-drag math would not be. What match-this-sound grades is
 *  the graph's live param state at Check time, not how it got there. */
async function setParam(page: Page, moduleId: string, paramId: string, value: number): Promise<void> {
  await page.evaluate(
    ({ moduleId, paramId, value }) => {
      const hook = (window as unknown as { __sinsthesis: { graph: { setParam(id: string, p: string, v: number): void } } }).__sinsthesis
      hook.graph.setParam(moduleId, paramId, value)
    },
    { moduleId, paramId, value },
  )
}

describe('academy: match-this-sound', () => {
  it('the target plays on demand, as many times as wanted, with no console errors', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOnWithMatchLevelsUnlocked(page)
    await enterLevel(page, '06-match-pluck')

    const playBtn = page.getByTestId('academy-play-target')
    await playBtn.waitFor({ state: 'visible' })
    expect(await playBtn.textContent()).toContain('Play target sound')

    // Twice -- "as many times as they want", not a one-shot preview.
    await playBtn.click()
    await page.waitForTimeout(150)
    await expect.poll(async () => await playBtn.textContent()).toContain('Play target sound')
    await playBtn.click()
    await page.waitForTimeout(150)
    await expect.poll(async () => await playBtn.textContent()).toContain('Play target sound')

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })

  it('a correctly-wired but wrongly-tuned patch fails, names a real dimension, and draws the overlay -- then the exact target passes', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOnWithMatchLevelsUnlocked(page)
    await enterLevel(page, '06-match-pluck')

    // Build the *right topology* -- VCO -> VCF -> VCA -> Output, ADSR ->
    // VCA CV -- but leave every param at its ordinary descriptor default.
    // The target is a short, bright pluck (fast attack, low sustain, a
    // bright cutoff); every one of those defaults is wrong for it (a slow
    // attack, sustain held at 0.7, a dark 1000 Hz cutoff, and a VCA that's
    // open regardless of the envelope since cvAmount defaults to 0) -- a
    // patch a player could plausibly leave half-tuned, not a strawman.
    await addFromPalette(page, 'vco')
    await addFromPalette(page, 'vcf')
    await addFromPalette(page, 'adsr')
    await addFromPalette(page, 'vca')
    await addFromPalette(page, 'output')

    await dragCable(page, 'jack-vco-1-out', 'jack-vcf-1-in')
    await dragCable(page, 'jack-vcf-1-out', 'jack-vca-1-in')
    await dragCable(page, 'jack-adsr-1-out', 'jack-vca-1-cv')
    await dragCable(page, 'jack-vca-1-out', 'jack-output-1-in')

    const checkBtn = page.getByTestId('academy-check')
    await checkBtn.click()
    // Checking a match-this-sound level renders offline -- real, if short --
    // so wait for the button to come back rather than assuming it's instant.
    await expect.poll(async () => await checkBtn.textContent()).toContain('Check my patch')

    const feedback = page.getByTestId('academy-feedback')
    await feedback.waitFor({ state: 'visible' })
    expect(await feedback.getAttribute('class')).toContain('academy-feedback-fail')

    const feedbackText = await feedback.textContent()
    // A real, actionable line -- names an actual knob, not a bare score.
    // Which specific dimension trips first depends on the exact distance
    // measured, so this accepts any of the sentences academy/sound-feedback.ts
    // can produce rather than pinning one.
    expect(feedbackText).toMatch(/Cut knob|Attack|Res knob|waveform/)
    expect(feedbackText).not.toMatch(/^\s*\d+(\.\d+)?\s*%?\s*$/) // never a bare number

    // "Show the miss": the overlay actually rendered onto the page.
    const overlay = page.getByTestId('academy-match-overlay')
    await overlay.waitFor({ state: 'visible' })
    expect(await page.getByTestId('academy-match-spectrum').isVisible()).toBe(true)
    expect(await page.getByTestId('academy-match-envelope').isVisible()).toBe(true)

    // Now tune it to the target's actual values (the same wiring, so this
    // proves param values -- not topology -- were what failed above) and
    // Check again.
    await setParam(page, 'vcf-1', 'cutoff', 6000)
    await setParam(page, 'vcf-1', 'resonance', 0.1)
    await setParam(page, 'adsr-1', 'attack', 0.005)
    await setParam(page, 'adsr-1', 'decay', 0.25)
    await setParam(page, 'adsr-1', 'sustain', 0)
    await setParam(page, 'adsr-1', 'release', 0.15)
    await setParam(page, 'vca-1', 'level', 0)
    await setParam(page, 'vca-1', 'cvAmount', 1)

    await checkBtn.click()
    await expect.poll(async () => await checkBtn.textContent()).toContain('Check my patch')
    await page.waitForTimeout(100)

    expect(await feedback.getAttribute('class')).toContain('academy-feedback-pass')
    expect(await feedback.textContent()).toContain('Level complete')

    const level7 = page.getByTestId('academy-level-07-match-waveform')
    expect(await level7.isDisabled()).toBe(false)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })
})
