import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'

/**
 * Drives the real rack page (rack.html + rack/main.ts) in an actual
 * Chromium tab, following the same pattern as tests/browser/dev-page.test.ts
 * and for the same reasons: a real Vite dev server plus real, trusted
 * pointer/keyboard input (via Playwright's CDP-backed `page.mouse` /
 * `page.keyboard`) is what satisfies the browser's autoplay gate on
 * `AudioContext`, and what makes a cable drag exercise the same
 * pointerdown/pointermove/pointerup path a real operator's mouse would.
 *
 * Verification here is deliberately end-to-end at the `PatchGraph` level,
 * not just "a line appeared in the DOM": the task this page exists to
 * prove out is that a drag calls `graph.connect` and a cable click calls
 * `graph.disconnect`, with the SVG curve only ever a picture of what the
 * graph already did.
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

async function settleAfterBoot(page: Page): Promise<void> {
  await page.waitForTimeout(250)
}

interface DebugHook {
  graph: {
    cables: ReadonlyArray<{ id: string; from: readonly [string, string]; to: readonly [string, string]; delayed: boolean }>
  }
  rms(): number
}

async function powerOn(page: Page): Promise<void> {
  // Seven starter modules wrap to two rack rows and the page runs taller
  // than Playwright's default 720px viewport. `page.mouse.move` addresses
  // viewport coordinates and does not auto-scroll the way locator actions
  // do, so a jack below the fold (this bit LFO's "out" jack specifically,
  // in the second row) would silently receive no pointerdown at all --
  // found by screenshotting mid-drag and seeing the browser's native text
  // selection highlight instead of a cable preview, i.e. the mousedown
  // landed on nothing draggable. A tall viewport sidesteps it rather than
  // scrolling mid-drag, which two different jacks could each need.
  await page.setViewportSize({ width: 1600, height: 1150 })
  await page.goto(baseUrl + '/rack.html', { waitUntil: 'load' })
  const powerBtn = page.getByTestId('power')
  await powerBtn.waitFor({ state: 'visible' })
  await powerBtn.click()
  await page.waitForFunction(() => Boolean((window as unknown as { __sinsthesis?: unknown }).__sinsthesis))
  const app = page.getByTestId('app')
  await app.waitFor({ state: 'visible' })
  await settleAfterBoot(page)
}

function cablesOf(page: Page): Promise<DebugHook['graph']['cables']> {
  return page.evaluate(
    () => (window as unknown as { __sinsthesis: DebugHook }).__sinsthesis.graph.cables,
  ) as unknown as Promise<DebugHook['graph']['cables']>
}

/** Quadratic-bezier midpoint matching `hangingPath` in rack/cables.ts
 *  exactly, so a click lands on the drawn stroke rather than guessing at
 *  a bounding-box center that a sagging curve would miss. */
function cableMidpoint(x1: number, y1: number, x2: number, y2: number): { x: number; y: number } {
  const dx = x2 - x1
  const sag = Math.min(140, Math.abs(dx) * 0.3) + 36
  const cx = (x1 + x2) / 2
  const cy = (y1 + y2) / 2 + sag
  return { x: 0.25 * x1 + 0.5 * cx + 0.25 * x2, y: 0.25 * y1 + 0.5 * cy + 0.25 * y2 }
}

