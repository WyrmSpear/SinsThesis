import { describe, it, expect, beforeAll } from 'vitest'
import { renderPatch } from '../../../src/engine/render'
import { compareSounds } from '../../../src/engine/analysis/compare'
import { registerAllModules } from '../../../src/engine/modules'
import { getModule } from '../../../src/engine/registry'
import { getLevel } from '../../../academy/levels'
import type { PatchFile } from '../../../src/engine/patch'

/**
 * Real-DSP measurement for the history track's one match-this-sound level,
 * history-01-modular-lead -- same structure and purpose as
 * tests/browser/analysis/compare-render.test.ts (which covers 06-08): a
 * target rendered against itself reads near-zero, and a real-DSP correct
 * patch scores below its own passThreshold while a plausible near-miss
 * scores above it. The sweep below (`describe.skip`) is how the actual
 * threshold in history-01-modular-lead.rubric.json was set -- re-enable and
 * run with `--reporter=verbose` to reproduce.
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

describe('match-this-sound: history-01-modular-lead real-DSP sanity', () => {
  it('the target rendered against itself reads near-zero distance', async () => {
    const level = getLevel('history-01-modular-lead')!
    const target = await renderPatch(level.solution, level.match!.seconds, {
      sampleRate: SR,
      gate: level.match!.gate,
    })
    const cmp = compareSounds(target, target, SR, level.match!.passThreshold)
    expect(cmp.distance).toBeLessThan(0.01)
    expect(cmp.pass).toBe(true)
    expect(cmp.detail).toEqual([])
  })
})

describe.skip('match-this-sound: history-01-modular-lead threshold calibration sweep (measurement only)', () => {
  it('filter envelope amount and cutoff sweeps', async () => {
    const level = getLevel('history-01-modular-lead')!
    const target = await renderPatch(level.solution, level.match!.seconds, { sampleRate: SR, gate: level.match!.gate })
    const scores: string[] = []
    for (const amt of [4.5, 3, 1.5, 0.5, 0]) {
      const variant = withParam(level.solution, 'vcf-1', 'cutoffCvAmount', amt)
      const buffer = await renderPatch(variant, level.match!.seconds, { sampleRate: SR, gate: level.match!.gate })
      scores.push(`cvAmt=${amt}:${compareSounds(target, buffer, SR, 1).distance.toFixed(4)}`)
    }
    for (const cutoff of [900, 700, 500, 300, 150]) {
      const variant = withParam(level.solution, 'vcf-1', 'cutoff', cutoff)
      const buffer = await renderPatch(variant, level.match!.seconds, { sampleRate: SR, gate: level.match!.gate })
      scores.push(`cutoff=${cutoff}:${compareSounds(target, buffer, SR, 1).distance.toFixed(4)}`)
    }
    for (const res of [0.45, 0.2, 0]) {
      const variant = withParam(level.solution, 'vcf-1', 'resonance', res)
      const buffer = await renderPatch(variant, level.match!.seconds, { sampleRate: SR, gate: level.match!.gate })
      scores.push(`res=${res}:${compareSounds(target, buffer, SR, 1).distance.toFixed(4)}`)
    }
    // eslint-disable-next-line no-console
    console.log(`history-01-modular-lead sweep: ${scores.join(' ')}`)
  })
})

describe('match-this-sound: history-01-modular-lead correct vs. close-but-wrong, real DSP', () => {
  it('filter envelope removed -- flat brightness instead of snap-then-settle', async () => {
    const level = getLevel('history-01-modular-lead')!
    const target = await renderPatch(level.solution, level.match!.seconds, {
      sampleRate: SR,
      gate: level.match!.gate,
    })

    const correctBuffer = await renderPatch(level.solution, level.match!.seconds, {
      sampleRate: SR,
      gate: level.match!.gate,
    })
    const correctScore = compareSounds(target, correctBuffer, SR, level.match!.passThreshold).distance

    // The plausible near-miss: everything wired the same way, but the
    // player never patched the ADSR's second cable into the VCF -- exactly
    // the "correctly wired but missing the second cable" mistake this
    // level's own brief warns about (same failure mode 09-thump/11-fold-pluck
    // already teach). The result is a flat, dull tone with none of the
    // target's snap-then-settle brightness.
    const close = withParam(level.solution, 'vcf-1', 'cutoffCvAmount', 0)
    const closeBuffer = await renderPatch(close, level.match!.seconds, { sampleRate: SR, gate: level.match!.gate })
    const closeCmp = compareSounds(target, closeBuffer, SR, level.match!.passThreshold)

    // eslint-disable-next-line no-console
    console.log(
      `history-01-modular-lead: correct=${correctScore.toFixed(4)} close-but-wrong=${closeCmp.distance.toFixed(4)} ` +
        `threshold=${level.match!.passThreshold}`,
    )
    expect(correctScore).toBeLessThan(level.match!.passThreshold)
    expect(closeCmp.distance).toBeGreaterThan(level.match!.passThreshold)
    expect(closeCmp.detail.length).toBeGreaterThan(0)
  })
})
