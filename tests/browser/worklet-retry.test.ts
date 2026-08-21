import { describe, it, expect } from 'vitest'
import { ensureWorkletsWithRetry } from '../../src/engine/render'
import { registerAllModules } from '../../src/engine/modules'
import { getModule } from '../../src/engine/registry'
import { PatchGraph } from '../../src/engine/graph'

/**
 * The regression guard for "no sound on first load, sound on a later
 * attempt" -- a real report from a phone and a desktop that went
 * unreproduced for two sessions.
 *
 * The mechanism, measured in a real browser before this file existed: the
 * `segment` bundle backs the ADSR, LFO, S&H and Sequencer, and the rack's
 * default patch runs its only gain path through the ADSR (`buildDefaultPatch`
 * sets the VCA to `level: 0`, `cvAmount: 1`, so the envelope is the sole
 * thing that can open it). When `segment` fails to load, `adsr` becomes a
 * `buildFailedInstance` stub -- correctly silent by design -- and the whole
 * instrument goes quiet. Not "a few modules in reduced mode": measured
 * key-down RMS 0.27258 with the bundle loaded, **0.00000** without it.
 *
 * On a cold first load that is 18 separate HTTP requests on whatever
 * network the visitor has. Any one of them failing produces total silence,
 * and because a reload re-fetches, the second attempt works -- which is
 * exactly the shape of the report.
 *
 * `ensureWorklets` was already built for this: it drops its cached
 * rejection precisely so "a caller who fixes the problem can retry" (its
 * own doc comment). Nothing ever retried. That was the gap.
 */

if (!getModule('vco')) registerAllModules()

/** A context whose `addModule` fails the first `failures` attempts for one
 *  bundle, then behaves normally -- a transient cold-network blip. */
function flakyContext(bundle: string, failures: number): OfflineAudioContext {
  const ctx = new OfflineAudioContext(1, 48000, 48000)
  const real = ctx.audioWorklet.addModule.bind(ctx.audioWorklet)
  let seen = 0
  ctx.audioWorklet.addModule = (url: string) => {
    if (url.includes(`/${bundle}.js`) && seen++ < failures) {
      return Promise.reject(new Error('simulated transient load failure'))
    }
    return real(url)
  }
  return ctx
}

describe('ensureWorkletsWithRetry', () => {
  it('recovers from a transient failure instead of leaving the instrument silent', async () => {
    const ctx = flakyContext('segment', 1)
    const result = await ensureWorkletsWithRetry(ctx, { attempts: 3, delayMs: 0 })

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2) // failed once, succeeded on the retry
    expect(result.missing).toEqual([])

    // The real proof: the ADSR builds its actual worklet, not a silent stub.
    const graph = new PatchGraph(ctx)
    const adsr = graph.addModule('adsr')
    expect(graph.getInstance(adsr)?.fallback).toBeUndefined()
  })

  it('succeeds on the first attempt when nothing is wrong, without extra fetches', async () => {
    const ctx = flakyContext('segment', 0)
    const result = await ensureWorkletsWithRetry(ctx, { attempts: 3, delayMs: 0 })
    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(1)
    expect(result.missing).toEqual([])
  })

  it('gives up after the allowed attempts and names exactly which bundles are missing', async () => {
    // Permanently broken, not transient -- a 404 rather than a blip.
    const ctx = flakyContext('segment', Number.MAX_SAFE_INTEGER)
    const result = await ensureWorkletsWithRetry(ctx, { attempts: 2, delayMs: 0 })

    expect(result.ok).toBe(false)
    expect(result.attempts).toBe(2)
    // Naming the bundle is what lets the UI say something true instead of
    // the old banner's "a few modules are in a reduced mode".
    expect(result.missing).toEqual(['segment'])
  })

  it('reports every still-missing bundle, not just the first', async () => {
    const ctx = new OfflineAudioContext(1, 48000, 48000)
    const real = ctx.audioWorklet.addModule.bind(ctx.audioWorklet)
    ctx.audioWorklet.addModule = (url: string) =>
      url.includes('/segment.js') || url.includes('/vco.js')
        ? Promise.reject(new Error('simulated'))
        : real(url)

    const result = await ensureWorkletsWithRetry(ctx, { attempts: 1, delayMs: 0 })
    expect(result.ok).toBe(false)
    expect(result.missing.slice().sort()).toEqual(['segment', 'vco'])
  })

  it('keeps every bundle that did load, so a retry never re-registers a working processor', async () => {
    // A second addModule() for an already-registered processor name throws.
    // ensureWorklets filters by loadedWorkletBundles for exactly this
    // reason; the retry loop must not defeat it.
    const ctx = flakyContext('segment', 2)
    const result = await ensureWorkletsWithRetry(ctx, { attempts: 4, delayMs: 0 })
    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(3)

    // Everything works, including bundles that loaded on attempt 1.
    const graph = new PatchGraph(ctx)
    for (const type of ['vco', 'vcf', 'adsr', 'lfo']) {
      expect(graph.getInstance(graph.addModule(type))?.fallback).toBeUndefined()
    }
  })
})