describe('rack page', () => {
  it('drags LFO out to the filter cutoff CV jack and creates a real PatchGraph connection', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)

    const before = await cablesOf(page)
    // The starter patch wires six cables and deliberately leaves the LFO
    // unpatched (rack/main.ts) -- exactly so a drag from it demonstrates
    // "any port may connect to any port" rather than the rack patching it
    // on the operator's behalf.
    expect(before).toHaveLength(6)
    expect(before.some((c) => c.from[0] === 'lfo')).toBe(false)

    const source = page.getByTestId('jack-lfo-out')
    const target = page.getByTestId('jack-vcf-cutoffCv')
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
    // A midpoint move first -- pointer-capture-driven drags in this app
    // read every pointermove, and a single jump can occasionally land
    // before the drag-preview element exists in slower CI environments.
    await page.mouse.move((sx + tx) / 2, (sy + ty) / 2, { steps: 5 })
    await page.mouse.move(tx, ty, { steps: 5 })
    await page.mouse.up()

    const after = await cablesOf(page)
    expect(after).toHaveLength(7)
    const newCable = after.find((c) => c.from[0] === 'lfo')
    expect(newCable).toBeDefined()
    expect(newCable!.from).toEqual(['lfo', 'out'])
    expect(newCable!.to).toEqual(['vcf', 'cutoffCv'])

    // The cable is drawn -- not just connected in the graph.
    const cablePath = page.locator(`.cable.signal-cv .cable-visible`)
    await expect.poll(() => cablePath.count()).toBeGreaterThan(0)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })

  it('clicking a cable removes the PatchGraph connection', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)

    // The VCO -> VCF audio cable is part of the starter patch, so this
    // removes an existing connection rather than one just created by a
    // drag -- proving disconnect independently of connect.
    const before = await cablesOf(page)
    const target = before.find((c) => c.from[0] === 'vco' && c.to[0] === 'vcf')
    if (!target) throw new Error('expected a starter vco -> vcf cable')
    expect(before).toHaveLength(6)

    const fromJack = page.getByTestId('jack-vco-out')
    const toJack = page.getByTestId('jack-vcf-in')
    const fromBox = await fromJack.boundingBox()
    const toBox = await toJack.boundingBox()
    if (!fromBox || !toBox) throw new Error('jack has no bounding box')
    const mid = cableMidpoint(
      fromBox.x + fromBox.width / 2,
      fromBox.y + fromBox.height / 2,
      toBox.x + toBox.width / 2,
      toBox.y + toBox.height / 2,
    )

    await page.mouse.click(mid.x, mid.y)

    const after = await cablesOf(page)
    expect(after).toHaveLength(5)
    expect(after.some((c) => c.id === target.id)).toBe(false)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })

  it('a real drag that closes a feedback loop is marked delayed, in the graph and on screen', async () => {
    // The starter patch already wires vcf.out -> vca.in. Dragging a second
    // cable from the VCA's output back to the filter's cutoff CV closes a
    // loop through those two modules -- exactly the case Section 5 calls
    // out: WebAudio only permits a graph cycle through a DelayNode, so
    // `PatchGraph.connect` must insert one and report `delayed: true`, and
    // the UI must style that cable distinctly (rack/style.css's
    // `.cable-delayed` rule) so the operator can see which cable costs
    // them the 128-sample delay.
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)

    const source = page.getByTestId('jack-vca-out')
    const target = page.getByTestId('jack-vcf-cutoffCv')
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

    const after = await cablesOf(page)
    expect(after).toHaveLength(7)
    const feedbackCable = after.find((c) => c.from[0] === 'vca' && c.to[0] === 'vcf')
    expect(feedbackCable).toBeDefined()
    expect(feedbackCable!.delayed).toBe(true)

    const delayedGroup = page.locator('.cable.cable-delayed')
    await expect.poll(() => delayedGroup.count()).toBeGreaterThan(0)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })

  it('drags a knob to change a param, honoring the exp curve, and double-click resets it', async () => {
    // Vertical drag to turn is the whole point of "real knobs, not
    // sliders" -- and the cutoff knob (curve: 'exp') is the case that
    // catches a renderer that quietly fell back to a linear mapping: a
    // fixed upward drag should move a *lot* more than the last few Hz
    // toward the top of a 20-20000 Hz range.
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)

    const knob = page.getByTestId('knob-cutoff')
    const readout = page.locator('[data-testid="readout-cutoff"]')
    expect(await readout.textContent()).toBe('1000 Hz')

    const box = await knob.boundingBox()
    if (!box) throw new Error('knob has no bounding box')
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2

    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx, cy - 90, { steps: 8 })
    await page.mouse.up()

    const cutoffAfterDrag = await page.evaluate(
      () => (window as unknown as { __sinsthesis: { graph: { getParams(id: string): Record<string, number> } } })
        .__sinsthesis.graph.getParams('vcf')['cutoff'],
    )
    // A linear mapping over the same pixel drag on a 20..20000 range would
    // land under 1200 Hz; the exp curve should clear well past 5000.
    expect(cutoffAfterDrag).toBeGreaterThan(5000)

    await knob.dblclick()
    const cutoffAfterReset = await page.evaluate(
      () => (window as unknown as { __sinsthesis: { graph: { getParams(id: string): Record<string, number> } } })
        .__sinsthesis.graph.getParams('vcf')['cutoff'],
    )
    expect(cutoffAfterReset).toBe(1000) // the vcf descriptor's own default

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })

  it('makes sound on a real keydown through the rack keyboard module', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)

    const rms = () => page.evaluate(() => (window as unknown as { __sinsthesis: DebugHook }).__sinsthesis.rms())

    const silenceBefore = await rms()
    expect(silenceBefore).toBeLessThan(0.001)

    await page.keyboard.down('KeyA')
    await page.waitForTimeout(300)
    const rmsHeld = await rms()
    expect(rmsHeld).toBeGreaterThan(0.02)

    await page.keyboard.up('KeyA')
    await page.waitForTimeout(2000)
    const rmsAfterRelease = await rms()
    expect(rmsAfterRelease).toBeLessThan(0.001)

    console.log(
      `rack-page.test.ts RMS: silence(before)=${silenceBefore.toExponential(3)} ` +
        `held=${rmsHeld.toExponential(3)} silence(after release)=${rmsAfterRelease.toExponential(3)}`,
    )

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })
})
