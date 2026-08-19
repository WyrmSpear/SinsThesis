import { describe, it, expect, beforeAll } from 'vitest'
import { renderPatch } from '../../../src/engine/render'
import { compareSounds } from '../../../src/engine/analysis/compare'
import { registerAllModules } from '../../../src/engine/modules'
import { getModule } from '../../../src/engine/registry'
import { getLevel } from '../../../academy/levels'
import type { PatchFile } from '../../../src/engine/patch'

/**
 * Real-DSP measurement for match-this-sound: unlike tests/node/analysis/
 * compare.test.ts (synthetic buffers, no AudioContext), this renders each
 * level's actual target `.sinp` through the real worklets, the same
 * `renderPatch` path the rack itself uses at play time. Two jobs:
 *
 * 1. Sanity, asserted every run: a target rendered and compared against
 *    itself reads (near-)zero, and a real-DSP correct patch scores below
 *    its own level's pass threshold while a plausible near-miss scores
 *    above it -- proving the whole pipeline (renderPatch -> compareSounds
 *    -> rubric threshold) agrees with the synthetic-signal properties
 *    tests/node/analysis/compare.test.ts already proved about
 *    compareSounds in isolation.
 * 2. The measurement `.superpowers/sdd/academy-match-sound-report.md`
 *    reports and each rubric.json's `passThreshold` was set from: build a
 *    correct patch, see what it scores; build several deliberately-wrong
 *    variants, see what those score; place the bar where it separates
 *    them. The calibration sweeps below (`describe.skip`, not part of the
 *    asserted suite -- they print a spread of scores to eyeball, not a
 *    pass/fail) are how those numbers were actually produced; re-enable
 *    them (drop `.skip`) and run with `--reporter=verbose` to reproduce.
 */

const SR = 48000

beforeAll(() => {
  if (!getModule('vco')) registerAllModules()
})

function clonePatch(patch: PatchFile): PatchFile {
  return JSON.parse(JSON.stringify(patch)) as PatchFile
}

function withParam(patch: PatchFile, type: string, param: string, value: number): PatchFile {
  const clone = clonePatch(patch)
  const mod = clone.modules.find((m) => m.type === type)
  if (!mod) throw new Error(`withParam: no module of type "${type}"`)
  mod.params[param] = value
  return clone
}

describe('match-this-sound: real-DSP sanity', () => {
  for (const id of ['06-match-pluck', '07-match-waveform', '08-match-resonance']) {
    it(`${id}: the target rendered against itself reads near-zero distance`, async () => {
      const level = getLevel(id)!
      const target = await renderPatch(level.solution, level.match!.seconds, {
        sampleRate: SR,
        gate: level.match!.gate,
      })
      const cmp = compareSounds(target, target, SR, level.match!.passThreshold)
      expect(cmp.distance).toBeLessThan(0.01)
      expect(cmp.pass).toBe(true)
      expect(cmp.detail).toEqual([])
    })
  }
})

describe.skip('match-this-sound: threshold calibration sweeps (measurement only)', () => {
  it('06-match-pluck: cutoff and attack sweeps', async () => {
    const level = getLevel('06-match-pluck')!
    const target = await renderPatch(level.solution, level.match!.seconds, { sampleRate: SR, gate: level.match!.gate })
    const scores: string[] = []
    for (const cutoff of [5500, 5000, 4200, 3200, 2000]) {
      const variant = withParam(level.solution, 'vcf', 'cutoff', cutoff)
      const buffer = await renderPatch(variant, level.match!.seconds, { sampleRate: SR, gate: level.match!.gate })
      scores.push(`cutoff=${cutoff}:${compareSounds(target, buffer, SR, 1).distance.toFixed(4)}`)
    }
    for (const attack of [0.01, 0.02, 0.04, 0.08]) {
      const variant = withParam(level.solution, 'adsr', 'attack', attack)
      const buffer = await renderPatch(variant, level.match!.seconds, { sampleRate: SR, gate: level.match!.gate })
      scores.push(`attack=${attack}:${compareSounds(target, buffer, SR, 1).distance.toFixed(4)}`)
    }
    // eslint-disable-next-line no-console
    console.log(`06-match-pluck sweep: ${scores.join(' ')}`)
  })

  it('07-match-waveform: pulse width and shape sweeps', async () => {
    const level = getLevel('07-match-waveform')!
    const target = await renderPatch(level.solution, level.match!.seconds, { sampleRate: SR })
    const scores: string[] = []
    for (const pw of [0.27, 0.29, 0.22, 0.2, 0.35, 0.5, 0.15, 0.1]) {
      const variant = withParam(level.solution, 'vco', 'pulseWidth', pw)
      const buffer = await renderPatch(variant, level.match!.seconds, { sampleRate: SR })
      scores.push(`pw=${pw}:${compareSounds(target, buffer, SR, 1).distance.toFixed(4)}`)
    }
    for (const [label, shape] of [['saw', 0], ['tri', 2], ['sine', 3]] as const) {
      const variant = withParam(level.solution, 'vco', 'shape', shape)
      const buffer = await renderPatch(variant, level.match!.seconds, { sampleRate: SR })
      scores.push(`shape=${label}:${compareSounds(target, buffer, SR, 1).distance.toFixed(4)}`)
    }
    // eslint-disable-next-line no-console
    console.log(`07-match-waveform sweep: ${scores.join(' ')}`)
  })

  it('08-match-resonance: resonance and no-sweep', async () => {
    const level = getLevel('08-match-resonance')!
    const target = await renderPatch(level.solution, level.match!.seconds, { sampleRate: SR })
    const scores: string[] = []
    for (const resonance of [0.8, 0.7, 0.5, 0.3, 0]) {
      const variant = withParam(level.solution, 'vcf', 'resonance', resonance)
      const buffer = await renderPatch(variant, level.match!.seconds, { sampleRate: SR })
      scores.push(`res=${resonance}:${compareSounds(target, buffer, SR, 1).distance.toFixed(4)}`)
    }
    const noSweep = withParam(level.solution, 'lfo', 'depth', 0)
    const noSweepBuffer = await renderPatch(noSweep, level.match!.seconds, { sampleRate: SR })
    scores.push(`no-sweep:${compareSounds(target, noSweepBuffer, SR, 1).distance.toFixed(4)}`)
    // eslint-disable-next-line no-console
    console.log(`08-match-resonance sweep: ${scores.join(' ')}`)
  })
})

