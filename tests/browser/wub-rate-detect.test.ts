import { describe, it, expect } from 'vitest'
import { renderGraph } from '../../src/engine/render'
import { registerAllModules } from '../../src/engine/modules'
import { getModule } from '../../src/engine/registry'
import { rms, spectralCentroid } from '../../src/engine/analysis/features'
import { detectRateHz, LOCK_CONFIDENCE } from '../../arcade/rate-detect'

if (!getModule('vco')) registerAllModules()

/**
 * Validates `arcade/rate-detect.ts` against a real, filtered, LFO-modulated
 * signal -- not just the synthetic sine sequences
 * `tests/node/arcade-rate-detect.test.ts` uses -- by rendering the exact
 * technique the preset bank's own "Tempo-Locked Wobble" entry teaches
 * (`academy/levels/bass-03-wobble.sinp`: VCO -> VCF, LFO into the VCF's
 * `cutoffCv`) through the real engine and feeding the rendered audio
 * through the same per-frame feature extraction `rack/wub-panel.ts` runs
 * live off an analyser tap: a short window's RMS and spectral centroid,
 * one reading per ~1/60s "frame."
 *
 * This is the honest check that a genuine cutoff wobble -- not an idealised
 * math sine -- actually produces a periodic brightness signal the detector
 * can lock onto, at the rates `arcade/wub-game.ts` actually spawns targets
 * at.
 */

const SAMPLE_RATE = 48000
const FRAME_HZ = 60
const HOP = Math.round(SAMPLE_RATE / FRAME_HZ)
const FEATURE_WINDOW = 1024

/** One RMS and one spectral-centroid reading per `HOP`-sample step --
 *  exactly what a live analyser tap polled once per animation frame would
 *  hand `arcade/rate-detect.ts`, just computed offline against a rendered
 *  buffer instead of a live `AnalyserNode`. */
function extractFeatures(samples: Float32Array): { level: Float32Array; centroid: Float32Array } {
  const hops = Math.floor((samples.length - FEATURE_WINDOW) / HOP)
  const level = new Float32Array(hops)
  const centroid = new Float32Array(hops)
  for (let i = 0; i < hops; i++) {
    const window = samples.subarray(i * HOP, i * HOP + FEATURE_WINDOW)
    level[i] = rms(window)
    centroid[i] = spectralCentroid(window, SAMPLE_RATE)
  }
  return { level, centroid }
}

/** VCO -> VCF, LFO free-running at `lfoHz` into the VCF's cutoffCv -- the
 *  wobble preset's own topology, with the LFO's `division` left at 0
 *  ('Free') so the test controls the exact Hz directly instead of going
 *  through a Clock's tempo. */
async function renderWobble(lfoHz: number, seconds: number): Promise<Float32Array> {
  return renderGraph(
    seconds,
    (ctx, graph) => {
      const vco = graph.addModule('vco', 'vco-1')
      const vcf = graph.addModule('vcf', 'vcf-1')
      const lfo = graph.addModule('lfo', 'lfo-1')
      graph.setParam(vco, 'octave', -1, ctx.currentTime)
      graph.setParam(vcf, 'cutoff', 400, ctx.currentTime)
      graph.setParam(vcf, 'resonance', 0.4, ctx.currentTime)
      graph.setParam(vcf, 'cutoffCvAmount', 4.5, ctx.currentTime)
      graph.setParam(lfo, 'rate', lfoHz, ctx.currentTime)
      graph.setParam(lfo, 'shape', 3, ctx.currentTime) // sine
      graph.setParam(lfo, 'depth', 1, ctx.currentTime)
      graph.connect([vco, 'out'], [vcf, 'in'])
      graph.connect([lfo, 'out'], [vcf, 'cutoffCv'])
      return vcf
    },
    SAMPLE_RATE,
  )
}

// The same target set arcade/wub-game.ts spawns (half note, quarter,
// quarter triplet, eighth, eighth triplet at a nominal 120 BPM).
const TARGETS = [1, 2, 2.667, 4, 5.333]

describe('wub disruptor: rate detection against a real filter-cutoff wobble', () => {
  for (const hz of TARGETS) {
    it(`recovers ${hz.toFixed(3)} Hz from a real VCO->VCF(LFO cutoff) render`, async () => {
      const seconds = Math.max(2.5, 3 / hz) + 0.3
      const samples = await renderWobble(hz, seconds)
      const { level, centroid } = extractFeatures(samples)

      const estLevel = detectRateHz(level, FRAME_HZ)
      const estCentroid = detectRateHz(centroid, FRAME_HZ)
      // Either channel locking on is enough -- rack/wub-panel.ts takes
      // whichever reads a real lock, exactly the "any means" principle
      // the paddle's own balance read established.
      const best =
        estCentroid && estCentroid.confidence >= LOCK_CONFIDENCE
          ? estCentroid
          : estLevel && estLevel.confidence >= LOCK_CONFIDENCE
            ? estLevel
            : undefined

      expect(best, `neither RMS nor centroid locked on for ${hz} Hz (level=${JSON.stringify(estLevel)}, centroid=${JSON.stringify(estCentroid)})`).toBeDefined()
      expect(Math.abs(best!.hz - hz)).toBeLessThan(0.3)
    })
  }

  it('a neighboring wrong rate does not read within the game\'s tolerance', async () => {
    // Quarter (2 Hz) target, played at eighth-note (4 Hz) rate instead --
    // a real, plausible player mistake (double-timed the wobble), not a
    // strawman.
    const targetHz = 2
    const wrongHz = 4
    const samples = await renderWobble(wrongHz, 2.5)
    const { level, centroid } = extractFeatures(samples)
    const estLevel = detectRateHz(level, FRAME_HZ)
    const estCentroid = detectRateHz(centroid, FRAME_HZ)
    const best =
      estCentroid && estCentroid.confidence >= LOCK_CONFIDENCE ? estCentroid : estLevel
    expect(best).toBeDefined()
    expect(Math.abs(best!.hz - targetHz)).toBeGreaterThan(0.5) // TOLERANCE_HZ margin, see arcade/wub-game.ts
  })
})
