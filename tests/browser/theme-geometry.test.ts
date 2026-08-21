import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { ViteDevServer } from 'vite'
import { createIsolatedServer, closeIsolatedServer } from './support/e2e-server'
import { chromium, type Browser, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'

/**
 * Section 8's claim under test, verbatim: "switching a theme rewrites
 * tokens and nothing else. Geometry -- panel widths, knob sizes, jack
 * positions -- stays identical across all eight [themes] ... a Playwright
 * test asserts exactly that." This drives the real rack page, adds every
 * module type through the palette (not just the starter patch's seven), and
 * measures every panel's width, every knob/switch/jack's size, and every
 * jack's position relative to its own panel, across every theme.
 *
 * This used to hold only approximately: `rack/panel.ts` sized panels with
 * `min-width` (shrink-to-fit), so a theme's font tokens (font-family,
 * letter-spacing, font-size all vary per theme) measurably changed panel
 * width -- up to ~11% on the VCO panel. The fix has two halves, both
 * required: `rack/panel.ts` now sets a definite `width` from
 * `descriptor.hp * HP_PX` (a fixed, non-themed constant) instead of
 * `min-width`, AND every module descriptor's `hp` was re-audited against
 * what its own layout actually needs at that width -- several were too
 * small (ADSR's hp=8 was the one that surfaced this; see
 * .superpowers/sdd/themes-complete-report.md for the full per-module
 * table). Pinning `width` alone, without the `hp` audit, breaks the
 * undersized descriptors' layouts instead of fixing geometry -- that's
 * exactly what happened the first time this was attempted and reverted.
 * With both halves done, every measurement below holds to exact pixel
 * equality, with no tolerance.
 *
 * Same real-Chromium-tab pattern as rack-page.test.ts and dev-page.test.ts,
 * for the same reason: a real Vite dev server plus Playwright's
 * CDP-backed input is what a `getBoundingClientRect()` measurement needs to
 * reflect actual layout rather than jsdom's approximation.
 *
 * Extended for the rack's physical-fidelity pass (see
 * .superpowers/sdd/rack-3u-report.md): every panel now also gets a fixed
 * `height` from `PANEL_HEIGHT_PX` (rack/panel.ts), the same "3U regardless
 * of width" rule a real Eurorack case enforces. The assertions below check
 * that claim two ways -- every panel in one theme shares the exact same
 * height, and each panel's height stays pixel-identical across all twelve
 * themes, mirroring how width was already checked.
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

// The eight themes Section 8 names, plus Brimstone (the ninth), Space
// Station, Vaporwave and Psychedelic (the tenth through twelfth -- see
// each theme's own rack/theme-*.css header comment). Graphite is the
// default and serves as the reference every other theme is compared
// against. Six ids below were renamed away from a third-party trademark
// (reaktor-dark -> graphite, moog-wood -> walnut-cream, ableton-live ->
// flat-grid, korg-ms20 -> patch-lab, geist-groovebox -> brushed-steel,
// casiotone -> toy-piano; see .superpowers/sdd/theme-rename-report.md) --
// the localStorage migration for returning visitors is covered separately,
// in tests/browser/theme-migration.test.ts.
const THEMES = [
  'graphite',
  'walnut-cream',
  'phosphor-lab',
  'flat-grid',
  'circuit-pcb',
  'brushed-steel',
  'toy-piano',
  'patch-lab',
  'brimstone',
  'space-station',
  'vaporwave',
  'psychedelic',
] as const

interface Size {
  width: number
  height: number
}

interface ControlGeometry {
  kind: string
  size: Size
  // Position relative to the panel's own top-left, not the viewport --
  // the rack reflows per theme (taller headers at a larger type scale push
  // rows down), so an absolute-position comparison would be comparing the
  // wrong thing. Relative-to-panel is what "jack positions stay identical"
  // actually means.
  x: number
  y: number
}

interface PanelGeometry {
  type: string
  width: number
  height: number
  controls: ControlGeometry[]
}

async function readAllPanelGeometry(page: Page): Promise<PanelGeometry[]> {
  const raw = await page.evaluate(() => {
    const panels = [...document.querySelectorAll<HTMLElement>('.module-panel')]
    return panels.map((panel) => {
      const prect = panel.getBoundingClientRect()
      const controls = [
        ...panel.querySelectorAll<HTMLElement>('.knob-dial, .switch-control, .jack-socket'),
      ].map((el) => {
        const r = el.getBoundingClientRect()
        return {
          kind: el.className,
          size: { width: r.width, height: r.height },
          x: r.left - prect.left,
          y: r.top - prect.top,
        }
      })
      return {
        type: panel.dataset['type'] ?? '',
        width: prect.width,
        height: prect.height,
        controls,
      }
    })
  })
  const round = (n: number): number => Math.round(n * 100) / 100
  return raw.map((p) => ({
    type: p.type,
    width: round(p.width),
    height: round(p.height),
    controls: p.controls.map((c) => ({
      kind: c.kind,
      size: { width: round(c.size.width), height: round(c.size.height) },
      x: round(c.x),
      y: round(c.y),
    })),
  }))
}

/** Every module panel's own bounding box must fully contain every one of
 *  its controls -- a control poking outside its panel (ADSR's original
 *  bug: knobs overlapping because the panel was narrower than four knob
 *  dials need) is exactly the failure this geometry claim exists to catch,
 *  and it would not show up in a width-only or size-only comparison. */
function assertNoOverflowOrOverlap(panels: PanelGeometry[]): void {
  for (const panel of panels) {
    for (const c of panel.controls) {
      expect(c.x, `${panel.type}: control ${c.kind} left edge inside panel`).toBeGreaterThanOrEqual(0)
      expect(c.y, `${panel.type}: control ${c.kind} top edge inside panel`).toBeGreaterThanOrEqual(0)
      expect(c.x + c.size.width, `${panel.type}: control ${c.kind} right edge inside panel`).toBeLessThanOrEqual(
        panel.width + 0.5,
      )
    }
    for (let i = 0; i < panel.controls.length; i++) {
      for (let j = i + 1; j < panel.controls.length; j++) {
        const a = panel.controls[i]!
        const b = panel.controls[j]!
        const ix = Math.min(a.x + a.size.width, b.x + b.size.width) - Math.max(a.x, b.x)
        const iy = Math.min(a.y + a.size.height, b.y + b.size.height) - Math.max(a.y, b.y)
        expect(
          ix > 1 && iy > 1,
          `${panel.type}: controls ${a.kind} and ${b.kind} overlap (${ix.toFixed(1)}x${iy.toFixed(1)}px)`,
        ).toBe(false)
      }
    }
  }
}

describe('theme geometry (Section 8)', () => {
  it(
    'switching every theme changes tokens and holds panel width, control size and jack position pixel-identical across all twelve',
    async () => {
      const page: Page = await browser.newPage()
      const consoleErrors: string[] = []
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text())
      })
      page.on('pageerror', (err) => consoleErrors.push(String(err)))

      await page.setViewportSize({ width: 2400, height: 3200 })
      await page.goto(baseUrl + '/', { waitUntil: 'load' })
      const powerBtn = page.getByTestId('power')
      await powerBtn.waitFor({ state: 'visible' })
      await powerBtn.click()
      await page.waitForFunction(() => Boolean((window as unknown as { __sinsthesis?: unknown }).__sinsthesis))
      const app = page.getByTestId('app')
      await app.waitFor({ state: 'visible' })
      await page.waitForTimeout(250)

      // Graphite is the default -- verify the switcher already shows it
      // active before touching anything, so a later mismatch can't be
      // blamed on this test's own setup.
      expect(await page.evaluate(() => document.documentElement.dataset['theme'])).toBe('graphite')

      // Add every module type through the palette so the assertions below
      // cover every registered descriptor, not just the starter patch's
      // seven.
      const paletteTypes = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid^="palette-add-"]')].map((e) =>
          e.getAttribute('data-testid')!.replace('palette-add-', ''),
        ),
      )
      expect(paletteTypes.length).toBeGreaterThan(0)
      for (const type of paletteTypes) {
        await page.getByTestId('palette-toggle').click()
        await page.getByTestId(`palette-add-${type}`).click()
      }

      const geometries: Record<string, PanelGeometry[]> = {}
      const indicatorTokens = new Set<string>()
      for (const theme of THEMES) {
        await page.getByTestId(`theme-${theme}`).click()
        expect(await page.evaluate(() => document.documentElement.dataset['theme'])).toBe(theme)
        await page.waitForTimeout(30)
        geometries[theme] = await readAllPanelGeometry(page)
        indicatorTokens.add(
          await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--knob-indicator').trim()),
        )
        // Fails closed within each theme first: a theme with its own
        // internal overlap/overflow bug should not need cross-theme
        // comparison to be caught.
        assertNoOverflowOrOverlap(geometries[theme]!)
      }

      // The tokens really did change per theme -- otherwise a bug that made
      // every theme file a no-op would still pass the geometry assertions
      // below vacuously.
      expect(indicatorTokens.size).toBe(THEMES.length)

      const reference = geometries['graphite']!
      expect(reference.length).toBeGreaterThanOrEqual(paletteTypes.length)

      // Every Eurorack module is 3U tall regardless of width -- the rack's
      // other half of "panel widths, knob sizes, jack positions stay
      // identical." Assert it two ways: every panel in the reference theme
      // shares one exact height (the rail claim itself -- VCO and Output
      // seated on the same line, not tops flush and bottoms ragged), and
      // then, in the cross-theme loop below, that height stays pixel-
      // identical per panel across all twelve themes the same way width
      // already does.
      const referenceHeight = reference[0]!.height
      for (const panel of reference) {
        expect(panel.height, `graphite: ${panel.type} panel height (every module is 3U)`).toBe(referenceHeight)
      }

      for (const theme of THEMES.slice(1)) {
        const g = geometries[theme]!
        expect(g.length, `${theme}: panel count`).toBe(reference.length)
        for (let i = 0; i < reference.length; i++) {
          const refPanel = reference[i]!
          const themePanel = g[i]!
          expect(themePanel.type, `${theme}: panel ${i} type`).toBe(refPanel.type)
          expect(themePanel.width, `${theme}: ${refPanel.type} panel width`).toBe(refPanel.width)
          expect(themePanel.height, `${theme}: ${refPanel.type} panel height`).toBe(refPanel.height)
          expect(themePanel.controls.length, `${theme}: ${refPanel.type} control count`).toBe(
            refPanel.controls.length,
          )
          for (let c = 0; c < refPanel.controls.length; c++) {
            const refControl = refPanel.controls[c]!
            const themeControl = themePanel.controls[c]!
            expect(themeControl.size, `${theme}: ${refPanel.type} control ${c} size`).toEqual(refControl.size)
            expect(themeControl.x, `${theme}: ${refPanel.type} control ${c} x`).toBe(refControl.x)
            expect(themeControl.y, `${theme}: ${refPanel.type} control ${c} y`).toBe(refControl.y)
          }
        }
      }

      // Reload with the last theme (Brimstone) already in localStorage and
      // confirm it persists across a full page load, per the task's
      // "persists across reloads" requirement -- and via the *inline*
      // bootstrap in index.html specifically, not this module's own JS: the
      // attribute must already be right by the time `--knob-indicator`
      // resolves, well before rack/theme-switcher.ts (an ES module) runs.
      await page.reload({ waitUntil: 'load' })
      expect(await page.evaluate(() => document.documentElement.dataset['theme'])).toBe(
        THEMES[THEMES.length - 1],
      )

      expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
      await page.close()
    },
    30000,
  )
})
