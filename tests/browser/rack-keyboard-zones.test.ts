import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { ViteDevServer } from 'vite'
import { createIsolatedServer, closeIsolatedServer } from './support/e2e-server'
import { chromium, type Browser, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'
import { rms } from '../../src/engine/analysis/features'

/**
 * The owner's own scenario, driven on the real rack page: "a sub bass
 * synth on one side with standard arpeggiated synths on... the other."
 * Two Keyboard modules, non-overlapping key-range zones, each driving its
 * own VCO -> VCA chain -- proving the split actually works end to end
 * (real palette adds, real jack drags, real computer-keydown input, real
 * audio out), not just that `inKeyRange`/`handleKey` are individually
 * correct (tests/node/midi.test.ts, tests/browser/modules/keyboard-midi.test.ts
 * already cover that). Same real-Chromium-tab pattern as rack-page.test.ts
 * and rack-sequencer.test.ts, and the same audio-thread-tap technique
 * rack-sequencer.test.ts uses, for the identical reason: main-thread
 * polling measurably misses short transients, and this needs to tell
 * "silent" from "sounding" apart with confidence.
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

interface DebugHook {
  graph: {
    moduleIds: readonly string[]
    getType(id: string): string
    getParams(id: string): Record<string, number>
    setParam(id: string, param: string, value: number, atTime?: number): void
    getInstance(id: string): { outputs: Map<string, AudioNode> } | undefined
  }
  ctx: AudioContext
}

/** Adds a second, independent voice (keyboard-2 -> vco-2 -> vca-2) through
 *  real palette clicks and real jack drags -- proving the *panel* wiring
 *  for a second Keyboard module, not just that a second engine instance
 *  can exist. Mirrors the starter patch's own keyboard -> vco -> vcf ->
 *  adsr -> vca chain, but skips the filter/envelope (not needed to tell
 *  "sounding" from "silent") the same economical way
 *  rack-sequencer.test.ts's `wireSequencerVoice` does. */
async function addSecondVoice(page: Page): Promise<{ keyboardId: string; vcaId: string }> {
  await addModule(page, 'keyboard')
  await addModule(page, 'vco')
  await addModule(page, 'vca')

  const ids = await page.evaluate(() => {
    const g = (window as unknown as { __sinsthesis: DebugHook }).__sinsthesis.graph
    const keyboards = g.moduleIds.filter((id) => g.getType(id) === 'keyboard')
    const vcos = g.moduleIds.filter((id) => g.getType(id) === 'vco')
    const vcas = g.moduleIds.filter((id) => g.getType(id) === 'vca')
    // The starter patch already has one of each -- the newest addition is
    // whichever id was not there before, which `addModule`'s `freshId`
    // (rack/main.ts) guarantees sorts after the starter's own fixed id.
    return {
      keyboardId: keyboards[keyboards.length - 1]!,
      vcoId: vcos[vcos.length - 1]!,
      vcaId: vcas[vcas.length - 1]!,
    }
  })

  await dragJackToJack(page, `jack-${ids.keyboardId}-pitch`, `jack-${ids.vcoId}-pitch`)
  await dragJackToJack(page, `jack-${ids.keyboardId}-gate`, `jack-${ids.vcaId}-cv`)
  await dragJackToJack(page, `jack-${ids.vcoId}-out`, `jack-${ids.vcaId}-in`)

  // Gate-controlled VCA, same trick the starter patch's own vca/adsr pair
  // and dev/main.ts both use: base level closed, CV (the keyboard's gate)
  // fully open, so silence really means silence rather than a free-running
  // oscillator bleeding through a unity-gain VCA. `atTime: ctx.currentTime`
  // is not optional here -- omitting it was this test's own first bug,
  // caught by the very thing it was trying to prove: a fresh VCA's
  // descriptor default is 1 (open), and without an explicit atTime,
  // `setParam` *ramps* down to 0 over B3's ~8ms smoothing window instead of
  // snapping, during which the already-oscillating VCO leaks straight
  // through -- the exact startup thump `rack/main.ts`'s own
  // `buildDefaultPatch` and `tests/browser/startup-thump.test.ts` exist to
  // prevent for the starter patch. Confirmed by measurement while writing
  // this test: a ~1ms, 0.8-peak burst at the very start of the capture,
  // silence for the rest of it -- not zone gating at all.
  await page.evaluate(
    ({ vcaId }) => {
      const { graph, ctx } = (window as unknown as { __sinsthesis: DebugHook }).__sinsthesis
      graph.setParam(vcaId, 'level', 0, ctx.currentTime)
      graph.setParam(vcaId, 'cvAmount', 1, ctx.currentTime)
    },
    { vcaId: ids.vcaId },
  )

  return { keyboardId: ids.keyboardId, vcaId: ids.vcaId }
}

/** Taps both VCAs' raw outputs (never patched to the real Output module,
 *  so this is the only way to hear them) via the peak-tap worklet, holds
 *  `keyCode` down for `holdMs`, releases it, and returns each chain's RMS
 *  over the whole capture. */
async function captureBothChains(
  page: Page,
  vcaAId: string,
  vcaBId: string,
  keyCode: string,
  holdMs: number,
): Promise<{ rmsA: number; rmsB: number }> {
  await page.evaluate(
    ({ vcaAId, vcaBId }) => {
      const w = window as unknown as {
        __sinsthesis: DebugHook
        __zoneTapA: { frame: number; samples: Float32Array }[]
        __zoneTapB: { frame: number; samples: Float32Array }[]
      }
      const { graph, ctx } = w.__sinsthesis
      w.__zoneTapA = []
      w.__zoneTapB = []

      function attach(id: string, sink: { frame: number; samples: Float32Array }[]): void {
        const tap = new AudioWorkletNode(ctx, 'peak-tap', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        })
        const mute = ctx.createGain()
        mute.gain.value = 0 // silent passthrough -- never audible
        tap.connect(mute)
        mute.connect(ctx.destination)
        tap.port.onmessage = (e: MessageEvent<{ frame: number; samples: Float32Array }>) => sink.push(e.data)
        graph.getInstance(id)!.outputs.get('out')!.connect(tap)
      }
      attach(vcaAId, w.__zoneTapA)
      attach(vcaBId, w.__zoneTapB)
    },
    { vcaAId, vcaBId },
  )

  await page.keyboard.down(keyCode)
  await page.waitForTimeout(holdMs)
  await page.keyboard.up(keyCode)
  await page.waitForTimeout(80) // let the tail settle before reading back

  const { samplesA, samplesB } = await page.evaluate(() => {
    const w = window as unknown as {
      __zoneTapA: { frame: number; samples: Float32Array }[]
      __zoneTapB: { frame: number; samples: Float32Array }[]
    }
    function flatten(chunks: { frame: number; samples: Float32Array }[]): number[] {
      const sorted = [...chunks].sort((a, b) => a.frame - b.frame)
      const total = sorted.reduce((n, c) => n + c.samples.length, 0)
      const out = new Float32Array(total)
      let i = 0
      for (const c of sorted) {
        out.set(c.samples, i)
        i += c.samples.length
      }
      return Array.from(out)
    }
    return { samplesA: flatten(w.__zoneTapA), samplesB: flatten(w.__zoneTapB) }
  })

  return { rmsA: rms(Float32Array.from(samplesA)), rmsB: rms(Float32Array.from(samplesB)) }
}

