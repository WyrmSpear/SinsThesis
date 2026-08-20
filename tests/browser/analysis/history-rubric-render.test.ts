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
 * Real-DSP evidence for the history track's four constrained-challenge
 * levels (history-02-motorik, history-03-squelch, history-04-funk-bass,
 * history-06-east-west) -- same structure and purpose as
 * tests/browser/analysis/rubric-render.test.ts (09-thump/10-drift/
 * 11-fold-pluck) and bass-rubric-render.test.ts (bass-05-finish): each
 * level's own proof patch passes its own rubric, and for each level at
 * least three genuinely different patches pass while at least two
 * plausible-but-wrong ones fail -- the only evidence that a rubric grades a
 * *class* of sounds rather than one exact patch. Bounds were set from real
 * renders of exactly these candidates; numbers are logged, not just
 * asserted, for the report.
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
function withoutCable(patch: PatchFile, from: [string, string], to: [string, string]): PatchFile {
  const clone = clonePatch(patch)
  clone.cables = clone.cables.filter(
    (c) => !(c.from[0] === from[0] && c.from[1] === from[1] && c.to[0] === to[0] && c.to[1] === to[1]),
  )
  return clone
}

/** Grades `patch` exactly the way rack/main.ts's checkLevel does for a
 *  constrained-challenge level: structural (inspect's maxModules) and
 *  perceptual (gradeFeatures on a real render), both required to pass. */
async function gradeConstrained(
  levelId: string, patch: PatchFile,
): Promise<{ pass: boolean; structuralPass: boolean; featuresPass: boolean; values: Record<string, unknown> }> {
  const level = getLevel(levelId)!
  const c = level.constrained!

  const ctx = new OfflineAudioContext(1, 128, SR)
  await ensureWorklets(ctx)
  const { graph } = loadPatch(ctx, patch)
  const structural = inspect(graph, { maxModules: c.maxModules })

  const samples = await renderPatch(patch, c.seconds, { sampleRate: SR, gate: c.gate })
  const featureResult = gradeFeatures(samples, SR, c.features)

  return {
    pass: structural.pass && featureResult.pass,
    structuralPass: structural.pass,
    featuresPass: featureResult.pass,
    values: featureResult.values,
  }
}

describe("constrained-challenge: each history level's own proof patch passes its own rubric", () => {
  for (const id of ['history-02-motorik', 'history-03-squelch', 'history-04-funk-bass', 'history-06-east-west']) {
    it(`${id}: the solution renders and passes both the structural and feature halves`, async () => {
      const level = getLevel(id)!
      const graded = await gradeConstrained(id, level.solution)
      // eslint-disable-next-line no-console
      console.log(`${id} solution values: ${JSON.stringify(graded.values)}`)
      expect(graded.structuralPass, `${id}: solution exceeds its own maxModules`).toBe(true)
      expect(graded.featuresPass, `${id}: solution fails its own feature bounds`).toBe(true)
      expect(graded.pass).toBe(true)
    })
  }
})

