import type { PatchFile } from '../src/engine/patch'

/**
 * The patch bank: a browsable set of genre presets loadable straight from
 * the rack, so "can it do dubstep" is a button, not an argument -- the
 * problem this file exists to close (docs/CONTINUATION.md / the task this
 * was built for: "a person opening the app has nothing to load").
 *
 * **Lazy on purpose.** Every entry's `file` is a memoized loader
 * (`lazyPreset`, below), not a plain object -- none of these `.sinp`s, most
 * of all `sampler-chop`'s 141 KB of embedded audio, ships in the initial
 * bundle for a visitor who never opens the Presets drawer. See
 * `.superpowers/sdd/robustness-report.md` for the before/after bundle
 * measurement this closes.
 *
 * **One artifact, two uses.** The academy was designed so a level's
 * solution is a real, loadable `.sinp` (academy/levels.ts's own header
 * comment). Four of these five bank entries import that *exact same file*
 * a bass-track level ships as its solution -- `?raw`, byte-identical, the
 * same seam `academy/levels.ts` already uses for the same reason -- rather
 * than maintaining a second copy that could drift. The fifth
 * (`bass-05-finish`, the constrained-challenge finale) is deliberately
 * NOT shared: every constrained-challenge level in this codebase (09-thump,
 * 10-drift, 11-fold-pluck, and this track's own finale) grants no Keyboard
 * and no Clock, because grading renders a synthetic gate offline rather
 * than trusting a live performance -- so that solution patch is silent
 * standing alone in a live rack (nothing ever gates its ADSR). A preset
 * that says nothing when loaded fails this file's own "immediately
 * playable" bar, so the bank's own `808-sub` entry is a separate,
 * self-triggering patch (same voice, plus a Clock feeding its ADSR
 * directly) instead -- see `presets/patches/808-sub.sinp`.
 *
 * **Immediately playable.** Every entry here makes sound the instant it
 * loads, with no further interaction: the sustained-tone entries
 * (Reese, Wobble, Growl, Layered Sub, Grime Lead) are plain free-running
 * oscillator chains with no envelope to wait on, and the percussive ones
 * (808 Sub, Trap Hi-Hat) carry their own Clock wired straight into an
 * ADSR gate, so they loop on their own rather than waiting for a keypress
 * that a bank preset -- unlike a level, unlike free play's starter patch --
 * has no Keyboard around to provide. `tests/browser/preset-bank.test.ts`
 * asserts this with the audio-thread tap (`__sinsthesis.rms()`), the same
 * hook `rack-page.test.ts` uses, because a DOM assertion alone can't prove
 * a worklet is actually producing signal. `sampler-chop` (the Sampler's own
 * demo, see `modules/sampler.ts`) follows the same self-triggering shape as
 * 808 Sub/Trap Hi-Hat -- a Clock gates it directly -- rather than needing a
 * Keyboard, and its `.sinp` carries its own audio embedded (this project's
 * chosen answer to "what happens to a sampler's sample on save/reload,"
 * see sampler.ts's own doc comment), so it is genuinely self-contained --
 * no external sample file for this repo, or a fork of it, to go missing.
 *
 * **Only one history-track solution is shared here, and deliberately not
 * more.** `history-02-motorik` (Clock -> Sequencer -> VCO -> VCF, no ADSR at
 * all) is free-running the same way Reese/Wobble/Growl are, so it needed no
 * changes to become a preset. The rest of the history track's levels are
 * constrained-challenge or match-this-sound and grant no Keyboard, gated
 * instead by a synthetic pulse at Check time (`renderPatch`'s own `gate`
 * option) -- the same reason `bass-05-finish` above needed a bespoke
 * self-triggering rebuild (`808-sub`) rather than being shared directly.
 * Building an equivalent self-triggering variant of every history level's
 * proof patch was out of scope for this pass; `history-02-motorik` is
 * genuinely free of that problem, not a special case carved out for it.
 */

function parseSinp(raw: string): PatchFile {
  return JSON.parse(raw) as PatchFile
}

/**
 * Wraps a dynamic `import('...sinp?raw')` into a memoized loader, so
 * `PRESET_BANK` below carries no preset's bytes -- audio or plain JSON --
 * in the initial bundle at all (this file's own header comment/the task
 * this closes: "the sampler's embedded demo sample loads eagerly for
 * every visitor whether or not they ever open the sampler"). A dynamic
 * `import()` of the same specifier is itself idempotent (the module
 * loader's own cache), so the `cached` promise here is belt-and-suspenders
 * against re-parsing the same JSON on a second `Load` click within one
 * session, not what makes repeated loads cheap -- that's already true
 * without it.
 */
