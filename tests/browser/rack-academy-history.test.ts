import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { ViteDevServer } from 'vite'
import { createIsolatedServer, closeIsolatedServer } from './support/e2e-server'
import { chromium, type Browser, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'

/**
 * Drives the real rack page for the history track, the academy's third
 * selectable sequence -- same real-Chromium, real-AudioContext pattern as
 * rack-academy-bass.test.ts (which proved the track picker itself works)
 * and rack-match-sound.test.ts / rack-academy-constrained.test.ts (which
 * proved the match and constrained UIs end to end). What's unique to this
 * file: that the history track is reachable from the picker, and that its
 * one match-this-sound level and its constrained-challenge capstone
 * (East Coast, West Coast) both fail with useful, player-facing feedback on
 * a plausible near-miss and then pass on a fix -- the same bar every other
 * grading mode in this app was held to.
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

const HISTORY_LEVELS_1_TO_5 = [
  'history-01-modular-lead', 'history-02-motorik', 'history-03-squelch', 'history-04-funk-bass', 'history-05-chop',
]

describe('academy: history track', () => {
  it('the track picker reaches the history track, showing its own level list', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)
    await enterAcademy(page)

    await page.getByTestId('academy-track-history').click()
    await page.waitForTimeout(150)

    expect(await page.getByTestId('academy-brief').textContent()).toContain('The Modular Lead')
    expect(await page.getByTestId('academy-level-history-01-modular-lead').isVisible()).toBe(true)
    expect(await page.getByTestId('academy-level-01-first-sound').count()).toBe(0)
    expect(await page.getByTestId('academy-level-bass-01-layers').count()).toBe(0)

    // Only the first history level is unlocked from a cold start.
    const level2 = page.getByTestId('academy-level-history-02-motorik')
    expect(await level2.isDisabled()).toBe(true)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })

  it('history-01-modular-lead: a wired-but-untuned patch fails naming a real dimension, then the tuned target passes and unlocks the next level', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)
    await enterAcademy(page)
    await page.getByTestId('academy-track-history').click()
    await page.getByTestId('academy-brief').waitFor({ state: 'visible' })

    const playBtn = page.getByTestId('academy-play-target')
    await playBtn.waitFor({ state: 'visible' })
    await playBtn.click()
    await expect.poll(async () => await playBtn.textContent()).toContain('Play target sound')

    // The right topology -- VCO -> VCF -> VCA -> Output, ADSR into both the
    // VCA's CV and the VCF's CV -- but every param left at its ordinary
    // descriptor default. The target snaps bright then settles; a
    // default-tuned ADSR (slow-ish attack, sustain 0.7) and a VCF with no
    // cutoffCvAmount patched-in depth misses that shape entirely.
    await addFromPalette(page, 'vco')
    await addFromPalette(page, 'vcf')
    await addFromPalette(page, 'adsr')
    await addFromPalette(page, 'vca')
    await addFromPalette(page, 'output')

    await dragCable(page, 'jack-vco-1-out', 'jack-vcf-1-in')
    await dragCable(page, 'jack-vcf-1-out', 'jack-vca-1-in')
    await dragCable(page, 'jack-adsr-1-out', 'jack-vca-1-cv')
    await dragCable(page, 'jack-adsr-1-out', 'jack-vcf-1-cutoffCv')
    await dragCable(page, 'jack-vca-1-out', 'jack-output-1-in')

    const checkBtn = page.getByTestId('academy-check')
    await checkBtn.click()
    await expect.poll(async () => await checkBtn.textContent()).toContain('Check my patch')

    const feedback = page.getByTestId('academy-feedback')
    await feedback.waitFor({ state: 'visible' })
    expect(await feedback.getAttribute('class')).toContain('academy-feedback-fail')
    const failText = await feedback.textContent()
    expect(failText).toMatch(/Cut knob|Attack|Res knob|waveform|Amt/)
    expect(failText).not.toMatch(/^\s*\d+(\.\d+)?\s*%?\s*$/)

    // Tune to the target's actual values -- same wiring, so this proves
    // param values (not topology) were what failed above.
    await setParam(page, 'vcf-1', 'cutoff', 900)
    await setParam(page, 'vcf-1', 'resonance', 0.45)
    await setParam(page, 'vcf-1', 'cutoffCvAmount', 4.5)
    await setParam(page, 'adsr-1', 'attack', 0.03)
    await setParam(page, 'adsr-1', 'decay', 0.35)
    await setParam(page, 'adsr-1', 'sustain', 0.55)
    await setParam(page, 'adsr-1', 'release', 0.5)
    await setParam(page, 'vca-1', 'level', 0)
    await setParam(page, 'vca-1', 'cvAmount', 1)

    await checkBtn.click()
    await expect.poll(async () => await checkBtn.textContent()).toContain('Check my patch')
    await page.waitForTimeout(100)

    expect(await feedback.getAttribute('class')).toContain('academy-feedback-pass')
    expect(await feedback.textContent()).toContain('Level complete')

    const level2 = page.getByTestId('academy-level-history-02-motorik')
    expect(await level2.isDisabled()).toBe(false)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })

  it('history-06-east-west: a patch missing the shaping-module envelope fails, then patching it in passes', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await page.addInitScript((completed: string[]) => {
      localStorage.setItem('sinsthesis:academy-progress:v1', JSON.stringify({ completed, currentTrack: 'history' }))
    }, HISTORY_LEVELS_1_TO_5)

    await powerOn(page)
    await enterAcademy(page)
    await page.getByTestId('academy-level-history-06-east-west').click()
    await page.getByTestId('academy-brief').waitFor({ state: 'visible' })

    const counter = page.getByTestId('academy-module-counter')
    await counter.waitFor({ state: 'visible' })
    expect(await counter.textContent()).toContain('Modules: 0 / 4')

    // The East Coast route, correctly wired, but the second ADSR cable
    // (into the VCF's own CV) never patched in -- a static, unmoving
    // brightness instead of the "fades as it dies" the brief asks for.
    await addFromPalette(page, 'vco')
    await addFromPalette(page, 'vcf')
    await addFromPalette(page, 'adsr')
    await addFromPalette(page, 'vca')
    await addFromPalette(page, 'output')
    await dragCable(page, 'jack-vco-1-out', 'jack-vcf-1-in')
    await dragCable(page, 'jack-vcf-1-out', 'jack-vca-1-in')
    await dragCable(page, 'jack-adsr-1-out', 'jack-vca-1-cv')
    await dragCable(page, 'jack-vca-1-out', 'jack-output-1-in')

    await setParam(page, 'vcf-1', 'cutoff', 200)
    await setParam(page, 'vcf-1', 'cutoffCvAmount', 0) // <- the miss: no filter envelope
    await setParam(page, 'adsr-1', 'attack', 0.005)
    await setParam(page, 'adsr-1', 'decay', 0.35)
    await setParam(page, 'adsr-1', 'sustain', 0.1)
    await setParam(page, 'adsr-1', 'release', 0.15)
    await setParam(page, 'vca-1', 'level', 0)
    await setParam(page, 'vca-1', 'cvAmount', 1)

    const checkBtn = page.getByTestId('academy-check')
    await checkBtn.click()
    await expect.poll(async () => await checkBtn.textContent()).toContain('Check my patch')

    const feedback = page.getByTestId('academy-feedback')
    await feedback.waitFor({ state: 'visible' })
    expect(await feedback.getAttribute('class')).toContain('academy-feedback-fail')
    const failText = await feedback.textContent()
    expect(failText).not.toMatch(/^\s*\d+(\.\d+)?\s*%?\s*$/)

    // Patch the same envelope into the VCF's own CV jack too -- the fix the
    // brief itself names -- and re-Check.
    await dragCable(page, 'jack-adsr-1-out', 'jack-vcf-1-cutoffCv')
    await setParam(page, 'vcf-1', 'cutoffCvAmount', 5)

    await checkBtn.click()
    await expect.poll(async () => await checkBtn.textContent()).toContain('Check my patch')
    await expect.poll(async () => await feedback.textContent()).toContain('Level complete')
    expect(await feedback.getAttribute('class')).toContain('academy-feedback-pass')

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })
})
