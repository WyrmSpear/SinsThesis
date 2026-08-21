import { describe, it, expect } from 'vitest'
import { buildTap, disposeTap, readBalance } from '../../../rack/arcade-panel'
import type { OutputInstance } from '../../../src/engine/modules/output'

/**
 * Regression test for the arcade paddle's "only reaches the left half"
 * bug (docs/CONTINUATION.md's READ FIRST section, reported by the owner).
 *
 * `rack/arcade-panel.ts`'s `buildTap` used to connect straight into a
 * `ChannelSplitterNode` (`channelInterpretation: 'discrete'`), which reads
 * a genuinely mono source as channel 0 = signal, channel 1 = silence --
 * `readBalance` then computes -1 and the paddle pins hard left. In today's
 * normal integration path (a real Output module, whose own internal gain
 * node already up-mixes mono to stereo -- see `src/engine/modules/
 * output.ts`), that up-mix happens to protect the tap transitively before
 * this fix existed too, which is exactly why a full rack-level test (the
 * "mono patch" case in `tests/browser/rack-arcade.test.ts`) is not enough
 * on its own to prove `buildTap`'s *own* fix is load-bearing -- reverting
 * it there still passes. This test closes that gap: it calls `buildTap`
 * directly against a fake `OutputInstance` whose `out` port is a raw
 * `OscillatorNode` -- a genuinely single-channel source with no upstream
 * up-mix of its own -- so it fails without `buildTap`'s own `upmix` stage
 * and passes with it, regardless of what Output does elsewhere.
 */
describe('arcade-panel buildTap: mono up-mix', () => {
  it('reads a centered balance from a deliberately raw, single-channel source', async () => {
    const SR = 48000
    const DURATION_S = 0.05
    const ctx = new OfflineAudioContext(1, Math.ceil(DURATION_S * SR), SR)

    // A bare OscillatorNode has no inputs, so its own output channel count
    // is always exactly 1 -- nothing upstream of it to up-mix, unlike
    // src/engine/modules/output.ts's `level` gain node, which up-mixes
    // *because* something up-mixable is connected into it. This is the
    // "genuinely mono, arriving unmixed" case the bug report describes.
    const osc = ctx.createOscillator()
    osc.frequency.value = 220
    osc.start()

    const fakeOutput: OutputInstance = {
      inputs: new Map(),
      outputs: new Map([['out', osc as AudioNode]]),
      analyser: ctx.createAnalyser(),
      setParam() {},
      dispose() {},
    }

    const tap = buildTap(ctx as unknown as AudioContext, fakeOutput)
    expect(tap).toBeDefined()
    if (!tap) return

    // Nothing needs to reach ctx.destination for the tap's own analysers to
    // fill -- OfflineAudioContext still runs every connected node in the
    // graph through to the render length, destination or not.
    await ctx.startRendering()

    const balance = readBalance(tap)
    // Before the fix this read -1 (hard left) for any mono source. Small
    // tolerance for the oscillator's phase at the analyser's read window,
    // not for the up-mix itself -- a real bug would read close to -1, not
    // close to 0.
    expect(Math.abs(balance)).toBeLessThan(0.05)

    disposeTap(tap)
  })
})