function lazyPreset(loader: () => Promise<{ default: string }>): () => Promise<PatchFile> {
  let cached: Promise<PatchFile> | undefined
  return () => {
    if (!cached) cached = loader().then((mod) => parseSinp(mod.default))
    return cached
  }
}

export interface PresetEntry {
  id: string
  name: string
  /** One line, plain language: what it is and where it's from. */
  description: string
  /** Fetches this preset's patch file on demand -- see `lazyPreset`'s own
   *  doc comment for why every entry is async now, not just the one with
   *  embedded audio: it keeps the bank to one pattern instead of a
   *  sync/async split a caller has to branch on, and it means the other
   *  nine entries' combined ~10 KB of JSON stops shipping to a visitor who
   *  never opens the Presets drawer either, not just the sampler's 141 KB. */
  file(): Promise<PatchFile>
}

export const PRESET_BANK: PresetEntry[] = [
  {
    id: 'reese',
    name: 'Reese',
    description: 'Two detuned saws through a filter -- the foundation of jungle and neuro.',
    file: lazyPreset(() => import('../academy/levels/bass-02-reese.sinp?raw')),
  },
  {
    id: 'wobble',
    name: 'Tempo-Locked Wobble',
    description: 'Clock into LFO into filter cutoff -- the dubstep gesture, chopping in time with the beat.',
    file: lazyPreset(() => import('../academy/levels/bass-03-wobble.sinp?raw')),
  },
  {
    id: 'growl',
    name: 'Growl',
    description: 'Drive with a modulated drive amount -- saturation moved over time, not just dialed in.',
    file: lazyPreset(() => import('../academy/levels/bass-04-growl.sinp?raw')),
  },
  {
    id: 'layered-sub',
    name: 'Layered Sub',
    description: 'A low sine for weight under a saw an octave up for presence -- bass built in layers.',
    file: lazyPreset(() => import('../academy/levels/bass-01-layers.sinp?raw')),
  },
  {
    id: '808-sub',
    name: '808 Sub',
    description: 'A low sine with a fast pitch envelope, self-triggering on its own clock -- the trap/808 drop.',
    file: lazyPreset(() => import('./patches/808-sub.sinp?raw')),
  },
  {
    id: 'trap-hihat',
    name: 'Trap Hi-Hat',
    description: "Noise through the filter's bandpass with a short envelope, rolling on its own clock.",
    file: lazyPreset(() => import('./patches/trap-hihat.sinp?raw')),
  },
  {
    id: 'grime-lead',
    name: 'Grime Lead',
    description: 'An aggressive, mid-forward driven pulse wave -- a whining grime bassline lead.',
    file: lazyPreset(() => import('./patches/grime-lead.sinp?raw')),
  },
  {
    id: 'pingpong-lead',
    name: 'Ping-Pong Lead',
    description: 'Two detuned pulses through a clock-locked Ping-Pong Delay -- echoes alternate L/R in time with the beat. Headphones recommended.',
    file: lazyPreset(() => import('./patches/pingpong-lead.sinp?raw')),
  },
  {
    id: 'sampler-chop',
    name: 'Sample Chop',
    description: 'A synthesized pluck, retriggered on the clock with an LFO wobbling its pitch, through a Bitcrusher for SP-1200-grade grit -- the sample-chop gesture jungle and hip-hop built a genre on. The audio is embedded in the patch itself; see sampler.ts\'s own doc comment for why.',
    file: lazyPreset(() => import('./patches/sampler-chop.sinp?raw')),
  },
  {
    id: 'motorik',
    name: 'Motorik',
    description: 'Clock into Sequencer into a filtered VCO, no envelope at all -- the mid-1970s Kraftwerk/Moroder idea that the sequencer is the whole band, not an accessory. From the history academy track.',
    file: lazyPreset(() => import('../academy/levels/history-02-motorik.sinp?raw')),
  },
  {
    id: 'psychoacoustic-demo',
    name: 'Psychoacoustic Demo',
    description: 'Three ways to land on a specific frequency: a per-ear pair five hertz apart (headphones make the difference audible as two separate tones; a speaker just mixes the two), a sine switched on and off five times a second with softened edges, and a switch-selected 264 Hz reference tone, all summed at the Output.',
    file: lazyPreset(() => import('./patches/psychoacoustic-demo.sinp?raw')),
  },
]

export function getPreset(id: string): PresetEntry | undefined {
  return PRESET_BANK.find((p) => p.id === id)
}
