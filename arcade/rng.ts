/**
 * A tiny seeded PRNG, so an arcade run can be replayed exactly.
 *
 * `arcade/game.ts` was written deterministic-given-`rng` from the start
 * (`spawnBlock` takes the generator as a parameter), but the browser only
 * ever reached it through `stepGame`'s `Math.random` default. That left the
 * *integration* path -- audio balance -> paddle -> a real falling block ->
 * score -- untestable except probabilistically, and
 * `tests/browser/rack-arcade.test.ts`'s catch test was exactly that: it
 * swept the paddle with an LFO and waited 15s for a randomly-placed block
 * to happen to land under it. The paddle is 90px of a 420px playfield, so
 * each block was roughly a 1-in-5 shot; the test failed about a quarter of
 * full-suite runs. Seeding the spawn positions makes that test assert a
 * fixed outcome instead of a likely one.
 *
 * Useful beyond the test, which is why it is a real URL option
 * (`?arcadeSeed=`) rather than a test-only hook: a run that misbehaves can
 * be reproduced move-for-move from its seed.
 *
 * mulberry32 -- 32-bit state, well-distributed for this purpose (block
 * positions), and short enough to read at a glance. Not cryptographic and
 * not used for anything that wants to be.
 */
export function mulberry32(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Reads `?arcadeSeed=<int>` off a query string. Returns a seeded
 *  generator, or `undefined` when the param is absent or not a finite
 *  number -- callers fall back to `Math.random` (real, unpredictable play). */
export function seededRngFromSearch(search: string): (() => number) | undefined {
  const raw = new URLSearchParams(search).get('arcadeSeed')
  if (raw === null) return undefined
  const seed = Number(raw)
  if (!Number.isFinite(seed)) return undefined
  return mulberry32(seed)
}
