/**
 * Pan Paddle -- the arcade layer's pure game logic. No DOM, no Web Audio,
 * no canvas: this module only knows about numbers, so it is testable from
 * plain node (`tests/node/arcade-game.test.ts`) the same way
 * `src/engine/analysis` is, and it is the file `rack/arcade-panel.ts`
 * drives from a `requestAnimationFrame` loop -- see that file's own doc
 * comment for why the split exists (ROADMAP 3a's "the game loop must not
 * fight the audio thread" non-negotiable, and the project's existing
 * convention of keeping pure logic separate from rendering, e.g.
 * `academy/levels.ts` versus `rack/academy-panel.ts`).
 *
 * Units are game pixels, 0 at the left/top of a `config.width` x
 * `config.height` playfield -- the same coordinate system
 * `rack/arcade-panel.ts`'s canvas draws in 1:1, so nothing here needs a
 * second unit system translated at render time.
 */

export interface Block {
  readonly id: number
  /** Center x, in game pixels. */
  readonly x: number
  /** Top y, in game pixels. Negative when just spawned, above the visible
   *  playfield. */
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface GameConfig {
  readonly width: number
  readonly height: number
  readonly paddleWidth: number
  readonly paddleHeight: number
  /** Top y of the paddle's catch band. */
  readonly paddleY: number
  /** Exponential-follow rate, in 1/seconds, the paddle chases its
   *  commanded target with. Not instantaneous on purpose: the stereo
   *  balance read driving `paddleTarget` is a per-buffer RMS measurement
   *  (see `rack/arcade-panel.ts`), which carries a little sample-to-sample
   *  jitter even from a rock-steady patch -- a small time constant
   *  (`1/paddleFollow` seconds) absorbs that jitter without adding
   *  perceptible lag, the same tradeoff `scheduleParam`'s param-smoothing
   *  makes for knob turns elsewhere in this codebase. */
  readonly paddleFollow: number
  /** Fall speed, px/sec, at the very start of a run (difficulty 1x). */
  readonly baseFallSpeed: number
  /** Milliseconds between spawns at difficulty 1x. */
  readonly spawnIntervalMs: number
  /** Fractional speed/spawn-rate increase per second survived -- the whole
   *  difficulty ramp. 0.05 means 5% faster, and 5% more frequent spawns,
   *  for every second the player survives. */
  readonly rampPerSecond: number
  readonly livesStart: number
  readonly blockWidth: number
  readonly blockHeight: number
}

export interface GameState {
  readonly config: GameConfig
  /** Paddle center x, in game pixels -- smoothed, see `paddleFollow`. */
  readonly paddleX: number
  /** The most recent commanded target, in game pixels, before smoothing --
   *  kept for tests and for a "ghost target" render hint. */
  readonly targetX: number
  readonly blocks: readonly Block[]
  readonly score: number
  readonly lives: number
  readonly elapsedMs: number
  readonly nextSpawnInMs: number
  readonly nextBlockId: number
  readonly status: 'playing' | 'gameover'
  /** Set for exactly the step a catch or miss happened on, `undefined`
   *  otherwise -- a one-frame event `rack/arcade-panel.ts` can hook a
   *  flash or a sound cue off of without re-deriving it by diffing score. */
  readonly lastEvent: 'catch' | 'miss' | undefined
}

export function defaultConfig(width: number, height: number): GameConfig {
  return {
    width,
    height,
    paddleWidth: 90,
    paddleHeight: 14,
    paddleY: height - 40,
    paddleFollow: 16,
    // Tuned by actually playing it (see .superpowers/sdd/pan-paddle-report.md),
    // not picked in the abstract. The first pass (fallSpeed 90, interval
    // 1400ms) felt unwinnable even under continuous, attentive control: the
    // ratio (time a block takes to fall) / (time between spawns) is roughly
    // constant across the whole run, since the difficulty ramp multiplies
    // both fall speed and spawn cadence by the same factor -- so whatever
    // that ratio is at the start is how many blocks are in the air at once
    // for the *entire game*, not just late. At the first pass's numbers it
    // was ~4 simultaneous blocks for a single paddle, which is a different,
    // harder game (triage, not catch) than the brief asked for ("Breakout
    // rather than Tetris -- bouncing, not stacking"). These numbers hold
    // that ratio near 1: usually one block in flight, occasionally two.
    baseFallSpeed: 160,
    spawnIntervalMs: 2300,
    rampPerSecond: 0.06,
    // 3 felt too punishing stacked on top of the crowding bug above -- a
    // brand-new player's first several misses while still learning where
    // their own stereo image actually sits (the panner's screen position
    // isn't a 1:1 visual cue the way a mouse cursor is) shouldn't be the
    // whole game. 4 buys one more.
    livesStart: 4,
    blockWidth: 56,
    blockHeight: 18,
  }
}

export function createGame(config: GameConfig): GameState {
  return {
    config,
    paddleX: config.width / 2,
    targetX: config.width / 2,
    blocks: [],
    score: 0,
    lives: config.livesStart,
    elapsedMs: 0,
    nextSpawnInMs: config.spawnIntervalMs,
    nextBlockId: 0,
    status: 'playing',
    lastEvent: undefined,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Deterministic given `rng`, so tests can pass a fixed generator instead
 *  of `Math.random` and get reproducible spawn positions. */
function spawnBlock(config: GameConfig, id: number, rng: () => number): Block {
  const halfW = config.blockWidth / 2
  const x = halfW + rng() * (config.width - config.blockWidth)
  return { id, x, y: -config.blockHeight, width: config.blockWidth, height: config.blockHeight }
}

/**
 * Advances the game by `dtMs` of wall-clock time, given the paddle's
 * commanded position for this frame (`paddleTarget`, -1..1, the same
 * range `rack/arcade-panel.ts` reads the measured stereo balance into --
 * see that file for where the number actually comes from).
 *
 * Pure: returns a new `GameState`, never mutates the one it was given, so
 * a caller (a rAF loop, or a test driving many steps in a row) can hold
 * onto an old state for comparison.
 *
 * `rng` defaults to `Math.random` for real play; tests override it to make
 * spawn positions reproducible.
 */
export function stepGame(
  state: GameState,
  dtMs: number,
  paddleTarget: number,
  rng: () => number = Math.random,
): GameState {
  if (state.status === 'gameover') return state.lastEvent === undefined ? state : { ...state, lastEvent: undefined }

  const cfg = state.config
  const dt = dtMs / 1000
  const elapsedMs = state.elapsedMs + dtMs
  // The whole difficulty ramp: one multiplier, applied to both fall speed
  // and spawn cadence, growing linearly with seconds survived. Deliberately
  // simple -- ROADMAP 3a's brief for this prototype says "ramping speed is
  // enough."
  const speedMul = 1 + (elapsedMs / 1000) * cfg.rampPerSecond

  const clampedTarget = clamp(paddleTarget, -1, 1)
  const targetX = ((clampedTarget + 1) / 2) * cfg.width
  const follow = 1 - Math.exp(-cfg.paddleFollow * dt)
  const halfPaddle = cfg.paddleWidth / 2
  const paddleX = clamp(state.paddleX + (targetX - state.paddleX) * follow, halfPaddle, cfg.width - halfPaddle)

  const paddleLeft = paddleX - halfPaddle
  const paddleRight = paddleX + halfPaddle

  let score = state.score
  let lives = state.lives
  let lastEvent: 'catch' | 'miss' | undefined
  const remaining: Block[] = []

  for (const b of state.blocks) {
    const moved: Block = { ...b, y: b.y + cfg.baseFallSpeed * speedMul * dt }
    const blockBottom = moved.y + moved.height
    const blockLeft = moved.x - moved.width / 2
    const blockRight = moved.x + moved.width / 2
    const inPaddleBand = blockBottom >= cfg.paddleY && moved.y <= cfg.paddleY + cfg.paddleHeight
    const overlapsX = blockRight > paddleLeft && blockLeft < paddleRight

    if (inPaddleBand && overlapsX) {
      score++
      lastEvent = 'catch'
      continue // caught -- removed from play
    }
    if (moved.y > cfg.height) {
      lives--
      lastEvent = 'miss'
      continue // fell past the paddle -- removed from play
    }
    remaining.push(moved)
  }

  let nextSpawnInMs = state.nextSpawnInMs - dtMs
  let nextBlockId = state.nextBlockId
  if (nextSpawnInMs <= 0) {
    remaining.push(spawnBlock(cfg, nextBlockId, rng))
    nextBlockId++
    nextSpawnInMs += cfg.spawnIntervalMs / speedMul
  }

  const status: GameState['status'] = lives <= 0 ? 'gameover' : 'playing'

  return {
    config: cfg,
    paddleX,
    targetX,
    blocks: remaining,
    score,
    lives,
    elapsedMs,
    nextSpawnInMs,
    nextBlockId,
    status,
    lastEvent,
  }
}
