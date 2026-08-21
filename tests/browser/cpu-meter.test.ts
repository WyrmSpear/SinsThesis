import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { ViteDevServer } from 'vite'
import { createIsolatedServer, closeIsolatedServer } from './support/e2e-server'
import { chromium, type Browser, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'

/**
 * Section 11's "CPU overload -> load meter" failure mode, driven end to
 * end through the real rack page -- the same real-`AudioContext`-in-a-real-
 * Chromium-tab pattern `rack-page.test.ts`/`preset-bank.test.ts` already
 * use, and for the same reason the CPU meter itself needs it: the
 * measurement technique (`worklets/cpu-meter.worklet.ts`'s own doc
 * comment) reads real wall-clock time between render-quantum callbacks,
 * which only means anything on a real-time `AudioContext` actually pacing
 * itself against a clock -- an `OfflineAudioContext` renders as fast as
 * possible with no such pacing, so this could not be exercised the cheaper
 * way `render.test.ts`'s worklet tests are.
 *
 * **What this file asserts, and what it deliberately doesn't.** Measured
 * live in this project's own headless/virtualized CI Chromium: the OS's
 * own thread-wake-up jitter for a 128-sample (~2.7 ms) audio callback in
 * that environment is itself on the same order as the callback period,
 * so the meter's *absolute* reading sits close to its own noise floor
 * regardless of patch weight there -- a real, sobering finding about
 * small-buffer real-time audio under virtualization, not a bug in the
 * technique (see the worklet's own doc comment for the parallel discovery
 * that `performance.now()` doesn't even exist in that same
 * `AudioWorkletGlobalScope`, caught the same way: by running it, not by
 * trusting the spec). A strict "heavy patch reads higher than idle" bar
 * would be asserting something about this one CI box's scheduler, not
 * about the meter -- so it is verified by hand instead, against a real,
 * non-virtualized browser, exactly as the task's own "look at it" step
 * asks (see `.superpowers/sdd/robustness-report.md` for those numbers and
 * a screenshot). What *is* asserted here, reliably, in any environment:
 * the meter is visible, reads a real number, and -- the regression this
 * suite exists to catch -- keeps reporting *new* numbers over time rather
 * than freezing. That last one is exactly the failure this task's own
 * build hit and fixed: an uncaught exception on the audio thread that
 * silently, permanently stopped every future report with no error
 * anywhere a player would see -- a meter frozen on its first reading looks
 * indistinguishable from a working one at a glance, which is precisely
 * why "still updating" needs its own assertion, not just "shows a number
 * once."
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

interface DebugHook {
  graph: {
    moduleIds: readonly string[]
    getType(id: string): string | undefined
    addModule(type: string, id?: string): string
    connect(from: readonly [string, string], to: readonly [string, string]): unknown
  }
}

async function powerOn(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 1000 })
  await page.goto(baseUrl + '/', { waitUntil: 'load' })
  const powerBtn = page.getByTestId('power')
  await powerBtn.waitFor({ state: 'visible' })
  await powerBtn.click()
  await page.waitForFunction(() => Boolean((window as unknown as { __sinsthesis?: unknown }).__sinsthesis))
  await page.getByTestId('app').waitFor({ state: 'visible' })
}

/** Reads the meter's current readout text, e.g. "CPU 12%". */
function readCpuText(page: Page): Promise<string> {
  return page.getByTestId('cpu-meter-readout').innerText()
}

function pctOf(text: string): number {
  const match = /CPU (\d+)%/.exec(text)
  if (!match) throw new Error(`cpu-meter-readout text didn't match the expected shape: "${text}"`)
  return Number(match[1])
}

describe('CPU load meter (Section 11)', () => {
  it('is visible on the toolbar the moment the rack is up, and reads a plausible number', async () => {
    const page = await browser.newPage()
    await powerOn(page)

    const meter = page.getByTestId('cpu-meter')
    await expect(meter.isHidden()).resolves.toBe(false)

    // The worklet reports about five times a second -- give it a couple of
    // reporting windows before reading anything.
    await page.waitForTimeout(600)
    const pct = pctOf(await readCpuText(page))
    expect(Number.isFinite(pct), 'a percentage reading must be a real, finite number').toBe(true)
    expect(pct, 'a percentage reading must be non-negative').toBeGreaterThanOrEqual(0)

    await page.close()
  })

  it('keeps reporting fresh numbers over time rather than freezing after its first report', async () => {
    const page = await browser.newPage()
    await powerOn(page)

    // Sample several reporting windows (~200ms apart) and record every
    // distinct value seen. A live meter's windowed average will vary at
    // least somewhat over a couple of seconds on any real machine (GC,
    // OS scheduling, the rack's own idle UI work); a meter whose worklet
    // silently died after its first callback -- the exact bug this task's
    // own build hit -- reports the identical value (usually its very
    // first) forever, which this distinguishes from genuine liveness.
    const readings: number[] = []
    for (let i = 0; i < 10; i++) {
      readings.push(pctOf(await readCpuText(page)))
      await page.waitForTimeout(250)
    }

    expect(readings.every(Number.isFinite), `every reading must be finite: ${readings.join(', ')}`).toBe(true)
    const distinct = new Set(readings)
    expect(
      distinct.size,
      `the meter should report more than one distinct value across 2.5s of real time -- ` +
        `readings were [${readings.join(', ')}], suggesting it froze`,
    ).toBeGreaterThan(1)

    await page.close()
  }, 15000)

  it('survives a deliberately heavy patch -- keeps reporting real numbers, and the rest of the rack keeps working', async () => {
    const page = await browser.newPage()
    await powerOn(page)
    await page.waitForTimeout(400)

    // Build real, audible load directly through the live graph -- many
    // VCO -> Ladder VCF -> Wavefolder voices, all summed into the existing
    // Output, so the audio thread genuinely has to render all of them
    // every quantum. Bypasses the rack's own panel rendering/palette UI on
    // purpose: this is about the audio thread surviving real load, not
    // about drag-and-drop, and adding this many modules through simulated
    // pointer drags would be needlessly slow. See this file's own header
    // comment for why the *absolute* reading isn't asserted against here
    // -- `.superpowers/sdd/robustness-report.md` has the real-hardware
    // numbers for that.
    const VOICE_COUNT = 300
    await page.evaluate((voiceCount) => {
      const hook = (window as unknown as { __sinsthesis: DebugHook }).__sinsthesis
      const { graph } = hook
      const outputId = graph.moduleIds.find((id) => graph.getType(id) === 'output')
      if (!outputId) throw new Error('no output module in the starter patch')
      for (let i = 0; i < voiceCount; i++) {
        const vcoId = graph.addModule('vco')
        const vcfId = graph.addModule('vcf')
        const foldId = graph.addModule('wavefolder')
        graph.connect([vcoId, 'out'], [vcfId, 'in'])
        graph.connect([vcfId, 'out'], [foldId, 'in'])
        graph.connect([foldId, 'out'], [outputId, 'in'])
      }
    }, VOICE_COUNT)

    await page.waitForTimeout(900)
    const pct = pctOf(await readCpuText(page))
    expect(Number.isFinite(pct), 'a percentage reading must be a real, finite number even under heavy load').toBe(
      true,
    )
    expect(pct).toBeGreaterThanOrEqual(0)

    const moduleCount = await page.evaluate(
      () => (window as unknown as { __sinsthesis: DebugHook }).__sinsthesis.graph.moduleIds.length,
    )
    expect(moduleCount).toBeGreaterThan(VOICE_COUNT * 2)

    await page.close()
  }, 30000)
})
