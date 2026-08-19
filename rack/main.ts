import { PatchGraph } from '../src/engine/graph'
import { registerAllModules } from '../src/engine/modules'
import { getModule } from '../src/engine/registry'
import { ensureWorklets } from '../src/engine/render'
import type { OutputInstance } from '../src/engine/modules/output'
import { buildPanel } from './panel'
import { CableLayer } from './cables'
import { buildKeyboardPanel } from './keyboard-panel'

// Same guard as dev/main.ts, same reason: registerAllModules() throws on a
// second call, and a fresh page load is the only case that should ever run
// it (docs/CONTINUATION.md).
if (!getModule('vco')) registerAllModules()

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`rack/main: missing #${id}`)
  return el as T
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

  const graph = new PatchGraph(ctx)

  // ---- the starter patch, instantiated through PatchGraph exactly as the
  // dev harness does (dev/main.ts). Keyboard is included even though the
  // task's module list names VCO/VCF/ADSR/VCA/Output/LFO without it: with
  // no source of pitch/gate CV, no cable in this rack could ever make a
  // sound, and the keyboard's own descriptor is what the on-screen piano
  // patches into (Section 6's "reuse dev/piano.ts" only makes sense wired
  // to a module the graph knows about). ----
  const keyboard = graph.addModule('keyboard', 'keyboard')
  const vco = graph.addModule('vco', 'vco')
  const vcf = graph.addModule('vcf', 'vcf')
  const adsr = graph.addModule('adsr', 'adsr')
  const vca = graph.addModule('vca', 'vca')
  const lfo = graph.addModule('lfo', 'lfo')
  const output = graph.addModule('output', 'output')

  const startCables = [
    graph.connect([keyboard, 'pitch'], [vco, 'pitch']),
    graph.connect([keyboard, 'gate'], [adsr, 'gate']),
    graph.connect([vco, 'out'], [vcf, 'in']),
    graph.connect([adsr, 'out'], [vca, 'cv']),
    graph.connect([vcf, 'out'], [vca, 'in']),
    graph.connect([vca, 'out'], [output, 'in']),
  ]
  // LFO is deliberately left unpatched -- it sits in the rack so the
  // operator can drag their own cable from it (e.g. to the VCF's cutoffCv
  // jack) and see "any port to any port" for themselves, rather than the
  // rack demonstrating patching on their behalf.

  // Same anti-thump snap as dev/main.ts: the VCA's descriptor default is
  // 1 (open, correct for a bare unity-gain use), and this patch closes it
  // through the envelope instead -- an exact-time `atTime` snap avoids the
  // free-running oscillator leaking through while the ramp is still close
  // to its pre-change value. See dev/main.ts for the full account.
  graph.setParam(vca, 'level', 0, ctx.currentTime)
  graph.setParam(vca, 'cvAmount', 1, ctx.currentTime)

  const outputInstance = graph.getInstance(output) as OutputInstance
  outputInstance.outputs.get('out')!.connect(ctx.destination)

  // ---- rack + cable layer ----
  const rackEl = $('rack-modules')
  const cableLayer = new CableLayer($('rack-surface'), graph)

  const order = [keyboard, vco, vcf, adsr, vca, lfo, output]
  for (const moduleId of order) {
    const type = graph.getType(moduleId)!
    const descriptor = getModule(type)!
    const panel = buildPanel(descriptor, moduleId, graph, {
      jacks: cableLayer.jackRegistry,
      customPanels: { keyboard: buildKeyboardPanel },
    })
    rackEl.append(panel)
  }

  // Jacks now exist with real layout, so the starter cables can be drawn --
  // exactly the same `renderCable` path a fresh drag uses.
  for (const cable of startCables) cableLayer.renderCable(cable)
  cableLayer.reflow()

  // ---- reveal ----
  $('power-section').hidden = true
  $('app').hidden = false

  // Debug hook for tests/browser/rack-page.test.ts, mirroring
  // dev/main.ts's __sinsthesis hook so the same audio-thread-backed RMS
  // measurement approach applies here.
  const globalWithHook = window as unknown as { __sinsthesis?: unknown }
  globalWithHook.__sinsthesis = {
    ctx,
    graph,
    cableLayer,
    rms(): number {
      const data = new Float32Array(1024)
      outputInstance.analyser.getFloatTimeDomainData(data)
      let sum = 0
      for (const s of data) sum += s * s
      return Math.sqrt(sum / data.length)
    },
  }
}

boot()
