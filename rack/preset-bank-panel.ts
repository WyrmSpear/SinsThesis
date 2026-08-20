import type { PresetEntry } from '../presets/bank'

/**
 * The patch bank drawer: a browsable list of genre presets, each one button
 * away from being the live patch -- Section 1's "a browsable list, not just
 * the existing file-upload." Same shape as `rack/palette.ts` (a drawer of
 * buttons, reading whatever list it's handed rather than hardcoding one),
 * and deliberately not a merge into the module palette: a preset and a
 * module are different kinds of thing to add to a rack -- one *is* a whole
 * patch, the other is one block inside it -- so they get their own drawer
 * and their own toolbar button.
 */

export interface BuildPresetBankOptions {
  onLoad: (id: string) => void
}

export function buildPresetBankPanel(entries: readonly PresetEntry[], opts: BuildPresetBankOptions): HTMLElement {
  const root = document.createElement('div')
  root.className = 'preset-bank'
  root.dataset['testid'] = 'preset-bank'

  const list = document.createElement('div')
  list.className = 'preset-bank-list'

  for (const entry of entries) {
    const item = document.createElement('div')
    item.className = 'preset-bank-entry'
    item.dataset['testid'] = `preset-entry-${entry.id}`

    const name = document.createElement('div')
    name.className = 'preset-bank-entry-name'
    name.textContent = entry.name

    const description = document.createElement('div')
    description.className = 'preset-bank-entry-description'
    description.textContent = entry.description

    const loadBtn = document.createElement('button')
    loadBtn.type = 'button'
    loadBtn.className = 'preset-bank-entry-load'
    loadBtn.dataset['testid'] = `preset-load-${entry.id}`
    loadBtn.textContent = 'Load'
    loadBtn.addEventListener('click', () => opts.onLoad(entry.id))

    item.append(name, description, loadBtn)
    list.append(item)
  }

  root.append(list)
  return root
}
