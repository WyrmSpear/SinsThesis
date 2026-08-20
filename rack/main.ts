import { PatchGraph } from '../src/engine/graph'
import { registerAllModules } from '../src/engine/modules'
import { getModule, listModules } from '../src/engine/registry'
import { ensureWorklets, renderPatch, renderPatchStereo } from '../src/engine/render'
import { serializePatch, loadPatch, type PatchFile } from '../src/engine/patch'
import { inspect, type InspectorFailure, type InspectorResult } from '../src/engine/analysis/inspector'
import { compareSounds } from '../src/engine/analysis/compare'
import { gradeFeatures } from '../src/engine/analysis/rubric'
import type { OutputInstance } from '../src/engine/modules/output'
import { LiveRecorder, type RecordingResult } from '../src/engine/recorder'
import { encodeWav, type WavFormat } from '../src/engine/wav'
import { buildPanel } from './panel'
import { buildGhostPanel } from './ghost-panel'
import { buildPalette } from './palette'
import { buildPresetBankPanel } from './preset-bank-panel'
import { PRESET_BANK, getPreset } from '../presets/bank'
import { CableLayer } from './cables'
import { buildKeyboardPanel } from './keyboard-panel'
import { buildSequencerPanel } from './sequencer-panel'
import { buildScopePanel } from './scope-panel'
import { startArcade, type ArcadeHandle } from './arcade-panel'
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
  await ensureWorklets(ctx)
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
  const modeFreeplayBtn = $<HTMLButtonElement>('mode-freeplay')
  const modeAcademyBtn = $<HTMLButtonElement>('mode-academy')
  const modeArcadeBtn = $<HTMLButtonElement>('mode-arcade')
  const arcadePanelEl = $('arcade-panel')

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
  let mode: 'freeplay' | 'academy' | 'arcade' = 'freeplay'
  // Arcade's own live handle (rack/arcade-panel.ts) -- undefined whenever
  // Arcade isn't the current mode, since the game's rAF loop and its
  // parallel stereo-balance tap have no reason to exist while nothing is
  // drawing them. Built fresh on every entry to Arcade (showArcade) and
  // torn down on every exit (showFreePlay/showAcademy), the same
  // "self-terminating panel" contract rack/scope-panel.ts documents for
  // its own tick loop.
  let arcadeHandle: ArcadeHandle | undefined
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
    if (saveSinpAlongside) downloadPatch(serializePatch(graph, { name: currentPatchName }))
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
    const { graph: loaded } = loadPatch(ctx, level.startingPatch)
    mountGraph(loaded)
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
    if (mode !== 'academy') freePlaySnapshot = serializePatch(graph, { name: currentPatchName })
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
      const { graph: restored } = loadPatch(ctx, freePlaySnapshot)
      mountGraph(restored)
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
    arcadeHandle?.stop()
    arcadeHandle = startArcade(arcadePanelEl, ctx, () => {
      const outId = graph.moduleIds.find((id) => graph.getType(id) === 'output')
      return outId ? (graph.getInstance(outId) as OutputInstance | undefined) : undefined
    })
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

  function loadPresetFromBank(id: string): void {
    if (recording) { showBanner('warn', 'Stop recording before loading a preset.'); return }
    const preset = getPreset(id)
    if (!preset) return
    const { graph: loaded, ghosts } = loadPatch(ctx, preset.file)
    currentPatchName = preset.file.meta.name
    patchNameInput.value = currentPatchName
    mountGraph(loaded)
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
    downloadPatch(serializePatch(graph, { name: currentPatchName }))
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
  renderStudio()

  // ---- reveal ----
  $('power-section').hidden = true
  $('app').hidden = false
}

boot()
