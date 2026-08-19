import type { Level } from '../academy/levels'
import type { AcademyProgress } from '../academy/progress'
import { isUnlocked } from '../academy/progress'
import type { InspectorResult } from '../src/engine/analysis/inspector'
import type { SoundComparison } from '../src/engine/analysis/compare'
import { renderMatchOverlay } from './match-sound-panel'

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
 *
 * Match-this-sound levels (`level.mode === 'match'`) grade sound instead
 * of topology, and "show the miss" means something more literal there: a
 * spectrum and an envelope, the player's overlaid on the target's, built
 * by `rack/match-sound-panel.ts`'s `renderMatchOverlay` from the same
 * `SoundComparison` the pass/fail line and the ranked feedback sentences
 * (`academy/sound-feedback.ts`) already came from -- one Check produces
 * one comparison, and everything on screen after it is a view of that one
 * object, never three independent re-derivations of it.
 */

export interface MatchCheckState {
  comparison: SoundComparison
  target: Float32Array
  player: Float32Array
  sampleRate: number
  /** Player-facing rephrasing of `comparison.detail` -- see
   *  `academy/sound-feedback.ts`'s `describeSoundDifference`. */
  feedback: readonly string[]
}

export interface AcademyPanelState {
  currentLevelId: string | undefined
  progress: AcademyProgress
  lastCheck: InspectorResult | undefined
  /** Player-facing rephrasing of `lastCheck.failures`, same order and
   *  length -- see `academy/feedback.ts`'s `describeFailures`. Ignored
   *  when `lastCheck` is undefined or passing. */
  feedback: readonly string[]
  /** True while a match-this-sound Check or "Play target" is mid-render --
   *  both take a real (if short) offline render, unlike a build-this-patch
   *  Check, which is synchronous. Buttons disable and say so rather than
   *  looking stuck. Always false for a build-this-patch level. */
  busy: boolean
  /** The most recent match-this-sound Check result for the current level,
   *  if any -- undefined for a build-this-patch level, or before its first
   *  Check this visit. */
  lastMatch: MatchCheckState | undefined
}

export interface AcademyPanelOptions {
  onSelectLevel: (id: string) => void
  onCheck: () => void
  /** Match-this-sound only: play the level's target sound through the live
   *  AudioContext. As many times as the player wants -- Section 3's "a
   *  player must be able to hear the target on demand", because comparing
   *  from memory is a different, harder skill than the one this teaches. */
  onPlayTarget: () => void
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

  if (current.mode === 'match') {
    const playBtn = document.createElement('button')
    playBtn.type = 'button'
    playBtn.className = 'academy-play-target-btn'
    playBtn.dataset['testid'] = 'academy-play-target'
    playBtn.textContent = state.busy ? 'Rendering…' : 'Play target sound'
    playBtn.disabled = state.busy
    playBtn.addEventListener('click', () => opts.onPlayTarget())
    container.append(playBtn)
  }

  const checkBtn = document.createElement('button')
  checkBtn.type = 'button'
  checkBtn.className = 'academy-check-btn'
  checkBtn.dataset['testid'] = 'academy-check'
  checkBtn.textContent = state.busy ? 'Rendering…' : 'Check my patch'
  checkBtn.disabled = state.busy
  checkBtn.addEventListener('click', () => opts.onCheck())
  container.append(checkBtn)

  const hasNext = levels.some((l, i) => levels[i - 1]?.id === current.id)
  const passMessage = hasNext
    ? `Level complete! The next level is unlocked below.`
    : `Level complete! That's every level in the academy so far.`

  if (current.mode === 'match') {
    if (!state.lastMatch) return
    const { comparison, feedback: lines, target, player, sampleRate } = state.lastMatch

    const feedback = document.createElement('div')
    feedback.className = `academy-feedback ${comparison.pass ? 'academy-feedback-pass' : 'academy-feedback-fail'}`
    feedback.dataset['testid'] = 'academy-feedback'

    if (comparison.pass) {
      feedback.textContent = passMessage
      container.append(feedback)
    } else {
      const heading = document.createElement('p')
      heading.className = 'academy-feedback-heading'
      heading.textContent = `Not yet — here's what's off:`

      const ul = document.createElement('ul')
      ul.className = 'academy-feedback-list'
      for (const line of lines) {
        const li = document.createElement('li')
        li.textContent = line
        ul.append(li)
      }
      feedback.append(heading, ul)
      container.append(feedback)

      const overlay = document.createElement('div')
      renderMatchOverlay(overlay, target, player, sampleRate)
      container.append(overlay)
    }
    return
  }

  if (!state.lastCheck) return

  const feedback = document.createElement('div')
  feedback.className = `academy-feedback ${state.lastCheck.pass ? 'academy-feedback-pass' : 'academy-feedback-fail'}`
  feedback.dataset['testid'] = 'academy-feedback'

  if (state.lastCheck.pass) {
    feedback.textContent = passMessage
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
