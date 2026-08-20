/**
 * Academy progress: which levels a player has completed, persisted the
 * same best-effort way `rack/patch-io.ts` persists autosave -- a
 * `localStorage` write can throw (quota, private browsing), and losing it
 * should never surface as if the player's own Check had failed.
 */

const PROGRESS_KEY = 'sinsthesis:academy-progress:v1'

export interface AcademyProgress {
  completed: string[]
  /** Which track the player was last looking at, e.g. `'main'` or `'bass'`
   *  (see `academy/levels.ts`'s `TRACKS`) -- purely a UI convenience so
   *  returning to the academy re-opens where the player left off, rather
   *  than data any grading logic reads. Undefined (rather than a stored
   *  default) for progress saved before tracks existed, or if a save ever
   *  fails -- the caller falls back to `'main'` the same way it always did. */
  currentTrack?: string
}

function emptyProgress(): AcademyProgress {
  return { completed: [] }
}

export function loadProgress(): AcademyProgress {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY)
    if (!raw) return emptyProgress()
    const parsed = JSON.parse(raw) as Partial<AcademyProgress>
    return {
      completed: Array.isArray(parsed.completed) ? parsed.completed : [],
      currentTrack: typeof parsed.currentTrack === 'string' ? parsed.currentTrack : undefined,
    }
  } catch {
    return emptyProgress()
  }
}

/** Records which track the player is looking at (idempotent-ish -- a
 *  redundant call just rewrites the same value) and persists it, mirroring
 *  `markComplete`'s "read, mutate, save, return" shape. */
export function setCurrentTrack(trackId: string): AcademyProgress {
  const progress = loadProgress()
  progress.currentTrack = trackId
  saveProgress(progress)
  return progress
}

export function saveProgress(progress: AcademyProgress): void {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress))
  } catch {
    /* best-effort; see saveAutosave in rack/patch-io.ts for the same reasoning */
  }
}

/** Records `id` as completed (idempotent) and persists it. Returns the
 *  updated progress so a caller can react without a second read. */
export function markComplete(id: string): AcademyProgress {
  const progress = loadProgress()
  if (!progress.completed.includes(id)) progress.completed.push(id)
  saveProgress(progress)
  return progress
}

/** The first level is always unlocked; every other level unlocks once the
 *  level immediately before it (in `levels`' own play order) is complete
 *  -- so unlocking is a property of *order*, not of some separately
 *  tracked "current level" pointer that could drift from `completed`. */
export function isUnlocked(levels: readonly { id: string }[], id: string, progress: AcademyProgress): boolean {
  const i = levels.findIndex((l) => l.id === id)
  if (i <= 0) return i === 0
  const prev = levels[i - 1]
  return prev !== undefined && progress.completed.includes(prev.id)
}

/** Test-only: clears persisted progress so a suite starts from a known
 *  state, the same role `clearRegistry` plays in `src/engine/registry.ts`. */
export function clearProgress(): void {
  try {
    localStorage.removeItem(PROGRESS_KEY)
  } catch {
    /* best-effort */
  }
}
