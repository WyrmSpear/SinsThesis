import { describe, it, expect } from 'vitest'
import { createGame, stepGame, defaultConfig, type GameConfig, type GameState } from '../../arcade/game'

/**
 * Pure-logic coverage for the pan-paddle arcade game
 * (ROADMAP 3a/`arcade/game.ts`) -- collision, scoring and the difficulty
 * ramp, with no canvas and no Web Audio in sight, the same split
 * `academy/levels.ts` vs `rack/academy-panel.ts` already draws. `rng` is
 * pinned in every test that spawns a block so positions are reproducible.
 */

function fixedRng(value: number): () => number {
  return () => value
}

describe('arcade/game: setup', () => {
  it('starts centered, empty, at full lives, playing', () => {
    const cfg = defaultConfig(400, 500)
    const state = createGame(cfg)
    expect(state.paddleX).toBe(200)
    expect(state.blocks).toEqual([])
    expect(state.score).toBe(0)
    expect(state.lives).toBe(cfg.livesStart)
    expect(state.status).toBe('playing')
  })
})

describe('arcade/game: paddle follow', () => {
  it('chases the commanded target smoothly, not instantly', () => {
    const cfg = defaultConfig(400, 500)
    let state = createGame(cfg)
    // Command full-right (+1 -> x = 400) and take one small step.
    state = stepGame(state, 16, 1, fixedRng(0.5))
    expect(state.paddleX).toBeGreaterThan(200) // moved toward target
    expect(state.paddleX).toBeLessThan(400) // but hasn't arrived in one frame
  })

  it('converges close to the target after many steps', () => {
    const cfg = defaultConfig(400, 500)
    let state = createGame(cfg)
    for (let i = 0; i < 60; i++) state = stepGame(state, 16, 1, fixedRng(0.5))
    // Clamped just inside the right wall by half the paddle's own width.
    expect(state.paddleX).toBeGreaterThan(cfg.width - cfg.paddleWidth / 2 - 5)
  })

  it('clamps the paddle inside the playfield', () => {
    const cfg = defaultConfig(400, 500)
    let state = createGame(cfg)
    for (let i = 0; i < 120; i++) state = stepGame(state, 16, -1, fixedRng(0.5))
    expect(state.paddleX).toBeGreaterThanOrEqual(cfg.paddleWidth / 2)
    expect(state.paddleX).toBeLessThanOrEqual(cfg.width - cfg.paddleWidth / 2)
  })
})

function stateWithOneBlock(cfg: GameConfig, block: Partial<GameState['blocks'][number]>): GameState {
  const base = createGame(cfg)
  return {
    ...base,
    // Long enough that the test's own steps never trigger a spawn, so the
    // block under test is the only thing moving.
    nextSpawnInMs: 60_000,
    blocks: [{ id: 0, x: cfg.width / 2, y: 0, width: cfg.blockWidth, height: cfg.blockHeight, ...block }],
  }
}

