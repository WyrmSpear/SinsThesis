/**
 * Clock-division rate for a synced LFO.
 *
 * A hardware clocked LFO doesn't need to be told a BPM -- it just watches
 * the pulses on its sync input and measures the gap between them. That's
 * more modular than reading a BPM param off a specific Clock module (any
 * clock source works: this project's own `clock-module.ts`, a sequencer's
 * clock output, or one a player builds from an LFO and a comparator), and
 * it's what this file does: `updateSync` tracks the interval between rising
 * edges on a sync signal, `isSyncLocked` says whether that interval is
 * trustworthy right now, and `lockedRateHz` turns it into a concrete LFO
 * rate for one of fifteen musical divisions.
 *
 * The one assumption this makes, because there is no way to ask a bare
 * pulse train what it means: **the measured pulse period is treated as one
 * quarter note.** That matches this project's own Clock module at its
 * default `division = 1` (one pulse per beat, i.e. quarter notes in 4/4),
 * and it's the same assumption a hardware clocked LFO with a plain "sync
 * in" jack makes -- a clock that instead pulses eighth notes will make this
 * module's "1/4" division read as an eighth note, exactly as it would on
 * a piece of Eurorack gear fed the same signal.
 *
 * Three edge cases the caller (segment.worklet.ts's LfoProcessor) has to
 * live with, each handled here:
 *
 * - **The first pulse.** A single edge has no period to measure against --
 *   `periodSeconds` stays 0 (see `updateSync`) and `isSyncLocked` correctly
 *   reports false until a second edge arrives. Nothing glitches because
 *   nothing changes: the caller keeps using its Hz rate until locked.
 * - **A stopped clock.** Once too long has passed since the last edge
 *   (`isSyncLocked`'s timeout, sized off the last known period), lock is
 *   released and the caller falls back to Hz. This is also how "sync was
 *   never patched at all" resolves, for free: an input that never pulses
 *   never locks, which is indistinguishable from a clock that stopped
 *   before sample zero -- exactly the free-running behavior the LFO wants
 *   when nothing is patched.
 * - **A tempo change mid-note.** `updateSync` blends a freshly measured
 *   period into the running estimate (`PERIOD_SMOOTH`) rather than
 *   snapping to it, and the caller (see segment.worklet.ts) only hard-syncs
 *   phase on the edge where lock is *first acquired*, not on every pulse --
 *   so a tempo step eases the rate over several pulses instead of yanking
 *   the LFO's phase and rate on every single one.
 */

/** Sixteen positions for the LFO's `division` param: index 0 is "ignore the
 *  clock, use the Hz knob" (the module's original, still-default behavior);
 *  the other fifteen are the standard whole/half/quarter/eighth/sixteenth
 *  note values, each with a straight, triplet and dotted variant -- the
 *  same set a DAW's tempo-synced LFO offers. Short enough to read on an 8HP
 *  switch (this module already had to abbreviate "Triangle" -> "Tri" for
 *  the same column width -- see lfo.ts). */
export const DIVISION_LABELS = [
  'Free',
  '1/1', '1/1T', '1/1.',
  '1/2', '1/2T', '1/2.',
  '1/4', '1/4T', '1/4.',
  '1/8', '1/8T', '1/8.',
  '1/16', '1/16T', '1/16.',
] as const

/**
 * LFO period as a multiple of the measured (assumed-quarter-note) pulse
 * period: eighth notes (0.5) complete twice per pulse, half notes (2) take
 * two pulses each. Triplet = 2/3 of the straight value (three fit where two
 * would); dotted = 1.5x (a dot adds half the note's own value again) --
 * standard rhythm-value arithmetic, not tuned by ear.
 *
 * Index 0 ('Free') is never read -- the caller (segment.worklet.ts) routes
 * Free mode around this table entirely and uses the Hz `rate` param instead
 * -- so it holds NaN rather than a number that would look meaningful if
 * misused.
 */
export const DIVISION_MULTIPLIERS: readonly number[] = [
  NaN,
  4, (4 * 2) / 3, 4 * 1.5,
  2, (2 * 2) / 3, 2 * 1.5,
  1, (1 * 2) / 3, 1 * 1.5,
  0.5, (0.5 * 2) / 3, 0.5 * 1.5,
  0.25, (0.25 * 2) / 3, 0.25 * 1.5,
]

