/**
 * Wub Disruptor -- ROADMAP 3a's second arcade prototype, pure game logic.
 * Same split the pan paddle established (`arcade/game.ts`'s own header
 * comment): no DOM, no Web Audio, just numbers, so this is node-testable
 * from plain node (`tests/node/arcade-wub-game.test.ts`) and is the file
 * `rack/wub-panel.ts` drives from a `requestAnimationFrame` loop.
 *
 * **The mechanic.** A target calls for a specific modulation rate (a
 * musical clock division, e.g. an eighth note) and communicates it by
 * pulsing at that rate -- no text, `rack/wub-panel.ts`'s own concern, not
 * this file's. The player sets up an LFO into filter cutoff (or achieves
 * the same wobble any other way -- see `arcade/rate-detect.ts`'s header
 * comment) and tunes its rate to match. Sustained lock -- not a single
 * lucky frame -- destroys the target; running out of time before locking
 * it lets it escape and costs a life.
 *
 * **Why only one target is ever active at a time.** This is not a
 * simplification made for pacing -- it's a consequence of what's actually
 * being measured. `arcade/rate-detect.ts` reads *one* modulation rate off
 * the *whole* mixed output; there is no way to ask "which of two
 * simultaneous targets' rates is the player currently playing" any more
 * than the pan paddle could steer toward two stereo positions at once. A
 * later version could let same-rate targets share a hit (a "combo"), but
 * two different-rate targets on screen together would need a second,
 * independent measurement of a *single* audio stream, which doesn't exist.
 *
 * **Why a target's lifetime depends on its own required rate.**
 * `arcade/rate-detect.ts` needs a window covering at least a couple of
 * modulation cycles before it can report anything at all -- a half-note
 * (1 Hz) target is physically unconfirmable in under a couple of seconds,
 * no matter how fast the player's reflexes are. `targetLifetimeMs` below
 * bakes that floor in per rate rather than fighting it with a flat
 * deadline every target would share.
 */

export interface WubConfig {
  readonly width: number
  readonly height: number
  readonly targetRadius: number
  /** The musical rates a target can call for, Hz -- half note, quarter,
   *  quarter triplet, eighth, eighth triplet at a nominal 120 BPM (the
   *  same quarter-note-period assumption `dsp/clock-sync.ts` makes for a
   *  tempo-synced LFO). Deliberately excludes anything faster (a sixteenth
   *  note and up): `arcade/rate-detect.ts`'s own accuracy measurement
   *  (`tests/node/arcade-rate-detect.test.ts`) is against exactly this
   *  set, and pushing the top end higher starts eating into
   *  `toleranceHz`'s safety margin against the frame-rate quantization
   *  error documented there. */
  readonly requiredRatesHz: readonly number[]
  /** How close a measured rate has to land to a target's `requiredHz` to
   *  count as "locked in," Hz. Set by measurement
   *  (`tests/node/arcade-rate-detect.test.ts`'s "correct vs.
   *  plausibly-wrong" suite, confirmed against real filtered audio by
   *  `tests/browser/wub-rate-detect.test.ts`): the detector's own worst
   *  measured error recovering a *correct* rate is under 0.2 Hz, and the
   *  smallest gap a *neighboring* musical division ever produces is over
   *  0.4 Hz. 0.35 sits in that gap with margin on both sides. */
  readonly toleranceHz: number
  /** Milliseconds of *sustained* lock (not one lucky frame) needed to
   *  destroy a target once the detector is reporting a confident, in-
   *  tolerance rate. */
  readonly chargeMsToDestroy: number
  /** Charge drains this many times faster than it fills whenever the
   *  measured rate drifts out of tolerance (or nothing is confidently
   *  detected) -- losing the pocket costs more than holding it gains, so a
   *  player can't win by drifting in and out of range and banking the
   *  in-range fragments. */
  readonly chargeDecayMultiple: number
  /** Extra reaction time folded into every target's lifetime on top of
   *  the physical detection floor -- time to notice a new target's pulse
   *  rate and start tuning toward it, before the detector even has a full
   *  window of the *correct* rate to measure. */
  readonly reactionMs: number
  /** How many of a target's own modulation cycles its lifetime budget
   *  holds beyond the reaction allowance -- covers the detector's window
   *  fill (`arcade/rate-detect.ts` needs a couple of cycles before it
   *  reports anything) plus room to actually accumulate
   *  `chargeMsToDestroy` once locked, not just confirm the rate once. */
  readonly lifetimeCycles: number
  /** Lifetime never drops below this regardless of rate or difficulty
   *  ramp -- a floor under the fastest target at the steepest ramp. */
  readonly lifetimeFloorMs: number
  /** Gap between a target being cleared (destroyed or escaped) and the
   *  next one spawning, at difficulty 1x. */
  readonly interTargetDelayMs: number
  /** Fractional increase per second survived, applied to spawn cadence
   *  (shorter gaps) and inversely to lifetime (less time per target) --
   *  the same single-multiplier ramp `arcade/game.ts`'s `rampPerSecond`
   *  uses, never pushed below `lifetimeFloorMs`. */
  readonly rampPerSecond: number
  readonly livesStart: number
}

export interface Target {
  readonly id: number
  readonly x: number
  readonly y: number
  readonly requiredHz: number
  readonly lifetimeMs: number
  readonly ageMs: number
  /** 0..config.chargeMsToDestroy. */
  readonly chargeMs: number
}