describe('match-this-sound: correct vs. close-but-wrong, real DSP (sets the pass threshold)', () => {
  it('06-match-pluck: cutoff darkened and attack loosened', async () => {
    const level = getLevel('06-match-pluck')!
    const target = await renderPatch(level.solution, level.match!.seconds, {
      sampleRate: SR,
      gate: level.match!.gate,
    })

    const correctBuffer = await renderPatch(level.solution, level.match!.seconds, {
      sampleRate: SR,
      gate: level.match!.gate,
    })
    const correctScore = compareSounds(target, correctBuffer, SR, level.match!.passThreshold).distance

    let close = withParam(level.solution, 'vcf', 'cutoff', 3200) // 6000 -> 3200 Hz: noticeably darker
    close = withParam(close, 'adsr', 'attack', 0.04) // 5ms -> 40ms: a looser pluck
    const closeBuffer = await renderPatch(close, level.match!.seconds, { sampleRate: SR, gate: level.match!.gate })
    const closeCmp = compareSounds(target, closeBuffer, SR, level.match!.passThreshold)

    // eslint-disable-next-line no-console
    console.log(
      `06-match-pluck: correct=${correctScore.toFixed(4)} close-but-wrong=${closeCmp.distance.toFixed(4)} ` +
        `threshold=${level.match!.passThreshold}`,
    )
    expect(correctScore).toBeLessThan(level.match!.passThreshold)
    expect(closeCmp.distance).toBeGreaterThan(level.match!.passThreshold)
    expect(closeCmp.detail.length).toBeGreaterThan(0)
  })

  it('07-match-waveform: pulse width widened back toward a symmetric square', async () => {
    const level = getLevel('07-match-waveform')!
    const target = await renderPatch(level.solution, level.match!.seconds, { sampleRate: SR })

    const correctBuffer = await renderPatch(level.solution, level.match!.seconds, { sampleRate: SR })
    const correctScore = compareSounds(target, correctBuffer, SR, level.match!.passThreshold).distance

    // Target is a narrow pulse (width 0.25). Widening back to a centered
    // 0.5 duty cycle is a real, plausible mistake -- "I found Pulse but
    // left Width at its default" -- and clearly a different waveform.
    const close = withParam(level.solution, 'vco', 'pulseWidth', 0.5)
    const closeBuffer = await renderPatch(close, level.match!.seconds, { sampleRate: SR })
    const closeCmp = compareSounds(target, closeBuffer, SR, level.match!.passThreshold)

    // eslint-disable-next-line no-console
    console.log(
      `07-match-waveform: correct=${correctScore.toFixed(4)} close-but-wrong=${closeCmp.distance.toFixed(4)} ` +
        `threshold=${level.match!.passThreshold}`,
    )
    expect(correctScore).toBeLessThan(level.match!.passThreshold)
    expect(closeCmp.distance).toBeGreaterThan(level.match!.passThreshold)
    expect(closeCmp.detail.length).toBeGreaterThan(0)
  })

  it('08-match-resonance: resonance backed off to half the target', async () => {
    const level = getLevel('08-match-resonance')!
    const target = await renderPatch(level.solution, level.match!.seconds, { sampleRate: SR })

    const correctBuffer = await renderPatch(level.solution, level.match!.seconds, { sampleRate: SR })
    const correctScore = compareSounds(target, correctBuffer, SR, level.match!.passThreshold).distance

    // Still sweeps, still somewhat resonant, but well short of the "sings"
    // character the brief describes -- 0.85 -> 0.5.
    const close = withParam(level.solution, 'vcf', 'resonance', 0.5)
    const closeBuffer = await renderPatch(close, level.match!.seconds, { sampleRate: SR })
    const closeCmp = compareSounds(target, closeBuffer, SR, level.match!.passThreshold)

    // eslint-disable-next-line no-console
    console.log(
      `08-match-resonance: correct=${correctScore.toFixed(4)} close-but-wrong=${closeCmp.distance.toFixed(4)} ` +
        `threshold=${level.match!.passThreshold}`,
    )
    expect(correctScore).toBeLessThan(level.match!.passThreshold)
    expect(closeCmp.distance).toBeGreaterThan(level.match!.passThreshold)
    expect(closeCmp.detail.length).toBeGreaterThan(0)
  })
})
