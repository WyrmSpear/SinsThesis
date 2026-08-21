import { PatchGraph } from '../src/engine/graph'
import { registerAllModules } from '../src/engine/modules'
import { getModule, listModules } from '../src/engine/registry'
import { ensureWorklets, renderPatch, renderPatchStereo } from '../src/engine/render'
import { createCpuMeter } from '../src/engine/cpu-meter'
import { renderCpuMeter } from './cpu-meter-panel'
import { serializePatch, loadPatch, type PatchFile } from '../src/engine/patch'
import { inspect, type InspectorFailure, type InspectorResult } from '../src/engine/analysis/inspector'
import { compareSounds } from '../src/engine/analysis/compare'
import { gradeFeatures } from '../src/engine/analysis/rubric'
import type { OutputInstance } from '../src/engine/modules/output'
import type { KeyboardMidiInstance } from '../src/engine/modules/keyboard-midi'
import { requestMidiAccess, parseMidiMessage } from '../src/engine/midi'
import { MidiLearnController, type MidiBinding } from '../src/engine/midi-learn'
import { LiveRecorder, type RecordingResult } from '../src/engine/recorder'
import { encodeWav, type WavFormat } from '../src/engine/wav'
import { buildPanel, type MidiKnobHandle } from './panel'
import { buildGhostPanel } from './ghost-panel'
import { renderMidiStatus, flashMidiActivity, type MidiStatusState } from './midi-status-panel'
import { buildPalette } from './palette'
import { buildPresetBankPanel } from './preset-bank-panel'
import { PRESET_BANK, getPreset } from '../presets/bank'
import { CableLayer } from './cables'
import { buildKeyboardPanel } from './keyboard-panel'
import { buildSequencerPanel } from './sequencer-panel'
import { buildScopePanel } from './scope-panel'
import { startArcade, type ArcadeHandle } from './arcade-panel'
import { seededRngFromSearch } from '../arcade/rng'
import { startWub } from './wub-panel'
import { buildSamplerPanel } from './sampler-panel'
import { enableReorder } from './reorder'
import { downloadPatch, downloadWav, readPatchFile, saveAutosave, loadAutosave, debounce } from './patch-io'
import { renderStudioPanel, type StudioPanelState } from './studio-panel'
import { renderPitchDisplay } from './pitch-display'
import { initThemeSwitcher } from './theme-switcher'
import { TRACKS, levelsInTrack, getLevel, type Level } from '../academy/levels'
import { loadProgress, markComplete, setCurrentTrack, type AcademyProgress } from '../academy/progress'
import { renderAcademyPanel, type MatchCheckState, type ConstrainedCheckState } from './academy-panel'
import { describeFailures } from '../academy/feedback'
import { describeSoundDifference } from '../academy/sound-feedback'
import { describeFeatureFailures } from '../academy/constrained-feedback'

/** Every match-this-sound render, target and player alike, uses this rate
 *  -- fixed rather than inherited from the live `AudioContext` (which
 *  varies by OS/device default) so a target rendered once is directly
 *  comparable to every player render for the rest of the session. */
