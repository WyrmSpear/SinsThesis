import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'
import { peakHz } from '../../src/engine/analysis/features'

/**
 * Rack-level sequencer proof, driving the real page (index.html +
 * rack/main.ts) in an actual Chromium tab, same pattern as
 * rack-page.test.ts and for the same reasons. Two things this file proves
 * that the engine-level test (tests/browser/modules/sequencer.test.ts) and
 * the theme/geometry tests do not:
 *
 * 1. The panel is real: dragging a step slider and the `steps` knob through
 *    real pointer events (not `graph.setParam` called directly from test
 *    code) is what actually changes what the sequencer plays -- proving the
 *    custom panel (rack/sequencer-panel.ts) is correctly wired to the
 *    engine, not just that the engine itself works.
 * 2. It sequences on a *live* `AudioContext`, not an offline render: the
 *    clock's rolling-horizon scheduling (clock-module.ts) and the
 *    processor's real audio-thread callback cadence only run under a live
 *    context, and a live context is also the only place the panel's
 *    playhead has anything to report. Audio assertions use an
 *    `AudioWorkletNode` tap wired onto the live rack's own `AudioContext`
 *    (`window.__sinsthesis.ctx`) -- the same audio-thread-tap technique
 *    `dev/thump-harness.ts` and `dev/sequencer-tap-harness.ts` use, and for
 *    the same reason their doc comments give: main-thread polling
 *    (`requestAnimationFrame`, a timed `graph.getParams` read) measurably
 *    misses transients this short.
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
  // Same wide/tall viewport as rack-page.test.ts, same reason: this test
  // adds two more modules on top of the seven-module starter patch and
  // needs every jack reachable without scrolling mid-drag.
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

/** Builds clock -> seq.clock, seq.cv -> vco.pitch through real cable drags
 *  (the starter patch's own VCO -> VCF -> VCA -> Output chain, so the tap
 *  below reads a voice that's already part of the live rendering graph --
 *  see rack/main.ts's starter patch). Returns the two new modules' ids. */
async function wireSequencerVoice(page: Page): Promise<{ clockId: string; seqId: string }> {
  await addModule(page, 'clock')
  await addModule(page, 'seq')

  const ids = await page.evaluate(() => {
    const g = (window as unknown as { __sinsthesis: { graph: { moduleIds: readonly string[]; getType(id: string): string } } }).__sinsthesis.graph
    return {
      clockId: g.moduleIds.find((id) => g.getType(id) === 'clock')!,
      seqId: g.moduleIds.find((id) => g.getType(id) === 'seq')!,
    }
  })

  await dragJackToJack(page, `jack-${ids.clockId}-gate`, `jack-${ids.seqId}-clock`)
  await dragJackToJack(page, `jack-${ids.seqId}-cv`, 'jack-vco-pitch')

  return ids
}

interface CaptureResult {
  samples: number[]
  sampleRate: number
}

/**
 * Resets the clock's phase to "now" (`graph.setParam` on `bpm` always calls
 * `rescheduleGate`, per clock-module.ts) and, in the same synchronous
 * `page.evaluate` call, wires an `AudioWorkletNode` tap onto the VCO's raw
 * output -- before the VCF/VCA/ADSR chain, matching the engine-level test's
 * own measurement point. Doing both in one call (no `await` between them)
 * is what makes "now" mean the same instant for the clock's new epoch and
 * for the tap's first captured sample, so the window offsets below line up
 * with the step grid.
 */
