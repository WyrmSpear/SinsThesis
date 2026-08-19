import { describe, it, expect } from 'vitest'
import { describeSoundDifference } from '../../academy/sound-feedback'
import type { SoundComparison, SoundDetail } from '../../src/engine/analysis/compare'

/**
 * Found by actually playing 07-match-waveform (a level with no VCF
 * granted) with a hand-built browse session: the naive phrasing sent the
 * player to "the filter's Res knob," which does not exist on that level's
 * rack -- see academy-match-sound-report.md. This suite pins the fix:
 * `resonance` detail is filter-only, and dropping it must never leave a
 * failed Check with nothing to say.
 */

function comparisonWith(detail: SoundDetail[]): SoundComparison {
  return { pass: false, distance: 1, spectralDistance: 1, envelopeDistance: 1, detail }
}

const brightnessDetail: SoundDetail = { kind: 'brightness', direction: 'darker', octaves: 0.4 }
const resonanceDetail: SoundDetail = { kind: 'resonance', direction: 'more', db: 5 }

describe('describeSoundDifference', () => {
  it('names the filter Res knob when the level has a filter', () => {
    const lines = describeSoundDifference(comparisonWith([resonanceDetail]), { hasFilter: true })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("filter's Res knob")
  })

  it('drops a resonance-only reading on a filterless level, without leaving a blank result', () => {
    const lines = describeSoundDifference(comparisonWith([resonanceDetail]), { hasFilter: false })
    // Dropping it would leave nothing to say, so it's kept -- imperfect
    // wording beats a Check that fails silently.
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("filter's Res knob")
  })

  it('drops resonance but keeps every other reading on a filterless level', () => {
    const lines = describeSoundDifference(comparisonWith([resonanceDetail, brightnessDetail]), { hasFilter: false })
    expect(lines).toHaveLength(1)
    expect(lines.some((l) => l.includes('Res knob'))).toBe(false)
    expect(lines[0]).toContain('darker')
  })

  it('never mentions the filter Cut knob for brightness on a filterless level', () => {
    const lines = describeSoundDifference(comparisonWith([brightnessDetail]), { hasFilter: false })
    expect(lines[0]).not.toMatch(/filter/i)
    expect(lines[0]).toContain('waveform')
  })

  it('does mention the filter Cut knob for brightness when the level has one', () => {
    const lines = describeSoundDifference(comparisonWith([brightnessDetail]), { hasFilter: true })
    expect(lines[0]).toMatch(/filter's Cut knob/)
  })
})
