import type { CpuLoadReport, CpuMeterHandle } from '../src/engine/cpu-meter'

/**
 * The toolbar's CPU load meter -- Section 11's "CPU overload -> load
 * meter" failure mode (`src/engine/cpu-meter.ts`/`worklets/cpu-meter.
 * worklet.ts` do the measuring; this file only draws what it reports).
 * Lives in the toolbar, not tucked into a drawer or a module panel: with
 * twenty-six modules a player can build a patch their machine can't
 * render, and the point of this whole failure mode is that they see *why*
 * audio is stuttering before they give up and close the tab, not after
 * they go digging for a devtools panel. The toolbar is the one piece of
 * chrome visible in every mode (free play, academy, arcade) and at every
 * scroll position.
 *
 * Two thresholds, not one flat "past X, turn red": `HIGH_LOAD_THRESHOLD`
 * is an early warning (getting close), `OVERRUN_THRESHOLD` is the point
 * where quanta actually ran over budget -- the task's own "past a
 * threshold it should say something actionable, not just turn red," so
 * the readout's text changes at each step, not only its color.
 */

const HIGH_LOAD_THRESHOLD = 0.75
const OVERRUN_THRESHOLD = 1

export interface CpuMeterView {
  dispose(): void
}

function readoutFor(report: CpuLoadReport, totalOverruns: number): string {
  const pct = Math.round(report.avgLoad * 100)
  if (report.avgLoad >= OVERRUN_THRESHOLD) {
    return `CPU ${pct}% -- audio is likely stuttering. Remove a module or simplify the patch. (${totalOverruns} overrun${totalOverruns === 1 ? '' : 's'} this session)`
  }
  if (report.avgLoad >= HIGH_LOAD_THRESHOLD) {
    return `CPU ${pct}% -- getting close to this machine's limit.`
  }
  return `CPU ${pct}%`
}

/**
 * Renders into `root` (index.html's `#cpu-meter`, inside the toolbar) and
 * returns a handle to unsubscribe. `meter` is `undefined` when the
 * `cpu-meter` worklet bundle itself didn't load (the same honest-absence
 * handling every other Section 11 fallback uses) -- the element just stays
 * hidden rather than showing a reading that isn't real.
 */
export function renderCpuMeter(root: HTMLElement, meter: CpuMeterHandle | undefined): CpuMeterView {
  root.innerHTML = ''
  if (!meter) {
    root.hidden = true
    return { dispose() {} }
  }
  root.hidden = false

  const track = document.createElement('div')
  track.className = 'cpu-meter-track'
  const fill = document.createElement('div')
  fill.className = 'cpu-meter-fill'
  track.append(fill)

  const readout = document.createElement('div')
  readout.className = 'cpu-meter-readout'
  readout.dataset['testid'] = 'cpu-meter-readout'
  readout.textContent = 'CPU 0%'

  root.append(track, readout)

  let totalOverruns = 0
  const unsubscribe = meter.onReport((report) => {
    totalOverruns += report.overruns
    // Displayed scale tops out at 150% of budget -- past 100% the number
    // in the text already says "stuttering"; the bar only needs to show
    // "over," not exactly how far over.
    const displayFraction = Math.min(1, report.avgLoad / 1.5)
    fill.style.width = `${Math.round(displayFraction * 100)}%`
    fill.classList.toggle('cpu-meter-fill-hot', report.avgLoad >= HIGH_LOAD_THRESHOLD && report.avgLoad < OVERRUN_THRESHOLD)
    fill.classList.toggle('cpu-meter-fill-over', report.avgLoad >= OVERRUN_THRESHOLD)
    readout.textContent = readoutFor(report, totalOverruns)
    readout.title = `Average render load: ${(report.avgLoad * 100).toFixed(0)}% of budget over the last reporting window. ${totalOverruns} overrun${totalOverruns === 1 ? '' : 's'} since power-on.`
  })

  return {
    dispose() {
      unsubscribe()
    },
  }
}