async function captureVcoAudio(page: Page, captureMs: number): Promise<CaptureResult> {
  await page.evaluate((clockId) => {
    const win = window as unknown as {
      __sinsthesis: { graph: { setParam(id: string, param: string, value: number): void; getInstance(id: string): { outputs: Map<string, AudioNode> }; moduleIds: readonly string[]; getType(id: string): string }; ctx: AudioContext }
      __seqTapChunks: { frame: number; samples: Float32Array }[]
    }
    const { graph, ctx } = win.__sinsthesis
    // 60 BPM, division 1 -- one step per second, matching
    // tests/browser/modules/sequencer.test.ts's own timing exactly, and
    // resets the step grid to start "now".
    graph.setParam(clockId, 'bpm', 60)
    graph.setParam(clockId, 'division', 1)

    const tap = new AudioWorkletNode(ctx, 'peak-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    const mute = ctx.createGain()
    mute.gain.value = 0 // silent passthrough -- never audible
    tap.connect(mute)
    mute.connect(ctx.destination)

    win.__seqTapChunks = []
    tap.port.onmessage = (e: MessageEvent<{ frame: number; samples: Float32Array }>) => {
      win.__seqTapChunks.push(e.data)
    }

    const vcoId = graph.moduleIds.find((id) => graph.getType(id) === 'vco')!
    graph.getInstance(vcoId).outputs.get('out')!.connect(tap)
  }, await resolveClockId(page))

  await page.waitForTimeout(captureMs)

  return page.evaluate(() => {
    const win = window as unknown as {
      __sinsthesis: { ctx: AudioContext }
      __seqTapChunks: { frame: number; samples: Float32Array }[]
    }
    const chunks = [...win.__seqTapChunks].sort((a, b) => a.frame - b.frame)
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

async function resolveClockId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const g = (window as unknown as { __sinsthesis: { graph: { moduleIds: readonly string[]; getType(id: string): string } } }).__sinsthesis.graph
    return g.moduleIds.find((id) => g.getType(id) === 'clock')!
  })
}

const SR = 48000
const WINDOW = 16384
const MARGIN = 0.2 // seconds clear of a step boundary, matching the engine-level test

function windowAt(samples: Float32Array, seconds: number): Float32Array {
  const start = Math.floor(seconds * SR)
  return samples.subarray(start, start + WINDOW)
}

describe('rack sequencer', () => {
  it('dragging a step slider changes the pitch that step plays', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)
    const { seqId } = await wireSequencerVoice(page)

    // Step 2 is left at its descriptor default (0 oct, 440 Hz) -- the
    // control. Step 1 is dragged a real 100px up the slider through actual
    // pointer events, the same drag mechanics rack-page.test.ts's knob test
    // uses, not a direct `graph.setParam` call -- this is what proves the
    // *panel*, not just the engine, is wired correctly.
    const slider1 = page.getByTestId('slider-step1')
    const box = await slider1.boundingBox()
    if (!box) throw new Error('slider has no bounding box')
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx, cy - 100, { steps: 8 })
    await page.mouse.up()

    const params = await page.evaluate(
      (id) => (window as unknown as { __sinsthesis: { graph: { getParams(id: string): Record<string, number> } } }).__sinsthesis.graph.getParams(id),
      seqId,
    )
    const step1Value = params['step1']!
    const step2Value = params['step2']!
    expect(step1Value).toBeGreaterThan(0.3) // the drag actually moved it well off the default
    expect(step2Value).toBe(0) // untouched control

    const expectedStep1Hz = 440 * 2 ** step1Value
    const expectedStep2Hz = 440 * 2 ** step2Value

    const result = await captureVcoAudio(page, 2200)
    const samples = Float32Array.from(result.samples)

    const step1Hz = peakHz(windowAt(samples, MARGIN), result.sampleRate)
    const step2Hz = peakHz(windowAt(samples, 1 + MARGIN), result.sampleRate)

    console.log(`rack-sequencer step program: step1=${step1Hz.toFixed(1)}Hz (expected ~${expectedStep1Hz.toFixed(1)}), step2=${step2Hz.toFixed(1)}Hz (expected ~${expectedStep2Hz.toFixed(1)})`)

    expect(step1Hz).toBeCloseTo(expectedStep1Hz, -1)
    expect(step2Hz).toBeCloseTo(expectedStep2Hz, -1)
    // The whole point: the two steps now sound different, and step1's own
    // programmed pitch -- not the descriptor default -- is what played.
    expect(Math.abs(step1Hz - step2Hz)).toBeGreaterThan(50)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  }, 20000)

  it('dragging the steps knob down to 1 shortens the loop -- every step boundary plays the same pitch', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)
    const { seqId } = await wireSequencerVoice(page)

    // Program step1 and step2 to clearly different pitches first, exactly
    // like the previous test, so a failure to shorten the loop (still
    // alternating) is unmistakable rather than accidentally passing because
    // both steps already sounded the same.
    const slider1 = page.getByTestId('slider-step1')
    const s1Box = await slider1.boundingBox()
    if (!s1Box) throw new Error('slider has no bounding box')
    await page.mouse.move(s1Box.x + s1Box.width / 2, s1Box.y + s1Box.height / 2)
    await page.mouse.down()
    await page.mouse.move(s1Box.x + s1Box.width / 2, s1Box.y + s1Box.height / 2 - 100, { steps: 8 })
    await page.mouse.up()

    // Real hardware-style "steps" knob drag, down from its default of 8 to
    // 1 -- vertical drag downward lowers a knob's value, same convention
    // rack/knob.ts uses everywhere else in the rack.
    const stepsKnob = page.getByTestId('knob-steps')
    const kBox = await stepsKnob.boundingBox()
    if (!kBox) throw new Error('knob has no bounding box')
    await page.mouse.move(kBox.x + kBox.width / 2, kBox.y + kBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(kBox.x + kBox.width / 2, kBox.y + kBox.height / 2 + 180, { steps: 8 })
    await page.mouse.up()

    const params = await page.evaluate(
      (id) => (window as unknown as { __sinsthesis: { graph: { getParams(id: string): Record<string, number> } } }).__sinsthesis.graph.getParams(id),
      seqId,
    )
    expect(params['steps']).toBe(1)
    const step1Value = params['step1']!
    const expectedHz = 440 * 2 ** step1Value

    const result = await captureVcoAudio(page, 2200)
    const samples = Float32Array.from(result.samples)

    const firstWindowHz = peakHz(windowAt(samples, MARGIN), result.sampleRate)
    const secondWindowHz = peakHz(windowAt(samples, 1 + MARGIN), result.sampleRate)

    console.log(`rack-sequencer steps=1: window1=${firstWindowHz.toFixed(1)}Hz window2=${secondWindowHz.toFixed(1)}Hz expected=${expectedHz.toFixed(1)}Hz`)

    // Both windows -- one that would have been step 2's slot at steps=2 --
    // now read step 1's programmed pitch: the loop no longer reaches step 2.
    expect(firstWindowHz).toBeCloseTo(expectedHz, -1)
    expect(secondWindowHz).toBeCloseTo(expectedHz, -1)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  }, 20000)
})