const MATCH_SAMPLE_RATE = 48000

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
  // Section 11's "a worklet fails to load" failure mode: `ensureWorklets`
  // still rejects if even one of its bundles' `addModule()` call failed
  // (render.ts's own doc comment explains why that's preserved on
  // purpose), but a rejection here must not take the whole rack down with
  // it -- before this fix, an uncaught throw left `powerBtn` stuck reading
  // "STARTING…" forever, silence with no explanation, worse than the one
  // module this is actually about. Every bundle that *did* load is
  // already recorded (`worklets/registry.ts`'s `markWorkletLoaded`, called
  // per-bundle as each `addModule()` resolves, independent of this
  // combined promise's own fate) by the time this `catch` runs, so
  // `buildDefaultPatch`/`loadPatch` below still build every module whose
  // worklet made it -- only the specific module(s) whose bundle didn't
  // fall back or fail loudly, each with its own visible badge
  // (rack/panel.ts). See `.superpowers/sdd/robustness-report.md`.
  let workletLoadFailed = false
  try {
    await ensureWorklets(ctx)
  } catch (err) {
    workletLoadFailed = true
    console.error('SinsThesis: one or more audio worklets failed to load.', err)
  }
  if (ctx.state === 'suspended') await ctx.resume()

  const rackEl = $('rack-modules')
  const paletteDrawer = $('palette-drawer')
  const presetBankDrawer = $('preset-bank-drawer')
  const academyPanel = $('academy-panel')
  const studioPanelEl = $('studio-panel')
  const pitchDisplayEl = $('pitch-display')
  const statusBanner = $('status-banner')
  const patchNameInput = $<HTMLInputElement>('patch-name')
  const paletteToggle = $<HTMLButtonElement>('palette-toggle')
  const presetBankToggle = $<HTMLButtonElement>('preset-bank-toggle')
  const saveBtn = $<HTMLButtonElement>('save-patch')
  const loadBtn = $<HTMLButtonElement>('load-patch')
  const loadFileInput = $<HTMLInputElement>('load-file')
  const cpuMeterEl = $('cpu-meter')
  const midiStatusEl = $('midi-status')
  const modeFreeplayBtn = $<HTMLButtonElement>('mode-freeplay')
  const modeAcademyBtn = $<HTMLButtonElement>('mode-academy')
  const modeArcadeBtn = $<HTMLButtonElement>('mode-arcade')
  const arcadePanelEl = $('arcade-panel')

  // Section 11's "CPU overload -> load meter": one meter for the whole
  // session, not per patch -- it measures the audio context's overall
  // render load (src/engine/cpu-meter.ts's own doc comment explains why
  // that already covers whatever is currently mounted), so nothing about
  // it needs rebuilding across mountGraph's patch swaps. `undefined` when
  // the `cpu-meter` worklet bundle itself didn't load; `renderCpuMeter`
  // hides the element rather than showing a reading that isn't real.
  renderCpuMeter(cpuMeterEl, createCpuMeter(ctx))

  // ---- mutable rack state: reassigned wholesale on every patch load, per
  // src/engine/graph.ts's dispose() doc comment -- a live session swapping
  // patches must tear down the old PatchGraph, not just drop the
  // reference, or its clock module's setInterval keeps firing forever. ----
  let graph: PatchGraph
  let cableLayer: CableLayer
  let nextColumn = 0
  let currentPatchName = 'Untitled'
  const connectedOutputs = new Set<string>()

  // ---- MIDI hardware state. `midiLearn` and `knobRegistry` are rebuilt on
  // every `mountGraph` -- a binding's `moduleId` is only meaningful against
  // the graph it names, the same reason `cableLayer` is rebuilt rather than
  // patched. Device access/selection, by contrast, is a property of the
  // player's own rig, not the patch (see src/engine/midi-learn.ts's header
  // comment for the full reasoning) -- it survives every patch swap and is
  // set up once, below, after POWER ON. ----
  let midiLearn = new MidiLearnController()
  // `${moduleId}:${paramId}` -> the live on-screen knob handle `rack/panel.ts`
  // registered for it, so an incoming CC can push a value onto the exact
  // dial it drives (`MidiKnobHandle.setValue`) and refresh its badge/armed
  // indicator (`MidiLearnHandle.refresh`) without rebuilding the panel.
  const knobRegistry = new Map<string, MidiKnobHandle>()
  // Mirrors `midiLearn`'s own single-armed-target invariant so this file
  // knows which *other* knob (if any) needs its indicator cleared when a
  // new one is armed -- `midiLearn.isArmed(...)` stays the source of truth
  // for any individual knob's own display, this is only bookkeeping for
  // "who else needs a refresh call."
  let armedKnobKey: string | undefined
  let midiAccess: MIDIAccess | null = null
  const midiInputs = new Map<string, MIDIInput>()
  let midiInput: MIDIInput | undefined
  let selectedMidiDeviceId: string | undefined

  function knobKey(moduleId: string, paramId: string): string {
    return `${moduleId}:${paramId}`
  }

  // Requested here, on POWER ON, not on page load and not behind a
  // separate "connect MIDI" button. Two reasons: some browsers gate
  // `requestMIDIAccess` behind its own permission prompt, and POWER ON is
  // already the one user gesture this whole app requires before anything
  // runs at all (`power-section`'s own "audio requires a user gesture"
  // copy) -- reusing it means a plugged-in controller works the instant
  // the rack does, with no extra click asked of a player who may not even
  // own one. `requestMidiAccess` never throws (src/engine/midi.ts's own
  // doc comment) -- `null` is the ordinary "no API, or the player refused
  // the prompt" case, and it is never treated as an error here: no banner,
  // no console noise, just `renderMidiStatusPanel` reading `midiAccess ===
  // null` as "unavailable." The computer keyboard (`rack/keyboard-panel.ts`)
  // needs nothing from this and keeps working regardless of the outcome.
  midiAccess = await requestMidiAccess()
  if (midiAccess) {
    // Hot-plug: a controller plugged in or unplugged after POWER ON fires
    // this, and `refreshMidiDevices` re-enumerates from scratch rather
    // than trying to patch in just the one port that changed.
    midiAccess.onstatechange = () => refreshMidiDevices()
    refreshMidiDevices()
  } else {
    renderMidiStatusPanel()
  }

  // ---- academy mode state. `mode` gates two things: which chrome is
  // visible (`academyPanel` vs. the ordinary palette/toolbar), and whether
  // `scheduleAutosave` is allowed to touch the free-play autosave slot --
  // see its own comment below for why academy edits must never overwrite
  // it. `freePlaySnapshot` is what makes leaving the academy restore
  // free-play exactly as it was, per the task's "the academy is a mode,
  // not a replacement": it is captured the moment the player *enters* the
  // academy (mountGraph having last held the free-play patch) and
  // reloaded the moment they leave. ----
  let mode: 'freeplay' | 'academy' | 'arcade' = 'freeplay'
  // Arcade's own live handle (rack/arcade-panel.ts) -- undefined whenever
  // Arcade isn't the current mode, since the game's rAF loop and its
  // parallel stereo-balance tap have no reason to exist while nothing is
  // drawing them. Built fresh on every entry to Arcade (showArcade) and
  // torn down on every exit (showFreePlay/showAcademy), the same
  // "self-terminating panel" contract rack/scope-panel.ts documents for
  // its own tick loop.
  let arcadeHandle: ArcadeHandle | undefined
  // Which of ROADMAP 3a's two shipped arcade games is mounted -- 'paddle'
  // (rack/arcade-panel.ts) or 'wub' (rack/wub-panel.ts). Picked by a small
  // in-panel toggle (see showArcade below), remembered across mode
  // switches within the session the same way `currentTrackId` remembers
  // the academy's last-viewed track, but deliberately not persisted --
  // Arcade has no saved-progress concept to hang it on.
  let arcadeGame: 'paddle' | 'wub' = 'paddle'
  let currentLevelId: string | undefined
  let progress: AcademyProgress = loadProgress()
  // Which selectable sequence (academy/levels.ts's TRACKS) the player is
  // looking at -- restored from wherever they last left off (best-effort,
  // same as `progress.completed` itself), falling back to 'main' for a
  // save from before tracks existed or if nothing was ever saved.
  let currentTrackId: string = progress.currentTrack && TRACKS.some((t) => t.id === progress.currentTrack)
    ? progress.currentTrack
    : 'main'
  let lastCheck: InspectorResult | undefined
  let freePlaySnapshot: PatchFile | undefined

  // ---- match-this-sound state: a level's target is rendered offline
  // (never stored at author time -- see academy/levels.ts's own header
  // comment for why) the first time it's needed and cached here per level
  // id for the rest of the session, since this build's DSP cannot change
  // out from under a single running page. `checking` covers both "Play
  // target" and "Check my patch", either of which is a real (if short)
  // OfflineAudioContext render -- unlike build-this-patch's synchronous
  // inspect(), so the panel disables its buttons and says so rather than
  // letting a second click race the first. ----
  const targetBufferCache = new Map<string, Float32Array>()
  let checking = false
  let lastMatch: MatchCheckState | undefined
  let lastConstrained: ConstrainedCheckState | undefined

  // ---- studio layer state (Phase 3's first slice): a `LiveRecorder` tap
  // for keeping a real performance, and an offline `renderPatch` bounce for
  // a fixed-length render of the patch as it stands. Only one capture is
  // ever "the current export" -- see rack/studio-panel.ts's own header
  // comment for why that mirrors a DAW's single last-bounce slot. ----
  const recorder = new LiveRecorder(ctx, { onAutoStop: handleRecordingResult })
  let recording = false
  let elapsedTimerHandle: ReturnType<typeof setInterval> | undefined
  let bounceBusy = false
  let bounceLengthSeconds = 4
  let lastCapture:
    | {
        /** Left channel, kept alongside `channels` for the pitch display
         *  and waveform (rack/pitch-display.ts), which are mono-shaped
         *  tools with no need for a stereo image -- see that module's own
         *  call below. */
        samples: Float32Array
        /** Both channels, for the WAV export -- see doExport below. A
         *  mono capture (the common case) arrives here as two identical
         *  channels, the same up-mix every stereo module's `in` jack
         *  performs; see output.ts's doc comment. */
        channels: [Float32Array, Float32Array]
        sampleRate: number
        source: 'recording' | 'bounce'
        seconds: number
        truncated: boolean
      }
    | undefined
  let wavFormat: WavFormat = 'float32'
  let saveSinpAlongside = true
  let studioStatus: string | undefined

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
    saveAutosave(serializePatch(graph, { name: currentPatchName }, midiLearn.all))
  }, 400)

  // ---- MIDI hardware wiring. `MIDI_DEVICE_KEY` is deliberately a
  // different storage key from `patch-io.ts`'s `AUTOSAVE_KEY` and never
  // touches `PatchFile` at all -- device selection is the player's rig,
  // not the patch (src/engine/midi-learn.ts's header comment). Best-effort
  // like every other localStorage write in this app (`saveAutosave`'s own
  // comment): losing it just means the device picker falls back to "first
  // available" next time, never a thrown error. ----
  const MIDI_DEVICE_KEY = 'sinsthesis:midi-device:v1'

  function loadSelectedMidiDeviceId(): string | undefined {
    try {
      return localStorage.getItem(MIDI_DEVICE_KEY) ?? undefined
    } catch {
      return undefined
    }
  }

  function saveSelectedMidiDeviceId(id: string): void {
    try {
      localStorage.setItem(MIDI_DEVICE_KEY, id)
    } catch {
      /* best-effort */
    }
  }

  function renderMidiStatusPanel(): void {
    const state: MidiStatusState = !midiAccess
      ? { kind: 'unavailable' }
      : midiInputs.size === 0
        ? { kind: 'no-device' }
        : {
            kind: 'connected',
            devices: [...midiInputs.values()].map((d) => ({ id: d.id, name: d.name || 'MIDI device' })),
            selectedId: selectedMidiDeviceId!,
          }
    renderMidiStatus(midiStatusEl, state, {
      onSelectDevice(id) {
        selectedMidiDeviceId = id
        saveSelectedMidiDeviceId(id)
        attachToSelectedDevice()
        renderMidiStatusPanel()
      },
    })
  }

  /** Listens to exactly one input at a time -- the device named by
   *  `selectedMidiDeviceId` -- rather than fanning in every plugged-in
   *  controller. Simpler to reason about (one clock of note/CC traffic,
   *  never two controllers' CC 74 fighting over the same knob) and matches
   *  the device picker's own "choose one" UI. Detaches from whatever was
   *  previously attached first, so switching devices (or losing the
   *  selected one on unplug) never leaves a stale listener receiving
   *  messages nobody expects anymore. */
  function attachToSelectedDevice(): void {
    if (midiInput) midiInput.onmidimessage = null
    midiInput = selectedMidiDeviceId ? midiInputs.get(selectedMidiDeviceId) : undefined
    if (midiInput) midiInput.onmidimessage = handleRawMidiMessage
  }

  /** Re-reads `midiAccess.inputs` -- called once after access is granted
   *  and again on every `onstatechange` (hot-plug: a controller plugged in
   *  or pulled out while the rack is already running). Keeps the current
   *  selection if it is still present; otherwise falls back to whatever
   *  was last persisted (if that device is back), then to the first
   *  available input, then to none. */
  function refreshMidiDevices(): void {
    midiInputs.clear()
    midiAccess?.inputs.forEach((input) => midiInputs.set(input.id, input))
    if (!selectedMidiDeviceId || !midiInputs.has(selectedMidiDeviceId)) {
      const persisted = loadSelectedMidiDeviceId()
      const fallback = persisted && midiInputs.has(persisted) ? persisted : midiInputs.keys().next().value
      selectedMidiDeviceId = fallback
    }
    attachToSelectedDevice()
    renderMidiStatusPanel()
  }

  /** Drops every MIDI-learn binding and registered knob addressed to
   *  `moduleId` -- called on module removal so a stale binding never
   *  points at a param that no longer exists, mirroring
   *  `removeModuleById`'s other per-module cleanup (`cableLayer`,
   *  `connectedOutputs`). */
  function purgeMidiForModule(moduleId: string): void {
    midiLearn.unbindModule(moduleId)
    const prefix = `${moduleId}:`
    for (const key of [...knobRegistry.keys()]) {
      if (key.startsWith(prefix)) knobRegistry.delete(key)
    }
    if (armedKnobKey?.startsWith(prefix)) armedKnobKey = undefined
  }

  /** Right-click "MIDI Learn" (or "Cancel MIDI Learn" while already armed)
   *  on a knob -- `rack/knob-midi.ts`'s `onLearnRequest`, which fires for
   *  both cases since they're the same toggle. Refreshes both the
   *  previously armed knob (if any, and different) and the newly armed
   *  one, so at most one knob ever shows a "listening" indicator. */
  function setArmedKnob(moduleId: string, paramId: string): void {
    const key = knobKey(moduleId, paramId)
    const previous = armedKnobKey
    if (armedKnobKey === key) {
      midiLearn.disarm()
      armedKnobKey = undefined
    } else {
      midiLearn.arm(moduleId, paramId)
      armedKnobKey = key
    }
    if (previous && previous !== key) knobRegistry.get(previous)?.refresh()
    knobRegistry.get(key)?.refresh()
  }

  /** The one entry point for every raw MIDI message this rack ever
   *  receives -- `MIDIInput.onmidimessage`, wired in `attachToSelectedDevice`.
   *  Note messages go to every Keyboard module in the patch, each deciding
   *  independently (via its own `handleMidiEvent`) whether the note falls
   *  in its own key-range zone -- exactly the same "every zone answers for
   *  itself, no arbitration" rule a computer-keyboard keydown already
   *  follows (`keyboard-midi.ts`'s own doc comment), so a split keyboard
   *  works identically from real hardware. CC messages never reach a
   *  Keyboard module at all -- they go straight to `midiLearn`, which may
   *  apply an existing binding, complete an armed one, or (the common
   *  case, no binding and nothing armed) do nothing. */
  function handleRawMidiMessage(e: MIDIMessageEvent): void {
    const event = parseMidiMessage(new Uint8Array(e.data ?? []))
    if (!event) return
    flashMidiActivity(midiStatusEl)

    if (event.kind === 'noteOn' || event.kind === 'noteOff') {
      for (const id of graph.moduleIds) {
        if (graph.getType(id) !== 'keyboard') continue
        const instance = graph.getInstance(id) as KeyboardMidiInstance | undefined
        instance?.handleMidiEvent(event)
      }
      return
    }

    const wasArmed = armedKnobKey
    const touched = midiLearn.handleCc(graph, event.controller, event.value)
    if (wasArmed && !midiLearn.armedTarget) armedKnobKey = undefined // the CC that just completed a bind disarms it
    if (touched.length === 0) return
    for (const binding of touched) {
      const handle = knobRegistry.get(knobKey(binding.moduleId, binding.paramId))
      const value = graph.getParams(binding.moduleId)[binding.paramId]
      if (value !== undefined) handle?.setValue(value)
      handle?.refresh()
    }
    scheduleAutosave()
  }

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
    const currentLevel = currentLevelId ? getLevel(currentLevelId) : undefined
    renderAcademyPanel(
      academyPanel,
      levelsInTrack(currentTrackId),
      {
        tracks: TRACKS,
        currentTrackId,
        currentLevelId,
        progress,
        lastCheck,
        feedback: lastCheck && !lastCheck.pass ? describeFailures(lastCheck, graph) : [],
        busy: checking,
        lastMatch,
        moduleCount:
          currentLevel?.mode === 'constrained'
            ? graph.moduleIds.filter((id) => graph.getType(id) !== 'output').length
            : undefined,
        lastConstrained,
      },
      { onSelectTrack: selectTrack, onSelectLevel: enterLevel, onCheck: checkLevel, onPlayTarget: playTarget },
    )
  }

  /** Switches the visible track and drops into its first level -- the same
   *  "choosing a track re-enters at its own beginning" behavior
   *  `showAcademy` already gives a fresh academy visit. Persisted
   *  (best-effort) so returning to the academy later reopens the same
   *  track, mirroring how `progress.completed` already survives a reload. */
  function selectTrack(id: string): void {
    if (id === currentTrackId) return
    currentTrackId = id
    progress = setCurrentTrack(id)
    currentLevelId = undefined
    lastCheck = undefined
    lastMatch = undefined
    lastConstrained = undefined
    clearHighlights()
    const first = levelsInTrack(currentTrackId)[0]
    if (first) enterLevel(first.id) // also refreshes the palette and renders
    else renderAcademy()
  }

  function renderStudio(): void {
    const state: StudioPanelState = {
      recording,
      elapsedSeconds: recording ? recorder.elapsedSeconds : 0,
      maxSeconds: recorder.maxSeconds,
      bounceBusy,
      bounceLengthSeconds,
      hasCapture: lastCapture !== undefined,
      captureSource: lastCapture?.source,
      captureSeconds: lastCapture?.seconds ?? 0,
      truncated: lastCapture?.truncated ?? false,
      wavFormat,
      saveSinpAlongside,
      statusMessage: studioStatus,
    }
    renderStudioPanel(studioPanelEl, state, {
      onRecordToggle: toggleRecord,
      onBounceLengthChange: (seconds) => {
        bounceLengthSeconds = seconds
        renderStudio()
      },
      onBounce: () => void doBounce(),
      onFormatChange: (format) => {
        wavFormat = format
        renderStudio()
      },
      onSaveSinpToggle: (checked) => {
        saveSinpAlongside = checked
        renderStudio()
      },
      onExport: doExport,
    })
    renderPitchDisplay(pitchDisplayEl, lastCapture && { samples: lastCapture.samples, sampleRate: lastCapture.sampleRate })
  }

  /** Record button: taps whatever the rack's first Output module currently
   *  emits (see rack/studio-panel.ts's header comment on why this is the
   *  live-performance mechanism, not the offline one) and starts a real
   *  wall-clock capture. A second click -- or `LiveRecorder`'s own length
   *  cap, via `handleRecordingResult` below -- stops it. */
  function toggleRecord(): void {
    if (recording) {
      handleRecordingResult(recorder.stop())
      return
    }
    const outputId = graph.moduleIds.find((id) => graph.getType(id) === 'output')
    const source = outputId ? graph.getInstance(outputId)?.outputs.get('out') : undefined
    if (!source) {
      showBanner('error', 'Add an Output module before recording.')
      return
    }
    studioStatus = undefined
    recorder.start(source)
    recording = true
    elapsedTimerHandle = setInterval(renderStudio, 200)
    renderStudio()
  }

  /** Shared by an explicit Stop click and `LiveRecorder`'s own auto-stop
   *  (the length cap firing from inside a worklet message handler) -- both
   *  end up with the same `RecordingResult` shape, so both are finished the
   *  same way, and the operator sees the same "capped" wording either way. */
  function handleRecordingResult(result: RecordingResult): void {
    recording = false
    if (elapsedTimerHandle !== undefined) {
      clearInterval(elapsedTimerHandle)
      elapsedTimerHandle = undefined
    }
    if (result.channels[0].length === 0) {
      renderStudio()
      return
    }
    lastCapture = {
      samples: result.channels[0],
      channels: result.channels,
      sampleRate: result.sampleRate,
      source: 'recording',
      seconds: result.seconds,
      truncated: result.truncated,
    }
    studioStatus = result.truncated
      ? `Recording stopped automatically at the ${Math.round(recorder.maxSeconds)}s limit. Export it, or start a new one.`
      : `Recorded ${result.seconds.toFixed(1)}s. Ready to export.`
    renderStudio()
  }

  /** Bounce: renders the *current* patch offline through the same
   *  `renderPatch` procedure match-this-sound already uses for the
   *  academy (see this file's `getTargetBuffer`) -- serialize-then-render,
   *  reusing the exact round trip `.sinp` save/load already exercises,
   *  rather than trying to clone the live graph. Faster than real time, no
   *  dropout risk, because nothing here runs against a real-time deadline.
   *
   *  Sample rate: `ctx.sampleRate`, the live `AudioContext`'s own rate --
   *  audit round two, finding 4. This used to hardcode `MATCH_SAMPLE_RATE`
   *  (48000), the constant match-this-sound deliberately fixes so a target
   *  rendered once stays comparable all session (see that constant's own
   *  doc comment). The bounce has no such comparability requirement -- it's
   *  a one-shot export of *this* patch -- and live recording already uses
   *  `ctx.sampleRate` (`LiveRecorder`, below), so on hardware running at
   *  44100 Hz instead of 48000, a bounce and a live recording of the same
   *  patch used to disagree at the sample level despite both WAV headers
   *  independently being internally correct. */
  async function doBounce(): Promise<void> {
    if (bounceBusy || recording) return
    bounceBusy = true
    studioStatus = undefined
    renderStudio()
    try {
      const patch = serializePatch(graph, { name: currentPatchName })
      const bounceSampleRate = ctx.sampleRate
      // Stereo -- see renderPatchStereo's own doc comment for why the
      // bounce specifically (unlike renderPatch's other callers, which stay
      // mono on purpose) needs both channels: this is the "export my patch"
      // feature, and a wide pad or a ping-pong lead bounced to mono would
      // be exactly the silent data-loss bug ROADMAP section 1a warns about.
      const { left, right } = await renderPatchStereo(patch, bounceLengthSeconds, { sampleRate: bounceSampleRate })
      lastCapture = {
        samples: left,
        channels: [left, right],
        sampleRate: bounceSampleRate,
        source: 'bounce',
        seconds: bounceLengthSeconds,
        truncated: false,
      }
      studioStatus = `Bounced ${bounceLengthSeconds.toFixed(1)}s. Ready to export.`
    } catch (err) {
      showBanner('error', `Bounce failed: ${(err as Error).message}`)
    } finally {
      bounceBusy = false
      renderStudio()
    }
  }

  /** Export: hand-written WAV (src/engine/wav.ts), named from the patch --
   *  see rack/patch-io.ts's `downloadWav` doc comment for why -- and,
   *  when `saveSinpAlongside` is checked, the `.sinp` that made the sound,
   *  so a recording and the patch that produced it never drift apart. */
  function doExport(): void {
    if (!lastCapture) return
    // Always writes both channels -- see the `lastCapture.channels` doc
    // comment above. A mono-only patch exports as two identical channels,
    // a correct (if unremarkable) stereo file, not a special case.
    const wavBuffer = encodeWav(lastCapture.channels, lastCapture.sampleRate, wavFormat)
    downloadWav(currentPatchName, wavBuffer)
    if (saveSinpAlongside) downloadPatch(serializePatch(graph, { name: currentPatchName }, midiLearn.all))
    studioStatus = `Exported "${currentPatchName}.wav"${saveSinpAlongside ? ' and .sinp' : ''}.`
    renderStudio()
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
    lastMatch = undefined
    lastConstrained = undefined
    const { graph: loaded, midiBindings } = loadPatch(ctx, level.startingPatch)
    mountGraph(loaded, midiBindings)
    currentPatchName = level.title
    patchNameInput.value = currentPatchName
    refreshPalette(level.grantedModules)
    renderAcademy()
  }

  /** Renders a match-this-sound level's target sound once and caches it
   *  for the rest of the session (see the `targetBufferCache` comment
   *  above): the `.sinp` under `level.solution` *is* the target here, not
   *  a model solution to compare wiring against. */
  async function getTargetBuffer(level: Level): Promise<Float32Array> {
    const cached = targetBufferCache.get(level.id)
    if (cached) return cached
    const buffer = await renderPatch(level.solution, level.match!.seconds, {
      sampleRate: MATCH_SAMPLE_RATE,
      gate: level.match!.gate,
    })
    targetBufferCache.set(level.id, buffer)
    return buffer
  }

  /** "Play target sound": Section 3's "hear the target on demand, as many
   *  times as you want" -- plays straight through the live `ctx`, no
   *  grading involved. Only the render (cached after the first call) takes
   *  real time; scheduling playback is instant. */
  function playTarget(): void {
    if (checking || !currentLevelId) return
    const level = getLevel(currentLevelId)
    if (!level || level.mode !== 'match') return
    checking = true
    renderAcademy()
    void getTargetBuffer(level)
      .then((buffer) => {
        const audioBuffer = ctx.createBuffer(1, buffer.length, MATCH_SAMPLE_RATE)
        // A fresh, plain-ArrayBuffer-backed copy: `renderPatch`'s Float32Array
        // is typed against the more general `ArrayBufferLike`, which
        // `copyToChannel` (correctly) won't accept a `SharedArrayBuffer`-backed
        // view as -- copying (not just casting) also means the render buffer
        // in `targetBufferCache` is never handed to WebAudio for it to retain
        // a reference into.
        audioBuffer.copyToChannel(new Float32Array(buffer), 0)
        const source = ctx.createBufferSource()
        source.buffer = audioBuffer
        source.connect(ctx.destination)
        source.start()
      })
      .finally(() => {
        checking = false
        renderAcademy()
      })
  }

  /** The Check button. Build-this-patch levels grade the live graph with
   *  the level's own `InspectorQuery` (Section: "Use inspect rather than
   *  writing new grading logic") -- synchronous, unchanged. Match-this-sound
   *  levels render the player's *current* patch offline through the same
   *  `renderPatch` procedure as the target (same duration, same gate
   *  schedule) and grade the pair with `compareSounds`. Either way, a pass
   *  persists progress; a fail leaves the graph untouched so the player
   *  keeps working on the same patch. */
  function checkLevel(): void {
    if (checking || !currentLevelId) return
    const level = getLevel(currentLevelId)
    if (!level) return

    if (level.mode === 'match') {
      checking = true
      renderAcademy()
      const playerPatch = serializePatch(graph, { name: currentPatchName })
      void Promise.all([
        getTargetBuffer(level),
        renderPatch(playerPatch, level.match!.seconds, { sampleRate: MATCH_SAMPLE_RATE, gate: level.match!.gate }),
      ])
        .then(([target, player]) => {
          const comparison = compareSounds(target, player, MATCH_SAMPLE_RATE, level.match!.passThreshold)
          lastMatch = {
            comparison,
            target,
            player,
            sampleRate: MATCH_SAMPLE_RATE,
            feedback: describeSoundDifference(comparison, { hasFilter: level.grantedModules.includes('vcf') }),
          }
          if (comparison.pass) progress = markComplete(level.id)
        })
        .finally(() => {
          checking = false
          renderAcademy()
        })
      return
    }

    if (level.mode === 'constrained') {
      checking = true
      renderAcademy()
      const c = level.constrained!
      const playerPatch = serializePatch(graph, { name: currentPatchName })
      const structural = inspect(graph, { maxModules: c.maxModules })
      void renderPatch(playerPatch, c.seconds, { sampleRate: MATCH_SAMPLE_RATE, gate: c.gate })
        .then((samples) => {
          const featureResult = gradeFeatures(samples, MATCH_SAMPLE_RATE, c.features)
          const pass = structural.pass && featureResult.pass
          lastConstrained = {
            pass,
            feedback: [...describeFailures(structural, graph), ...describeFeatureFailures(featureResult.detail)],
          }
          if (pass) {
            progress = markComplete(level.id)
            clearHighlights()
          } else {
            highlightFailures(structural.detail)
          }
        })
        .finally(() => {
          checking = false
          renderAcademy()
        })
      return
    }

    const result = inspect(graph, level.query!)
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
    if (mode !== 'academy') freePlaySnapshot = serializePatch(graph, { name: currentPatchName }, midiLearn.all)
    stopArcade()
    mode = 'academy'
    modeAcademyBtn.classList.add('mode-toggle-btn-active')
    modeFreeplayBtn.classList.remove('mode-toggle-btn-active')
    modeArcadeBtn.classList.remove('mode-toggle-btn-active')
    academyPanel.hidden = false
    arcadePanelEl.hidden = true
    paletteDrawer.hidden = true
    const firstOfTrack = levelsInTrack(currentTrackId)[0]
    if (currentLevelId === undefined && firstOfTrack) {
      enterLevel(firstOfTrack.id) // also refreshes the palette and renders
    } else {
      refreshPalette(currentLevelId ? getLevel(currentLevelId)?.grantedModules : undefined)
      renderAcademy()
    }
  }

  function showFreePlay(): void {
    const wasAcademy = mode === 'academy'
    stopArcade()
    mode = 'freeplay'
    modeFreeplayBtn.classList.add('mode-toggle-btn-active')
    modeAcademyBtn.classList.remove('mode-toggle-btn-active')
    modeArcadeBtn.classList.remove('mode-toggle-btn-active')
    academyPanel.hidden = true
    arcadePanelEl.hidden = true
    clearHighlights()
    refreshPalette()
    // Only academy swaps the mounted graph out from under free play (a
    // level's own solution-in-progress) -- Arcade never touches `graph` at
    // all, so leaving it has nothing to restore. Restoring on every exit
    // regardless of where the player came from would occasionally hand
    // them back a stale snapshot from a much earlier academy visit.
    if (wasAcademy && freePlaySnapshot) {
      const { graph: restored, midiBindings } = loadPatch(ctx, freePlaySnapshot)
      mountGraph(restored, midiBindings)
      currentPatchName = freePlaySnapshot.meta.name
      patchNameInput.value = currentPatchName
    }
  }

  /** Arcade mode (ROADMAP 3a's pan-paddle prototype): a third top-level
   *  mode, not an academy track, because the two are different products
   *  by the roadmap's own account -- academy grades a patch's topology or
   *  sound against a rubric with a Check button; arcade is continuous and
   *  twitch-timed and has no pass/fail patch to check. Left as free-play's
   *  own graph, untouched: "the rack does not disappear -- patching is the
   *  controller" means whatever the player already has patched (Panner,
   *  LFO, Output, anything) is exactly what steers the paddle, with no
   *  separate arcade-only patch to build first. See rack/arcade-panel.ts's
   *  header comment for what actually drives the paddle and why. */
  /** Reads the output getter both arcade games take -- pulled out since
   *  showArcade needs to hand the identical closure to whichever of the
   *  two it mounts. */
  function currentOutputInstance(): OutputInstance | undefined {
    const outId = graph.moduleIds.find((id) => graph.getType(id) === 'output')
    return outId ? (graph.getInstance(outId) as OutputInstance | undefined) : undefined
  }

  /** Mounts whichever game `arcadeGame` currently names into the picker's
   *  own slot element, tearing down whatever was running before -- called
   *  on every entry to Arcade and every picker click, never on a mode this
   *  file doesn't own. */
  function mountArcadeGame(slot: HTMLElement): void {
    arcadeHandle?.stop()
    arcadeHandle =
      arcadeGame === 'wub'
        ? startWub(slot, ctx, currentOutputInstance)
        : // A fresh generator per mount, so `?arcadeSeed=` replays the same
          // block sequence on every restart rather than continuing the
          // previous run's stream. Absent the param this is `undefined` and
          // `startArcade` falls back to `Math.random`.
          startArcade(
            slot,
            ctx,
            currentOutputInstance,
            seededRngFromSearch(location.search) ?? Math.random,
          )
  }

  /** The picker itself: two `.mode-toggle-btn`s (the same vocabulary the
   *  top-level Free Play/Academy/Arcade toggle already uses -- zero new
   *  CSS) above a slot div the selected game's own `startX` clears and
   *  rebuilds on every mount, exactly the way `arcadePanelEl` itself
   *  already gets rebuilt on every entry to Arcade. Built once per entry
   *  to Arcade rather than persisted across exits, matching every other
   *  panel in this file's own "rebuild the whole thing declaratively"
   *  convention (see arcadePanelEl's own doc comment). */
  function buildArcadeShell(): HTMLElement {
    arcadePanelEl.innerHTML = ''
    const picker = document.createElement('div')
    picker.className = 'mode-toggle arcade-game-picker'

    const paddleBtn = document.createElement('button')
    paddleBtn.type = 'button'
    paddleBtn.className = 'mode-toggle-btn'
    paddleBtn.textContent = 'Pan Paddle'
    paddleBtn.dataset['testid'] = 'wub-game-paddle'

    const wubBtn = document.createElement('button')
    wubBtn.type = 'button'
    wubBtn.className = 'mode-toggle-btn'
    wubBtn.textContent = 'Wub Disruptor'
    wubBtn.dataset['testid'] = 'wub-game-wub'

    const slot = document.createElement('div')
    slot.dataset['testid'] = 'arcade-game-slot'

    function refreshActive(): void {
      paddleBtn.classList.toggle('mode-toggle-btn-active', arcadeGame === 'paddle')
      wubBtn.classList.toggle('mode-toggle-btn-active', arcadeGame === 'wub')
    }
    refreshActive()

    paddleBtn.addEventListener('click', () => {
      if (arcadeGame === 'paddle') return
      arcadeGame = 'paddle'
      refreshActive()
      mountArcadeGame(slot)
    })
    wubBtn.addEventListener('click', () => {
      if (arcadeGame === 'wub') return
      arcadeGame = 'wub'
      refreshActive()
      mountArcadeGame(slot)
    })

    picker.append(paddleBtn, wubBtn)
    arcadePanelEl.append(picker, slot)
    return slot
  }

  function showArcade(): void {
    mode = 'arcade'
    modeArcadeBtn.classList.add('mode-toggle-btn-active')
    modeFreeplayBtn.classList.remove('mode-toggle-btn-active')
    modeAcademyBtn.classList.remove('mode-toggle-btn-active')
    academyPanel.hidden = true
    paletteDrawer.hidden = true
    arcadePanelEl.hidden = false
    clearHighlights()
    refreshPalette() // unrestricted -- arcade is free play plus an overlay, not a granted-module level
    const slot = buildArcadeShell()
    mountArcadeGame(slot)
  }

  function stopArcade(): void {
    arcadeHandle?.stop()
    arcadeHandle = undefined
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
    purgeMidiForModule(id)
    scheduleAutosave()
    // Constrained-challenge's live module counter (Section: "show the
    // player their count against the limit while they build") has to
    // track every add and remove, not only a Check -- academy mode's own
    // rebuild is cheap enough to just run on every module count change.
    if (mode === 'academy') renderAcademy()
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
      customPanels: {
        keyboard: buildKeyboardPanel, sequencer: buildSequencerPanel, scope: buildScopePanel,
        sampler: buildSamplerPanel,
      },
      onChange: scheduleAutosave,
      onRemove: removeModuleById,
      midiLearn: {
        getBinding: (moduleId, paramId) => midiLearn.bindingFor(moduleId, paramId),
        isArmed: (moduleId, paramId) => midiLearn.isArmed(moduleId, paramId),
        onLearnRequest: (moduleId, paramId) => setArmedKnob(moduleId, paramId),
        onUnbind: (moduleId, paramId) => {
          midiLearn.unbind(moduleId, paramId)
          knobRegistry.get(knobKey(moduleId, paramId))?.refresh()
          scheduleAutosave()
        },
        registerKnob: (moduleId, paramId, handle) => knobRegistry.set(knobKey(moduleId, paramId), handle),
      },
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
    if (mode === 'academy') renderAcademy()
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
      midiLearn,
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
  function mountGraph(newGraph: PatchGraph, midiBindings: readonly MidiBinding[] = []): void {
    cableLayer?.destroy()
    graph?.dispose()

    graph = newGraph
    cableLayer = new CableLayer($('rack-surface'), graph)
    cableLayer.onChange = scheduleAutosave
    connectedOutputs.clear()
    // A binding's `moduleId` is only meaningful against the graph that
    // minted it -- see the `midiLearn` field's own comment above -- so a
    // fresh `MidiLearnController` is built from exactly this load's own
    // bindings on every swap, the same way `cableLayer` is rebuilt rather
    // than reused. `renderRack` below repopulates `knobRegistry` from
    // scratch as it draws each panel, so clearing it here (rather than
    // leaving stale entries from the discarded graph) keeps it exactly in
    // sync with what's on screen.
    midiLearn = new MidiLearnController(midiBindings)
    knobRegistry.clear()
    armedKnobKey = undefined
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
    presetBankDrawer.hidden = true
    paletteDrawer.hidden = !paletteDrawer.hidden
  })

  // The patch bank: a fixed list built once (PRESET_BANK never changes at
  // runtime, unlike the palette, which is re-filtered per academy level),
  // wired through the identical load path an explicit "Load .sinp" already
  // uses -- loadPatch, then mountGraph -- so a bank preset is loaded
  // exactly the way any other patch file is, not a special second path.
  presetBankDrawer.append(buildPresetBankPanel(PRESET_BANK, { onLoad: loadPresetFromBank }))
  presetBankToggle.addEventListener('click', () => {
    paletteDrawer.hidden = true
    presetBankDrawer.hidden = !presetBankDrawer.hidden
  })

  async function loadPresetFromBank(id: string): Promise<void> {
    if (recording) { showBanner('warn', 'Stop recording before loading a preset.'); return }
    const preset = getPreset(id)
    if (!preset) return
    // Fetched on demand -- see presets/bank.ts's own doc comment. Cheap
    // after the first load of any given preset (the dynamic import is
    // cached by the module loader), so reopening the same preset later in
    // the session costs no extra network or parse work.
    const file = await preset.file()
    const { graph: loaded, ghosts, midiBindings } = loadPatch(ctx, file)
    currentPatchName = file.meta.name
    patchNameInput.value = currentPatchName
    mountGraph(loaded, midiBindings)
    if (ghosts.length > 0) showBanner('warn', ghostMessage(ghosts))
    else clearBanner()
    scheduleAutosave()
    presetBankDrawer.hidden = true
  }

  // A patch swap mid-recording would tear down the very module instance
  // `recorder` is tapped onto (`mountGraph` disposes the old graph), so the
  // three ways the mounted patch can change while the transport is running
  // are guarded here rather than inside `mountGraph` itself -- recording
  // stays tied to a stable graph for its whole duration.
  modeFreeplayBtn.classList.add('mode-toggle-btn-active')
  modeFreeplayBtn.addEventListener('click', () => {
    if (recording) { showBanner('warn', 'Stop recording before switching modes.'); return }
    showFreePlay()
  })
  modeAcademyBtn.addEventListener('click', () => {
    if (recording) { showBanner('warn', 'Stop recording before switching modes.'); return }
    showAcademy()
  })
  modeArcadeBtn.addEventListener('click', () => {
    if (recording) { showBanner('warn', 'Stop recording before switching modes.'); return }
    showArcade()
  })

  saveBtn.addEventListener('click', () => {
    currentPatchName = patchNameInput.value.trim() || 'Untitled'
    patchNameInput.value = currentPatchName
    downloadPatch(serializePatch(graph, { name: currentPatchName }, midiLearn.all))
  })

  loadBtn.addEventListener('click', () => {
    if (recording) { showBanner('warn', 'Stop recording before loading a different patch.'); return }
    loadFileInput.click()
  })
  loadFileInput.addEventListener('change', () => {
    const file = loadFileInput.files?.[0]
    loadFileInput.value = '' // so re-choosing the same filename still fires 'change'
    if (!file) return
    void (async () => {
      try {
        const parsed = await readPatchFile(file)
        const { graph: loaded, ghosts, midiBindings } = loadPatch(ctx, parsed)
        // Only now, with a fully-built replacement graph in hand, do we
        // touch the live rack -- a `loadPatch` throw above (bad version,
        // a cable naming a port a known module no longer has) leaves the
        // running patch completely untouched rather than half-torn-down.
        currentPatchName = parsed.meta?.name ?? 'Untitled'
        patchNameInput.value = currentPatchName
        mountGraph(loaded, midiBindings)
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
      const { graph: restored, ghosts, midiBindings } = loadPatch(ctx, autosaved)
      currentPatchName = autosaved.meta?.name ?? 'Untitled'
      mountGraph(restored, midiBindings)
      if (ghosts.length > 0) showBanner('warn', ghostMessage(ghosts))
    } catch (err) {
      showBanner('error', `Could not restore your autosaved patch (${(err as Error).message}). Starting fresh.`)
      mountGraph(buildDefaultPatch())
    }
  } else {
    mountGraph(buildDefaultPatch())
  }
  if (workletLoadFailed) {
    const note =
      "Some audio components didn't load, so a few modules are running in a reduced mode or " +
      'are disabled -- check each module\'s panel for details.'
    showBanner('warn', statusBanner.hidden ? note : `${statusBanner.textContent} ${note}`)
  }
  patchNameInput.value = currentPatchName
  renderStudio()

  // ---- reveal ----
  $('power-section').hidden = true
  $('app').hidden = false
}

boot()
