import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'
import { peakHz } from '../../src/engine/analysis/features'
import { decodeWav } from '../../src/engine/wav'

/**
 * Rack-level proof for the studio layer's first slice (live recording +
 * offline bounce, both exported as WAV), driving the real page
 * (index.html + rack/main.ts) in an actual Chromium tab -- same pattern as
 * rack-scope.test.ts and for the same reasons.
 *
 * The one assertion that actually proves anything here is decoding the
 * *exported file* back and reading its fundamental with `peakHz`: a test
 * that only checked file size or a WAV header would pass on a silent or
 * pure-noise export just as readily as a real one. Decoding proves the
 * bytes on disk are the tone that was played, not merely that some bytes
 * were written.
 *
 * Both captures use the same patch -- a VCO tuned to a known frequency and
 * cabled straight to Output, bypassing the gate-dependent ADSR/VCA chain --
 * so the live recording and the offline bounce should read the same
 * fundamental, which is exactly the comparison the task asks for.
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

/** Adds a fresh VCO, tunes it to `tuneSemitones` above A4 (a precise
 *  `graph.setParam` call, not a mouse drag -- exact frequency matters for
 *  the `peakHz` assertions below), and cables it straight into the
 *  starter patch's Output module, bypassing the keyboard/ADSR/VCA chain
 *  entirely so the tone is continuous with no gate needed -- exactly the
 *  self-playing shape the task describes offline bounce being for, and
 *  just as valid a source for the live tap. */
async function buildKnownToneVoice(page: Page, tuneSemitones: number): Promise<{ vcoId: string; expectedHz: number }> {
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
    { id: vcoId, tune: tuneSemitones },
  )

  await dragJackToJack(page, `jack-${vcoId}-out`, 'jack-output-in')

  const expectedHz = 440 * Math.pow(2, tuneSemitones / 12)
  return { vcoId, expectedHz }
}

/** Clicks `triggerTestId` and captures the single WAV `Blob` it downloads,
 *  returning it as an `ArrayBuffer` -- the same `URL.createObjectURL`
 *  interception seam rack-page.test.ts's save/load round trip uses, except
 *  the payload here is binary, so it goes back to Node as base64 rather
 *  than text. */
