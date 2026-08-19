import type { SoundComparison, SoundDetail } from '../src/engine/analysis/compare'

/**
 * Turns a `SoundComparison`'s structured `detail` into the sentences the
 * academy panel shows a player -- the same split `academy/feedback.ts`
 * already draws for build-this-patch: `engine/analysis` stays
 * engine-facing (its `SoundDetail` values are plain data -- a kind, a
 * direction, a magnitude -- not English), and this file is where they
 * become words. Unlike `inspect()`'s failures, `compareSounds`' dimensions
 * were never engine identifiers to begin with (there's no module id to
 * hide here), so the split is purely "data vs. prose," not "hide the
 * engine's vocabulary" -- but it is the same reason: a test asserting on
 * `SoundDetail.kind === 'brightness'` must never break because someone
 * reworded a sentence.
 *
 * Every line names an actual knob (Cutoff, Resonance, Attack, Shape) --
 * Section 4's mandate is not just "say what's wrong" but "the player
 * should know what knob to reach for next." Which knobs even *exist*
 * depends on the level: `07-match-waveform` grants no VCF at all, and
 * `resonance`/`brightness`'s naive wording ("turn the filter's Res knob
 * down") named a knob that literally is not on the rack -- found by
 * actually playing the level (see academy-match-sound-report.md), not by
 * reasoning about it. `hasFilter` (the caller's own `level.grantedModules`
 * check) is what a real filter-aware phrasing needs, and a `resonance`
 * reading with no filter granted has no knob to send the player to at
 * all, so it's dropped rather than left dangling -- unless dropping it
 * would leave nothing to say, in which case showing an imperfectly-worded
 * line beats showing none.
 */

function describeDetail(d: SoundDetail, hasFilter: boolean): string {
  switch (d.kind) {
    case 'brightness': {
      const filterClause = hasFilter
        ? d.direction === 'brighter' ? ` (or lower the filter's Cut knob)` : ` (or raise the filter's Cut knob)`
        : ''
      return d.direction === 'brighter'
        ? `Your patch sounds brighter than the target -- try a mellower waveform${filterClause}.`
        : `Your patch sounds darker than the target -- try a brighter waveform${filterClause}.`
    }

    case 'attack':
      return d.direction === 'shorter'
        ? `The sound snaps in faster than the target's does -- try a slower Attack on the envelope.`
        : `The sound takes longer to arrive than the target's does -- try a faster Attack on the envelope.`

    case 'resonance':
      return d.direction === 'more'
        ? `There's more resonance than the target has -- try turning the filter's Res knob down.`
        : `The target has more resonance (that filter "zing") than yours -- try turning Res up.`

    case 'fullness':
      return d.direction === 'hollower'
        ? `Your tone sounds hollower than the target -- try a fuller waveform (a saw instead of a narrow pulse or square).`
        : `Your tone sounds fuller than the target, which is more hollow -- try a narrower pulse, or a square wave.`
  }
}

export interface SoundFeedbackOptions {
  /** Whether the level's granted modules include a VCF -- a `resonance`
   *  reading names a knob that doesn't exist on a level with no filter, so
   *  it's dropped there rather than pointed at nothing. */
  hasFilter: boolean
}

/** Player-facing rephrasing of `comparison.detail` -- not guaranteed the
 *  same length when `hasFilter` is false (a `resonance` line with no real
 *  Res knob to send the player to is dropped, unless dropping it would
 *  leave the list empty, in which case it's kept rather than showing
 *  nothing). Empty (nothing to say) when `comparison.pass` is true. */
export function describeSoundDifference(comparison: SoundComparison, opts: SoundFeedbackOptions): string[] {
  const all = comparison.detail.map((d) => ({ d, text: describeDetail(d, opts.hasFilter) }))
  const relevant = opts.hasFilter ? all : all.filter(({ d }) => d.kind !== 'resonance')
  const chosen = relevant.length > 0 ? relevant : all
  return chosen.map(({ text }) => text)
}
