import type { PatchFile } from '../src/engine/patch'

/**
 * The patch bank: a browsable set of genre presets loadable straight from
 * the rack, so "can it do dubstep" is a button, not an argument -- the
 * problem this file exists to close (docs/CONTINUATION.md / the task this
 * was built for: "a person opening the app has nothing to load").
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
 * a worklet is actually producing signal.
 */

import reeseRaw from '../academy/levels/bass-02-reese.sinp?raw'
import wobbleRaw from '../academy/levels/bass-03-wobble.sinp?raw'
import growlRaw from '../academy/levels/bass-04-growl.sinp?raw'
import layeredSubRaw from '../academy/levels/bass-01-layers.sinp?raw'
import sub808Raw from './patches/808-sub.sinp?raw'
import hihatRaw from './patches/trap-hihat.sinp?raw'
import grimeLeadRaw from './patches/grime-lead.sinp?raw'
import pingpongLeadRaw from './patches/pingpong-lead.sinp?raw'

function parseSinp(raw: string): PatchFile {
  return JSON.parse(raw) as PatchFile
}

export interface PresetEntry {
  id: string
  name: string
  /** One line, plain language: what it is and where it's from. */
  description: string
  file: PatchFile
}

export const PRESET_BANK: PresetEntry[] = [
  {
    id: 'reese',
    name: 'Reese',
    description: 'Two detuned saws through a filter -- the foundation of jungle and neuro.',
    file: parseSinp(reeseRaw),
  },
  {
    id: 'wobble',
    name: 'Tempo-Locked Wobble',
    description: 'Clock into LFO into filter cutoff -- the dubstep gesture, chopping in time with the beat.',
    file: parseSinp(wobbleRaw),
  },
  {
    id: 'growl',
    name: 'Growl',
    description: 'Drive with a modulated drive amount -- saturation moved over time, not just dialed in.',
    file: parseSinp(growlRaw),
  },
  {
    id: 'layered-sub',
    name: 'Layered Sub',
    description: 'A low sine for weight under a saw an octave up for presence -- bass built in layers.',
    file: parseSinp(layeredSubRaw),
  },
  {
    id: '808-sub',
    name: '808 Sub',
    description: 'A low sine with a fast pitch envelope, self-triggering on its own clock -- the trap/808 drop.',
    file: parseSinp(sub808Raw),
  },
  {
    id: 'trap-hihat',
    name: 'Trap Hi-Hat',
    description: "Noise through the filter's bandpass with a short envelope, rolling on its own clock.",
    file: parseSinp(hihatRaw),
  },
  {
    id: 'grime-lead',
    name: 'Grime Lead',
    description: 'An aggressive, mid-forward driven pulse wave -- a whining grime bassline lead.',
    file: parseSinp(grimeLeadRaw),
  },
  {
    id: 'pingpong-lead',
    name: 'Ping-Pong Lead',
    description: 'Two detuned pulses through a clock-locked Ping-Pong Delay -- echoes alternate L/R in time with the beat. Headphones recommended.',
    file: parseSinp(pingpongLeadRaw),
  },
]

export function getPreset(id: string): PresetEntry | undefined {
  return PRESET_BANK.find((p) => p.id === id)
}
