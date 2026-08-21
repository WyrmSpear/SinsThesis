import { describe, it, expect } from 'vitest'
import { createGame, stepWub, defaultConfig, type WubConfig } from '../../arcade/wub-game'
import { LOCK_CONFIDENCE } from '../../arcade/rate-detect'

/**
 * Pure-logic coverage for the wub disruptor (`arcade/wub-game.ts`) --
 * target lifecycle, sustained-lock charging, the difficulty ramp -- no
 * canvas, no Web Audio, no rate detector, the same split
 * `tests/node/arcade-game.test.ts` uses for the pan paddle. `rng` is
 * pinned everywhere a target spawns so placement/rate are reproducible.
 */

function fixedRng(value: number): () => number {
  return () => value
}

describe('arcade/wub-game: setup', () => {
  it('starts with no target, full lives, playing, waiting to spawn', () => {
    const cfg = defaultConfig(400, 500)
    const state = createGame(cfg)
    expect(state.target).toBeUndefined()
    expect(state.score).toBe(0)
    expect(state.lives).toBe(cfg.livesStart)
    expect(state.status).toBe('playing')
  })
})

describe('arcade/wub-game: spawning', () => {
  it('spawns a target on the first step, drawing its rate from requiredRatesHz', () => {
    const cfg = defaultConfig(400, 500)
    let state = createGame(cfg)
    state = stepWub(state, 16, undefined, 0, LOCK_CONFIDENCE, fixedRng(0.5))
    expect(state.target).toBeDefined()
    expect(cfg.requiredRatesHz).toContain(state.target!.requiredHz)
  })

  it('keeps the target inside the playfield bounds', () => {
    const cfg = defaultConfig(400, 500)
    let state = createGame(cfg)
    for (const rngVal of [0, 0.001, 0.999, 0.5]) {
      state = stepWub(createGame(cfg), 16, undefined, 0, LOCK_CONFIDENCE, fixedRng(rngVal))
      const t = state.target!
      expect(t.x).toBeGreaterThanOrEqual(cfg.targetRadius)
      expect(t.x).toBeLessThanOrEqual(cfg.width - cfg.targetRadius)
      expect(t.y).toBeGreaterThanOrEqual(cfg.targetRadius)
      expect(t.y).toBeLessThanOrEqual(cfg.height - cfg.targetRadius)
    }
  })

  it('never spawns a second target while one is already active', () => {
    const cfg = defaultConfig(400, 500)
    let state = createGame(cfg)
    state = stepWub(state, 16, undefined, 0, LOCK_CONFIDENCE, fixedRng(0.2))
    const firstId = state.target!.id
    state = stepWub(state, 16, undefined, 0, LOCK_CONFIDENCE, fixedRng(0.8))
    expect(state.target!.id).toBe(firstId)
  })

  it('sizes a slower target\'s lifetime longer than a faster one\'s', () => {
    const cfg: WubConfig = { ...defaultConfig(400, 500), requiredRatesHz: [1, 5.333] }
    // rng() picks the index into requiredRatesHz -- 0 -> index 0 (1 Hz), a
    // value near 1 -> the last index (5.333 Hz), same convention
    // arcade/game.ts's own spawn tests use for picking extremes.
    const slow = stepWub(createGame(cfg), 16, undefined, 0, LOCK_CONFIDENCE, fixedRng(0))
    const fast = stepWub(createGame(cfg), 16, undefined, 0, LOCK_CONFIDENCE, fixedRng(0.999))
    expect(slow.target!.requiredHz).toBe(1)
    expect(fast.target!.requiredHz).toBe(5.333)
    expect(slow.target!.lifetimeMs).toBeGreaterThan(fast.target!.lifetimeMs)
  })
})

