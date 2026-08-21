import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { ViteDevServer } from 'vite'
import { createIsolatedServer, closeIsolatedServer } from './support/e2e-server'
import { chromium, type Browser, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'

/**
 * Drives the real rack page to prove the pitch display (rack/pitch-display.ts)
 * actually reads back the right note for a real recording -- same
 * real-Chromium, real-AudioContext pattern as studio-record.test.ts, which
 * already proves the WAV bytes are correct; this proves the musical
 * reading built on top of them is too.
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

/** Adds a fresh VCO tuned to a known note and cables it straight to
 *  Output -- the same continuous, gate-free voice studio-record.test.ts
 *  uses, for the same reason: a steady tone with no ADSR needed. 16
 *  semitones above A4 is this codebase's own documented safe test
 *  frequency (~1108.7 Hz, C#6 -- docs/CONTINUATION.md trap 1: avoid
 *  sampleRate/f0 landing near an integer). */
async function buildKnownToneVoice(page: Page): Promise<{ expectedHz: number }> {
  await page.getByTestId('palette-toggle').click()
  await page.getByTestId('palette-add-vco').click()
  await page.waitForTimeout(50)

  const vcoId: string = await page.evaluate(() => {
    const g = (window as unknown as { __sinsthesis: { graph: { moduleIds: readonly string[]; getType(id: string): string } } })
      .__sinsthesis.graph
    const found = g.moduleIds.find((id) => g.getType(id) === 'vco' && id !== 'vco')
    if (!found) throw new Error('second VCO not found')
    return found
  })

  await page.evaluate(
    ({ id, tune }) => {
      const win = window as unknown as { __sinsthesis: { graph: { setParam(id: string, param: string, value: number, atTime?: number): void }; ctx: AudioContext } }
      win.__sinsthesis.graph.setParam(id, 'tune', tune, win.__sinsthesis.ctx.currentTime)
    },
    { id: vcoId, tune: 16 },
  )

  await dragJackToJack(page, `jack-${vcoId}-out`, 'jack-output-in')

  return { expectedHz: 440 * Math.pow(2, 16 / 12) }
}

describe('pitch display: reads back a known note from a real recording', () => {
  it('the readout names the right note and frequency, and the contour + waveform render', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)
    const { expectedHz } = await buildKnownToneVoice(page)

    // Before any capture, the pitch display is hidden.
    expect(await page.getByTestId('pitch-display').isHidden()).toBe(true)

    await page.getByTestId('record-btn').click()
    await page.waitForTimeout(900) // real wall-clock capture, same as studio-record.test.ts
    await page.getByTestId('record-btn').click()
    await page.getByTestId('export-panel').waitFor({ state: 'visible' })

    const display = page.getByTestId('pitch-display')
    await display.waitFor({ state: 'visible' })
    expect(await page.getByTestId('pitch-display-wave').isVisible()).toBe(true)
    expect(await page.getByTestId('pitch-display-contour').isVisible()).toBe(true)

    const readoutText = await page.getByTestId('pitch-display-readout').textContent()
    // C#6, the note 16 semitones above A4.
    expect(readoutText).toContain('C#6')
    const hzMatch = readoutText?.match(/^([\d.]+) Hz/)
    expect(hzMatch).toBeTruthy()
    const measuredHz = Number(hzMatch![1])
    expect(Math.abs(measuredHz - expectedHz)).toBeLessThan(10)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })
})
