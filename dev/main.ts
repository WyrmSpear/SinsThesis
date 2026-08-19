import { PatchGraph, type Cable } from '../src/engine/graph'
import { registerAllModules } from '../src/engine/modules'
import { getModule } from '../src/engine/registry'
import { ensureWorklets } from '../src/engine/render'
import { keyToNote } from '../src/engine/midi'
import type { ParamSpec } from '../src/engine/types'
import type { KeyboardMidiInstance } from '../src/engine/modules/keyboard-midi'
import type { OutputInstance } from '../src/engine/modules/output'
import { buildSlider, buildToggle, type SliderHandle, type ToggleHandle } from './controls'
import { startScope } from './scope'
import { buildPiano } from './piano'
import { BASS_PRESET, LEAD_PRESET, type Preset } from './presets'

/**
 * Defensive against the known trap (docs/CONTINUATION.md): `registerAllModules()`
 * throws if a type is already registered, which bites on a second call —
 * hot reload being the obvious way to trigger one. This module has no
 * `import.meta.hot.accept()`, so an edit to it triggers Vite's default full
 * page reload rather than an in-place HMR update, and a fresh page load
 * only ever runs this once. The guard costs nothing and removes the risk
 * entirely regardless of that assumption.
 */
if (!getModule('vco')) registerAllModules()

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`main: missing #${id}`)
  return el as T
}

function paramOf(type: string, id: string): ParamSpec {
  const descriptor = getModule(type)
  if (!descriptor) throw new Error(`main: unknown module type "${type}"`)
  const spec = descriptor.params.find((p) => p.id === id)
  if (!spec) throw new Error(`main: "${type}" has no param "${id}"`)
  return spec
}

const KEY_LABELS: Record<string, string> = {
  KeyA: 'A', KeyW: 'W', KeyS: 'S', KeyE: 'E', KeyD: 'D', KeyF: 'F', KeyT: 'T',
  KeyG: 'G', KeyY: 'Y', KeyH: 'H', KeyU: 'U', KeyJ: 'J', KeyK: 'K', KeyO: 'O', KeyL: 'L',
}

// The reverse of `keyToNote`: which computer-key letter, if any, plays a
// given absolute MIDI note under the octave currently selected. Rebuilt
// (cheaply -- 15 entries) whenever the octave changes, so the piano's
// labels track it.
const KEY_CODES = Object.keys(KEY_LABELS)

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function noteName(note: number): string {
  const name = NOTE_NAMES[((note % 12) + 12) % 12]
  const octave = Math.floor(note / 12) - 1
  return `${name}${octave}`
}

