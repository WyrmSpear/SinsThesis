import { describe, it, expect, beforeAll } from 'vitest'
import { renderPatch, ensureWorklets } from '../../../src/engine/render'
import { gradeFeatures } from '../../../src/engine/analysis/rubric'
import { inspect } from '../../../src/engine/analysis/inspector'
import { loadPatch } from '../../../src/engine/patch'
import { registerAllModules } from '../../../src/engine/modules'
import { getModule } from '../../../src/engine/registry'
import { getLevel } from '../../../academy/levels'
import type { PatchFile } from '../../../src/engine/patch'

/**
 * Real-DSP evidence for the bass track's own constrained-challenge finale,
 * bass-05-finish -- same structure and same reason as
 * tests/browser/analysis/rubric-render.test.ts (which covers 09-thump,
 * 10-drift, 11-fold-pluck): the level's own proof patch has to pass its own
 * rubric, and at least three genuinely different patches must pass while at
 * least two plausible-but-wrong ones fail, which is the only evidence that
 * a constrained-challenge rubric grades a *class* of sounds rather than one
 * exact patch. The bounds themselves (peakRms, attackMs, centroidHz,
 * pitchDropOctaves) were set from real renders of exactly these six
 * candidates -- see bass-05-finish.rubric.json's own numbers.
 */

const SR = 48000

beforeAll(() => {
  if (!getModule('vco')) registerAllModules()
})

function clonePatch(patch: PatchFile): PatchFile {
  return JSON.parse(JSON.stringify(patch)) as PatchFile
}
function withParam(patch: PatchFile, id: string, param: string, value: number): PatchFile {
  const clone = clonePatch(patch)
  const mod = clone.modules.find((m) => m.id === id)
  if (!mod) throw new Error(`withParam: no module "${id}"`)
  mod.params[param] = value
  return clone
}

async function gradeConstrained(
  levelId: string, patch: PatchFile,
): Promise<{ pass: boolean; structuralPass: boolean; featuresPass: boolean }> {
  const level = getLevel(levelId)!
  const c = level.constrained!

  const ctx = new OfflineAudioContext(1, 128, SR)
  await ensureWorklets(ctx)
  const { graph } = loadPatch(ctx, patch)
  const structural = inspect(graph, { maxModules: c.maxModules })

  const samples = await renderPatch(patch, c.seconds, { sampleRate: SR, gate: c.gate })
  const featureResult = gradeFeatures(samples, SR, c.features)

  return { pass: structural.pass && featureResult.pass, structuralPass: structural.pass, featuresPass: featureResult.pass }
}

describe("bass-05-finish: the solution renders and passes its own rubric", () => {
  it('the solution passes both the structural and feature halves', async () => {
    const level = getLevel('bass-05-finish')!
    const graded = await gradeConstrained('bass-05-finish', level.solution)
    expect(graded.structuralPass, 'solution exceeds its own maxModules').toBe(true)
    expect(graded.featuresPass, 'solution fails its own feature bounds').toBe(true)
    expect(graded.pass).toBe(true)
  })
})

describe('bass-05-finish: three-pass/two-fail matrix, real DSP', () => {
  it('three different passing patches, two plausible-but-wrong failing patches', async () => {
    const level = getLevel('bass-05-finish')!
    const sol = level.solution

    const passes = {
      'correct proof patch (sine, octave -3, fmAmount 2.5)': sol,
      'deeper, snappier pitch envelope': withParam(withParam(sol, 'vco-1', 'fmAmount', 3.2), 'adsr-1', 'decay', 0.35),
      'triangle wave instead of sine': withParam(sol, 'vco-1', 'shape', 2),
    }
    const fails = {
      'no pitch envelope ("boop" -- fmAmount 0, otherwise identical)': withParam(sol, 'vco-1', 'fmAmount', 0),
      'octave nudged way up (too bright/thin for a sub)': withParam(sol, 'vco-1', 'octave', -1),
    }

    for (const [label, patch] of Object.entries(passes)) {
      const graded = await gradeConstrained('bass-05-finish', patch)
      // eslint-disable-next-line no-console
      console.log(`bass-05-finish PASS case "${label}": pass=${graded.pass}`)
      expect(graded.pass, `expected to pass: ${label}`).toBe(true)
    }
    for (const [label, patch] of Object.entries(fails)) {
      const graded = await gradeConstrained('bass-05-finish', patch)
      // eslint-disable-next-line no-console
      console.log(`bass-05-finish FAIL case "${label}": pass=${graded.pass}`)
      expect(graded.pass, `expected to fail: ${label}`).toBe(false)
    }
  })
})
