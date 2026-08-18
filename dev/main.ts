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

  // ---- keyboard: real keydown/keyup, ASDF row + Z/X octave, no auto-repeat ----
  let octave = graph.getParams(keyboard).octave ?? 4
  const octaveReadout = $('octave-readout')
  const keysHeld = $('keys-held')
  const held = new Set<string>()

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

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return
    if (e.code === 'KeyZ') {
      octave = Math.max(0, octave - 1)
      graph.setParam(keyboard, 'octave', octave)
      octaveReadout.textContent = String(octave)
      return
    }
    if (e.code === 'KeyX') {
      octave = Math.min(8, octave + 1)
      graph.setParam(keyboard, 'octave', octave)
      octaveReadout.textContent = String(octave)
      return
    }
    if (keyToNote(e.code, octave) === undefined) return
    keyboardInstance.handleKey(e.code, true)
    held.add(e.code)
    renderHeld()
  })

  window.addEventListener('keyup', (e) => {
    if (keyToNote(e.code, octave) === undefined) return
    keyboardInstance.handleKey(e.code, false)
    held.delete(e.code)
    renderHeld()
  })

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
      const data = new Float32Array(outputInstance.analyser.fftSize)
      outputInstance.analyser.getFloatTimeDomainData(data)
      let sum = 0
      for (const s of data) sum += s * s
      return Math.sqrt(sum / data.length)
    },
  }
}

boot()
