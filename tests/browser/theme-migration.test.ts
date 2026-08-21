import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { ViteDevServer } from 'vite'
import { createIsolatedServer, closeIsolatedServer } from './support/e2e-server'
import { chromium, type Browser, type Page } from 'playwright'
import { fileURLToPath } from 'node:url'

/**
 * Six theme ids were renamed away from a third-party trademark (see
 * .superpowers/sdd/theme-rename-report.md): reaktor-dark -> graphite,
 * moog-wood -> walnut-cream, ableton-live -> flat-grid, korg-ms20 ->
 * patch-lab, geist-groovebox -> brushed-steel, casiotone -> toy-piano.
 * A returning visitor's `localStorage['sinsthesis-theme']` still holds the
 * old id, and without a migration they would silently reset to the default
 * (`graphite`) instead of keeping the theme they actually picked -- worse,
 * the old id no longer matches any shipped `:root[data-theme="..."]`
 * selector at all, so the page would render fully unstyled until
 * rack/theme-switcher.ts's own (deferred) migration ran, not just show the
 * wrong skin.
 *
 * This drives the real rack page in an actual Chromium tab, the same
 * real-dev-server-plus-Playwright pattern as theme-geometry.test.ts, for
 * the same reason: the migration under test lives partly in index.html's
 * *inline* bootstrap script (plain JS, not this project's TypeScript), and
 * only a real page load exercises that script at all.
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

// Every renamed id, old -> new -- kept in sync with
// rack/theme-switcher.ts's OLD_THEME_IDS and index.html's own copy of it.
const OLD_TO_NEW = {
  'reaktor-dark': 'graphite',
  'moog-wood': 'walnut-cream',
  'ableton-live': 'flat-grid',
  'korg-ms20': 'patch-lab',
  'geist-groovebox': 'brushed-steel',
  casiotone: 'toy-piano',
} as const

describe('theme id migration (localStorage)', () => {
  for (const [oldId, newId] of Object.entries(OLD_TO_NEW)) {
    it(`a stored "${oldId}" resolves to "${newId}" on load, and persists as "${newId}"`, async () => {
      const page: Page = await browser.newPage()
      const consoleErrors: string[] = []
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text())
      })
      page.on('pageerror', (err) => consoleErrors.push(String(err)))

      // First load establishes the origin so localStorage is writable, then
      // plant the pre-rename id a real returning visitor would still have.
      await page.goto(baseUrl + '/', { waitUntil: 'load' })
      await page.evaluate((id) => localStorage.setItem('sinsthesis-theme', id), oldId)

      // Reload is the load that matters: index.html's inline bootstrap
      // script runs synchronously on this navigation, before any stylesheet
      // is parsed and before rack/theme-switcher.ts (an ES module) even
      // loads -- exactly the "first paint already has the right attribute"
      // path this migration has to hold for.
      await page.reload({ waitUntil: 'load' })

      expect(
        await page.evaluate(() => document.documentElement.dataset['theme']),
        `data-theme after loading with stored "${oldId}"`,
      ).toBe(newId)

      // The switcher itself must agree, not just the raw attribute -- the
      // correct button shows pressed/active once rack/main.ts's deferred
      // initThemeSwitcher() runs.
      const themeSwitcher = page.getByTestId('theme-switcher')
      await themeSwitcher.waitFor({ state: 'visible' })
      const activeButton = page.getByTestId(`theme-${newId}`)
      await activeButton.waitFor({ state: 'visible' })
      expect(
        await activeButton.evaluate((el) => el.classList.contains('theme-btn-active')),
        `theme-${newId} button shows active after migrating from "${oldId}"`,
      ).toBe(true)
      expect(await activeButton.getAttribute('aria-pressed')).toBe('true')

      // localStorage itself was normalized to the new id, not left holding
      // the stale one forever -- otherwise every future load would still
      // depend on the migration map rather than converging on the current
      // id, and any other code that reads the key directly (not just this
      // page's own bootstrap) would keep seeing the old value.
      expect(
        await page.evaluate(() => localStorage.getItem('sinsthesis-theme')),
        `localStorage after migrating from "${oldId}"`,
      ).toBe(newId)

      expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([])
      await page.close()
    })
  }

  it('a stored id that is already current is left untouched', async () => {
    const page: Page = await browser.newPage()
    await page.goto(baseUrl + '/', { waitUntil: 'load' })
    await page.evaluate(() => localStorage.setItem('sinsthesis-theme', 'brimstone'))
    await page.reload({ waitUntil: 'load' })

    expect(await page.evaluate(() => document.documentElement.dataset['theme'])).toBe('brimstone')
    expect(await page.evaluate(() => localStorage.getItem('sinsthesis-theme'))).toBe('brimstone')
    await page.close()
  })

  it('no stored id at all still falls back to the default (graphite)', async () => {
    const page: Page = await browser.newPage()
    await page.goto(baseUrl + '/', { waitUntil: 'load' })
    await page.evaluate(() => localStorage.removeItem('sinsthesis-theme'))
    await page.reload({ waitUntil: 'load' })

    expect(await page.evaluate(() => document.documentElement.dataset['theme'])).toBe('graphite')
    await page.close()
  })
})
