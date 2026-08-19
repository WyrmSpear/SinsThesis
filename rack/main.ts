import { PatchGraph } from '../src/engine/graph'
import { registerAllModules } from '../src/engine/modules'
import { getModule, listModules } from '../src/engine/registry'
import { ensureWorklets } from '../src/engine/render'
import { serializePatch, loadPatch, type PatchFile } from '../src/engine/patch'
import { inspect, type InspectorFailure, type InspectorResult } from '../src/engine/analysis/inspector'
import type { OutputInstance } from '../src/engine/modules/output'
import { buildPanel } from './panel'
import { buildGhostPanel } from './ghost-panel'
import { buildPalette } from './palette'
import { CableLayer } from './cables'
import { buildKeyboardPanel } from './keyboard-panel'
import { buildSequencerPanel } from './sequencer-panel'
import { buildScopePanel } from './scope-panel'
import { enableReorder } from './reorder'
import { downloadPatch, readPatchFile, saveAutosave, loadAutosave, debounce } from './patch-io'
import { initThemeSwitcher } from './theme-switcher'
import { LEVELS, getLevel } from '../academy/levels'
import { loadProgress, markComplete, type AcademyProgress } from '../academy/progress'
import { renderAcademyPanel } from './academy-panel'
import { describeFailures } from '../academy/feedback'

// Same guard as dev/main.ts, same reason: registerAllModules() throws on a
// second call, and a fresh page load is the only case that should ever run
// it (docs/CONTINUATION.md).
if (!getModule('vco')) registerAllModules()

// Independent of power-on: the switcher only ever writes
// `document.documentElement.dataset.theme`, never touches the AudioContext
// or the graph, so a visitor can preview every skin before pressing POWER.
initThemeSwitcher(document.getElementById('theme-switcher')!)

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`rack/main: missing #${id}`)
  return el as T
}

/**
 * Picks an id `PatchGraph.addModule` cannot already hold. `addModule`
 * would itself generate one when called with no id, but only from its own
 * internal counter -- shared with cable ids and reset to zero by every
 * `new PatchGraph()` -- which a loaded file's own ids (arbitrary strings
 * chosen by whoever last saved it) can collide with. Reading the graph's
 * actual `moduleIds` and picking the first free `${type}-N` makes
 * collision structurally impossible regardless of what a loaded patch
 * happens to be named, rather than trusting a counter that was never told
 * about those names.
 */
function freshId(graph: PatchGraph, type: string): string {
  const existing = new Set(graph.moduleIds)
  let n = 1
  while (existing.has(`${type}-${n}`)) n++
  return `${type}-${n}`
}

function ghostMessage(ghosts: readonly string[]): string {
  const noun = ghosts.length > 1 ? 'types' : 'type'
  return (
    `This patch uses a module ${noun} this build does not know: ${ghosts.join(', ')}. ` +
    `Shown as placeholder panels below -- their params and cables are kept intact and will ` +
    `be written back out the next time you save.`
  )
}

let started = false

function boot(): void {
  const powerBtn = $<HTMLButtonElement>('power-btn')
  powerBtn.addEventListener('click', () => void start(powerBtn), { once: true })
}

