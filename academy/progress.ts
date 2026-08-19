/**
 * Academy progress: which levels a player has completed, persisted the
 * same best-effort way `rack/patch-io.ts` persists autosave -- a
 * `localStorage` write can throw (quota, private browsing), and losing it
 * should never surface as if the player's own Check had failed.
 */

const PROGRESS_KEY = 'sinsthesis:academy-progress:v1'

export interface AcademyProgress {
  completed: string[]
}

function emptyProgress(): AcademyProgress {
  return { completed: [] }
}

export function loadProgress(): AcademyProgress {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY)
    if (!raw) return emptyProgress()
    const parsed = JSON.parse(raw) as Partial<AcademyProgress>
    return { completed: Array.isArray(parsed.completed) ? parsed.completed : [] }
  } catch {
    return emptyProgress()
  }
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
