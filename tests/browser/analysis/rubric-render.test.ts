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
 * Real-DSP evidence for constrained-challenge: unlike
 * tests/node/analysis/rubric.test.ts (synthetic buffers, no AudioContext),
 * this renders real patches through the real worklets, the same
 * `renderPatch` path the rack itself uses at Check time. Two jobs:
 *
 * 1. Sanity, asserted every run: each level's own proof patch, graded the
 *    *whole* way a real Check grades it -- `inspect()`'s `maxModules` for
 *    the structural half, `gradeFeatures` for the perceptual half -- passes
 *    both.
 * 2. The three-pass/two-fail matrix the task demands: for each level, at
 *    least three genuinely different patches that all pass, and at least
 *    two plausible-but-wrong patches that both fail. This is the only
 *    evidence that a level's rubric grades a *class* of sounds rather than
 *    one exact patch -- see .superpowers/sdd/academy-constrained-report.md
 *    for the full table these assertions reproduce, and the calibration
 *    sweep this file's own `describe.skip` block holds for how the bounds
 *    in each level's rubric.json were actually set.
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
function withCable(patch: PatchFile, from: [string, string], to: [string, string]): PatchFile {
  const clone = clonePatch(patch)
  clone.cables.push({ from, to })
  return clone
}

/** Grades `patch` exactly the way rack/main.ts's checkLevel does for a
 *  constrained-challenge level: structural (inspect's maxModules) and
 *  perceptual (gradeFeatures on a real render), both required to pass. */
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

describe('constrained-challenge: each level\'s own proof patch passes its own rubric', () => {
  for (const id of ['09-thump', '10-drift', '11-fold-pluck']) {
    it(`${id}: the solution renders and passes both the structural and feature halves`, async () => {
      const level = getLevel(id)!
      const graded = await gradeConstrained(id, level.solution)
      expect(graded.structuralPass, `${id}: solution exceeds its own maxModules`).toBe(true)
      expect(graded.featuresPass, `${id}: solution fails its own feature bounds`).toBe(true)
      expect(graded.pass).toBe(true)
    })
  }
})

