/**
 * Arcade sound feedback -- synthesized collision/hit cues for both arcade
 * games (Pan Paddle's catch/miss, Wub Disruptor's destroy/escape). Both
 * games shipped with a real playfield and a real audio-driven controller
 * but no audio *feedback* on a hit -- the owner's own playtest note ("felt
 * like there should be a collision sound"). This file is that feedback,
 * synthesized with a handful of native Web Audio nodes (an OscillatorNode
 * + a GainNode envelope per hit) -- this is a synthesizer, and a one-shot
 * blip costs nothing built the same way every other sound in this project
 * is. No sample is shipped for it.
 *
 * **Never routed through the Output module, on purpose.** Both games'
 * paddle/target feedback is driven by *measuring* whatever the Output
 * module (`src/engine/modules/output.ts`) is emitting --
 * `rack/arcade-panel.ts`'s stereo-balance tap and `rack/wub-panel.ts`'s
 * modulation-rate tap both read `instance.outputs.get('out')` directly. If
 * a collision sound played through that same node, it would become part of
 * the very signal being measured -- every hit would tug the paddle
 * sideways (a blip is rarely perfectly centered the instant it lands) or
 * spike the wub detector's rate estimate, a feedback loop between the
 * game's own sound and its own controller that would be *silent* in
 * isolation (nothing crashes, nothing throws) and only show up as "the
 * paddle jitters right after every catch" during play. `createArcadeAudio`
 * below takes only an `AudioContext` -- never an `OutputInstance` or any of
 * its nodes -- so this module is structurally unable to route into that tap
 * chain, not just disciplined about avoiding it. Every node it builds
 * connects to its own private bus, which connects straight to
 * `ctx.destination` (an *additional* edge into the same destination
 * `rack/main.ts`'s `wireOutputs` already connects the real patch to, not a
 * disconnect-and-reroute -- the same "parallel tap, never in series"
 * pattern `rack/arcade-panel.ts`'s own header comment documents for the
 * balance tap itself). `tests/browser/modules/arcade-audio.test.ts` proves
 * this directly: a hard-panned fake Output stays pinned at its balance
 * while a run of collision sounds plays on the very same `AudioContext`.
 */

const STORAGE_KEY = 'sinsthesis-arcade-muted'

function loadMuted(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function saveMuted(muted: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, muted ? '1' : '0')
  } catch {
    // Best effort -- a private-browsing tab or disabled storage shouldn't
    // break the game, just the persistence of the toggle across sessions.
  }
}

export interface ArcadeAudio {
  /** A short, bright blip -- Pan Paddle's catch cue. `pitchFrac` (0..1,
   *  clamped) is where across the playfield the hit happened, so the pitch
   *  itself carries information instead of every catch sounding identical
   *  -- the paddle's left edge reads lower, its right edge higher. */
  playCatch(pitchFrac: number): void
  /** A short, dull thud with a falling pitch -- Pan Paddle's miss cue,
   *  deliberately the opposite shape (lower, descending, no pitch
   *  variation) so catch and miss are told apart by ear alone, not just by
   *  watching the score. */
  playMiss(): void
  /** A brighter, rising chirp -- Wub Disruptor's destroy cue. `pitchFrac`
   *  (0..1, clamped) carries the destroyed target's own required rate, so a
   *  fast target pops higher than a slow one -- the same "pitch carries
   *  information" idea `playCatch` uses for paddle position. */
  playDestroy(pitchFrac: number): void
  /** A low, descending buzz -- Wub Disruptor's escape cue, the same
   *  catch/miss opposition `playCatch`/`playMiss` establish, applied here. */
  playEscape(): void
  setMuted(muted: boolean): void
  getMuted(): boolean
  /** Disconnects the private bus. Idempotent-safe to call even if a blip is
   *  still ringing out -- matches `disposeTap`'s own teardown contract. */
  dispose(): void
}

/** Peak linear gain for every blip -- quiet enough that fifty hits in a row
 *  (a real full run of either game) stays a cue, not a nuisance. Set by
 *  ear during playtesting, not measured -- there is no "correct" loudness
 *  for a game cue, only "clearly audible against the patch without
 *  competing with it." */
const PEAK_GAIN = 0.14

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x))
}

interface BlipOpts {
  readonly type: OscillatorType
  readonly freqStart: number
  readonly freqEnd: number
  readonly durationS: number
  readonly peak: number
}

/** One percussive blip: an oscillator with an optional pitch sweep, under a
 *  short linear-attack / exponential-decay envelope. Both nodes are torn
 *  down on `onended`, so a run of fifty hits never accumulates dead nodes
 *  on the graph. */
function blip(ctx: AudioContext, bus: GainNode, opts: BlipOpts): void {
  const { type, freqStart, freqEnd, durationS, peak } = opts
  const now = ctx.currentTime
  const osc = ctx.createOscillator()
  osc.type = type
  osc.frequency.setValueAtTime(Math.max(20, freqStart), now)
  if (freqEnd !== freqStart) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), now + durationS)
  }
  const env = ctx.createGain()
  env.gain.setValueAtTime(0, now)
  // A few-ms linear attack avoids the click a hard onset at full gain would
  // add, short enough not to blunt a cue that has to read as "instant"
  // against a falling block or a pulsing target.
  env.gain.linearRampToValueAtTime(peak, now + 0.004)
  env.gain.exponentialRampToValueAtTime(0.0001, now + durationS)
  osc.connect(env)
  env.connect(bus)
  osc.start(now)
  osc.stop(now + durationS + 0.02)
  osc.onended = () => {
    osc.disconnect()
    env.disconnect()
  }
}

export function createArcadeAudio(ctx: AudioContext): ArcadeAudio {
  // The private bus every blip connects through -- see this file's header
  // comment for why this is the *only* node ever wired outward, straight to
  // ctx.destination, and never toward anything an OutputInstance owns.
  const bus = ctx.createGain()
  let muted = loadMuted()
  bus.gain.value = muted ? 0 : 1
  bus.connect(ctx.destination)

  return {
    playCatch(pitchFrac) {
      if (muted) return
      const freq = 480 + clamp01(pitchFrac) * 640 // 480..1120 Hz across the paddle
      blip(ctx, bus, { type: 'triangle', freqStart: freq, freqEnd: freq * 0.82, durationS: 0.09, peak: PEAK_GAIN })
    },
    playMiss() {
      if (muted) return
      blip(ctx, bus, { type: 'sine', freqStart: 220, freqEnd: 95, durationS: 0.16, peak: PEAK_GAIN })
    },
    playDestroy(pitchFrac) {
      if (muted) return
      const freq = 520 + clamp01(pitchFrac) * 380 // 520..900 Hz across the target-rate range
      blip(ctx, bus, { type: 'triangle', freqStart: freq, freqEnd: freq * 1.6, durationS: 0.13, peak: PEAK_GAIN })
    },
    playEscape() {
      if (muted) return
      blip(ctx, bus, { type: 'sine', freqStart: 260, freqEnd: 85, durationS: 0.22, peak: PEAK_GAIN })
    },
    setMuted(next) {
      muted = next
      // A short setTargetAtTime, not a hard step, so toggling mid-blip
      // can't add a click of its own.
      bus.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.01)
      saveMuted(muted)
    },
    getMuted() {
      return muted
    },
    dispose() {
      bus.disconnect()
    },
  }
}
