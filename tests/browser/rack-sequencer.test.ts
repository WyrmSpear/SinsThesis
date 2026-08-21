import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { ViteDevServer } from 'vite'
import { createIsolatedServer, closeIsolatedServer } from './support/e2e-server'
import { chromium, type Browser, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
 * Retimes the clock's phase to "now" (`graph.setParam` on `bpm` always
 * calls `rescheduleGate`, per clock-module.ts), forces the sequencer back
 * to step 0, and wires an `AudioWorkletNode` tap onto the VCO's raw output
 * -- before the VCF/VCA/ADSR chain, matching the engine-level test's own
 * measurement point. All three happen in one synchronous `page.evaluate`
 * call so every scheduled time below is relative to the exact same `t0`.
 *
 * Root cause of the flake this guards against (see .superpowers/sdd/themes-
 * ten-eleven-twelve-report.md for the full account, reproduced with 4-way
 * parallel full-suite contention until it hit reliably): `rescheduleGate`
 * only re-times the *clock's own* gate edges from "now" -- it has no idea
 * the sequencer downstream exists, and correctly does not reset its step
 * counter (a tempo knob on real hardware doesn't rewind a running
 * sequence). `wireSequencerVoice` connects `clock.gate -> seq.clock`
 * *before* the drag under test even happens, at whatever tempo the clock
 * module's own default (120 BPM) gives it, and that clock keeps ticking on
 * the *audio* clock throughout however long the rest of the test setup
 * takes on the *main thread* -- normally a few hundred ms, easily several
 * seconds once the suite is fully loaded and every `page.evaluate` round
 * trip queues up behind sibling Chromium processes. By the time this
 * function's own reset runs, `sequencerStep`'s internal `state.index` (dsp/
 * segment.ts) has already advanced through however many steps the old
 * schedule fired in the meantime -- fast in isolation, arbitrarily far
 * under load -- so "the clock's first new edge after reset" lands on
 * whatever step the drift left it on, not step 0. Only `step1` was ever
 * programmed; every other step is still its default (0 oct, 440 Hz), so
 * landing on any step but 0 reads back as 440 Hz regardless of what the
 * drag set -- exactly the "two octaves low" symptom, and exactly why it
 * read as "the drag didn't register": from the audio's point of view nothing
 * downstream of the drag was ever wrong, the sequencer just wasn't looking
 * at step 1 anymore when the tap started listening.
 *
 * The fix drives the sequencer's own `reset` port (already in its
 * descriptor, just never wired by this test) directly: a throwaway
 * `ConstantSourceNode` pulsed 0 -> 1 -> 0 onto the same front `GainNode`
 * `wireSequencerVoice`'s cable would have driven. Two things had to be true
 * for this to actually be deterministic rather than just less flaky,
 * both found by reproducing under 4-way parallel full-suite contention
 * rather than assumed:
 *
 * 1. It must not race the OLD (pre-retime) schedule. A first attempt
 *    pulsed reset in its own `page.evaluate` call, then `waitForTimeout`ed
 *    before retiming the clock in a second call -- but during that real
 *    wall-clock gap the *old*, not-yet-cancelled schedule (still running on
 *    the audio clock regardless of JS timing) could fire another edge and
 *    immediately undo the reset. Measured: this made the failure rate
 *    *worse*, not better. The fix is ordering: retime the clock FIRST --
 *    `rescheduleGate`'s own `cancelScheduledValues` kills the old schedule
 *    atomically, with no gap for it to sneak in one more edge -- and only
 *    then reset.
 * 2. It must not race the NEW (post-retime) schedule's own immediate first
 *    edge. `ctx.currentTime` only advances once per 128-sample render
 *    quantum (~2.7 ms at 48 kHz), and two reads of it microseconds apart in
 *    the same JS task routinely return the identical value -- so scheduling
 *    the reset at bare `ctx.currentTime` right after the retime (still in
 *    the same call) could still land the reset's rising edge in the exact
 *    same quantum as the new schedule's own near-immediate first edge.
 *    `sequencerStep` processes both within that one call in that case: the
 *    reset sets `state.index = 0`, and the *same* sample's clock edge
 *    immediately advances it to 1 -- skipping step 0 and landing one step
 *    early. The fix is an explicit future offset, `RESET_SETTLE` (0.35 s),
 *    passed to `setValueAtTime` rather than "now" -- Web Audio schedules it
 *    exactly there in audio-clock time regardless of when the JS call
 *    itself actually runs, comfortably inside the 1 s gap between the new
 *    schedule's first edge (~0 s) and second edge (1 s), so it can never
 *    coincide with either.
 *
 * `windowAt` calls below read the first (step 1) window at
 * `RESET_SETTLE + MARGIN`, not bare `MARGIN`, to stay clear of the reset
 * pulse itself; the second (step 2) window stays at `1 + MARGIN` exactly as
 * before, since that boundary is the retime's own second edge and is
 * untouched by any of this.
 */