describe('constrained-challenge: three-pass/two-fail matrix, real DSP', () => {
  it('09-thump: three different passing patches, two plausible-but-wrong failing patches', async () => {
    const level = getLevel('09-thump')!
    const sol = level.solution

    const passes = {
      'correct proof patch (sine, fmAmount 2, octave -3)': sol,
      'triangle wave instead of sine': withParam(sol, 'vco-1', 'shape', 2),
      'octave -2, gentler pitch envelope depth': withParam(withParam(sol, 'vco-1', 'octave', -2), 'vco-1', 'fmAmount', 2),
    }
    const fails = {
      'no pitch envelope ("boop" -- fmAmount 0, otherwise identical)': withParam(sol, 'vco-1', 'fmAmount', 0),
      'octave nudged way up (too bright/thin for a kick)': withParam(sol, 'vco-1', 'octave', 1),
    }

    for (const [label, patch] of Object.entries(passes)) {
      const graded = await gradeConstrained('09-thump', patch)
      // eslint-disable-next-line no-console
      console.log(`09-thump PASS case "${label}": pass=${graded.pass}`)
      expect(graded.pass, `expected to pass: ${label}`).toBe(true)
    }
    for (const [label, patch] of Object.entries(fails)) {
      const graded = await gradeConstrained('09-thump', patch)
      // eslint-disable-next-line no-console
      console.log(`09-thump FAIL case "${label}": pass=${graded.pass}`)
      expect(graded.pass, `expected to fail: ${label}`).toBe(false)
    }
  })

  it('10-drift: three different passing patches, two plausible-but-wrong failing patches', async () => {
    const level = getLevel('10-drift')!
    const sol = level.solution

    const vcoLfoDrift: PatchFile = {
      version: 1,
      meta: { name: 'vco+lfo pitch drift, no filter', created: '', author: '' },
      modules: [
        { id: 'vco-1', type: 'vco', slot: [0, 0], params: { octave: -1, fmAmount: 1.5 } },
        { id: 'lfo-1', type: 'lfo', slot: [0, 1], params: { rate: 0.4, shape: 2, depth: 1 } },
        { id: 'output-1', type: 'output', slot: [0, 2], params: {} },
      ],
      cables: [
        { from: ['vco-1', 'out'], to: ['output-1', 'in'] },
        { from: ['lfo-1', 'out'], to: ['vco-1', 'fm'] },
      ],
    }
    const vcoVcfLfoSweep: PatchFile = {
      version: 1,
      meta: { name: 'vco+vcf+lfo swept filter', created: '', author: '' },
      modules: [
        { id: 'vco-1', type: 'vco', slot: [0, 0], params: { octave: -1, shape: 0 } },
        { id: 'vcf-1', type: 'vcf', slot: [0, 1], params: { cutoff: 500, resonance: 0.4, cutoffCvAmount: 3 } },
        { id: 'lfo-1', type: 'lfo', slot: [0, 2], params: { rate: 0.4, shape: 2, depth: 1 } },
        { id: 'output-1', type: 'output', slot: [0, 3], params: {} },
      ],
      cables: [
        { from: ['vco-1', 'out'], to: ['vcf-1', 'in'] },
        { from: ['vcf-1', 'out'], to: ['output-1', 'in'] },
        { from: ['lfo-1', 'out'], to: ['vcf-1', 'cutoffCv'] },
      ],
    }

    const passes = {
      'correct proof patch (noise+vcf+lfo swept cutoff)': sol,
      'vco+lfo pitch drift, no filter at all': vcoLfoDrift,
      'vco+vcf+lfo, a swept filter over a tone instead of noise': vcoVcfLfoSweep,
    }
    const fails = {
      'lfo depth at 0 (patched but doing nothing)': withParam(sol, 'lfo-1', 'depth', 0),
      "cutoffCvAmount at 0 (lfo patched, filter not listening)": withParam(sol, 'vcf-1', 'cutoffCvAmount', 0),
    }

    for (const [label, patch] of Object.entries(passes)) {
      const graded = await gradeConstrained('10-drift', patch)
      // eslint-disable-next-line no-console
      console.log(`10-drift PASS case "${label}": pass=${graded.pass}`)
      expect(graded.pass, `expected to pass: ${label}`).toBe(true)
    }
    for (const [label, patch] of Object.entries(fails)) {
      const graded = await gradeConstrained('10-drift', patch)
      // eslint-disable-next-line no-console
      console.log(`10-drift FAIL case "${label}": pass=${graded.pass}`)
      expect(graded.pass, `expected to fail: ${label}`).toBe(false)
    }
  })

  it('11-fold-pluck: three different passing patches, two plausible-but-wrong failing patches', async () => {
    const level = getLevel('11-fold-pluck')!
    const sol = level.solution

    const passes = {
      'correct proof patch (sine, foldCvAmount 4)': sol,
      'shorter decay, same fold-envelope trick': withParam(sol, 'adsr-1', 'decay', 0.08),
      'asymmetric fold (symmetry offset)': withParam(sol, 'wavefolder-1', 'symmetry', 0.3),
    }
    const cheat = withParam(withCable(sol, ['adsr-1', 'out'], ['vco-1', 'fm']), 'vco-1', 'fmAmount', 1.5)
    const fails = {
      'no fold CV (static fold -- no color change at all)': withParam(sol, 'wavefolder-1', 'foldCvAmount', 0),
      'pitch bent instead (fm cabled in -- the forbidden shortcut)': cheat,
    }

    for (const [label, patch] of Object.entries(passes)) {
      const graded = await gradeConstrained('11-fold-pluck', patch)
      // eslint-disable-next-line no-console
      console.log(`11-fold-pluck PASS case "${label}": pass=${graded.pass}`)
      expect(graded.pass, `expected to pass: ${label}`).toBe(true)
    }
    for (const [label, patch] of Object.entries(fails)) {
      const graded = await gradeConstrained('11-fold-pluck', patch)
      // eslint-disable-next-line no-console
      console.log(`11-fold-pluck FAIL case "${label}": pass=${graded.pass}`)
      expect(graded.pass, `expected to fail: ${label}`).toBe(false)
    }
  })
})