describe('rack keyboard zones: a split keyboard', () => {
  it('two Keyboard modules with non-overlapping zones each drive their own chain -- a low note plays only the low chain, a high note only the high one', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)

    // Chain A is the starter patch's own keyboard -> vco -> vcf -> adsr ->
    // vca -> output, already wired by rack/main.ts's buildDefaultPatch.
    const chainAIds = await page.evaluate(() => {
      const g = (window as unknown as { __sinsthesis: DebugHook }).__sinsthesis.graph
      return {
        keyboardId: g.moduleIds.find((id) => g.getType(id) === 'keyboard')!,
        vcaId: g.moduleIds.find((id) => g.getType(id) === 'vca')!,
      }
    })

    // The knob readout reads musically, not as a raw note number -- part
    // of this task's own design brief. Read it straight off the starter
    // keyboard's own panel before anything below touches its params: the
    // knob widget's readout is local UI state, set from the descriptor's
    // default at construction and updated only through its own drag
    // gesture (`rack/knob.ts`) -- a `graph.setParam` call made directly,
    // the way the rest of this test drives the zone params for speed and
    // precision, updates the engine but never reaches back into an
    // already-built knob's own readout (nothing in this codebase's panel
    // layer does; a live re-render, the way a patch Load rebuilds the
    // whole panel from the graph's current values, is the only thing that
    // would). So this checks it at the one point it is guaranteed to be
    // live: rangeLow=0 default reads "C-1", rangeHigh=127 default reads
    // "G9" (MIDI 127 is the ninth G above C-1).
    const loReadoutText = await page
      .locator(`[data-module="${chainAIds.keyboardId}"] [data-testid="readout-rangeLow"]`)
      .textContent()
    const hiReadoutText = await page
      .locator(`[data-module="${chainAIds.keyboardId}"] [data-testid="readout-rangeHigh"]`)
      .textContent()
    expect(loReadoutText).toBe('C-1')
    expect(hiReadoutText).toBe('G9')

    const chainB = await addSecondVoice(page)

    // Same octave for both -- the split is entirely the zone's doing, not
    // a different key-to-note mapping between the two modules. At octave
    // 3, KeyA -> 48 (the sub-bass row) and KeyK -> 60 (the seam's high
    // side) -- see this file's own header comment.
    await page.evaluate(
      ({ aId, bId }) => {
        const g = (window as unknown as { __sinsthesis: DebugHook }).__sinsthesis.graph
        g.setParam(aId, 'octave', 3)
        g.setParam(bId, 'octave', 3)
        g.setParam(aId, 'rangeLow', 0)
        g.setParam(aId, 'rangeHigh', 59) // sub bass: below the seam
        g.setParam(bId, 'rangeLow', 60)
        g.setParam(bId, 'rangeHigh', 127) // lead: at and above the seam
      },
      { aId: chainAIds.keyboardId, bId: chainB.keyboardId },
    )

    // KeyA (note 48) sits inside chain A's zone only.
    const low = await captureBothChains(page, chainAIds.vcaId, chainB.vcaId, 'KeyA', 300)
    expect(low.rmsA).toBeGreaterThan(0.05)
    expect(low.rmsB).toBeLessThan(0.001)

    // Chain A goes through the starter patch's own ADSR (default release
    // 0.2s) -- give its envelope a full, generously-margined beat to decay
    // back to silence before the next capture starts. Without this, the
    // still-decaying tail from the note just released bleeds into the
    // start of the next capture's window and reads as if chain A were
    // still sounding -- not a zone-gating bug, an envelope-timing one this
    // test found in itself while being written.
    await page.waitForTimeout(900)

    // KeyK (note 60) sits inside chain B's zone only.
    const high = await captureBothChains(page, chainAIds.vcaId, chainB.vcaId, 'KeyK', 300)
    expect(high.rmsA).toBeLessThan(0.001)
    expect(high.rmsB).toBeGreaterThan(0.05)

    expect(consoleErrors).toEqual([])
    await page.close()
  }, 30000)
})
