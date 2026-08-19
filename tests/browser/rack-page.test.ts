import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
    moduleIds: readonly string[]
    cables: ReadonlyArray<{ id: string; from: readonly [string, string]; to: readonly [string, string]; delayed: boolean; active: boolean }>
    getParams(id: string): Record<string, number>
  }
  rms(): number
}

function moduleIdsOf(page: Page): Promise<readonly string[]> {
  return page.evaluate(
    () => (window as unknown as { __sinsthesis: DebugHook }).__sinsthesis.graph.moduleIds,
  ) as unknown as Promise<readonly string[]>
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

    // The rendered curve is anchored at each jack's `.jack-socket` circle,
    // not the wider `.jack` element that also carries its label
    // (`anchorOf` in rack/cables.ts) -- exactly matching that anchor, not
    // approximating it from the outer element, is what keeps this
    // midpoint on the actual 14px-wide hit-stroke regardless of how tall
    // the label below the socket happens to render.
    const fromJack = page.getByTestId('jack-vco-out').locator('.jack-socket')
    const toJack = page.getByTestId('jack-vcf-in').locator('.jack-socket')
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

  it('adds a module from the palette into the graph and onto the rack', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)

    const before = await moduleIdsOf(page)
    expect(before).toHaveLength(7)

    // The palette is read from `listModules()` (rack/palette.ts), never a
    // hardcoded list -- adding "noise" here exercises a module the starter
    // patch itself never instantiates, proving the palette isn't just
    // re-adding the same seven.
    await page.getByTestId('palette-toggle').click()
    await page.getByTestId('palette-add-noise').click()

    const after = await moduleIdsOf(page)
    expect(after).toHaveLength(8)
    const newId = after.find((id) => !before.includes(id))
    expect(newId).toBeDefined()
    expect(newId).toMatch(/^noise-\d+$/)

    // Really on screen, not just in the graph -- the generic renderer drew
    // a real panel for it.
    expect(await page.getByTestId(`module-${newId}`).isVisible()).toBe(true)
    expect(await page.getByTestId(`jack-${newId}-out`).isVisible()).toBe(true)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })

  it('removes a module and drops every cable that touched it, on screen and in the graph', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)

    // The VCO carries two of the starter patch's six cables (keyboard ->
    // vco.pitch, vco.out -> vcf.in) -- removing it should drop both,
    // re-read from the graph rather than tracked separately by the view
    // (rack/cables.ts's `syncFromGraph`).
    const before = await cablesOf(page)
    expect(before).toHaveLength(6)

    await page.getByTestId('remove-vco').click()

    const after = await cablesOf(page)
    expect(after).toHaveLength(4)
    expect(after.some((c) => c.from[0] === 'vco' || c.to[0] === 'vco')).toBe(false)

    const ids = await moduleIdsOf(page)
    expect(ids).not.toContain('vco')
    expect(await page.getByTestId('module-vco').count()).toBe(0)

    // Not just absent from the graph's cable list -- the SVG cable
    // elements that used to represent them are gone too.
    await expect.poll(() => page.locator('.cable').count()).toBe(4)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })

  it('a save/load round trip reproduces the same modules, params and cables', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)

    // Change a param and add a module first, so the round trip has more to
    // lose than the untouched starter patch would prove.
    const knob = page.getByTestId('knob-cutoff')
    const box = await knob.boundingBox()
    if (!box) throw new Error('knob has no bounding box')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 40, { steps: 8 })
    await page.mouse.up()
    await page.getByTestId('palette-toggle').click()
    await page.getByTestId('palette-add-noise').click()

    interface PatchSnapshot { moduleIds: string[]; cables: Array<{ from: readonly [string, string]; to: readonly [string, string] }>; cutoff: number }
    const readSnapshot = (): Promise<PatchSnapshot> =>
      page.evaluate(() => {
        const g = (window as unknown as { __sinsthesis: DebugHook }).__sinsthesis.graph
        return {
          moduleIds: [...g.moduleIds].sort(),
          cables: g.cables.map((c) => ({ from: c.from, to: c.to })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
          cutoff: g.getParams('vcf')['cutoff'],
        }
      }) as unknown as Promise<PatchSnapshot>

    const before = await readSnapshot()
    expect(before.cutoff).toBeGreaterThan(1000) // the drag actually moved it

    // Save: capture what would have downloaded, without touching a real
    // filesystem download dialog -- `URL.createObjectURL` is the one seam
    // `downloadPatch` (rack/patch-io.ts) offers for this.
    const patchText = await page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const orig = URL.createObjectURL.bind(URL)
          URL.createObjectURL = (blob: Blob) => {
            void blob.text().then(resolve)
            return orig(blob)
          }
          ;(document.getElementById('save-patch') as HTMLButtonElement).click()
        }),
    )

    const tmpPath = join(tmpdir(), `rack-roundtrip-${Date.now()}-${Math.random().toString(36).slice(2)}.sinp`)
    writeFileSync(tmpPath, patchText)

    try {
      // Mutate the live rack before loading, so a passing test proves the
      // load actually rebuilt state rather than the state having never
      // changed.
      await page.getByTestId('remove-lfo').click()
      expect(await moduleIdsOf(page)).not.toEqual(before.moduleIds.sort())

      await page.getByTestId('load-patch').click()
      await page.getByTestId('load-file-input').setInputFiles(tmpPath)
      await page.waitForTimeout(200)

      const after = await readSnapshot()
      expect(after).toEqual(before)
      expect(await page.getByTestId('status-banner').isHidden()).toBe(true)
    } finally {
      unlinkSync(tmpPath)
    }

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })

  it('loads a file naming an unknown module type as a ghost with its cables intact', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)

    // A hand-built fixture, not something this build ever produced --
    // "quantum-resonator" is a type no descriptor registers, and the
    // fixture cables it to a real vco so the test can check the cable
    // round-trips even though one end is unknown.
    const fixture = {
      version: 1,
      meta: { name: 'Ghost Fixture', created: new Date().toISOString(), author: '' },
      modules: [
        { id: 'vco', type: 'vco', slot: [0, 0], params: {} },
        { id: 'mystery', type: 'quantum-resonator', slot: [0, 1], params: { drive: 5 } },
      ],
      cables: [{ from: ['vco', 'out'], to: ['mystery', 'in'] }],
    }
    const tmpPath = join(tmpdir(), `rack-ghost-${Date.now()}-${Math.random().toString(36).slice(2)}.sinp`)
    writeFileSync(tmpPath, JSON.stringify(fixture))

    try {
      await page.getByTestId('load-patch').click()
      await page.getByTestId('load-file-input').setInputFiles(tmpPath)
      await page.waitForTimeout(200)

      const banner = page.getByTestId('status-banner')
      expect(await banner.isVisible()).toBe(true)
      expect(await banner.textContent()).toContain('quantum-resonator')

      const ghostPanel = page.getByTestId('module-mystery')
      expect(await ghostPanel.isVisible()).toBe(true)
      expect(await ghostPanel.getAttribute('data-ghost')).toBe('true')

      const cables = await cablesOf(page)
      expect(cables).toHaveLength(1)
      expect(cables[0]!.from).toEqual(['vco', 'out'])
      expect(cables[0]!.to).toEqual(['mystery', 'in'])
      expect(cables[0]!.active).toBe(false) // one end is a ghost -- no audio flows

      // The cable is drawn too, not just present in the graph -- the
      // ghost's jack got a real DOM anchor for it to attach to.
      await expect.poll(() => page.locator('.cable').count()).toBe(1)
    } finally {
      unlinkSync(tmpPath)
    }

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })
})
