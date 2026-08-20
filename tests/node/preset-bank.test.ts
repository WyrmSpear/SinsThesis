import { describe, it, expect, beforeEach } from 'vitest'
import { loadPatch, serializePatch } from '../../src/engine/patch'
import { registerModule, clearRegistry } from '../../src/engine/registry'
import { stubContext, stubNode } from '../helpers/stub-instance'
import { PRESET_BANK } from '../../presets/bank'
import { vcoDescriptor } from '../../src/engine/modules/vco'
import { vcfDescriptor } from '../../src/engine/modules/vcf'
import { svfDescriptor } from '../../src/engine/modules/svf'
import { adsrDescriptor } from '../../src/engine/modules/adsr'
import { vcaDescriptor } from '../../src/engine/modules/vca'
import { lfoDescriptor } from '../../src/engine/modules/lfo'
import { noiseDescriptor } from '../../src/engine/modules/noise'
import { wavefolderDescriptor } from '../../src/engine/modules/wavefolder'
import { driveDescriptor } from '../../src/engine/modules/drive'
import { mixerDescriptor } from '../../src/engine/modules/mixer'
import { clockDescriptor } from '../../src/engine/modules/clock-module'
import { keyboardMidiDescriptor } from '../../src/engine/modules/keyboard-midi'
import { outputDescriptor } from '../../src/engine/modules/output'
import { pingpongDescriptor } from '../../src/engine/modules/pingpong'
import type { ModuleDescriptor, ModuleInstance } from '../../src/engine/types'

/**
 * The patch bank's own load/round-trip guarantee, at the same level
 * tests/node/academy-levels.test.ts holds the academy to: every entry is a
 * real, loadable `.sinp` this build's registry actually knows, not just a
 * JSON blob that happens to parse. `create()` is replaced with a bare stub
 * (real descriptors build actual AudioWorkletNodes, which need a real
 * AudioContext this plain-Node suite never constructs) but every port and
 * param id comes straight from the real descriptor, so a preset naming a
 * port or param a module doesn't actually have fails loudly here instead of
 * silently no-opping in the browser.
 */
function stubbedFrom(real: ModuleDescriptor): ModuleDescriptor {
  return {
    ...real,
    create(): ModuleInstance {
      const inputs = new Map<string, AudioNode | AudioParam>()
      const outputs = new Map<string, AudioNode>()
      for (const p of real.ports) {
        const node = stubNode() as unknown as AudioNode
        if (p.dir === 'in') inputs.set(p.id, node)
        else outputs.set(p.id, node)
      }
      const values = new Map<string, number>()
      return {
        inputs,
        outputs,
        setParam: (id, value) => values.set(id, value),
        dispose: () => values.clear(),
      }
    },
  }
}

const REAL_DESCRIPTORS = [
  vcoDescriptor, vcfDescriptor, svfDescriptor, adsrDescriptor, vcaDescriptor,
  lfoDescriptor, noiseDescriptor, wavefolderDescriptor, driveDescriptor,
  mixerDescriptor, clockDescriptor, keyboardMidiDescriptor, outputDescriptor,
  pingpongDescriptor,
]

describe('patch bank', () => {
  beforeEach(() => {
    clearRegistry()
    for (const d of REAL_DESCRIPTORS) registerModule(stubbedFrom(d))
  })

  it('ships at least six presets', () => {
    expect(PRESET_BANK.length).toBeGreaterThanOrEqual(6)
  })

  it('every preset id is unique', () => {
    const ids = PRESET_BANK.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  for (const preset of PRESET_BANK) {
    describe(preset.id, () => {
      it('loads with no ghosts -- every module type this build actually knows', () => {
        const { ghosts } = loadPatch(stubContext(), preset.file)
        expect(ghosts, `"${preset.id}" names an unregistered module type`).toEqual([])
      })

      it('has exactly one Output module, so renderPatch can find where to listen', () => {
        const outputs = preset.file.modules.filter((m) => m.type === 'output')
        expect(outputs.length).toBe(1)
      })

      it('has at least one cable -- a preset with no wiring cannot make sound', () => {
        expect(preset.file.cables.length).toBeGreaterThan(0)
      })

      it('every cable references a module the preset actually defines', () => {
        const ids = new Set(preset.file.modules.map((m) => m.id))
        for (const cable of preset.file.cables) {
          expect(ids.has(cable.from[0]), `cable from unknown module "${cable.from[0]}"`).toBe(true)
          expect(ids.has(cable.to[0]), `cable to unknown module "${cable.to[0]}"`).toBe(true)
        }
      })

      it('round-trips through serialize/load without loss', () => {
        const { graph } = loadPatch(stubContext(), preset.file)
        const again = serializePatch(graph, preset.file.meta)
        expect(again.modules.map((m) => m.id).sort()).toEqual(preset.file.modules.map((m) => m.id).sort())
        expect(again.cables.slice().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual(
          preset.file.cables.slice().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        )
        for (const m of preset.file.modules) {
          const roundTripped = again.modules.find((mm) => mm.id === m.id)!
          expect(roundTripped.params).toEqual(m.params)
        }
      })
    })
  }
})