export interface WubState {
  readonly config: WubConfig
  readonly target: Target | undefined
  readonly score: number
  readonly lives: number
  readonly elapsedMs: number
  readonly nextSpawnInMs: number
  readonly nextTargetId: number
  readonly status: 'playing' | 'gameover'
  /** Set for exactly the step a destroy or escape happened on, the same
   *  one-frame-event contract `arcade/game.ts`'s `lastEvent` documents. */
  readonly lastEvent: 'destroyed' | 'escaped' | undefined
}

export function defaultConfig(width: number, height: number): WubConfig {
  return {
    width,
    height,
    targetRadius: 46,
    requiredRatesHz: [1, 2, 2.667, 4, 5.333],
    toleranceHz: 0.35,
    chargeMsToDestroy: 700,
    chargeDecayMultiple: 2,
    reactionMs: 1500,
    lifetimeCycles: 8,
    lifetimeFloorMs: 4000,
    interTargetDelayMs: 900,
    rampPerSecond: 0.04,
    livesStart: 4,
  }
}

/** A target's full lifetime budget at difficulty 1x -- see `lifetimeCycles`
 *  and `reactionMs`'s own doc comments for what each term covers. */
function baseLifetimeMs(cfg: WubConfig, requiredHz: number): number {
  return cfg.reactionMs + cfg.lifetimeCycles * (1000 / requiredHz)
}

/** Deterministic given `rng`, so tests can pass a fixed generator and get
 *  reproducible target placement/rate, the same convention
 *  `arcade/game.ts`'s `spawnBlock` uses. */
function spawnTarget(cfg: WubConfig, id: number, speedMul: number, rng: () => number): Target {
  const r = cfg.targetRadius
  const x = r + rng() * (cfg.width - 2 * r)
  const y = r + rng() * (cfg.height - 2 * r)
  const requiredHz = cfg.requiredRatesHz[Math.floor(rng() * cfg.requiredRatesHz.length)]!
  const lifetimeMs = Math.max(cfg.lifetimeFloorMs, baseLifetimeMs(cfg, requiredHz) / speedMul)
  return { id, x, y, requiredHz, lifetimeMs, ageMs: 0, chargeMs: 0 }
}

export function createGame(config: WubConfig): WubState {
  return {
    config,
    target: undefined,
    score: 0,
    lives: config.livesStart,
    elapsedMs: 0,
    nextSpawnInMs: 0,
    nextTargetId: 0,
    status: 'playing',
    lastEvent: undefined,
  }
}

/**
 * Advances the game by `dtMs`, given this frame's rate measurement.
 * `measuredHz`/`confidence` are exactly `arcade/rate-detect.ts`'s
 * `RateEstimate` shape, split into two args (rather than an optional
 * struct) so a caller with no lock at all can just pass `undefined` for
 * `measuredHz` without also constructing a dummy confidence.
 *
 * Pure: returns a new `WubState`, never mutates the one it was given --
 * same contract as `arcade/game.ts`'s `stepGame`.
 */
export function stepWub(
  state: WubState,
  dtMs: number,
  measuredHz: number | undefined,
  confidence: number,
  lockConfidence: number,
  rng: () => number = Math.random,
): WubState {
  if (state.status === 'gameover') return state.lastEvent === undefined ? state : { ...state, lastEvent: undefined }

  const cfg = state.config
  const elapsedMs = state.elapsedMs + dtMs
  const speedMul = 1 + (elapsedMs / 1000) * cfg.rampPerSecond

  let target = state.target
  let score = state.score
  let lives = state.lives
  let lastEvent: WubState['lastEvent']
  let justCleared = false

  if (target) {
    const ageMs = target.ageMs + dtMs
    const inTolerance =
      measuredHz !== undefined && confidence >= lockConfidence && Math.abs(measuredHz - target.requiredHz) <= cfg.toleranceHz
    const chargeMs = inTolerance
      ? Math.min(cfg.chargeMsToDestroy, target.chargeMs + dtMs)
      : Math.max(0, target.chargeMs - dtMs * cfg.chargeDecayMultiple)

    if (chargeMs >= cfg.chargeMsToDestroy) {
      score++
      lastEvent = 'destroyed'
      target = undefined
      justCleared = true
    } else if (ageMs >= target.lifetimeMs) {
      lives--
      lastEvent = 'escaped'
      target = undefined
      justCleared = true
    } else {
      target = { ...target, ageMs, chargeMs }
    }
  }

  // `nextSpawnInMs` only counts down while there is no target on screen --
  // it means "time left in the *gap after* a target clears," not a
  // free-running clock. Counting it down unconditionally (including while
  // a target is alive and being fought) would let it go arbitrarily
  // negative over a long fight and make the *next* target spawn instantly
  // the moment this one clears, defeating `interTargetDelayMs` entirely --
  // caught by tests/node/arcade-wub-game.test.ts stepping frame-by-frame
  // through a real target's lifetime rather than in one large jump.
  let nextSpawnInMs = state.nextSpawnInMs
  if (justCleared) {
    nextSpawnInMs = cfg.interTargetDelayMs / speedMul
  } else if (!target) {
    nextSpawnInMs -= dtMs
  }
  let nextTargetId = state.nextTargetId
  if (!target && nextSpawnInMs <= 0) {
    target = spawnTarget(cfg, nextTargetId, speedMul, rng)
    nextTargetId++
  }

  const status: WubState['status'] = lives <= 0 ? 'gameover' : 'playing'

  return {
    config: cfg,
    target,
    score,
    lives,
    elapsedMs,
    nextSpawnInMs,
    nextTargetId,
    status,
    lastEvent,
  }
}
