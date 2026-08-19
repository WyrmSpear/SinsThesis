import type { Level } from '../academy/levels'
import type { AcademyProgress } from '../academy/progress'
import { isUnlocked } from '../academy/progress'
import type { InspectorResult } from '../src/engine/analysis/inspector'

/**
 * The academy's own panel: a level list, the current level's brief, a
 * Check button, and feedback -- built the same declarative,
 * rebuild-on-every-change way `rack/main.ts`'s `renderRack` draws the rack
 * itself, rather than hand-patching a live DOM tree. This module owns only
 * *what* to draw; `rack/main.ts` owns all the state (which level, the
 * player's progress, the last Check result) and every side effect (loading
 * a starting patch, filtering the palette, running `inspect`).
 *
 * Section 4 of the task this exists for is blunt about why feedback is a
 * list, not a score: "a grade is never a bare number... show the miss."
 * The sentences it lays out are player-facing text built by
 * `academy/feedback.ts` from `inspect`'s structured result -- module
 * display names, port labels, "the second VCO," a param's own units --
 * not `inspect`'s own engine-facing sentences (which name modules by id,
 * for the test suite). This file still never rewrites or summarizes
 * anything itself; it only lays out whatever `feedback` the caller hands
 * it.
 */

export interface AcademyPanelState {
  currentLevelId: string | undefined
  progress: AcademyProgress
  lastCheck: InspectorResult | undefined
  /** Player-facing rephrasing of `lastCheck.failures`, same order and
   *  length -- see `academy/feedback.ts`'s `describeFailures`. Ignored
   *  when `lastCheck` is undefined or passing. */
  feedback: readonly string[]
}

export interface AcademyPanelOptions {
  onSelectLevel: (id: string) => void
  onCheck: () => void
}

export function renderAcademyPanel(
  container: HTMLElement,
  levels: readonly Level[],
  state: AcademyPanelState,
  opts: AcademyPanelOptions,
): void {
  container.innerHTML = ''
  container.dataset['testid'] = 'academy-panel'

  const list = document.createElement('div')
  list.className = 'academy-level-list'
  list.dataset['testid'] = 'academy-level-list'

  for (const [i, level] of levels.entries()) {
    const unlocked = isUnlocked(levels, level.id, state.progress)
    const completed = state.progress.completed.includes(level.id)
    const current = level.id === state.currentLevelId

    const entry = document.createElement('button')
    entry.type = 'button'
    entry.className = [
      'academy-level-entry',
      current && 'academy-level-current',
      completed && 'academy-level-complete',
      !unlocked && 'academy-level-locked',
    ].filter(Boolean).join(' ')
    entry.dataset['testid'] = `academy-level-${level.id}`
    entry.disabled = !unlocked
    entry.title = unlocked ? level.title : `Complete level ${i} to unlock "${level.title}"`

    const badge = document.createElement('span')
    badge.className = 'academy-level-badge'
    badge.textContent = completed ? '✓' : !unlocked ? '\u{1F512}' : `${i + 1}`

    const label = document.createElement('span')
    label.className = 'academy-level-label'
    label.textContent = level.title

    entry.append(badge, label)
    if (unlocked) entry.addEventListener('click', () => opts.onSelectLevel(level.id))
    list.append(entry)
  }
  container.append(list)

  const current = levels.find((l) => l.id === state.currentLevelId)
  if (!current) {
    const empty = document.createElement('p')
    empty.className = 'academy-empty-note'
    empty.textContent = 'Choose a level from the list to begin.'
    container.append(empty)
    return
  }

  const brief = document.createElement('div')
  brief.className = 'academy-brief'
  brief.dataset['testid'] = 'academy-brief'

  const title = document.createElement('h3')
  title.className = 'academy-brief-title'
  title.textContent = current.title

  const body = document.createElement('p')
  body.className = 'academy-brief-body'
  body.textContent = current.brief

  brief.append(title, body)
  container.append(brief)

  const checkBtn = document.createElement('button')
  checkBtn.type = 'button'
  checkBtn.className = 'academy-check-btn'
  checkBtn.dataset['testid'] = 'academy-check'
  checkBtn.textContent = 'Check my patch'
  checkBtn.addEventListener('click', () => opts.onCheck())
  container.append(checkBtn)

  if (!state.lastCheck) return

  const feedback = document.createElement('div')
  feedback.className = `academy-feedback ${state.lastCheck.pass ? 'academy-feedback-pass' : 'academy-feedback-fail'}`
  feedback.dataset['testid'] = 'academy-feedback'

  if (state.lastCheck.pass) {
    const hasNext = levels.some((l, i) => levels[i - 1]?.id === current.id)
    feedback.textContent = hasNext
      ? `Level complete! The next level is unlocked below.`
      : `Level complete! That's every level in the academy so far.`
  } else {
    const heading = document.createElement('p')
    heading.className = 'academy-feedback-heading'
    const n = state.feedback.length
    heading.textContent = `Not yet — ${n} thing${n === 1 ? '' : 's'} to fix:`

    const ul = document.createElement('ul')
    ul.className = 'academy-feedback-list'
    for (const line of state.feedback) {
      const li = document.createElement('li')
      li.textContent = line
      ul.append(li)
    }
    feedback.append(heading, ul)
  }
  container.append(feedback)
}
