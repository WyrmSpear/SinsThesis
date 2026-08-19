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
 * bootstrap, the page would flash Reaktor Dark and then repaint into the
 * stored theme once this module (an ES module, deferred by spec) finally
 * ran.
 */

export const STORAGE_KEY = 'sinsthesis-theme'
export const DEFAULT_THEME = 'reaktor-dark'

export interface ThemeOption {
  id: string
  label: string
}

/** The eight themes Section 8 names; four built so far (spec's own
 *  one-line description follows each id below in file order). Adding a
 *  fifth is: drop a `rack/theme-<id>.css` file, add one line here. */
export const THEMES: readonly ThemeOption[] = [
  { id: 'reaktor-dark', label: 'Reaktor Dark' },
  { id: 'moog-wood', label: 'Moog Wood' },
  { id: 'phosphor-lab', label: 'Phosphor Lab' },
  { id: 'ableton-live', label: 'Ableton Live' },
]

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
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
  return document.documentElement.dataset['theme'] || DEFAULT_THEME
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
