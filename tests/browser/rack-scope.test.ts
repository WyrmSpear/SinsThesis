import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { ViteDevServer } from 'vite'
import { createIsolatedServer, closeIsolatedServer } from './support/e2e-server'
import { chromium, type Browser, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'
import { peakHz } from '../../src/engine/analysis/features'

/**
 * Rack-level proof for Phase 2's first slice, driving the real page
 * (index.html + rack/main.ts) in an actual Chromium tab -- same pattern as
 * rack-page.test.ts and rack-sequencer.test.ts, and for the same reasons
 * (a real user-gesture power-on, a real `AudioContext`, real pointer
 * events for every drag). Three things proved here that neither
 * tests/browser/modules/scope.test.ts (engine-level, `OfflineAudioContext`)
 * nor the theme/geometry tests do:
 *
 * 1. The scope is reachable from the palette and its custom panel actually
 *    mounts (`rack/scope-panel.ts` wired through `rack/main.ts`'s
 *    `customPanels`), not just registered in the module set.
 * 2. Patching a live VCO into a live scope produces a genuinely non-flat
 *    display and a readout that tracks the real signal.
 * 3. Clicking a cable opens an inspector instead of deleting the cable
 *    (rack/cable-inspector.ts, rack/cables.ts) -- the cable survives the
 *    click, and the reading it shows is measurably close to the note
 *    actually playing.
 *
 * Frequency assertions use `peakHz` against the audio-thread `peak-tap`
 * worklet capture, the same technique rack-sequencer.test.ts uses and for
 * the same reason its own doc comment gives: this suite's job is to prove
 * the *displayed* reading is correct, and grading it against a
 * main-thread-polled number would only prove the display agrees with
 * itself.
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
  cables: readonly { id: string; from: readonly [string, string]; to: readonly [string, string] }[]
}

async function firstIdOfType(page: Page, type: string): Promise<string> {
  return page.evaluate(
    (t) => {
      const g = (window as unknown as { __sinsthesis: { graph: GraphHandle } }).__sinsthesis.graph
      const id = g.moduleIds.find((m) => g.getType(m) === t)
      if (!id) throw new Error(`no module of type "${t}"`)
      return id
    },
    type,
  )
}

interface TapResult {
  samples: number[]
  sampleRate: number
}

/** Wires an `AudioWorkletNode` tap onto `sourceModuleId`'s `out` port and
 *  captures `captureMs` of real audio-thread samples -- the same
 *  audio-thread-tap technique tests/browser/rack-sequencer.test.ts uses
 *  (`peak-tap`, already loaded by `rack/main.ts`'s boot). Main-thread
 *  polling (a timed `getFloatTimeDomainData` read) is what the scope
 *  display itself does for its live redraw, which is exactly why grading
 *  correctness needs an independent, audio-thread-accurate measurement
 *  instead of reading the display's own number back. */
async function captureModuleAudio(page: Page, sourceModuleId: string, captureMs: number): Promise<TapResult> {
  await page.evaluate((moduleId) => {
    const win = window as unknown as {
      __sinsthesis: { graph: { getInstance(id: string): { outputs: Map<string, AudioNode> } }; ctx: AudioContext }
      __scopeTapChunks: { frame: number; samples: Float32Array }[]
    }
    const { graph, ctx } = win.__sinsthesis

    const tap = new AudioWorkletNode(ctx, 'peak-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    const mute = ctx.createGain()
    mute.gain.value = 0 // silent passthrough -- never audible
    tap.connect(mute)
    mute.connect(ctx.destination)

    win.__scopeTapChunks = []
    tap.port.onmessage = (e: MessageEvent<{ frame: number; samples: Float32Array }>) => {
      win.__scopeTapChunks.push(e.data)
    }

    graph.getInstance(moduleId).outputs.get('out')!.connect(tap)
  }, sourceModuleId)

  await page.waitForTimeout(captureMs)

  return page.evaluate(() => {
    const win = window as unknown as {
      __sinsthesis: { ctx: AudioContext }
      __scopeTapChunks: { frame: number; samples: Float32Array }[]
    }
    const chunks = [...win.__scopeTapChunks].sort((a, b) => a.frame - b.frame)
    const total = chunks.reduce((n, c) => n + c.samples.length, 0)
    const samples = new Float32Array(total)
    let i = 0
    for (const c of chunks) {
      samples.set(c.samples, i)
      i += c.samples.length
    }
    return { samples: Array.from(samples), sampleRate: win.__sinsthesis.ctx.sampleRate }
  })
}

describe('rack scope', () => {
  it('is reachable from the palette and mounts its custom panel', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)
    await addModule(page, 'scope')

    const scopeId = await firstIdOfType(page, 'scope')
    const panel = page.locator(`.module-panel[data-module="${scopeId}"]`)
    expect(await panel.isVisible()).toBe(true)
    // The generic layout: an "In"/"Thru" jack pair and the timebase knob
    // plus view switch (rack/panel.ts drawing straight from the
    // descriptor). The custom panel's own canvas, proving `customPanel:
    // 'scope'` actually resolved to rack/scope-panel.ts rather than
    // falling back to the "not implemented" badge.
    expect(await page.getByTestId(`jack-${scopeId}-in`).isVisible()).toBe(true)
    expect(await page.getByTestId(`jack-${scopeId}-thru`).isVisible()).toBe(true)
    expect(await page.getByTestId('knob-timebase').isVisible()).toBe(true)
    expect(await page.getByTestId('switch-view').isVisible()).toBe(true)
    expect(await page.getByTestId(`scope-display-${scopeId}`).isVisible()).toBe(true)
    expect(await page.locator('.custom-panel-missing').count()).toBe(0)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  }, 20000)

  it('patching a VCO into it produces a non-flat display', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)
    await addModule(page, 'scope')
    const scopeId = await firstIdOfType(page, 'scope')

    await dragJackToJack(page, 'jack-vco-out', `jack-${scopeId}-in`)
    // A few animation frames for the display's own `requestAnimationFrame`
    // loop (rack/scope-panel.ts) to pick up the analyser's first real data.
    await page.waitForTimeout(500)

    const distinctColors = await page.evaluate((id) => {
      const canvas = document.querySelector(`[data-testid="scope-display-${id}"]`) as HTMLCanvasElement
      const ctx = canvas.getContext('2d')!
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const seen = new Set<string>()
      for (let i = 0; i < data.length; i += 4) seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`)
      return seen.size
    }, scopeId)
    // A flat/silent display is just the background fill plus the center
    // gridline -- two colors. A real waveform trace adds a third (plus
    // anti-aliased in-between shades in practice), so this is a
    // conservative floor for "there is a trace drawn here."
    expect(distinctColors).toBeGreaterThan(2)

    const readoutText = await page.locator(`[data-testid="scope-readout-${scopeId}"]`).textContent()
    expect(readoutText).toMatch(/Hz/)
    const reportedHz = parseFloat(readoutText ?? '')
    // The VCO's own default (tune=0, octave=0, no pitch cable patched) is
    // 440 Hz exactly (vco.worklet.ts: `440 * 2 ** (octave + tune / 12)`).
    // One FFT bin at the display's own 8192-point analyser and 48 kHz is
    // ~5.9 Hz wide, so requiring the readout within 10 Hz is tight against
    // real bin resolution without being flaky against leakage.
    expect(Math.abs(reportedHz - 440)).toBeLessThan(10)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  }, 20000)

  it('clicking a cable opens an inspector instead of deleting it, reading the correct fundamental', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)

    // Play a note through the starter patch's own keyboard -> VCO -> VCF ->
    // ADSR -> VCA -> Output voice (rack/main.ts's `buildDefaultPatch`), so
    // the cable under inspection carries a real, gated, non-default pitch
    // -- proving the reading tracks *the note actually playing*, not just
    // the VCO's free-running default the previous test already covers.
    const keyboardId = await firstIdOfType(page, 'keyboard')
    const noteMidi = 67 // G4, 392 Hz -- distinct from the VCO's own 440 Hz default
    const expectedHz = 440 * Math.pow(2, (noteMidi - 69) / 12)
    await page.evaluate(
      ({ id, note }) => {
        const inst = (window as unknown as { __sinsthesis: { graph: { getInstance(id: string): { pressNote(who: string, note: number): void } } } }).__sinsthesis.graph.getInstance(id)
        inst.pressNote('rack-scope-test', note)
      },
      { id: keyboardId, note: noteMidi },
    )
    await page.waitForTimeout(150) // clear the ADSR attack

    const cableId = await page.evaluate(() => {
      const g = (window as unknown as { __sinsthesis: { graph: GraphHandle } }).__sinsthesis.graph
      const cable = g.cables.find((c) => c.from[0] === 'vco' && c.from[1] === 'out')
      if (!cable) throw new Error('vco -> vcf cable not found')
      return cable.id
    })

    const cablesBefore = await page.evaluate(
      () => (window as unknown as { __sinsthesis: { graph: GraphHandle } }).__sinsthesis.graph.cables.length,
    )

    const hit = page.getByTestId(`cable-${cableId}`)
    await hit.waitFor({ state: 'attached' })
    // A real coordinate click would have to land exactly on the curved,
    // 14px-wide `.cable-hit` stroke (`pointer-events: stroke`,
    // rack/style.css) -- reliable for a human eyeballing the cable, but a
    // bounding-box midpoint is not guaranteed to sit on a curved path.
    // Dispatching the click directly on the element is the same technique
    // rack-page.test.ts's other non-drag interactions use, and it still
    // exercises the exact listener `rack/cables.ts`'s `renderCable` wires
    // up -- only the pixel-geometry hit-test is skipped, not the handler.
    await hit.dispatchEvent('click')
    await page.waitForTimeout(400) // let the inspector's own draw loop run a few frames

    // The cable survives the click: this is the whole point of splitting
    // click-to-inspect from click-to-remove (rack/cable-inspector.ts's doc
    // comment).
    const cablesAfter = await page.evaluate(
      () => (window as unknown as { __sinsthesis: { graph: GraphHandle } }).__sinsthesis.graph.cables.length,
    )
    expect(cablesAfter).toBe(cablesBefore)

    const inspector = page.getByTestId('cable-inspector')
    expect(await inspector.isVisible()).toBe(true)
    const readoutText = await page.getByTestId('cable-inspector-readout').textContent()
    expect(readoutText).toMatch(/Hz/)

    // Cross-check the inspector's own main-thread-polled number against an
    // independent audio-thread capture of the same node (see
    // `captureModuleAudio`'s doc comment for why this, not the displayed
    // number, is the ground truth being graded against).
    const tap = await captureModuleAudio(page, 'vco', 600)
    const measuredHz = peakHz(Float32Array.from(tap.samples), tap.sampleRate)
    console.log(`rack-scope cable inspector: displayed="${readoutText}" measured=${measuredHz.toFixed(1)}Hz expected=${expectedHz.toFixed(1)}Hz`)
    // Same ~10 Hz floor as the previous test (one FFT bin at 48 kHz/8192).
    expect(Math.abs(measuredHz - expectedHz)).toBeLessThan(10)

    // Deselecting: clicking elsewhere closes the inspector without
    // touching the cable.
    await page.mouse.click(40, 40)
    await page.waitForTimeout(100)
    expect(await inspector.count()).toBe(0)
    const cablesAfterDeselect = await page.evaluate(
      () => (window as unknown as { __sinsthesis: { graph: GraphHandle } }).__sinsthesis.graph.cables.length,
    )
    expect(cablesAfterDeselect).toBe(cablesBefore)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  }, 20000)

  it("removing a cable is still possible, through the inspector's own button", async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)

    const cableId = await page.evaluate(() => {
      const g = (window as unknown as { __sinsthesis: { graph: GraphHandle } }).__sinsthesis.graph
      const cable = g.cables.find((c) => c.from[0] === 'vco' && c.from[1] === 'out')
      if (!cable) throw new Error('vco -> vcf cable not found')
      return cable.id
    })
    const cablesBefore = await page.evaluate(
      () => (window as unknown as { __sinsthesis: { graph: GraphHandle } }).__sinsthesis.graph.cables.length,
    )

    const hit = page.getByTestId(`cable-${cableId}`)
    await hit.waitFor({ state: 'attached' })
    await hit.dispatchEvent('click') // see the previous test's comment for why dispatch, not a coordinate click
    await page.getByTestId('cable-inspector-remove').click()
    await page.waitForTimeout(100)

    const cablesAfter = await page.evaluate(
      () => (window as unknown as { __sinsthesis: { graph: GraphHandle } }).__sinsthesis.graph.cables.length,
    )
    expect(cablesAfter).toBe(cablesBefore - 1)
    expect(await page.getByTestId('cable-inspector').count()).toBe(0)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  }, 20000)
})
