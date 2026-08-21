import type { ModuleDescriptor, ModuleGroup } from '../src/engine/types'
import { MODULE_GROUPS } from '../src/engine/types'

/**
 * The module palette: every registered descriptor, grouped and offered as
 * an "add" button. Reads `listModules()` results handed to it -- never a
 * hardcoded module list -- so a newly registered module appears here
 * with no change to this file (`src/engine/registry.ts`'s `listModules`
 * is the only source of truth for what exists).
 *
 * Grouping reads each descriptor's own `group` field (Section 4 of the
 * spec, added alongside this palette) rather than inferring a category
 * from `type` or `name` in this file -- exactly the same reasoning as
 * `labels` living on `ParamSpec` instead of the panel guessing "is this
 * discrete" from a param's range.
 */

const GROUP_TITLES: Record<ModuleGroup, string> = {
  source: 'Sources',
  shaping: 'Shaping',
  effects: 'Effects',
  modulation: 'Modulation',
  utility: 'Utility',
  control: 'Control',
}

/** Modules that ship with no `group` fall in here rather than being
 *  silently omitted from the palette -- an ungrouped module is still a
 *  real module the operator should be able to add. */
const UNGROUPED_TITLE = 'Other'

export interface BuildPaletteOptions {
  onAdd: (type: string) => void
}

export function buildPalette(descriptors: readonly ModuleDescriptor[], opts: BuildPaletteOptions): HTMLElement {
  const root = document.createElement('div')
  root.className = 'palette'
  root.dataset['testid'] = 'palette'

  const byGroup = new Map<string, ModuleDescriptor[]>()
  for (const d of descriptors) {
    const key = d.group ?? UNGROUPED_TITLE
    const list = byGroup.get(key) ?? []
    list.push(d)
    byGroup.set(key, list)
  }

  const orderedKeys = [...MODULE_GROUPS, UNGROUPED_TITLE].filter((k) => byGroup.has(k))

  for (const key of orderedKeys) {
    const section = document.createElement('div')
    section.className = 'palette-section'

    const heading = document.createElement('h3')
    heading.className = 'palette-section-title'
    heading.textContent = key === UNGROUPED_TITLE ? UNGROUPED_TITLE : GROUP_TITLES[key as ModuleGroup]
    section.append(heading)

    const list = document.createElement('div')
    list.className = 'palette-list'

    for (const d of byGroup.get(key)!.sort((a, b) => a.name.localeCompare(b.name))) {
      const entry = document.createElement('button')
      entry.type = 'button'
      entry.className = 'palette-entry'
      entry.dataset['testid'] = `palette-add-${d.type}`
      entry.title = `Add ${d.name} (${d.hp}hp)`

      const name = document.createElement('span')
      name.className = 'palette-entry-name'
      name.textContent = d.name

      const hp = document.createElement('span')
      hp.className = 'palette-entry-hp'
      hp.textContent = `${d.hp}hp`

      entry.append(name, hp)
      entry.addEventListener('click', () => opts.onAdd(d.type))
      list.append(entry)
    }

    section.append(list)
    root.append(section)
  }

  return root
}