function noteFreq(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12)
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
  // Must finish before any node is built — the load contract render.ts and
  // every module in src/engine/modules/ depend on.
  await ensureWorklets(ctx)
  if (ctx.state === 'suspended') await ctx.resume()

  const graph = new PatchGraph(ctx)

  const vco = graph.addModule('vco', 'vco')
  const vcf = graph.addModule('vcf', 'vcf')
  const vca = graph.addModule('vca', 'vca')
  const wavefolder = graph.addModule('wavefolder', 'wavefolder')
  const adsr = graph.addModule('adsr', 'adsr')
  const lfo = graph.addModule('lfo', 'lfo')
  const keyboard = graph.addModule('keyboard', 'keyboard')
  const output = graph.addModule('output', 'output')

  graph.connect([vco, 'out'], [vcf, 'in'])
  graph.connect([vca, 'out'], [output, 'in'])
  graph.connect([keyboard, 'pitch'], [vco, 'pitch'])
  graph.connect([keyboard, 'gate'], [adsr, 'gate'])
  graph.connect([adsr, 'out'], [vca, 'cv'])
  // The ADSR gates the VCA entirely through CV: base level 0, CV amount 1,
  // so the envelope (0..1) *is* the gain, not an offset added to a fader.
  graph.setParam(vca, 'level', 0)
  graph.setParam(vca, 'cvAmount', 1)
  // A fixed modulation depth for the LFO->cutoff patch cable below; the
  // toggle only adds/removes the cable, same as plugging in a real one.
  graph.setParam(vcf, 'cutoffCvAmount', 3)

  const outputInstance = graph.getInstance(output) as OutputInstance
  outputInstance.outputs.get('out')!.connect(ctx.destination)

  const keyboardInstance = graph.getInstance(keyboard) as KeyboardMidiInstance

  // ---- signal path: vcf -> [wavefolder] -> vca, rebuilt on bypass toggle ----
  let wavefolderEnabled = false
  let pathCables: Cable[] = []
  function rebuildSignalPath(): void {
    for (const c of pathCables) graph.disconnect(c.id)
    pathCables = wavefolderEnabled
      ? [graph.connect([vcf, 'out'], [wavefolder, 'in']), graph.connect([wavefolder, 'out'], [vca, 'in'])]
      : [graph.connect([vcf, 'out'], [vca, 'in'])]
  }
  rebuildSignalPath()

  // ---- LFO -> filter cutoff, added/removed as a cable, like a patch cord ----
  let lfoCable: Cable | null = null
  function setLfoRouted(enabled: boolean): void {
    if (enabled && !lfoCable) lfoCable = graph.connect([lfo, 'out'], [vcf, 'cutoffCv'])
    else if (!enabled && lfoCable) {
      graph.disconnect(lfoCable.id)
      lfoCable = null
    }
  }

  // ---- keyboard: computer keys + on-screen piano, one held-note state ----
  //
  // Both input paths call into `keyboardInstance` (handleKey / pressNote /
  // releaseNote), which is the single note path -- see keyboard-midi.ts.
  // Everything below this point is UI bookkeeping: which owner (a computer
  // key code, or a mouse/touch pointer id) currently has which note down,
  // used only to drive highlighting and the "sounding" readout. It never
  // decides what plays; it mirrors what already did.
  let octave = graph.getParams(keyboard).octave ?? 4
  const octaveReadout = $('octave-readout')
  const keysHeld = $('keys-held')
  const noteReadout = $('note-readout')
  const held = new Set<string>() // computer-key codes, for the letter-chip row

  const heldKeyNotes = new Map<string, number>() // code -> note, while key: is down in the engine
  const activePointers = new Map<number, number>() // pointerId -> note, while ext:mouse:<id> is down
  const sustainedByHold = new Set<string>() // owner ids ('key:'+code / 'mouse:'+pointerId) drone-only
  let holdEngaged = false

  function isNoteHeld(note: number): boolean {
    for (const n of heldKeyNotes.values()) if (n === note) return true
    for (const n of activePointers.values()) if (n === note) return true
    return false
  }

  function renderHeld(): void {
    keysHeld.replaceChildren(
      ...[...held].map((code) => {
        const chip = document.createElement('span')
        chip.className = 'key-chip'
        chip.textContent = KEY_LABELS[code] ?? code
        return chip
      }),
    )
  }

  function renderNoteReadout(): void {
    const note = keyboardInstance.currentNote()
    noteReadout.textContent = note === undefined ? '—' : `${noteName(note)}  ${noteFreq(note).toFixed(2)} Hz`
  }

  function refreshHighlights(): void {
    for (let n = pianoStart; n <= pianoEnd; n++) piano.setHeld(n, isNoteHeld(n))
    renderNoteReadout()
  }

  // ---- hold / drone: the first control anyone should reach for. When
  // engaged, an up-event (keyup, mouseup, a pointer leaving a key) does not
  // release the note in the engine -- it just stops being *physically*
  // held, moving to `sustainedByHold` so the gate stays open and every knob
  // is explorable in real time. Turning hold back off flushes whatever is
  // only sounding because of it. ----
  const holdBtn = $<HTMLButtonElement>('hold-btn')
  function setHold(engaged: boolean): void {
    holdEngaged = engaged
    holdBtn.classList.toggle('engaged', engaged)
    holdBtn.setAttribute('aria-pressed', String(engaged))
    if (engaged) return
    for (const ownerId of sustainedByHold) {
      if (ownerId.startsWith('key:')) {
        const code = ownerId.slice(4)
        heldKeyNotes.delete(code)
        keyboardInstance.handleKey(code, false)
      } else {
        const pointerId = Number(ownerId.slice(6))
        activePointers.delete(pointerId)
        keyboardInstance.releaseNote(`mouse:${pointerId}`)
      }
    }
    sustainedByHold.clear()
    refreshHighlights()
  }
  holdBtn.addEventListener('click', () => setHold(!holdEngaged))

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return
    if (e.code === 'KeyZ') {
      octave = Math.max(0, octave - 1)
      graph.setParam(keyboard, 'octave', octave)
      octaveReadout.textContent = String(octave)
      piano.refreshLabels()
      return
    }
    if (e.code === 'KeyX') {
      octave = Math.min(8, octave + 1)
      graph.setParam(keyboard, 'octave', octave)
      octaveReadout.textContent = String(octave)
      piano.refreshLabels()
      return
    }
    const note = keyToNote(e.code, octave)
    if (note === undefined) return
    sustainedByHold.delete(`key:${e.code}`) // repressing clears any stale drone entry
    keyboardInstance.handleKey(e.code, true)
    heldKeyNotes.set(e.code, note)
    held.add(e.code)
    renderHeld()
    refreshHighlights()
  })

  window.addEventListener('keyup', (e) => {
    if (!heldKeyNotes.has(e.code)) return
    held.delete(e.code)
    renderHeld()
    if (holdEngaged) {
      sustainedByHold.add(`key:${e.code}`)
      return // note stays open in the engine; heldKeyNotes keeps it lit
    }
    heldKeyNotes.delete(e.code)
    keyboardInstance.handleKey(e.code, false)
    refreshHighlights()
  })

  // ---- on-screen piano: two octaves, mouse + touch, drag glissando ----
  const pianoStart = 60 // C4 -- lines up with the default-octave computer keys below
  const pianoEnd = 84 // C6, exactly two octaves

  function releasePointer(pointerId: number): void {
    const note = activePointers.get(pointerId)
    if (note === undefined) return
    if (holdEngaged) {
      sustainedByHold.add(`mouse:${pointerId}`)
      return // stays open in the engine; activePointers keeps it lit
    }
    activePointers.delete(pointerId)
    keyboardInstance.releaseNote(`mouse:${pointerId}`)
    refreshHighlights()
  }

  const piano = buildPiano({
    startNote: pianoStart,
    endNote: pianoEnd,
    onPress(pointerId, note) {
      sustainedByHold.delete(`mouse:${pointerId}`)
      keyboardInstance.pressNote(`mouse:${pointerId}`, note)
      activePointers.set(pointerId, note)
      refreshHighlights()
    },
    onMove(pointerId, note) {
      const prev = activePointers.get(pointerId)
      if (prev === undefined || prev === note) return
      // Glissando: release the old note and press the new one under the
      // same owner id, back to back in the same synchronous tick. Both
      // AudioParam automations (gate 0, then gate 1) land at the same
      // `ctx.currentTime`; Web Audio resolves same-timestamp events in the
      // order they were added, so the press -- scheduled immediately after
      // -- wins and the gate never audibly drops between keys.
      const ownerId = `mouse:${pointerId}`
      keyboardInstance.releaseNote(ownerId)
      keyboardInstance.pressNote(ownerId, note)
      activePointers.set(pointerId, note)
      refreshHighlights()
    },
    onRelease: releasePointer,
    labelFor(note) {
      for (const code of KEY_CODES) {
        if (keyToNote(code, octave) === note) return KEY_LABELS[code]
      }
      return undefined
    },
  })
  // A global catch: if the button is released (or the touch cancels)
  // anywhere other than over a piano key -- off the edge of the keyboard,
  // outside the window, wherever -- this still fires and releases the
  // note. Per-key `pointerup`/`pointerleave` above already cover the common
  // cases; this is the belt-and-suspenders backstop so a drag that exits
  // the whole page can never leave a note droning.
  window.addEventListener('pointerup', (e) => releasePointer(e.pointerId))
  window.addEventListener('pointercancel', (e) => releasePointer(e.pointerId))
  $('piano-mount').append(piano.el)

  // ---- controls, built from the module descriptors ----
  const sliders: Record<string, SliderHandle> = {}
  let wavefolderToggle!: ToggleHandle
  let lfoToggle!: ToggleHandle

  function slider(
    containerId: string,
    type: string,
    moduleId: string,
    paramId: string,
    labels?: readonly string[],
  ): void {
    const spec = paramOf(type, paramId)
    const initial = graph.getParams(moduleId)[paramId] ?? spec.default
    const handle = buildSlider(spec, initial, (value) => graph.setParam(moduleId, paramId, value), { labels })
    sliders[`${moduleId}.${paramId}`] = handle
    $(containerId).append(handle.el)
  }

  slider('vco-controls', 'vco', vco, 'shape', ['Saw', 'Pulse', 'Tri', 'Sine'])
  slider('vco-controls', 'vco', vco, 'octave')
  slider('vco-controls', 'vco', vco, 'tune')
  slider('vco-controls', 'vco', vco, 'pulseWidth')

  slider('vcf-controls', 'vcf', vcf, 'cutoff')
  slider('vcf-controls', 'vcf', vcf, 'resonance')
  slider('vcf-controls', 'vcf', vcf, 'drive')

  slider('adsr-controls', 'adsr', adsr, 'attack')
  slider('adsr-controls', 'adsr', adsr, 'decay')
  slider('adsr-controls', 'adsr', adsr, 'sustain')
  slider('adsr-controls', 'adsr', adsr, 'release')

  wavefolderToggle = buildToggle('Patched in (off = bypassed)', wavefolderEnabled, (checked) => {
    wavefolderEnabled = checked
    rebuildSignalPath()
  }, 'wavefolder-enabled')
  $('wavefolder-toggle').append(wavefolderToggle.el)
  slider('wavefolder-controls', 'wavefolder', wavefolder, 'drive')

  lfoToggle = buildToggle('Route to cutoff', false, setLfoRouted, 'lfo-routed')
  $('lfo-toggle').append(lfoToggle.el)
  slider('lfo-controls', 'lfo', lfo, 'rate')
  slider('lfo-controls', 'lfo', lfo, 'depth')

  slider('master-controls', 'output', output, 'level')

  // ---- scope ----
  startScope(outputInstance.analyser, ctx.sampleRate, $('scope-wave'), $('scope-spectrum'))

  // ---- presets ----
  function applyPreset(preset: Preset): void {
    graph.setParam(vco, 'shape', preset.vco.shape)
    graph.setParam(vco, 'octave', preset.vco.octave)
    graph.setParam(vco, 'tune', preset.vco.tune)
    graph.setParam(vco, 'pulseWidth', preset.vco.pulseWidth)
    sliders[`${vco}.shape`]!.setValue(preset.vco.shape)
    sliders[`${vco}.octave`]!.setValue(preset.vco.octave)
    sliders[`${vco}.tune`]!.setValue(preset.vco.tune)
    sliders[`${vco}.pulseWidth`]!.setValue(preset.vco.pulseWidth)

    graph.setParam(vcf, 'cutoff', preset.vcf.cutoff)
    graph.setParam(vcf, 'resonance', preset.vcf.resonance)
    graph.setParam(vcf, 'drive', preset.vcf.drive)
    sliders[`${vcf}.cutoff`]!.setValue(preset.vcf.cutoff)
    sliders[`${vcf}.resonance`]!.setValue(preset.vcf.resonance)
    sliders[`${vcf}.drive`]!.setValue(preset.vcf.drive)

    graph.setParam(adsr, 'attack', preset.adsr.attack)
    graph.setParam(adsr, 'decay', preset.adsr.decay)
    graph.setParam(adsr, 'sustain', preset.adsr.sustain)
    graph.setParam(adsr, 'release', preset.adsr.release)
    sliders[`${adsr}.attack`]!.setValue(preset.adsr.attack)
    sliders[`${adsr}.decay`]!.setValue(preset.adsr.decay)
    sliders[`${adsr}.sustain`]!.setValue(preset.adsr.sustain)
    sliders[`${adsr}.release`]!.setValue(preset.adsr.release)

    wavefolderEnabled = preset.wavefolder.enabled
    rebuildSignalPath()
    wavefolderToggle.setChecked(preset.wavefolder.enabled)
    graph.setParam(wavefolder, 'drive', preset.wavefolder.drive)
    sliders[`${wavefolder}.drive`]!.setValue(preset.wavefolder.drive)

    setLfoRouted(preset.lfo.enabled)
    lfoToggle.setChecked(preset.lfo.enabled)
    graph.setParam(lfo, 'rate', preset.lfo.rate)
    graph.setParam(lfo, 'depth', preset.lfo.depth)
    sliders[`${lfo}.rate`]!.setValue(preset.lfo.rate)
    sliders[`${lfo}.depth`]!.setValue(preset.lfo.depth)

    graph.setParam(output, 'level', preset.masterLevel)
    sliders[`${output}.level`]!.setValue(preset.masterLevel)
  }

  $<HTMLButtonElement>('preset-bass').addEventListener('click', () => applyPreset(BASS_PRESET))
  $<HTMLButtonElement>('preset-lead').addEventListener('click', () => applyPreset(LEAD_PRESET))

  // ---- reveal ----
  $('power-section').hidden = true
  $('app').hidden = false

  // A debug hook for tests/browser/dev-page.test.ts, which drives this page
  // from outside and needs to read the same AnalyserNode the scope reads.
  // Not part of the instrument itself.
  const globalWithHook = window as unknown as { __sinsthesis?: unknown }
  globalWithHook.__sinsthesis = {
    ctx,
    graph,
    rms(): number {
      // A fixed, deliberately small window -- independent of the scope's
      // `analyser.fftSize` (raised to 8192 for spectrum resolution; see
      // dev/scope.ts). `getFloatTimeDomainData` fills a shorter array with
      // just its most recent samples, so this still reads the current
      // signal. Tying the window to fftSize instead made this measurement
      // 4x more likely to catch a brief post-connect settling transient
      // and read as "not silent" when nothing is actually held.
      const data = new Float32Array(1024)
      outputInstance.analyser.getFloatTimeDomainData(data)
      let sum = 0
      for (const s of data) sum += s * s
      return Math.sqrt(sum / data.length)
    },
  }
}

boot()