async function captureWavDownload(page: Page, triggerTestId: string): Promise<ArrayBuffer> {
  const base64 = await page.evaluate(
    (testId) =>
      new Promise<string>((resolve, reject) => {
        const orig = URL.createObjectURL.bind(URL)
        URL.createObjectURL = (blob: Blob) => {
          void blob
            .arrayBuffer()
            .then((buf) => {
              const bytes = new Uint8Array(buf)
              let binary = ''
              const chunk = 0x8000
              for (let i = 0; i < bytes.length; i += chunk) {
                binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
              }
              resolve(btoa(binary))
            })
            .catch(reject)
          return orig(blob)
        }
        const el = document.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null
        if (!el) { reject(new Error(`no element with data-testid="${testId}"`)); return }
        el.click()
      }),
    triggerTestId,
  )
  const buffer = Buffer.from(base64, 'base64')
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

describe('studio: live recording and offline bounce', () => {
  it('the transport shows armed state and elapsed time while recording, and stops cleanly', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)

    const recordBtn = page.getByTestId('record-btn')
    expect(await recordBtn.getAttribute('aria-pressed')).toBe('false')

    await recordBtn.click()
    expect(await recordBtn.getAttribute('aria-pressed')).toBe('true')
    expect(await page.locator('[data-testid="record-btn"] .studio-rec-dot-active').isVisible()).toBe(true)

    await page.waitForTimeout(900)
    const elapsedMidway = await page.getByTestId('record-elapsed').textContent()
    expect(elapsedMidway).toMatch(/^0:0[0-9]/) // some non-zero, sub-10s elapsed

    await recordBtn.click()
    expect(await recordBtn.getAttribute('aria-pressed')).toBe('false')
    expect(await page.getByTestId('export-panel').isVisible()).toBe(true)
    expect(await page.getByTestId('capture-summary').textContent()).toMatch(/Recording/)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })

  it('a live recording of a known tone, exported as WAV, decodes back to that tone', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)
    // Tune 16 semitones above A4 -> ~1108.7 Hz, one of this codebase's own
    // documented safe test frequencies (docs/CONTINUATION.md trap 1: avoid
    // sampleRate/f0 landing near an integer -- 441/1109/1760 are safe).
    const { expectedHz } = await buildKnownToneVoice(page, 16)

    await page.getByTestId('record-btn').click()
    await page.waitForTimeout(900) // real wall-clock capture -- this is the point of live recording
    await page.getByTestId('record-btn').click()
    expect(await page.getByTestId('export-panel').isVisible()).toBe(true)

    // Export the WAV alone -- uncheck "save .sinp too" so exactly one blob
    // download happens, keeping the interception in captureWavDownload
    // unambiguous about which blob it caught.
    await page.getByTestId('save-sinp-checkbox').uncheck()
    const wavBuffer = await captureWavDownload(page, 'export-wav-btn')

    const decoded = decodeWav(wavBuffer)
    expect(decoded.channels).toHaveLength(1) // the engine's whole signal path is mono
    expect(decoded.sampleRate).toBeGreaterThan(0)
    // At least ~700ms actually captured (900ms requested, minus setup/IPC slack).
    expect(decoded.channels[0]!.length / decoded.sampleRate).toBeGreaterThan(0.7)

    const measuredHz = peakHz(decoded.channels[0]!, decoded.sampleRate)
    console.log(`studio-record live recording: expected=${expectedHz.toFixed(1)}Hz measured=${measuredHz.toFixed(1)}Hz`)
    expect(Math.abs(measuredHz - expectedHz)).toBeLessThan(10)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })

  it('an offline bounce of the same patch, exported as WAV, produces the same fundamental as the live recording', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await powerOn(page)
    const { expectedHz } = await buildKnownToneVoice(page, 16)

    // Live recording side of the comparison.
    await page.getByTestId('record-btn').click()
    await page.waitForTimeout(700)
    await page.getByTestId('record-btn').click()
    expect(await page.getByTestId('export-panel').isVisible()).toBe(true)
    await page.getByTestId('save-sinp-checkbox').uncheck()
    const liveWav = decodeWav(await captureWavDownload(page, 'export-wav-btn'))
    const liveHz = peakHz(liveWav.channels[0]!, liveWav.sampleRate)

    // Offline bounce side: same patch, rendered through renderPatch, not
    // real-time playback -- rack/studio-panel.ts's "Render" button.
    const lengthInput = page.getByTestId('bounce-length')
    await lengthInput.fill('1')
    await lengthInput.dispatchEvent('change')
    await page.getByTestId('bounce-btn').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="bounce-btn"]')?.textContent === 'Render', { timeout: 10000 })
    expect(await page.getByTestId('export-panel').isVisible()).toBe(true)
    expect(await page.getByTestId('capture-summary').textContent()).toMatch(/Bounce/)

    const bounceWav = decodeWav(await captureWavDownload(page, 'export-wav-btn'))
    const bounceHz = peakHz(bounceWav.channels[0]!, bounceWav.sampleRate)

    console.log(
      `studio-record bounce vs. live: expected=${expectedHz.toFixed(1)}Hz live=${liveHz.toFixed(1)}Hz bounce=${bounceHz.toFixed(1)}Hz`,
    )
    expect(Math.abs(bounceHz - expectedHz)).toBeLessThan(10)
    expect(Math.abs(bounceHz - liveHz)).toBeLessThan(10)

    // The bounce rendered ~1s at the context's own sample rate, exactly --
    // an offline render, unlike the live tap, has no real-time slack to
    // account for.
    expect(bounceWav.channels[0]!.length / bounceWav.sampleRate).toBeCloseTo(1, 1)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })

  // Audit round two, finding 4: the bounce hardcoded 48000 (`rack/main.ts`'s
  // MATCH_SAMPLE_RATE, deliberately fixed for match-this-sound but reused
  // here by accident) while live recording already followed `ctx.sampleRate`
  // -- untested until now because every page in this suite runs on whatever
  // sample rate Chromium's default output device reports, which is 48000 in
  // this environment. `page.addInitScript` (already used the same way in
  // rack-match-sound.test.ts) installs a subclass that forces the real
  // `AudioContext` rack/main.ts constructs to 44100 -- a real, legal
  // Web-Audio-API sample rate, just not the one every other test in this
  // file happens to run at -- before rack/main.ts's own `new AudioContext()`
  // call ever executes, so nothing here depends on the test machine's actual
  // audio hardware.
  it('bounces at the context sample rate, not a hardcoded 48000, on a 44100 Hz context', async () => {
    const page: Page = await browser.newPage()
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await page.addInitScript(() => {
      const Orig = window.AudioContext
      // Test-only: forces a non-48000 context sample rate before any page
      // script (rack/main.ts included) constructs one.
      window.AudioContext = class extends Orig {
        constructor(options?: AudioContextOptions) {
          super({ ...options, sampleRate: 44100 })
        }
      }
    })

    await powerOn(page)
    const ctxSampleRate = await page.evaluate(
      () => (window as unknown as { __sinsthesis: { ctx: AudioContext } }).__sinsthesis.ctx.sampleRate,
    )
    expect(ctxSampleRate).toBe(44100) // the override actually took, or the rest of this test proves nothing

    const { expectedHz } = await buildKnownToneVoice(page, 16) // ~1108.7 Hz, this project's own safe test frequency

    const lengthInput = page.getByTestId('bounce-length')
    await lengthInput.fill('1')
    await lengthInput.dispatchEvent('change')
    await page.getByTestId('bounce-btn').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="bounce-btn"]')?.textContent === 'Render', { timeout: 10000 })
    expect(await page.getByTestId('export-panel').isVisible()).toBe(true)

    await page.getByTestId('save-sinp-checkbox').uncheck()
    const bounceWav = decodeWav(await captureWavDownload(page, 'export-wav-btn'))
    const bounceHz = peakHz(bounceWav.channels[0]!, bounceWav.sampleRate)

    console.log(
      `studio-record bounce @ 44100Hz context: wav.sampleRate=${bounceWav.sampleRate} expectedHz=${expectedHz.toFixed(1)} measuredHz=${bounceHz.toFixed(1)}`,
    )
    // The bug: this used to be 48000 unconditionally, regardless of what the
    // live context actually ran at.
    expect(bounceWav.sampleRate).toBe(44100)
    expect(Math.abs(bounceHz - expectedHz)).toBeLessThan(10)
    // Exactly 1s of audio at the *bounce's own* sample rate -- confirms the
    // WAV header and the sample count agree, not just that the header claims
    // 44100 while still holding a 48000-length buffer.
    expect(bounceWav.channels[0]!.length / bounceWav.sampleRate).toBeCloseTo(1, 1)

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
    await page.close()
  })
})

