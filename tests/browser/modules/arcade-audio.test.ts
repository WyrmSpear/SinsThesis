import { describe, it, expect } from 'vitest'
import { buildTap, disposeTap, readBalance } from '../../../rack/arcade-panel'
import { createArcadeAudio } from '../../../rack/arcade-audio'
import type { OutputInstance } from '../../../src/engine/modules/output'

/**
 * The trap this closes (see .superpowers/sdd/arcade-audio-report.md and
 * rack/arcade-audio.ts's own header comment): the pan-paddle is steered by
 * *measuring* whatever the Output module is emitting
 * (`rack/arcade-panel.ts`'s `buildTap` reads `instance.outputs.get('out')`
 * directly). If the new collision-sound cue were ever wired through that
 * same node, it would become part of the very signal the paddle reads --
 * every catch would tug the measured balance toward wherever the blip's own
 * stereo image happens to sit, a feedback loop between the game's own sound
 * and its own controller. `createArcadeAudio` is built so this is
 * structurally impossible (it only ever receives an `AudioContext`, never
 * an `OutputInstance` or any of its nodes), but "structurally impossible by
 * today's code" is exactly the kind of guarantee a future refactor can
 * silently break with no test watching for it -- so this proves it
 * directly rather than trusting the header comment.
 */
describe('arcade-audio: collision cues do not perturb the balance tap', () => {
  it('a hard-panned fake Output stays pinned at its balance while collision sounds play on the same context', async () => {
    const SR = 48000
    // Short, and the analyser is read right after this render completes --
    // `readBalance` sees only the *current* window (the last ~5ms before
    // rendering stopped), so the render has to end while a blip would still
    // be ringing for this test to mean anything. A blip's envelope decays
    // over roughly 90-220ms (rack/arcade-audio.ts's `durationS`), so 50ms
    // samples mid-decay rather than long after every cue has already gone
    // silent -- confirmed against a deliberately misrouted sanity build of
    // this same test, which reads off -1 at this duration and would NOT at
    // a longer one (both the blip and the misrouting would be invisible by
    // then).
    const DURATION_S = 0.05
    const ctx = new OfflineAudioContext(2, Math.ceil(DURATION_S * SR), SR)

    // A genuinely stereo, hard-left source: channel 0 (left) carries a
    // constant 1, channel 1 (right) a constant 0 -- exactly what a real
    // hard-panned patch's Output node would emit, so `readBalance` should
    // read a stable -1 for the entire render if, and only if, nothing else
    // reaches this node or the tap built on it.
    const left = ctx.createConstantSource()
    left.offset.value = 1
    const right = ctx.createConstantSource()
    right.offset.value = 0
    const merger = ctx.createChannelMerger(2)
    left.connect(merger, 0, 0)
    right.connect(merger, 0, 1)
    left.start()
    right.start()

    const fakeOutput: OutputInstance = {
      inputs: new Map(),
      outputs: new Map([['out', merger as AudioNode]]),
      analyser: ctx.createAnalyser(),
      setParam() {},
      dispose() {},
    }

    const tap = buildTap(ctx as unknown as AudioContext, fakeOutput)
    expect(tap).toBeDefined()
    if (!tap) return

    // Explicitly unmuted regardless of any stored preference, so this test
    // proves the routing claim rather than accidentally passing because
    // nothing got scheduled.
    const audio = createArcadeAudio(ctx as unknown as AudioContext)
    audio.setMuted(false)
    expect(audio.getMuted()).toBe(false)

    // A full run's worth of hits, both games, both event types -- if any of
    // these ever routed into the tap's chain, the balance would move off
    // -1.
    for (let i = 0; i < 20; i++) {
      audio.playCatch(i / 20)
      audio.playMiss()
      audio.playDestroy(i / 20)
      audio.playEscape()
    }

    await ctx.startRendering()

    const balance = readBalance(tap)
    // Before a hypothetical regression (routing the blip bus through the
    // Output node instead of straight to ctx.destination) this would read
    // something audibly off -1, not a value this tight to it.
    expect(balance).toBeLessThan(-0.98)

    disposeTap(tap)
    audio.dispose()
  })
})
