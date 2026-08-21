import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'

/**
 * MIDI hardware, end to end, on the real rack page -- the exact thing that
 * was missing: `requestMidiAccess` existed and `handleMidiEvent` had
 * module-level coverage (`tests/browser/modules/keyboard-midi.test.ts`),
 * but no UI file ever called the former, so a real controller did nothing
 * at all (docs/CONTINUATION.md's READ FIRST). This drives `rack/main.ts`'s
 * actual wiring: POWER ON requesting access, a synthesized note reaching
 * the default patch's Keyboard module, and the MIDI-learn gesture
 * (right-click a knob -> "MIDI Learn" -> a CC arrives -> the knob is
 * bound and the parameter moves), including that a binding survives a
 * save/reload round trip.
 *
 * Real hardware cannot be plugged into a CI/test browser, so every
 * scenario below synthesizes MIDI input the same way a real
 * `MIDIAccess`/`MIDIInput` would deliver it: `navigator.requestMIDIAccess`
 * is stubbed (via `page.addInitScript`, so it exists before `rack/main.ts`
 * ever runs) to resolve a fake `MIDIAccess` object whose one input's
 * `onmidimessage` this file calls directly with real MIDI byte arrays --
 * exactly the shape `MIDIMessageEvent.data` has. What this proves: the
 * rack's own message-routing and MIDI-learn logic, driven by a message
 * that arrived through the real `onmidimessage` entry point `rack/main.ts`
 * wires up. What it does NOT prove: that a real physical controller's
 * browser-native `MIDIAccess` implementation behaves identically to this
 * stub, or that any specific piece of hardware's byte stream matches what
 * `parseMidiMessage` expects. See `.superpowers/sdd/midi-report.md` for
 * the explicit list of what still needs the owner's own controller.
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

/** Installed before any page script runs (`addInitScript`), so
 *  `navigator.requestMIDIAccess` is already the fake implementation by the
 *  time `rack/main.ts`'s POWER ON handler calls `requestMidiAccess()`.
 *  `window.__fakeMidiInputs` stays reachable afterward so a test can call
 *  each fake input's `onmidimessage` directly -- the same thing a real
 *  browser does when a byte string arrives on that port. */
function installFakeMidi(deviceSpecs: Array<{ id: string; name: string }>): (page: Page) => Promise<void> {
  return async (page: Page): Promise<void> => {
    await page.addInitScript((specs: Array<{ id: string; name: string }>) => {
      const inputs = new Map<string, unknown>()
      for (const spec of specs) {
        inputs.set(spec.id, {
          id: spec.id,
          name: spec.name,
          type: 'input',
          state: 'connected',
          connection: 'open',
          onmidimessage: null,
          addEventListener() {},
          removeEventListener() {},
        })
      }
      ;(window as unknown as { __fakeMidiInputs: Map<string, unknown> }).__fakeMidiInputs = inputs
      const access = {
        inputs: { forEach: (cb: (v: unknown, k: string) => void) => inputs.forEach(cb) },
        outputs: { forEach: () => {} },
        onstatechange: null,
        addEventListener() {},
        removeEventListener() {},
      }
      ;(navigator as unknown as { requestMIDIAccess: () => Promise<unknown> }).requestMIDIAccess = () =>
        Promise.resolve(access)
    }, deviceSpecs)
  }
}

/** Removes `requestMIDIAccess` entirely -- the "no Web MIDI API at all"
 *  case `src/engine/midi.ts`'s own doc comment names as ordinary, not an
 *  error. Real headless Chromium does implement the API, so this has to be
 *  stubbed away explicitly to exercise the unavailable path deterministically. */
async function removeMidiAccess(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (navigator as unknown as { requestMIDIAccess?: unknown }).requestMIDIAccess
  })
}

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

async function sendRawMidi(page: Page, deviceId: string, bytes: number[]): Promise<void> {
  await page.evaluate(
    ([id, data]: [string, number[]]) => {
      const inputs = (window as unknown as { __fakeMidiInputs: Map<string, { onmidimessage?: (e: unknown) => void }> })
        .__fakeMidiInputs
      const input = inputs.get(id)
      input?.onmidimessage?.({ data: new Uint8Array(data) })
    },
    [deviceId, bytes] as [string, number[]],
  )
}

interface DebugHook {
  graph: {
    moduleIds: readonly string[]
    getType(id: string): string
    getParams(id: string): Record<string, number>
  }
  midiLearn: {
    bindingFor(moduleId: string, paramId: string): { controller: number } | undefined
    all: readonly { controller: number; moduleId: string; paramId: string }[]
  }
  rms(): number
}