export const RESET_SETTLE = 0.35 // seconds after the clock retime before the reset pulse fires

async function captureVcoAudio(page: Page, captureMs: number, seqId: string): Promise<CaptureResult> {
  await page.evaluate(({ clockId, seqId, resetSettle }) => {
    const win = window as unknown as {
      __sinsthesis: {
        graph: {
          setParam(id: string, param: string, value: number): void
          getInstance(id: string): { inputs: Map<string, AudioNode | AudioParam>; outputs: Map<string, AudioNode> }
          moduleIds: readonly string[]
          getType(id: string): string
        }
        ctx: AudioContext
      }
      __seqTapChunks: { frame: number; samples: Float32Array }[]
    }
    const { graph, ctx } = win.__sinsthesis

    // 60 BPM, division 1 -- one step per second, matching
    // tests/browser/modules/sequencer.test.ts's own timing exactly.
    // Retime FIRST (see point 1 above): this atomically cancels whatever
    // schedule was already running and commits a fresh one from "now",
    // before the reset pulse below touches anything.
    graph.setParam(clockId, 'bpm', 60)
    graph.setParam(clockId, 'division', 1)

    // Force the sequencer to step 0, scheduled comfortably clear of both
    // the retime's own immediate first edge and its second edge one second
    // later (see point 2 above).
    const t0 = ctx.currentTime
    const resetFront = graph.getInstance(seqId).inputs.get('reset') as AudioNode
    const resetPulse = new ConstantSourceNode(ctx, { offset: 0 })
    resetPulse.connect(resetFront)
    resetPulse.start()
    resetPulse.offset.setValueAtTime(1, t0 + resetSettle)
    resetPulse.offset.setValueAtTime(0, t0 + resetSettle + 0.03)
    resetPulse.stop(t0 + resetSettle + 0.05)

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
  }, { clockId: await resolveClockId(page), seqId, resetSettle: RESET_SETTLE })

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

    const result = await captureVcoAudio(page, 2200, seqId)
    const samples = Float32Array.from(result.samples)

    const step1Hz = peakHz(windowAt(samples, RESET_SETTLE + MARGIN), result.sampleRate)
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

    const result = await captureVcoAudio(page, 2200, seqId)
    const samples = Float32Array.from(result.samples)

    const firstWindowHz = peakHz(windowAt(samples, RESET_SETTLE + MARGIN), result.sampleRate)
    const secondWindowHz = peakHz(windowAt(samples, 1 + MARGIN), result.sampleRate)

    console.log(`rack-sequencer steps=1: window1=${firstWindowHz.toFixed(1)}Hz window2=${secondWindowHz.toFixed(1)}Hz expected=${expectedHz.toFixed(1)}Hz`)

    // Both windows -- one that would have been step 2's slot at steps=2 --
    // now read step 1's programmed pitch: the loop no longer reaches step 2.
    expect(firstWindowHz).toBeCloseTo(expectedHz, -1)
    expect(secondWindowHz).toBeCloseTo(expectedHz, -1)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  }, 20000)

  it('a reordered rack round-trips through save/load with positions preserved', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)

    // Drag the VCF module's header to before the Keyboard/MIDI module --
    // the leftmost slot -- through real pointer events on rack/reorder.ts's
    // drag surface (the module header, not the panel body).
    const vcfHeader = page.locator('.module-panel[data-module="vcf"] .module-header')
    const keyboardPanel = page.locator('.module-panel[data-module="keyboard"]')
    const vcfBox = await vcfHeader.boundingBox()
    const kbBox = await keyboardPanel.boundingBox()
    if (!vcfBox || !kbBox) throw new Error('module has no bounding box')

    await page.mouse.move(vcfBox.x + vcfBox.width / 2, vcfBox.y + vcfBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(kbBox.x + 5, kbBox.y + kbBox.height / 2, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(150)

    interface SlotSnapshot { moduleIds: string[]; slots: Record<string, [number, number]> }
    const readSlots = (): Promise<SlotSnapshot> =>
      page.evaluate(() => {
        const g = (window as unknown as { __sinsthesis: { graph: { moduleIds: readonly string[]; getSlot(id: string): [number, number] } } }).__sinsthesis.graph
        const slots: Record<string, [number, number]> = {}
        for (const id of g.moduleIds) slots[id] = g.getSlot(id)
        return { moduleIds: [...g.moduleIds].sort(), slots }
      }) as unknown as Promise<SlotSnapshot>

    const before = await readSlots()
    // The drag actually moved it: VCF now sits at column 0, ahead of every
    // module that used to precede it.
    expect(before.slots['vcf']).toEqual([0, 0])
    expect(before.slots['keyboard']).toEqual([0, 1])

    const domOrderBefore = await page.evaluate(() =>
      [...document.querySelectorAll('#rack-modules > .module-panel')].map((p) => (p as HTMLElement).dataset['module']),
    )
    expect(domOrderBefore[0]).toBe('vcf')

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

    const tmpPath = join(tmpdir(), `rack-reorder-${Date.now()}-${Math.random().toString(36).slice(2)}.sinp`)
    writeFileSync(tmpPath, patchText)

    try {
      // Mutate the live rack before loading -- removing a module proves the
      // load actually rebuilds state rather than the state having never
      // changed, same guard the existing save/load test uses.
      await page.getByTestId('remove-lfo').click()

      await page.getByTestId('load-patch').click()
      await page.getByTestId('load-file-input').setInputFiles(tmpPath)
      await page.waitForTimeout(200)

      const after = await readSlots()
      expect(after).toEqual(before)

      const domOrderAfter = await page.evaluate(() =>
        [...document.querySelectorAll('#rack-modules > .module-panel')].map((p) => (p as HTMLElement).dataset['module']),
      )
      expect(domOrderAfter[0]).toBe('vcf')
      expect(domOrderAfter[1]).toBe('keyboard')
    } finally {
      unlinkSync(tmpPath)
    }

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  }, 20000)

  it('cancelling a module-reorder drag (pointercancel) leaves no panel stuck in the picked-up state', async () => {
    // rack/reorder.ts had the exact same missing-pointercancel bug as
    // rack/cables.ts (see that file's own header comment and the cable
    // drag-cancel test in rack-page.test.ts): only `pointerup` ended a
    // drag, so a touch scroll/zoom takeover mid-reorder left `draggingEl`
    // wedged forever -- the panel stuck at reduced opacity
    // (`.module-dragging`) and every future `pointermove` anywhere in the
    // window still shoving it around the rack.
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)

    const vcfHeader = page.locator('.module-panel[data-module="vcf"] .module-header')
    const keyboardPanel = page.locator('.module-panel[data-module="keyboard"]')
    const vcfBox = await vcfHeader.boundingBox()
    const kbBox = await keyboardPanel.boundingBox()
    if (!vcfBox || !kbBox) throw new Error('module has no bounding box')

    await page.evaluate(() => {
      ;(window as unknown as { __capturedPointerId?: number }).__capturedPointerId = undefined
      window.addEventListener(
        'pointerdown',
        (e) => {
          ;(window as unknown as { __capturedPointerId?: number }).__capturedPointerId = e.pointerId
        },
        { capture: true, once: true },
      )
    })

    await page.mouse.move(vcfBox.x + vcfBox.width / 2, vcfBox.y + vcfBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(kbBox.x + 5, kbBox.y + kbBox.height / 2, { steps: 10 })

    // A real drag is in progress -- the VCF panel is visibly picked up.
    await expect
      .poll(() => page.locator('.module-panel[data-module="vcf"].module-dragging').count())
      .toBe(1)

    const pointerId = await page.evaluate(
      () => (window as unknown as { __capturedPointerId?: number }).__capturedPointerId,
    )
    if (pointerId === undefined) throw new Error('pointerdown never fired')
    await page.evaluate((pid: number) => {
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: pid, bubbles: true, cancelable: true }))
    }, pointerId)

    // Torn down immediately -- not stuck at reduced opacity, and dragging
    // the mouse further (Playwright's button is still physically "down")
    // no longer moves anything, proving `draggingEl` was actually cleared
    // rather than just the CSS class.
    await expect
      .poll(() => page.locator('.module-panel[data-module="vcf"].module-dragging').count())
      .toBe(0)

    const domOrderAfterCancel = await page.evaluate(() =>
      [...document.querySelectorAll('#rack-modules > .module-panel')].map((p) => (p as HTMLElement).dataset['module']),
    )

    await page.mouse.move(kbBox.x + 400, kbBox.y + kbBox.height / 2, { steps: 5 })
    const domOrderAfterFurtherMove = await page.evaluate(() =>
      [...document.querySelectorAll('#rack-modules > .module-panel')].map((p) => (p as HTMLElement).dataset['module']),
    )
    expect(domOrderAfterFurtherMove).toEqual(domOrderAfterCancel)

    await page.mouse.up()

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  }, 20000)
})