describe('arcade/game: collision', () => {
  it('registers a catch when a block reaches the paddle band over the paddle', () => {
    const cfg = defaultConfig(400, 500)
    // Paddle starts centered under the block's x. Place the block right at
    // the top edge of the catch band already, so one small step lands it
    // inside the band without needing to simulate the whole fall.
    const state = stateWithOneBlock(cfg, { x: 200, y: cfg.paddleY - 1 })
    const next = stepGame(state, 16, 0, fixedRng(0.5))
    expect(next.lastEvent).toBe('catch')
    expect(next.score).toBe(1)
    expect(next.blocks.length).toBe(0)
    expect(next.lives).toBe(cfg.livesStart) // a catch costs no life
  })

  it('does not register a catch when the block misses the paddle horizontally', () => {
    const cfg = defaultConfig(400, 500)
    // Paddle commanded hard right; block stays over the left edge.
    let state = stateWithOneBlock(cfg, { x: 20, y: cfg.paddleY - 1 })
    state = stepGame(state, 16, 1, fixedRng(0.5))
    expect(state.lastEvent).not.toBe('catch')
    expect(state.score).toBe(0)
  })

  it('registers a miss and loses a life once a block passes the bottom', () => {
    const cfg = defaultConfig(400, 500)
    const state = stateWithOneBlock(cfg, { x: 200, y: cfg.height + 1 })
    const next = stepGame(state, 16, 0, fixedRng(0.5))
    expect(next.lastEvent).toBe('miss')
    expect(next.lives).toBe(cfg.livesStart - 1)
    expect(next.blocks.length).toBe(0)
    expect(next.score).toBe(0)
  })

  it('ends the game once lives reach zero, and freezes further updates', () => {
    const cfg = { ...defaultConfig(400, 500), livesStart: 1 }
    const state = stateWithOneBlock(cfg, { x: 200, y: cfg.height + 1 })
    const afterMiss = stepGame(state, 16, 0, fixedRng(0.5))
    expect(afterMiss.status).toBe('gameover')
    expect(afterMiss.lives).toBe(0)

    const frozen = stepGame(afterMiss, 1000, 1, fixedRng(0.5))
    expect(frozen.score).toBe(afterMiss.score)
    expect(frozen.lives).toBe(afterMiss.lives)
    expect(frozen.paddleX).toBe(afterMiss.paddleX)
    expect(frozen.status).toBe('gameover')
  })
})

describe('arcade/game: spawning', () => {
  it('spawns nothing before the configured interval elapses', () => {
    const cfg = defaultConfig(400, 500)
    let state = createGame(cfg)
    state = stepGame(state, cfg.spawnIntervalMs - 10, 0, fixedRng(0.5))
    expect(state.blocks.length).toBe(0)
  })

  it('spawns a block once the interval elapses, at a reproducible x for a fixed rng', () => {
    const cfg = defaultConfig(400, 500)
    let state = createGame(cfg)
    state = stepGame(state, cfg.spawnIntervalMs, 0, fixedRng(0.5))
    expect(state.blocks.length).toBe(1)
    expect(state.blocks[0]!.x).toBeCloseTo(cfg.width / 2, 5)
    expect(state.blocks[0]!.y).toBe(-cfg.blockHeight)
  })
})

describe('arcade/game: difficulty ramp', () => {
  it('makes blocks fall faster the longer the run survives', () => {
    const cfg = { ...defaultConfig(400, 500), rampPerSecond: 0.5 } // exaggerated for a clear measurement
    const early = stateWithOneBlock(cfg, { x: 200, y: 0 })
    const earlyNext = stepGame(early, 100, 0, fixedRng(0.5))
    const earlyDelta = earlyNext.blocks[0]!.y - 0

    // Same block, but the state claims 20 simulated seconds have already
    // elapsed -- only the ramp should differ, not the step itself.
    const late = { ...stateWithOneBlock(cfg, { x: 200, y: 0 }), elapsedMs: 20_000 }
    const lateNext = stepGame(late, 100, 0, fixedRng(0.5))
    const lateDelta = lateNext.blocks[0]!.y - 0

    expect(lateDelta).toBeGreaterThan(earlyDelta)
  })

  it('re-schedules the next spawn sooner once the ramp has picked up speed', () => {
    const cfg = { ...defaultConfig(400, 500), rampPerSecond: 0.5 }

    // Drive an early-game spawn (elapsedMs near 0, speedMul near 1) and
    // read how far out the *next* spawn was scheduled.
    let early = createGame(cfg)
    early = stepGame(early, cfg.spawnIntervalMs, 0, fixedRng(0.5))
    const earlyNextSpawn = early.nextSpawnInMs

    // Same trigger, but 20 simulated seconds further into the ramp
    // (speedMul = 1 + 20*0.5 = 11x) -- only the ramp should differ.
    let late = { ...createGame(cfg), elapsedMs: 20_000 }
    late = stepGame(late, cfg.spawnIntervalMs, 0, fixedRng(0.5))
    const lateNextSpawn = late.nextSpawnInMs

    expect(lateNextSpawn).toBeLessThan(earlyNextSpawn)
  })
})