describe('MIDI status', () => {
  it('reads "unavailable" when the browser has no Web MIDI API at all', async () => {
    const page = await browser.newPage()
    await removeMidiAccess(page)
    await powerOn(page)
    const status = page.getByTestId('midi-status')
    expect(await status.getAttribute('class')).toMatch(/midi-status-unavailable/)
    expect(await status.textContent()).toContain('unavailable')
    await page.close()
  })

  it('reads "no device" when access is granted but nothing is plugged in', async () => {
    const page = await browser.newPage()
    await installFakeMidi([])(page)
    await powerOn(page)
    const status = page.getByTestId('midi-status')
    expect(await status.getAttribute('class')).toMatch(/midi-status-no-device/)
    expect(await status.textContent()).toContain('no device')
    await page.close()
  })

  it('shows the connected device by name, and a picker when more than one exists', async () => {
    const page = await browser.newPage()
    await installFakeMidi([
      { id: 'dev-a', name: 'Test Controller A' },
      { id: 'dev-b', name: 'Test Controller B' },
    ])(page)
    await powerOn(page)
    const status = page.getByTestId('midi-status')
    expect(await status.getAttribute('class')).toMatch(/midi-status-connected/)
    expect(await status.textContent()).toContain('Test Controller A') // first device wins by default
    expect(await page.getByTestId('midi-status-select').isVisible()).toBe(true)
    await page.close()
  })

  it('flashes the activity dot when a message arrives', async () => {
    const page = await browser.newPage()
    await installFakeMidi([{ id: 'dev-a', name: 'Test Controller' }])(page)
    await powerOn(page)
    await sendRawMidi(page, 'dev-a', [0xb0, 1, 64])
    expect(await page.locator('.midi-status-dot-flash').count()).toBe(1)
    await page.close()
  })
})

describe('MIDI note input reaches the Keyboard module', () => {
  it('a synthesized note-on sounds through the default patch, note-off silences it', async () => {
    const page = await browser.newPage()
    await installFakeMidi([{ id: 'dev-a', name: 'Test Controller' }])(page)
    await powerOn(page)

    const readRms = () => page.evaluate(() => (window as unknown as { __sinsthesis: { rms(): number } }).__sinsthesis.rms())

    const silenceBefore = await readRms()
    expect(silenceBefore).toBeLessThan(0.001)

    await sendRawMidi(page, 'dev-a', [0x90, 60, 100]) // note-on, middle C, velocity 100
    await page.waitForTimeout(300)
    const rmsHeld = await readRms()
    expect(rmsHeld).toBeGreaterThan(0.02)

    await sendRawMidi(page, 'dev-a', [0x80, 60, 64]) // note-off
    // Same wait as rack-page.test.ts's own computer-keyboard equivalent --
    // the default patch's ADSR release phase, not an instant cutoff, needs
    // real time to decay below the silence threshold.
    await page.waitForTimeout(2000)
    const rmsAfterRelease = await readRms()
    expect(rmsAfterRelease).toBeLessThan(0.001)

    await page.close()
  })
})

