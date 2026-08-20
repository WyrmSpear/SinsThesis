import { describe, it, expect } from 'vitest'
import { isUnlocked, type AcademyProgress } from '../../academy/progress'
import { LEVELS, TRACKS, levelsInTrack, getLevel } from '../../academy/levels'

/**
 * The multi-track unlock model: `isUnlocked` (academy/progress.ts) is
 * unchanged code -- it already took an explicit `levels` list to check
 * "the one before this" against, rather than reading a hardcoded global.
 * What actually makes two tracks behave as two independent sequences is
 * entirely on the *caller's* side: `levelsInTrack` (academy/levels.ts)
 * scopes that list to one track before `isUnlocked` ever sees it, so this
 * suite proves the seam holds -- a player's `completed` array is one flat
 * list (real localStorage has no notion of "per track"), but which level
 * that unlocks next depends on which track's own list it's checked against.
 */

function progressWith(...completed: string[]): AcademyProgress {
  return { completed }
}

describe('multi-track academy', () => {
  it('TRACKS lists at least the main and bass tracks', () => {
    const ids = TRACKS.map((t) => t.id)
    expect(ids).toContain('main')
    expect(ids).toContain('bass')
  })

  it('every level in LEVELS names a track that TRACKS actually defines', () => {
    const trackIds = new Set(TRACKS.map((t) => t.id))
    for (const level of LEVELS) {
      expect(trackIds.has(level.track), `${level.id} names unknown track "${level.track}"`).toBe(true)
    }
  })

  it('the main track has its original eleven levels, untouched', () => {
    const main = levelsInTrack('main')
    expect(main.length).toBe(11)
    expect(main[0]!.id).toBe('01-first-sound')
    expect(main[main.length - 1]!.id).toBe('11-fold-pluck')
  })

  it('the bass track has five levels, in the taught order', () => {
    const bass = levelsInTrack('bass')
    expect(bass.map((l) => l.id)).toEqual([
      'bass-01-layers', 'bass-02-reese', 'bass-03-wobble', 'bass-04-growl', 'bass-05-finish',
    ])
  })

  it("a track's own first level is always unlocked, regardless of any other track's progress", () => {
    const bass = levelsInTrack('bass')
    // Every main-track level complete, nothing in the bass track touched.
    const mainAllDone = progressWith(...levelsInTrack('main').map((l) => l.id))
    expect(isUnlocked(bass, 'bass-01-layers', mainAllDone)).toBe(true)
    // With genuinely empty progress too.
    expect(isUnlocked(bass, 'bass-01-layers', progressWith())).toBe(true)
  })

  it("a track's second level does not unlock from another track's progress alone", () => {
    const bass = levelsInTrack('bass')
    const mainAllDone = progressWith(...levelsInTrack('main').map((l) => l.id))
    expect(isUnlocked(bass, 'bass-02-reese', mainAllDone)).toBe(false)
  })

  it('completing a track level unlocks the next level in that same track only', () => {
    const bass = levelsInTrack('bass')
    const main = levelsInTrack('main')
    const progress = progressWith('bass-01-layers')
    expect(isUnlocked(bass, 'bass-02-reese', progress)).toBe(true)
    expect(isUnlocked(bass, 'bass-03-wobble', progress)).toBe(false)
    // The main track is unaffected: its second level still needs its own
    // first level completed, not the bass track's.
    expect(isUnlocked(main, '02-shape-it', progress)).toBe(false)
  })

  it('walking the bass track end to end unlocks one level at a time', () => {
    const bass = levelsInTrack('bass')
    const ids = bass.map((l) => l.id)
    let progress = progressWith()
    for (let i = 0; i < ids.length; i++) {
      expect(isUnlocked(bass, ids[i]!, progress), `${ids[i]} should be unlocked at step ${i}`).toBe(true)
      if (i + 1 < ids.length) {
        expect(isUnlocked(bass, ids[i + 1]!, progress), `${ids[i + 1]} should not be unlocked yet`).toBe(false)
      }
      progress = progressWith(...progress.completed, ids[i]!)
    }
  })

  it('every bass level is reachable by id and reports the bass track', () => {
    for (const id of ['bass-01-layers', 'bass-02-reese', 'bass-03-wobble', 'bass-04-growl', 'bass-05-finish']) {
      const level = getLevel(id)
      expect(level, `expected level "${id}"`).toBeDefined()
      expect(level!.track).toBe('bass')
    }
  })
})