async function start(powerBtn: HTMLButtonElement): Promise<void> {
  if (started) return
  started = true
  powerBtn.disabled = true
  powerBtn.textContent = 'STARTING…'

  const ctx = new AudioContext()
  await ensureWorklets(ctx)
  if (ctx.state === 'suspended') await ctx.resume()

  const rackEl = $('rack-modules')
  const paletteDrawer = $('palette-drawer')
  const academyPanel = $('academy-panel')
  const statusBanner = $('status-banner')
  const patchNameInput = $<HTMLInputElement>('patch-name')
  const paletteToggle = $<HTMLButtonElement>('palette-toggle')
  const saveBtn = $<HTMLButtonElement>('save-patch')
  const loadBtn = $<HTMLButtonElement>('load-patch')
  const loadFileInput = $<HTMLInputElement>('load-file')
  const modeFreeplayBtn = $<HTMLButtonElement>('mode-freeplay')
  const modeAcademyBtn = $<HTMLButtonElement>('mode-academy')

  // ---- mutable rack state: reassigned wholesale on every patch load, per
  // src/engine/graph.ts's dispose() doc comment -- a live session swapping
  // patches must tear down the old PatchGraph, not just drop the
  // reference, or its clock module's setInterval keeps firing forever. ----
  let graph: PatchGraph
  let cableLayer: CableLayer
  let nextColumn = 0
  let currentPatchName = 'Untitled'
  const connectedOutputs = new Set<string>()

  // ---- academy mode state. `mode` gates two things: which chrome is
  // visible (`academyPanel` vs. the ordinary palette/toolbar), and whether
  // `scheduleAutosave` is allowed to touch the free-play autosave slot --
  // see its own comment below for why academy edits must never overwrite
  // it. `freePlaySnapshot` is what makes leaving the academy restore
  // free-play exactly as it was, per the task's "the academy is a mode,
  // not a replacement": it is captured the moment the player *enters* the
  // academy (mountGraph having last held the free-play patch) and
  // reloaded the moment they leave. ----
  let mode: 'freeplay' | 'academy' = 'freeplay'
  let currentLevelId: string | undefined
  let progress: AcademyProgress = loadProgress()
  let lastCheck: InspectorResult | undefined
  let freePlaySnapshot: PatchFile | undefined

  function showBanner(kind: 'warn' | 'error', message: string): void {
    statusBanner.hidden = false
    statusBanner.textContent = message
    statusBanner.className = `status-banner status-banner-${kind}`
    statusBanner.dataset['testid'] = 'status-banner'
  }

  function clearBanner(): void {
    statusBanner.hidden = true
    statusBanner.textContent = ''
  }

  // Academy edits must never land in the free-play autosave slot: they
  // patch the *same* PatchGraph/CableLayer plumbing free play uses (no
  // separate "academy graph" type exists), so every knob turn and cable
  // drag fires the identical onChange -> scheduleAutosave hook regardless
  // of mode. Without this guard, working through a single academy level
  // would silently overwrite whatever the player had built in free play,
  // and reloading the page afterward would hand them the level instead of
  // their own patch -- exactly the "replacement, not a mode" failure the
  // task warns against.
  function scheduleAutosave(): void {
    if (mode === 'academy') return
    saveDebounced()
  }
  const saveDebounced = debounce(() => {
    saveAutosave(serializePatch(graph, { name: currentPatchName }))
  }, 400)

  /** Rebuilds the palette drawer, optionally restricted to `allowedTypes`
   *  -- the mechanism Section 12's "a level can grant four modules and
   *  withhold the rest" describes. Free play calls this with no argument
   *  (every registered module); entering an academy level calls it with
   *  that level's `grantedModules`. */
  function refreshPalette(allowedTypes?: readonly string[]): void {
    paletteDrawer.innerHTML = ''
    const descriptors = allowedTypes
      ? listModules().filter((d) => allowedTypes.includes(d.type))
      : listModules()
    paletteDrawer.append(buildPalette(descriptors, { onAdd: addModuleFromPalette }))
  }

  /** The visible trace of a failed Check (Section 4: "the player must be
   *  able to see *why*"). Reads the module ids straight out of `inspect`'s
   *  own structured `detail` (never re-deriving pass/fail -- that stays
   *  `inspect`'s job entirely) rather than pattern-matching its English
   *  sentences, so this keeps working exactly the same regardless of how
   *  `describeFailures` phrases the feedback panel's text. */
  function highlightFailures(detail: readonly InspectorFailure[]): void {
    clearHighlights()
    const flagged = new Set<string>()
    for (const f of detail) {
      if (f.kind === 'missingConnection') { flagged.add(f.from.id); flagged.add(f.to.id) }
      else if (f.kind === 'missingParam' || f.kind === 'paramMismatch') flagged.add(f.module.id)
      // 'missingModule' names no existing panel -- there is nothing to flag yet.
    }
    for (const id of flagged) {
      rackEl.querySelector(`[data-module="${CSS.escape(id)}"]`)?.classList.add('module-panel-flag-miss')
    }
  }

  function clearHighlights(): void {
    for (const el of rackEl.querySelectorAll('.module-panel-flag-miss')) el.classList.remove('module-panel-flag-miss')
  }

  function renderAcademy(): void {
    renderAcademyPanel(
      academyPanel,
      LEVELS,
      {
        currentLevelId,
        progress,
        lastCheck,
        feedback: lastCheck && !lastCheck.pass ? describeFailures(lastCheck, graph) : [],
      },
      { onSelectLevel: enterLevel, onCheck: checkLevel },
    )
  }

  /** Loads a level's starting patch into the live rack and filters the
   *  palette to what it grants -- the two things Section 3 says "entering
   *  a level" does. Reuses `mountGraph`/`loadPatch` exactly as an explicit
   *  Load does, so a level's `.sinp` is loaded through the same one path
   *  every other patch in this app is. */
  function enterLevel(id: string): void {
    const level = getLevel(id)
    if (!level) return
    currentLevelId = id
    lastCheck = undefined
    const { graph: loaded } = loadPatch(ctx, level.startingPatch)
    mountGraph(loaded)
    currentPatchName = level.title
    patchNameInput.value = currentPatchName
    refreshPalette(level.grantedModules)
    renderAcademy()
  }

  /** The Check button: grades the live graph with the level's own
   *  `InspectorQuery` and nothing else (Section: "Use inspect rather than
   *  writing new grading logic"). A pass persists progress and unlocks the
   *  next level; a fail highlights the panels its failures named and
   *  leaves the graph untouched, so the player can keep working on the
   *  same patch. */
  function checkLevel(): void {
    if (!currentLevelId) return
    const level = getLevel(currentLevelId)
    if (!level) return
    const result = inspect(graph, level.query)
    lastCheck = result
    if (result.pass) {
      progress = markComplete(level.id)
      clearHighlights()
    } else {
      highlightFailures(result.detail)
    }
    renderAcademy()
  }

  function showAcademy(): void {
    if (mode !== 'academy') freePlaySnapshot = serializePatch(graph, { name: currentPatchName })
    mode = 'academy'
    modeAcademyBtn.classList.add('mode-toggle-btn-active')
    modeFreeplayBtn.classList.remove('mode-toggle-btn-active')
    academyPanel.hidden = false
    paletteDrawer.hidden = true
    if (currentLevelId === undefined && LEVELS[0]) {
      enterLevel(LEVELS[0].id) // also refreshes the palette and renders
    } else {
      refreshPalette(currentLevelId ? getLevel(currentLevelId)?.grantedModules : undefined)
      renderAcademy()
    }
  }

  function showFreePlay(): void {
    mode = 'freeplay'
    modeFreeplayBtn.classList.add('mode-toggle-btn-active')
    modeAcademyBtn.classList.remove('mode-toggle-btn-active')
    academyPanel.hidden = true
    clearHighlights()
    refreshPalette()
    if (freePlaySnapshot) {
      const { graph: restored } = loadPatch(ctx, freePlaySnapshot)
      mountGraph(restored)
      currentPatchName = freePlaySnapshot.meta.name
      patchNameInput.value = currentPatchName
    }
  }

  // Drag-to-reorder, wired once at boot rather than per-mount: it is
  // delegated (one `pointerdown` listener on `rackEl` itself, matched
  // against `.module-header` on every event), so it keeps working for
  // panels added later through the palette with no re-registration, and it
  // reads `graph`/`cableLayer` through getters so a patch load swapping
  // both out from under it (`mountGraph`, below) is never stale.
  enableReorder(rackEl, () => graph, () => cableLayer, scheduleAutosave)

  /** Real WebAudio destination hookup, not a rendering concern -- the one
   *  place this file is allowed to know a module `type` string, the same
   *  way the original starter patch already did by calling
   *  `outputInstance.outputs.get('out')!.connect(ctx.destination)`
   *  directly. Generalized here because the palette can now add or remove
   *  Output modules freely, so "exactly one, built once" no longer holds. */
  function wireOutputs(): void {
    for (const id of graph.moduleIds) {
      if (graph.getType(id) !== 'output' || connectedOutputs.has(id)) continue
      const instance = graph.getInstance(id)
      if (!instance) continue
      instance.outputs.get('out')?.connect(ctx.destination)
      connectedOutputs.add(id)
    }
  }

  function recomputeNextColumn(): void {
    nextColumn = 0
    for (const id of graph.moduleIds) {
      const col = graph.getSlot(id)[1]
      if (col >= nextColumn) nextColumn = col + 1
    }
  }

  function removeModuleById(id: string): void {
    graph.removeModule(id) // disconnects every cable touching it and disposes its instance
    rackEl.querySelector(`[data-module="${CSS.escape(id)}"]`)?.remove()
    cableLayer.removeModuleJacks(id)
    cableLayer.syncFromGraph() // engine is the source of truth for what cables remain
    // `freshId` reuses a freed `${type}-N` the moment it's free, so without
    // this an id like "output-1" removed and then re-added (a new instance,
    // same string) would be skipped by `wireOutputs`'s `connectedOutputs.has`
    // check -- looking connected while its `out` was never actually patched
    // to `ctx.destination` at all.
    connectedOutputs.delete(id)
    scheduleAutosave()
  }

  function renderModulePanel(id: string): HTMLElement {
    const type = graph.getType(id)!
    const instance = graph.getInstance(id)
    if (instance === undefined) {
      // A ghost: this build's registry has no descriptor for `type`, so
      // there is nothing `buildPanel` could read. See rack/ghost-panel.ts.
      return buildGhostPanel(id, type, graph, cableLayer.jackRegistry, removeModuleById)
    }
    const descriptor = getModule(type)!
    return buildPanel(descriptor, id, graph, {
      jacks: cableLayer.jackRegistry,
      customPanels: { keyboard: buildKeyboardPanel, sequencer: buildSequencerPanel, scope: buildScopePanel },
      onChange: scheduleAutosave,
      onRemove: removeModuleById,
    })
  }

  function addModuleFromPalette(type: string): void {
    const id = freshId(graph, type)
    graph.addModule(type, id)
    graph.setSlot(id, [0, nextColumn++])
    rackEl.append(renderModulePanel(id))
    cableLayer.reflow()
    wireOutputs()
    scheduleAutosave()
    paletteDrawer.hidden = true
  }

  /** Full rebuild: render every module in the graph (slot column order,
   *  so a save/load round trip keeps left-to-right position) and every
   *  cable the graph reports -- never a locally tracked list, so a ghost's
   *  cables show up exactly when the graph says they exist. */
  function renderRack(): void {
    rackEl.innerHTML = ''
    const order = [...graph.moduleIds].sort((a, b) => graph.getSlot(a)[1] - graph.getSlot(b)[1])
    for (const id of order) rackEl.append(renderModulePanel(id))
    for (const cable of graph.cables) cableLayer.renderCable(cable)
    cableLayer.reflow()
  }

  function updateDebugHook(): void {
    const globalWithHook = window as unknown as { __sinsthesis?: unknown }
    globalWithHook.__sinsthesis = {
      ctx,
      graph,
      cableLayer,
      rms(): number {
        const outId = graph.moduleIds.find((id) => graph.getType(id) === 'output')
        const instance = outId ? (graph.getInstance(outId) as OutputInstance | undefined) : undefined
        if (!instance) return 0
        const data = new Float32Array(1024)
        instance.analyser.getFloatTimeDomainData(data)
        let sum = 0
        for (const s of data) sum += s * s
        return Math.sqrt(sum / data.length)
      },
    }
  }

  /** Swaps in a fresh `PatchGraph` -- tearing down whatever was mounted
   *  before, per `PatchGraph.dispose()`'s doc comment -- and rebuilds the
   *  whole rack from it. Used for the initial boot, an explicit Load, and
   *  autosave restore alike, so there is exactly one path from "a graph
   *  exists" to "the screen matches it." */
  function mountGraph(newGraph: PatchGraph): void {
    cableLayer?.destroy()
    graph?.dispose()

    graph = newGraph
    cableLayer = new CableLayer($('rack-surface'), graph)
    cableLayer.onChange = scheduleAutosave
    connectedOutputs.clear()
    wireOutputs()
    recomputeNextColumn()
    renderRack()
    updateDebugHook()
  }

  // ---- the starter patch: instantiated through PatchGraph exactly as the
  // dev harness does (dev/main.ts). Keyboard is included even though the
  // task's module list names VCO/VCF/ADSR/VCA/Output/LFO without it: with
  // no source of pitch/gate CV, no cable in this rack could ever make a
  // sound, and the keyboard's own descriptor is what the on-screen piano
  // patches into. ----
  function buildDefaultPatch(): PatchGraph {
    const g = new PatchGraph(ctx)
    const keyboard = g.addModule('keyboard', 'keyboard')
    const vco = g.addModule('vco', 'vco')
    const vcf = g.addModule('vcf', 'vcf')
    const adsr = g.addModule('adsr', 'adsr')
    const vca = g.addModule('vca', 'vca')
    const lfo = g.addModule('lfo', 'lfo')
    const output = g.addModule('output', 'output')

    ;[keyboard, vco, vcf, adsr, vca, lfo, output].forEach((id, i) => g.setSlot(id, [0, i]))

    g.connect([keyboard, 'pitch'], [vco, 'pitch'])
    g.connect([keyboard, 'gate'], [adsr, 'gate'])
    g.connect([vco, 'out'], [vcf, 'in'])
    g.connect([adsr, 'out'], [vca, 'cv'])
    g.connect([vcf, 'out'], [vca, 'in'])
    g.connect([vca, 'out'], [output, 'in'])
    // LFO is deliberately left unpatched -- it sits in the rack so the
    // operator can drag their own cable from it (e.g. to the VCF's
    // cutoffCv jack) and see "any port to any port" for themselves.

    // Same anti-thump snap as dev/main.ts: the VCA's descriptor default is
    // 1 (open, correct for a bare unity-gain use), and this patch closes
    // it through the envelope instead -- an exact-time `atTime` snap
    // avoids the free-running oscillator leaking through while the ramp is
    // still close to its pre-change value.
    g.setParam(vca, 'level', 0, ctx.currentTime)
    g.setParam(vca, 'cvAmount', 1, ctx.currentTime)

    return g
  }

  // ---- toolbar wiring: independent of which graph happens to be mounted,
  // since every handler reads the outer `graph`/`cableLayer`/
  // `currentPatchName` bindings fresh on each call. ----
  refreshPalette()
  paletteToggle.addEventListener('click', () => {
    paletteDrawer.hidden = !paletteDrawer.hidden
  })

  modeFreeplayBtn.classList.add('mode-toggle-btn-active')
  modeFreeplayBtn.addEventListener('click', showFreePlay)
  modeAcademyBtn.addEventListener('click', showAcademy)

  saveBtn.addEventListener('click', () => {
    currentPatchName = patchNameInput.value.trim() || 'Untitled'
    patchNameInput.value = currentPatchName
    downloadPatch(serializePatch(graph, { name: currentPatchName }))
  })

  loadBtn.addEventListener('click', () => loadFileInput.click())
  loadFileInput.addEventListener('change', () => {
    const file = loadFileInput.files?.[0]
    loadFileInput.value = '' // so re-choosing the same filename still fires 'change'
    if (!file) return
    void (async () => {
      try {
        const parsed = await readPatchFile(file)
        const { graph: loaded, ghosts } = loadPatch(ctx, parsed)
        // Only now, with a fully-built replacement graph in hand, do we
        // touch the live rack -- a `loadPatch` throw above (bad version,
        // a cable naming a port a known module no longer has) leaves the
        // running patch completely untouched rather than half-torn-down.
        currentPatchName = parsed.meta?.name ?? 'Untitled'
        patchNameInput.value = currentPatchName
        mountGraph(loaded)
        if (ghosts.length > 0) showBanner('warn', ghostMessage(ghosts))
        else clearBanner()
        scheduleAutosave()
      } catch (err) {
        showBanner('error', `Could not load "${file.name}": ${(err as Error).message}`)
      }
    })()
  })

  // ---- boot: restore an autosave if one exists and still loads under
  // this build; otherwise the starter patch. A restore that throws (a
  // stale, newer-version autosave, or JSON corruption) falls back to the
  // starter patch rather than leaving the page blank. ----
  const autosaved = loadAutosave()
  if (autosaved) {
    try {
      const { graph: restored, ghosts } = loadPatch(ctx, autosaved)
      currentPatchName = autosaved.meta?.name ?? 'Untitled'
      mountGraph(restored)
      if (ghosts.length > 0) showBanner('warn', ghostMessage(ghosts))
    } catch (err) {
      showBanner('error', `Could not restore your autosaved patch (${(err as Error).message}). Starting fresh.`)
      mountGraph(buildDefaultPatch())
    }
  } else {
    mountGraph(buildDefaultPatch())
  }
  patchNameInput.value = currentPatchName

  // ---- reveal ----
  $('power-section').hidden = true
  $('app').hidden = false
}

boot()