describe('constrained-challenge: three-pass/two-fail matrix, real DSP', () => {
  it('history-02-motorik: three different passing patches, two plausible-but-wrong failing patches', async () => {
    const level = getLevel('history-02-motorik')!
    const sol = level.solution

    const differentPattern: PatchFile = withParam(
      withParam(withParam(sol, 'seq-1', 'step2', 1), 'seq-1', 'step4', -1.5), 'seq-1', 'step6', 0.75,
    )
    // No filter accent from the gate, but a wider pitch swing across steps
    // so the pattern still moves plenty on pitch alone -- a legitimate
    // different route to the same "this changes over time" destination.
    const noFilterAccent = withParam(
      withParam(withParam(withoutCable(sol, ['seq-1', 'gate'], ['vcf-1', 'cutoffCv']), 'seq-1', 'step3', 1.5), 'seq-1', 'step5', -1.5),
      'seq-1', 'step7', 1.5,
    )

    const passes = {
      'correct proof patch (8-step pitch pattern + gate-driven filter accent)': sol,
      'a different step pattern, same wiring': differentPattern,
      'pitch-sequenced only, no filter accent from the gate': noFilterAccent,
    }
    const fails = {
      'sequencer never clocked -- frozen on step 1': withoutCable(sol, ['clock-1', 'gate'], ['seq-1', 'clock']),
      'output turned down to near-silent': withParam(sol, 'output-1', 'level', 0.01),
    }

    for (const [label, patch] of Object.entries(passes)) {
      const graded = await gradeConstrained('history-02-motorik', patch)
      // eslint-disable-next-line no-console
      console.log(`history-02-motorik PASS case "${label}": pass=${graded.pass} values=${JSON.stringify(graded.values)}`)
      expect(graded.pass, `expected to pass: ${label}`).toBe(true)
    }
    for (const [label, patch] of Object.entries(fails)) {
      const graded = await gradeConstrained('history-02-motorik', patch)
      // eslint-disable-next-line no-console
      console.log(`history-02-motorik FAIL case "${label}": pass=${graded.pass} values=${JSON.stringify(graded.values)}`)
      expect(graded.pass, `expected to fail: ${label}`).toBe(false)
    }
  })

  it('history-03-squelch: three different passing patches, two plausible-but-wrong failing patches', async () => {
    const level = getLevel('history-03-squelch')!
    const sol = level.solution

    const passes = {
      'correct proof patch (resonance 0.9, cutoff 150, cvAmount 5)': sol,
      'slightly gentler resonance and a higher base cutoff': withParam(withParam(sol, 'vcf-1', 'resonance', 0.8), 'vcf-1', 'cutoff', 220),
      'pulse wave instead of saw': withParam(sol, 'vco-1', 'shape', 1),
    }
    const fails = {
      'no filter envelope -- resonant but static, never sweeps': withParam(sol, 'vcf-1', 'cutoffCvAmount', 0),
      'attack far too slow -- eases in instead of snapping': withParam(sol, 'adsr-1', 'attack', 0.15),
    }

    for (const [label, patch] of Object.entries(passes)) {
      const graded = await gradeConstrained('history-03-squelch', patch)
      // eslint-disable-next-line no-console
      console.log(`history-03-squelch PASS case "${label}": pass=${graded.pass} values=${JSON.stringify(graded.values)}`)
      expect(graded.pass, `expected to pass: ${label}`).toBe(true)
    }
    for (const [label, patch] of Object.entries(fails)) {
      const graded = await gradeConstrained('history-03-squelch', patch)
      // eslint-disable-next-line no-console
      console.log(`history-03-squelch FAIL case "${label}": pass=${graded.pass} values=${JSON.stringify(graded.values)}`)
      expect(graded.pass, `expected to fail: ${label}`).toBe(false)
    }
  })

  it('history-04-funk-bass: three different passing patches, two plausible-but-wrong failing patches', async () => {
    const level = getLevel('history-04-funk-bass')!
    const sol = level.solution

    const passes = {
      'correct proof patch (resonance 0.15, cutoff 300, cvAmount 3)': sol,
      'a touch more filter envelope, slightly shorter decay': withParam(withParam(sol, 'vcf-1', 'cutoffCvAmount', 4), 'adsr-1', 'decay', 0.18),
      'pulse wave instead of saw': withParam(sol, 'vco-1', 'shape', 1),
    }
    const fails = {
      'no filter envelope -- flat, un-played tone': withParam(sol, 'vcf-1', 'cutoffCvAmount', 0),
      'attack far too slow -- eases in instead of played': withParam(sol, 'adsr-1', 'attack', 0.2),
    }

    for (const [label, patch] of Object.entries(passes)) {
      const graded = await gradeConstrained('history-04-funk-bass', patch)
      // eslint-disable-next-line no-console
      console.log(`history-04-funk-bass PASS case "${label}": pass=${graded.pass} values=${JSON.stringify(graded.values)}`)
      expect(graded.pass, `expected to pass: ${label}`).toBe(true)
    }
    for (const [label, patch] of Object.entries(fails)) {
      const graded = await gradeConstrained('history-04-funk-bass', patch)
      // eslint-disable-next-line no-console
      console.log(`history-04-funk-bass FAIL case "${label}": pass=${graded.pass} values=${JSON.stringify(graded.values)}`)
      expect(graded.pass, `expected to fail: ${label}`).toBe(false)
    }
  })

  it('history-06-east-west: three different passing patches (both routes), two plausible-but-wrong failing patches', async () => {
    const level = getLevel('history-06-east-west')!
    const sol = level.solution // the filter (East Coast) route

    // The West Coast route: swap the VCF for a Wavefolder, sine source (no
    // harmonics of its own until folded -- same reasoning 11-fold-pluck's
    // own brief uses), envelope driving foldCvAmount instead of cutoffCv.
    const wavefolderRoute: PatchFile = {
      version: 1,
      meta: { name: 'east-west: wavefolder route', created: '', author: '' },
      modules: [
        { id: 'vco-1', type: 'vco', slot: [0, 0], params: { octave: -2, shape: 3 } },
        { id: 'wavefolder-1', type: 'wavefolder', slot: [0, 1], params: { drive: 1, symmetry: 0, foldCvAmount: 4 } },
        { id: 'adsr-1', type: 'adsr', slot: [0, 2], params: { attack: 0.003, decay: 0.15, sustain: 0, release: 0.05 } },
        { id: 'vca-1', type: 'vca', slot: [0, 3], params: { level: 0, cvAmount: 1 } },
        { id: 'output-1', type: 'output', slot: [0, 4], params: {} },
      ],
      cables: [
        { from: ['vco-1', 'out'], to: ['wavefolder-1', 'in'] },
        { from: ['wavefolder-1', 'out'], to: ['vca-1', 'in'] },
        { from: ['adsr-1', 'out'], to: ['vca-1', 'cv'] },
        { from: ['adsr-1', 'out'], to: ['wavefolder-1', 'foldCv'] },
        { from: ['vca-1', 'out'], to: ['output-1', 'in'] },
      ],
    }

    const passes = {
      'correct proof patch (East Coast: ladder filter route)': sol,
      'West Coast: wavefolder route, sine source': wavefolderRoute,
      'East Coast route, higher base cutoff': withParam(sol, 'vcf-1', 'cutoff', 300),
    }
    const cheat = withParam(withCable(sol, ['adsr-1', 'out'], ['vco-1', 'fm']), 'vco-1', 'fmAmount', 1.5)
    const fails = {
      'no envelope on the shaping module at all -- static brightness': withParam(sol, 'vcf-1', 'cutoffCvAmount', 0),
      'pitch bent instead of color faded (fm cabled in -- the forbidden shortcut)': cheat,
    }

    for (const [label, patch] of Object.entries(passes)) {
      const graded = await gradeConstrained('history-06-east-west', patch)
      // eslint-disable-next-line no-console
      console.log(`history-06-east-west PASS case "${label}": pass=${graded.pass} values=${JSON.stringify(graded.values)}`)
      expect(graded.pass, `expected to pass: ${label}`).toBe(true)
    }
    for (const [label, patch] of Object.entries(fails)) {
      const graded = await gradeConstrained('history-06-east-west', patch)
      // eslint-disable-next-line no-console
      console.log(`history-06-east-west FAIL case "${label}": pass=${graded.pass} values=${JSON.stringify(graded.values)}`)
      expect(graded.pass, `expected to fail: ${label}`).toBe(false)
    }
  })
})