export interface SyncState {
  /** Seconds between the last two rising edges, smoothed (see
   *  PERIOD_SMOOTH). 0 until a second edge has ever been seen. */
  periodSeconds: number
  /** Samples since the last rising edge, or since state creation if there
   *  hasn't been one yet. Grows without bound while unpatched -- harmless,
   *  it only ever feeds a >= comparison in isSyncLocked. */
  samplesSinceEdge: number
  /** Previous sample's sync level, for edge detection. */
  prevLevel: number
}

export function createSyncState(): SyncState {
  return { periodSeconds: 0, samplesSinceEdge: Infinity, prevLevel: 0 }
}

/** Blend weight applied to a freshly measured period on every edge after
 *  the first: `next = prev + (measured - prev) * PERIOD_SMOOTH`. At 0.35,
 *  the estimate closes 35% of the remaining gap on every pulse, i.e. it
 *  decays geometrically at 0.65^n -- measured on a 120->174 BPM step
 *  (tests/node/dsp/clock-sync.test.ts's tempo-change suite): 45% error
 *  after the first post-change pulse, 12% after four, 2% after eight. That
 *  is slow enough that no single jittered pulse (a hand-tapped or sloppy
 *  clock) can snap the rate and produce the lurch this was built to avoid,
 *  and fast enough that the wobble is clearly sliding toward the new tempo
 *  within a couple of bars rather than visibly lagging behind a change the
 *  player can already hear. */
const PERIOD_SMOOTH = 0.35

/** How many missed periods before the clock is declared stopped, with a
 *  floor so a fast clock's tiny period doesn't make the timeout trigger-
 *  happy on ordinary jitter. Three periods is long enough that a clock
 *  which is merely running a little late (a laggy tick) never trips it,
 *  short enough that a genuinely stopped clock hands control back to the
 *  Hz knob within a second or so at any tempo this project's own Clock
 *  module can produce (20-300 BPM, i.e. 0.2-3s quarter-note periods).
 */
const STOPPED_PERIOD_MULTIPLE = 3
const STOPPED_FLOOR_SECONDS = 0.5

/**
 * Advance sync tracking by one sample. Call this every sample regardless of
 * whether the caller is currently in Free mode -- the period estimate
 * should never freeze just because the Rate knob's Hz mode happens to be
 * selected right now; otherwise switching into a division mode mid-patch
 * would have to wait through the same "first pulse" cold start it would
 * from silence, even with a clock that's been running the whole time.
 */
export function updateSync(state: SyncState, level: number, sampleRate: number): void {
  const rising = level >= 0.5 && state.prevLevel < 0.5
  state.prevLevel = level

  if (rising) {
    // First-ever pulse: nothing to measure a period against yet. Recorded
    // only so the *second* pulse has a start point -- periodSeconds stays
    // 0, so isSyncLocked correctly reports "not locked" until then.
    if (Number.isFinite(state.samplesSinceEdge)) {
      const measured = state.samplesSinceEdge / sampleRate
      state.periodSeconds = state.periodSeconds === 0
        ? measured // first-ever measurement: adopt outright, nothing to blend from
        : state.periodSeconds + (measured - state.periodSeconds) * PERIOD_SMOOTH
    }
    state.samplesSinceEdge = 0
  } else {
    state.samplesSinceEdge += 1
  }
}

/**
 * True when the measured period is recent enough to trust. False before the
 * second-ever pulse (nothing measured yet) and false again once the clock
 * has gone quiet for a few periods -- stopped, or the sync input was never
 * patched at all, which looks identical to "stopped since sample zero" and
 * resolves to the same free-running-Hz fallback either way.
 */
export function isSyncLocked(state: SyncState, sampleRate: number): boolean {
  if (state.periodSeconds <= 0) return false
  const timeoutSeconds = Math.max(state.periodSeconds * STOPPED_PERIOD_MULTIPLE, STOPPED_FLOOR_SECONDS)
  return state.samplesSinceEdge / sampleRate <= timeoutSeconds
}

/**
 * The LFO rate implied by the current locked period and a division index
 * into DIVISION_LABELS/DIVISION_MULTIPLIERS. Callers should only trust this
 * while isSyncLocked is true -- it happily returns a (finite, nonsensical)
 * number otherwise rather than throwing, since there's no invalid input
 * here to reject, but the result is meaningless before a period is known.
 * divisionIndex 0 ('Free') is the caller's responsibility to route around;
 * see the module doc comment.
 */
export function lockedRateHz(state: SyncState, divisionIndex: number): number {
  const multiplier = DIVISION_MULTIPLIERS[divisionIndex] ?? 1
  return 1 / (state.periodSeconds * multiplier)
}