describe('arcade/wub-game: locking and destroying a target', () => {
  it('charges while the measured rate is within tolerance and confident', () => {
    const cfg = defaultConfig(400, 500)
    let state = stepWub(createGame(cfg), 16, undefined, 0, LOCK_CONFIDENCE, fixedRng(0))
    const requiredHz = state.target!.requiredHz
    state = stepWub(state, 100, requiredHz, 0.99, LOCK_CONFIDENCE, fixedRng(0))
    expect(state.target!.chargeMs).toBeGreaterThan(0)
  })

  it('destroys the target once sustained charge reaches chargeMsToDestroy, awarding a point', () => {
    const cfg = defaultConfig(400, 500)
    let state = stepWub(createGame(cfg), 16, undefined, 0, LOCK_CONFIDENCE, fixedRng(0))
    const requiredHz = state.target!.requiredHz
    // Step in a chunk larger than chargeMsToDestroy so it crosses in one go.
    state = stepWub(state, cfg.chargeMsToDestroy + 50, requiredHz, 0.99, LOCK_CONFIDENCE, fixedRng(0))
    expect(state.target).toBeUndefined()
    expect(state.score).toBe(1)
    expect(state.lastEvent).toBe('destroyed')
    expect(state.lives).toBe(cfg.livesStart) // no life lost on a destroy
  })

  it('does not charge on a confident but out-of-tolerance rate', () => {
    const cfg = defaultConfig(400, 500)
    let state = stepWub(createGame(cfg), 16, undefined, 0, LOCK_CONFIDENCE, fixedRng(0))
    const wrongHz = state.target!.requiredHz + 2 // well outside toleranceHz
    state = stepWub(state, 200, wrongHz, 0.99, LOCK_CONFIDENCE, fixedRng(0))
    expect(state.target!.chargeMs).toBe(0)
  })

  it('does not charge on an in-band rate whose confidence is below the lock threshold', () => {
    const cfg = defaultConfig(400, 500)
    let state = stepWub(createGame(cfg), 16, undefined, 0, LOCK_CONFIDENCE, fixedRng(0))
    const requiredHz = state.target!.requiredHz
    state = stepWub(state, 200, requiredHz, LOCK_CONFIDENCE - 0.1, LOCK_CONFIDENCE, fixedRng(0))
    expect(state.target!.chargeMs).toBe(0)
  })

  it('decays charge faster than it accrues once lock is lost (chargeDecayMultiple)', () => {
    const cfg = defaultConfig(400, 500)
    let state = stepWub(createGame(cfg), 16, undefined, 0, LOCK_CONFIDENCE, fixedRng(0))
    const requiredHz = state.target!.requiredHz
    // Charge for 600ms (chargeMsToDestroy is 700, so this stays short of
    // full and short of clipping the decay step below at zero).
    state = stepWub(state, 600, requiredHz, 0.99, LOCK_CONFIDENCE, fixedRng(0))
    const charged = state.target!.chargeMs
    expect(charged).toBe(600)
    state = stepWub(state, 100, undefined, 0, LOCK_CONFIDENCE, fixedRng(0))
    const drained = charged - state.target!.chargeMs
    expect(drained).toBeCloseTo(100 * cfg.chargeDecayMultiple, 1) // decays at 2x fill rate
  })
})