describe('build: history-05-chop', () => {
  it("the solution's topology passes its own query", async () => {
    const level = getLevel('history-05-chop')!
    const ctx = new OfflineAudioContext(1, 128, SR)
    await ensureWorklets(ctx)
    const { graph } = loadPatch(ctx, level.solution)
    const result = inspect(graph, level.query!)
    expect(result.pass, `history-05-chop solution failed: ${result.failures.join('; ')}`).toBe(true)
  })

  it('an unwired sampler and bitcrusher (added but not patched) fails the query', async () => {
    const level = getLevel('history-05-chop')!
    const unwired: PatchFile = {
      version: 1,
      meta: { name: 'unwired', created: '', author: '' },
      modules: [
        { id: 'clock-1', type: 'clock', slot: [0, 0], params: {} },
        { id: 'sampler-1', type: 'sampler', slot: [0, 1], params: {} },
        { id: 'bitcrusher-1', type: 'bitcrusher', slot: [0, 2], params: {} },
        { id: 'output-1', type: 'output', slot: [0, 3], params: {} },
      ],
      cables: [],
    }
    const ctx = new OfflineAudioContext(1, 128, SR)
    await ensureWorklets(ctx)
    const { graph } = loadPatch(ctx, unwired)
    const result = inspect(graph, level.query!)
    expect(result.pass).toBe(false)
  })
})
