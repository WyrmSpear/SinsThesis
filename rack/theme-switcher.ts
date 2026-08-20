/**
 * The theme switcher (spec Section 8: "a theme is a token file, not a
 * component fork"). This file is the one place that knows the list of
 * theme ids and how to flip between them -- it never reaches into
 * rack/panel.ts, rack/knob.ts or rack/style.css to do it. Switching a
 * theme is exactly one DOM write: `document.documentElement.dataset.theme
 * = id`. Every rack/theme-*.css file scopes its custom properties under
 * `:root[data-theme="<id>"]`, so that single attribute write is what makes
 * every panel, knob, jack and cable repaint at once -- no JS ever touches
 * an individual element's style.
 *
 * `index.html` also carries a tiny inline bootstrap script, before any
 * stylesheet link, that sets the same attribute from localStorage
 * synchronously on load -- this module's job starts after that: rendering
 * the visible switcher and wiring its clicks. Without the inline
 * bootstrap, the page would flash Graphite and then repaint into the
 * stored theme once this module (an ES module, deferred by spec) finally
 * ran.
 */

export const STORAGE_KEY = 'sinsthesis-theme'
export const DEFAULT_THEME = 'graphite'

export interface ThemeOption {
  id: string
  label: string
}

/** The eight themes Section 8 names, plus Brimstone, Space Station,
 *  Vaporwave and Psychedelic -- proof a twelfth is still just: drop a
 *  `rack/theme-<id>.css` file, add one line here. Six ids were renamed
 *  away from a third-party trademark (see
 *  .superpowers/sdd/theme-rename-report.md for the full map and reasoning);
 *  see `OLD_THEME_IDS` below for what a returning visitor's localStorage
 *  might still hold. */
export const THEMES: readonly ThemeOption[] = [
  { id: 'graphite', label: 'Graphite' },
  { id: 'walnut-cream', label: 'Walnut & Cream' },
  { id: 'phosphor-lab', label: 'Phosphor Lab' },
  { id: 'flat-grid', label: 'Flat Grid' },
  { id: 'circuit-pcb', label: 'Circuit/PCB' },
  { id: 'brushed-steel', label: 'Brushed Steel' },
  { id: 'toy-piano', label: 'Toy Piano' },
  { id: 'patch-lab', label: 'Patch Lab' },
  { id: 'brimstone', label: 'Brimstone' },
  { id: 'space-station', label: 'Space Station' },
  { id: 'vaporwave', label: 'Vaporwave' },
  { id: 'psychedelic', label: 'Psychedelic' },
]

/** Old theme ids, from before the trademark rename, mapped to their
 *  replacement -- a returning visitor's `localStorage` entry still holds
 *  the old id, and without this map they would silently land on
 *  `DEFAULT_THEME` instead of keeping the theme they actually picked.
 *  `index.html`'s inline bootstrap script duplicates this exact map: it
 *  has to run synchronously, before any ES module (this one included) is
 *  even fetched, to avoid a flash of an unstyled page (the old
 *  `data-theme` value no longer matches any shipped `:root[data-theme=...]`
 *  selector). Keep both maps in sync if a theme is ever renamed again. */
export const OLD_THEME_IDS: Readonly<Record<string, string>> = {
  'reaktor-dark': 'graphite',
  'moog-wood': 'walnut-cream',
  'ableton-live': 'flat-grid',
  'korg-ms20': 'patch-lab',
  'geist-groovebox': 'brushed-steel',
  casiotone: 'toy-piano',
}

/** Migrates a possibly-stale theme id to its current one; an id that is
 *  already current, or unrecognized entirely, passes through unchanged. */
export function migrateThemeId(id: string): string {
  return OLD_THEME_IDS[id] ?? id
}

function readStored(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const migrated = migrateThemeId(raw)
    // Normalize localStorage itself once migrated, so a caller that reads
    // the key directly (or a future map lookup) sees the current id too,
    // not just this in-memory return value.
    if (migrated !== raw) writeStored(migrated)
    return migrated
  } catch {
    // Private browsing / storage disabled -- fall through to the default
    // rather than throwing during boot.
    return null
  }
}

function writeStored(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // Same tolerance as readStored: a switcher that still switches the
    // *current* tab is more useful than one that throws because it
    // couldn't persist.
  }
}

export function currentTheme(): string {
  // migrateThemeId as a defense-in-depth pass, not the primary migration
  // path -- index.html's inline bootstrap script is what normally sets
  // this attribute to an already-current id before this module even loads
  // (see that script's own comment). This just means a stray old id left
  // on the attribute by some other path still resolves to a real theme
  // instead of one no `:root[data-theme=...]` selector matches.
  return migrateThemeId(document.documentElement.dataset['theme'] || DEFAULT_THEME)
}

function applyTheme(id: string): void {
  document.documentElement.dataset['theme'] = id
  writeStored(id)
}

/** Renders the switcher into `container` and wires its clicks. Reads the
 *  already-applied theme (set either by index.html's inline bootstrap
 *  script or by a prior call to this function) rather than localStorage
 *  directly, so it always reflects what's actually on screen. */
export function initThemeSwitcher(container: HTMLElement): void {
  container.innerHTML = ''
  container.setAttribute('role', 'radiogroup')
  container.setAttribute('aria-label', 'Rack theme')

  const buttons = new Map<string, HTMLButtonElement>()

  function refresh(): void {
    const active = currentTheme()
    for (const [id, btn] of buttons) {
      const isActive = id === active
      btn.classList.toggle('theme-btn-active', isActive)
      btn.setAttribute('aria-pressed', String(isActive))
    }
  }

  for (const theme of THEMES) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'theme-btn'
    btn.textContent = theme.label
    btn.dataset['testid'] = `theme-${theme.id}`
    btn.setAttribute('role', 'radio')
    btn.addEventListener('click', () => {
      applyTheme(theme.id)
      refresh()
    })
    buttons.set(theme.id, btn)
    container.append(btn)
  }

  refresh()
}
