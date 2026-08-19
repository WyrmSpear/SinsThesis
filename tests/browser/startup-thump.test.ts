import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'

/**
 * Reproduces, and then guards against, the power-on thump: the VCA opens
 * fully open by construction and default (`level` defaults to 1), so
 * whatever closes it for a fresh, note-not-yet-played voice does so with
 * `graph.setParam(vca, 'level', 0)` -- the same call `dev/main.ts`'s real
 * boot makes. That call goes through `scheduleParam` (param-smoothing.ts),
 * which with no `atTime` is a `setTargetAtTime` ramp, not a snap. The
 * voice's last cable (VCF -> VCA) lands a moment later, while that ramp is
 * still close to its starting value, so real oscillator signal rides the
 * still-near-open gain out before the ramp finishes decaying.
 *
 * This needs a *live* `AudioContext`, not `OfflineAudioContext`: an
 * offline render has no real-time buffering ahead of `ctx.currentTime`, so
 * every scheduled event lands exactly where it's asked to and this defect
 * does not reproduce there at all -- which is exactly why it survived this
 * long. A live context's audio thread runs ahead of `ctx.currentTime` by
 * its own output latency, so a handful of render quanta already committed
 * to the pre-change gain value reach the tap before the ramp-down is heard
 * from at all.
 *
 * The measurement itself has to run on the audio thread too. Main-thread
 * polling (`ScriptProcessorNode`, an `AnalyserNode` read on a
 * `requestAnimationFrame` cadence) is what produced the earlier
 * "intermittent" read on this bug -- 2 hits in 42 boots, against 30/30 for
 * an `AudioWorkletNode` tap. `dev/thump-harness.ts` is that tap: it wires
 * an `AudioWorkletNode` onto the VCA's output *before* the graph exists,
 * so it captures from the first sample the voice ever produces, then
 * replicates `dev/main.ts`'s exact construction and cable order for the
 * VCO -> VCF -> VCA voice.
 *
 * Lives in its own "e2e" vitest project (environment: 'node'), like
 * dev-page.test.ts: it needs a real Vite dev server and a real, trusted
 * user gesture to satisfy the browser's autoplay policy on `AudioContext`
 * (a JS-dispatched click leaves the context suspended, producing no
 * samples at all -- confirmed while building this test, not assumed).
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

interface ThumpResult {
  peakDb: number
  peakSampleIndex: number
  lastLoudSampleIndex: number
  durationMs: number
  totalSamples: number
  sampleRate: number
}

/** Runs one boot repro in a fresh page and returns the measured result.
 *  A real, trusted click (via CDP, not `dispatchEvent`) is what lets the
 *  `AudioContext` this harness creates actually start running. */
async function bootOnce(page: Page): Promise<ThumpResult> {
  await page.goto(baseUrl + '/harness.html', { waitUntil: 'load' })
  await page.addScriptTag({ url: '/dev/thump-harness.ts', type: 'module' })

  await page.evaluate(() => {
    ;(window as unknown as { __thumpResult?: unknown }).__thumpResult = undefined
    document.body.addEventListener(
      'click',
      () => {
        void (window as unknown as { __runThumpBoot(): Promise<unknown> })
          .__runThumpBoot()
          .then((r) => {
            ;(window as unknown as { __thumpResult?: unknown }).__thumpResult = r
          })
      },
      { once: true },
    )
  })

  await page.click('body')

  await page.waitForFunction(
    () => (window as unknown as { __thumpResult?: unknown }).__thumpResult !== undefined,
    undefined,
    { timeout: 10000 },
  )

  return page.evaluate(
    () => (window as unknown as { __thumpResult: ThumpResult }).__thumpResult,
  )
}

describe('power-on thump', () => {
  it(
    'a fresh VCO -> VCF -> VCA voice, closed but not yet playing a note, stays below the audible-thump threshold on boot',
    async () => {
      const page = await browser.newPage()
      const result = await bootOnce(page)
      await page.close()

      console.log(
        `startup-thump: peak=${result.peakDb.toFixed(1)} dBFS @ sample ${result.peakSampleIndex}, ` +
          `loud until sample ${result.lastLoudSampleIndex} (${result.durationMs.toFixed(1)} ms), ` +
          `${result.totalSamples} samples captured @ ${result.sampleRate} Hz`,
      )

      // -40 dBFS is comfortably below the measured pre-fix range (-8.3 to
      // -19.9 dBFS, median about -14) and comfortably above the residual
      // noise floor a healthy, closed VCA should measure (well under
      // -60 dBFS -- see SILENCE_THRESHOLD in the harness). It leaves real
      // margin on both sides while still being a threshold a genuine thump
      // cannot sneak under.
      expect(result.peakDb).toBeLessThan(-40)
    },
    20000,
  )

  it(
    'boots repeatedly without the thump (distribution, not a single sample)',
    async () => {
      const N = 20
      const peaks: number[] = []
      for (let i = 0; i < N; i++) {
        const page = await browser.newPage()
        const result = await bootOnce(page)
        await page.close()
        peaks.push(result.peakDb)
      }

      const worst = Math.max(...peaks)
      const sorted = [...peaks].sort((a, b) => a - b)
      const median = sorted[Math.floor(sorted.length / 2)]!

      console.log(
        `startup-thump distribution over ${N} boots: worst=${worst.toFixed(1)} dBFS, ` +
          `median=${median.toFixed(1)} dBFS, all=[${peaks.map((p) => p.toFixed(1)).join(', ')}]`,
      )

      expect(worst).toBeLessThan(-40)
    },
    120000,
  )
})