describe('MIDI learn: right-click a knob, wiggle a CC, it binds and drives the param', () => {
  it('binds CC to the VCF cutoff knob and a later CC message moves the param through its exp curve', async () => {
    const page = await browser.newPage()
    await installFakeMidi([{ id: 'dev-a', name: 'Test Controller' }])(page)
    await powerOn(page)

    const cutoffKnob = page.getByTestId('knob-cutoff')
    await cutoffKnob.waitFor({ state: 'visible' })
    await cutoffKnob.click({ button: 'right' })
    await page.getByTestId('knob-midi-learn').waitFor({ state: 'visible' })
    await page.getByTestId('knob-midi-learn').click()

    // Wiggle: CC 74, value 64 -- the arming message itself both creates
    // the binding and applies a value (rack/knob-midi.ts's own comment on
    // why: the knob should visibly respond to the very wiggle that bound it).
    await sendRawMidi(page, 'dev-a', [0xb0, 74, 64])
    await page.waitForTimeout(50)

    const binding = await page.evaluate(
      () => (window as unknown as { __sinsthesis: DebugHook }).__sinsthesis.midiLearn.bindingFor('vcf', 'cutoff'),
    )
    expect(binding).toEqual({ controller: 74, moduleId: 'vcf', paramId: 'cutoff' })

    const expected = 20 * Math.pow(20000 / 20, 64 / 127)
    const cutoffAfterLearn = await page.evaluate(
      () => (window as unknown as { __sinsthesis: { graph: { getParams(id: string): Record<string, number> } } }).__sinsthesis.graph.getParams('vcf')['cutoff'],
    )
    expect(cutoffAfterLearn).toBeCloseTo(expected, 3)

    // Badge visible on the dial.
    expect(await page.getByTestId('knob-cutoff').getByTestId('knob-midi-badge').textContent()).toContain('CC74')

    // A later CC on the same controller moves the param again, at the top
    // of the range this time (CC 127 -> normalized 1.0 -> exactly `max`).
    await sendRawMidi(page, 'dev-a', [0xb0, 74, 127])
    await page.waitForTimeout(50)
    const cutoffAtMax = await page.evaluate(
      () => (window as unknown as { __sinsthesis: { graph: { getParams(id: string): Record<string, number> } } }).__sinsthesis.graph.getParams('vcf')['cutoff'],
    )
    expect(cutoffAtMax).toBeCloseTo(20000, 1)

    await page.close()
  })

  it('removing a binding stops the CC from driving the param', async () => {
    const page = await browser.newPage()
    await installFakeMidi([{ id: 'dev-a', name: 'Test Controller' }])(page)
    await powerOn(page)

    const cutoffKnob = page.getByTestId('knob-cutoff')
    await cutoffKnob.click({ button: 'right' })
    await page.getByTestId('knob-midi-learn').click()
    await sendRawMidi(page, 'dev-a', [0xb0, 10, 0])
    await page.waitForTimeout(50)

    await cutoffKnob.click({ button: 'right' })
    await page.getByTestId('knob-midi-unbind').waitFor({ state: 'visible' })
    await page.getByTestId('knob-midi-unbind').click()

    const bindingAfterUnbind = await page.evaluate(
      () => (window as unknown as { __sinsthesis: DebugHook }).__sinsthesis.midiLearn.bindingFor('vcf', 'cutoff'),
    )
    expect(bindingAfterUnbind).toBeUndefined()

    const before = await page.evaluate(
      () => (window as unknown as { __sinsthesis: { graph: { getParams(id: string): Record<string, number> } } }).__sinsthesis.graph.getParams('vcf')['cutoff'],
    )
    await sendRawMidi(page, 'dev-a', [0xb0, 10, 100])
    await page.waitForTimeout(50)
    const after = await page.evaluate(
      () => (window as unknown as { __sinsthesis: { graph: { getParams(id: string): Record<string, number> } } }).__sinsthesis.graph.getParams('vcf')['cutoff'],
    )
    expect(after).toBeCloseTo(before!, 6)

    await page.close()
  })

  it('a binding survives a save -> reload round trip (persisted via the .sinp, not the live session)', async () => {
    const page = await browser.newPage()
    await installFakeMidi([{ id: 'dev-a', name: 'Test Controller' }])(page)
    await powerOn(page)

    const cutoffKnob = page.getByTestId('knob-cutoff')
    await cutoffKnob.click({ button: 'right' })
    await page.getByTestId('knob-midi-learn').click()
    await sendRawMidi(page, 'dev-a', [0xb0, 21, 90])
    await page.waitForTimeout(500) // autosave is debounced 400ms

    const autosaved = await page.evaluate(() => localStorage.getItem('sinsthesis:autosave:v1'))
    expect(autosaved).toBeTruthy()
    const parsed = JSON.parse(autosaved!)
    expect(parsed.midiBindings).toEqual([{ controller: 21, moduleId: 'vcf', paramId: 'cutoff' }])

    // Fresh page load: autosave restore should reconstruct the binding
    // (rack/main.ts's boot path threads `loadPatch`'s `midiBindings`
    // through to `mountGraph`), no re-learning required.
    await powerOn(page)
    const bindingAfterReload = await page.evaluate(
      () => (window as unknown as { __sinsthesis: DebugHook }).__sinsthesis.midiLearn.bindingFor('vcf', 'cutoff'),
    )
    expect(bindingAfterReload).toEqual({ controller: 21, moduleId: 'vcf', paramId: 'cutoff' })
    expect(await page.getByTestId('knob-cutoff').getByTestId('knob-midi-badge').textContent()).toContain('CC21')

    // And the restored binding still actually drives the param.
    await sendRawMidi(page, 'dev-a', [0xb0, 21, 0])
    await page.waitForTimeout(50)
    const cutoffAtMin = await page.evaluate(
      () => (window as unknown as { __sinsthesis: { graph: { getParams(id: string): Record<string, number> } } }).__sinsthesis.graph.getParams('vcf')['cutoff'],
    )
    expect(cutoffAtMin).toBeCloseTo(20, 1)

    await page.close()
  })

  it('removing the bound module drops its binding rather than leaving it dangling', async () => {
    const page = await browser.newPage()
    await installFakeMidi([{ id: 'dev-a', name: 'Test Controller' }])(page)
    await powerOn(page)

    await page.getByTestId('knob-cutoff').click({ button: 'right' })
    await page.getByTestId('knob-midi-learn').click()
    await sendRawMidi(page, 'dev-a', [0xb0, 30, 50])
    await page.waitForTimeout(50)
    expect(
      await page.evaluate(() => (window as unknown as { __sinsthesis: DebugHook }).__sinsthesis.midiLearn.bindingFor('vcf', 'cutoff')),
    ).toEqual({ controller: 30, moduleId: 'vcf', paramId: 'cutoff' })

    await page.getByTestId('remove-vcf').click()

    const bindingsAfterRemove = await page.evaluate(
      () => (window as unknown as { __sinsthesis: DebugHook }).__sinsthesis.midiLearn.all,
    )
    expect(bindingsAfterRemove.some((b) => b.moduleId === 'vcf')).toBe(false)

    await page.close()
  })
})