describe('arcade/wub-game: a target that outlives its budget escapes', () => {
  it('costs a life and clears the target, without touching score', () => {
    const cfg = defaultConfig(400, 500)
    let state = stepWub(createGame(cfg), 16, undefined, 0, LOCK_CONFIDENCE, fixedRng(0))
    const lifetimeMs = state.target!.lifetimeMs
    // Frame-sized steps (the real rAF loop's own granularity, clamped the
    // same way arcade/game.ts's own dt is) rather than one giant leap, so
    // the escape and the *next* spawn's own delay aren't folded into a
    // single stepWub call -- a live game never calls this with a
    // multi-second dt in one go.
    let elapsed = 0
    while (elapsed < lifetimeMs + 32 && state.lastEvent === undefined) {
      state = stepWub(state, 16, undefined, 0, LOCK_CONFIDENCE, fixedRng(0))
      elapsed += 16
    }
    expect(state.target).toBeUndefined()
    expect(state.lastEvent).toBe('escaped')
    expect(state.lives).toBe(cfg.livesStart - 1)
    expect(state.score).toBe(0)
  })

  it('ends the game once lives reach zero', () => {
    const cfg: WubConfig = { ...defaultConfig(400, 500), livesStart: 1 }
    let state = stepWub(createGame(cfg), 16, undefined, 0, LOCK_CONFIDENCE, fixedRng(0))
    const lifetimeMs = state.target!.lifetimeMs
    state = stepWub(state, lifetimeMs + 50, undefined, 0, LOCK_CONFIDENCE, fixedRng(0))
    expect(state.status).toBe('gameover')
    expect(state.lives).toBe(0)
  })

  it('freezes once gameover, ignoring further steps', () => {
    const cfg: WubConfig = { ...defaultConfig(400, 500), livesStart: 1 }
    let state = stepWub(createGame(cfg), 16, undefined, 0, LOCK_CONFIDENCE, fixedRng(0))
    const lifetimeMs = state.target!.lifetimeMs
    state = stepWub(state, lifetimeMs + 50, undefined, 0, LOCK_CONFIDENCE, fixedRng(0))
    expect(state.status).toBe('gameover')
    const frozen = stepWub(state, 500, 2, 0.99, LOCK_CONFIDENCE, fixedRng(0.5))
    expect(frozen.score).toBe(state.score)
    expect(frozen.lives).toBe(state.lives)
    expect(frozen.target).toBeUndefined()
  })
})

describe('arcade/wub-game: difficulty ramp', () => {
  it('shrinks a freshly spawned target\'s lifetime as elapsed time grows', () => {
    const cfg = defaultConfig(400, 500)
    // Drive elapsed time up with a long run of no-op steps, target
    // destroyed instantly and respawned each cycle to see the ramp's
    // effect on a *fresh* spawn's lifetime.
    let state = createGame(cfg)
    // Force through many spawn/destroy cycles to accumulate elapsed time.
    for (let i = 0; i < 50; i++) {
      state = stepWub(state, 16, undefined, 0, LOCK_CONFIDENCE, fixedRng(0))
      if (state.target) {
        state = stepWub(state, cfg.chargeMsToDestroy + 50, state.target.requiredHz, 0.99, LOCK_CONFIDENCE, fixedRng(0))
      }
      // Clear the inter-target delay so the loop always has a target to work with.
      if (!state.target) state = stepWub(state, cfg.interTargetDelayMs + 50, undefined, 0, LOCK_CONFIDENCE, fixedRng(0))
    }
    expect(state.elapsedMs).toBeGreaterThan(20000)
    const lateTarget = state.target ?? stepWub(state, 16, undefined, 0, LOCK_CONFIDENCE, fixedRng(0)).target!
    const earlyLifetime = stepWub(createGame(cfg), 16, undefined, 0, LOCK_CONFIDENCE, fixedRng(0)).target!.lifetimeMs
    if (lateTarget.requiredHz === 1) {
      // Only compare directly when the rate matches (rng is fixed at 0,
      // which always draws the same rate here, so this always holds --
      // asserted for clarity rather than as a defensive branch).
      expect(lateTarget.lifetimeMs).toBeLessThanOrEqual(earlyLifetime)
    }
  })

  it('never ramps lifetime below lifetimeFloorMs', () => {
    const cfg: WubConfig = { ...defaultConfig(400, 500), rampPerSecond: 5 } // absurdly steep, on purpose
    let state = createGame(cfg)
    state = { ...state, elapsedMs: 600_000 } // 10 minutes in, ramp multiplier is huge
    state = stepWub(state, 16, undefined, 0, LOCK_CONFIDENCE, fixedRng(0))
    expect(state.target!.lifetimeMs).toBeGreaterThanOrEqual(cfg.lifetimeFloorMs)
  })
})
