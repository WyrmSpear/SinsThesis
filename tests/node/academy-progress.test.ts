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
  it('TRACKS lists at least the main, bass and history tracks', () => {
    const ids = TRACKS.map((t) => t.id)
    expect(ids).toContain('main')
    expect(ids).toContain('bass')
    expect(ids).toContain('history')
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

  // A third track, checked the same way the bass-vs-main assertions above
  // already do: not because the unlock mechanism is different (it's the
  // same `isUnlocked` call, over a third list `levelsInTrack` scopes), but
  // because a three-track model is the first real proof no *pair* of
  // tracks accidentally shares progress once there's a third to get it
  // wrong against.
  it('the history track has six levels, in the taught order', () => {
    const history = levelsInTrack('history')
    expect(history.map((l) => l.id)).toEqual([
      'history-01-modular-lead', 'history-02-motorik', 'history-03-squelch',
      'history-04-funk-bass', 'history-05-chop', 'history-06-east-west',
    ])
  })

  it("the history track's own first level is always unlocked, regardless of main or bass progress", () => {
    const history = levelsInTrack('history')
    const otherTracksAllDone = progressWith(
      ...levelsInTrack('main').map((l) => l.id),
      ...levelsInTrack('bass').map((l) => l.id),
    )
    expect(isUnlocked(history, 'history-01-modular-lead', otherTracksAllDone)).toBe(true)
    expect(isUnlocked(history, 'history-01-modular-lead', progressWith())).toBe(true)
  })

  it("the history track's second level does not unlock from main or bass progress alone", () => {
    const history = levelsInTrack('history')
    const otherTracksAllDone = progressWith(
      ...levelsInTrack('main').map((l) => l.id),
      ...levelsInTrack('bass').map((l) => l.id),
    )
    expect(isUnlocked(history, 'history-02-motorik', otherTracksAllDone)).toBe(false)
  })

  it('walking the history track end to end unlocks one level at a time, independent of the other two tracks', () => {
    const history = levelsInTrack('history')
    const main = levelsInTrack('main')
    const bass = levelsInTrack('bass')
    const ids = history.map((l) => l.id)
    let progress = progressWith()
    for (let i = 0; i < ids.length; i++) {
      expect(isUnlocked(history, ids[i]!, progress), `${ids[i]} should be unlocked at step ${i}`).toBe(true)
      if (i + 1 < ids.length) {
        expect(isUnlocked(history, ids[i + 1]!, progress), `${ids[i + 1]} should not be unlocked yet`).toBe(false)
      }
      progress = progressWith(...progress.completed, ids[i]!)
    }
    // Completing the whole history track never unlocked anything in main or bass.
    expect(isUnlocked(main, '02-shape-it', progress)).toBe(false)
    expect(isUnlocked(bass, 'bass-02-reese', progress)).toBe(false)
  })

  it('every history level is reachable by id and reports the history track', () => {
    for (const id of [
      'history-01-modular-lead', 'history-02-motorik', 'history-03-squelch',
      'history-04-funk-bass', 'history-05-chop', 'history-06-east-west',
    ]) {
      const level = getLevel(id)
      expect(level, `expected level "${id}"`).toBeDefined()
      expect(level!.track).toBe('history')
    }
  })
})
