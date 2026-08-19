import { PATCH_VERSION, type PatchFile } from '../src/engine/patch'
import type { InspectorQuery } from '../src/engine/analysis/inspector'

import rubric01 from './levels/01-first-sound.rubric.json'
import solution01Raw from './levels/01-first-sound.sinp?raw'
import rubric02 from './levels/02-shape-it.rubric.json'
import solution02Raw from './levels/02-shape-it.sinp?raw'
import rubric03 from './levels/03-play-notes.rubric.json'
import solution03Raw from './levels/03-play-notes.sinp?raw'
import rubric04 from './levels/04-modulate.rubric.json'
import solution04Raw from './levels/04-modulate.sinp?raw'
import rubric05 from './levels/05-resonance.rubric.json'
import solution05Raw from './levels/05-resonance.sinp?raw'
import rubric06 from './levels/06-match-pluck.rubric.json'
import solution06Raw from './levels/06-match-pluck.sinp?raw'
import rubric07 from './levels/07-match-waveform.rubric.json'
import solution07Raw from './levels/07-match-waveform.sinp?raw'
import rubric08 from './levels/08-match-resonance.rubric.json'
import solution08Raw from './levels/08-match-resonance.sinp?raw'

// `.sinp` is loaded with Vite's `?raw` suffix rather than a plain import,
// so the file stays byte-identical JSON with the real `.sinp` extension --
// the same one `rack/patch-io.ts`'s `downloadPatch` writes -- instead of
// needing a `.sinp.json` double extension purely to satisfy a bundler's
// extension-sniffing. Parsed once here, not per level access.
function parseSinp(raw: string): PatchFile {
  return JSON.parse(raw) as PatchFile
}
const solution01 = parseSinp(solution01Raw)
const solution02 = parseSinp(solution02Raw)
const solution03 = parseSinp(solution03Raw)
const solution04 = parseSinp(solution04Raw)
const solution05 = parseSinp(solution05Raw)
const solution06 = parseSinp(solution06Raw)
const solution07 = parseSinp(solution07Raw)
const solution08 = parseSinp(solution08Raw)

/**
 * The academy's level format, and why it is two files rather than one.
 *
 * Each level is a `<id>.sinp` **solution** patch plus a `<id>.rubric.json`
 * **rubric**. The `.sinp` is byte-for-byte the same shape `rack/patch-io.ts`
 * downloads when you press "Save .sinp" -- so a level's solution is
 * authored the way the spec's forward-compat section describes: open the
 * rack, patch the thing, hit Save, drop the file in `academy/levels/`.
 * Nothing here invents a second patch schema for levels to drift from the
 * one the engine already owns (`src/engine/patch.ts`'s `PatchFile`).
 *
 * The rubric is hand-edited prose and data -- id, title, a beginner-facing
 * brief, which module types the palette grants, and the `InspectorQuery`
 * pass condition -- none of which has a "patch it" gesture. Mixing that
 * into the `.sinp` would mean either the solution patch carries fields the
 * engine's own format doesn't define, or the rubric's JSON has a giant
 * embedded patch blob a level designer has to route around every time they
 * just want to fix a typo in the brief. Keeping them apart means either can
 * change without touching the other, and the `.sinp` stays a real,
 * loadable patch a person can also just double-click into the free-play
 * rack to see what it sounds like.
 *
 * A level's *starting* patch is not a third file: `startingPatchFrom`
 * names an earlier level's id, and that level's own solution becomes where
 * the next one begins -- so progressing through the academy is literally
 * "keep patching on top of what you already built," and every starting
 * patch a player ever sees is itself a solution some earlier level already
 * proved passes its own query (tests/node/academy-levels.test.ts checks
 * exactly that chain). A level with no `startingPatchFrom` begins from an
 * empty rack.
 *
 * **Two grading modes share this one format.** `mode: 'build'` (the
 * default, and every level through 05) grades topology via `inspect()` and
 * `query`. `mode: 'match'` (levels 06-08) grades sound instead: the
 * `.sinp` is not a model *solution* to compare a patch's wiring against --
 * it *is* the target sound, rendered offline (`renderPatch`, from
 * `src/engine/render.ts`) at the moment a player Checks, not stored as a
 * cached feature vector at author time. This project's DSP has changed
 * substantially more than once (docs/CONTINUATION.md), and a stored
 * reference would silently go stale against it -- exactly the kind of
 * "near miss scores unfairly" bug this grading mode exists to avoid, since
 * the player's own render always reflects *this build's* DSP, and the
 * target must too or the comparison is measuring a difference that was
 * never in the patch. Re-rendering the same short clip once per Check is
 * fast enough that this cost is not worth trading correctness for.
 * `match` carries how long to render (`seconds`), an optional envelope
 * gate schedule (`gate` -- see `renderPatch`'s own doc comment for why a
 * match-this-sound level grants no keyboard and gets a synthetic gate
 * pulse instead), and the pass threshold measured in
 * `.superpowers/sdd/academy-match-sound-report.md`.
 */
export interface MatchRubric {
  /** How long to render both the target and the player's patch, in seconds. */
  seconds: number
  /** When given, every `adsr` module in the patch gets a synthetic gate
   *  pulse on this schedule (see `renderPatch`) -- omitted for a level
   *  whose target never gates anything (a plain sustained tone). */
  gate?: { onAt: number; offAt?: number }
  /** `compareSounds`' `distance` must be at or below this to pass -- see
   *  the match-sound report for the correct-vs-close-miss measurement
   *  that set it. */
  passThreshold: number
}

export interface LevelRubric {
  id: string
  title: string
  brief: string
  grantedModules: string[]
  startingPatchFrom?: string
  /** Defaults to 'build' when omitted, so every pre-existing rubric JSON
   *  (levels 01-05, written before this field existed) still parses. */
  mode?: 'build' | 'match'
  /** Required when `mode` is 'build' (or omitted). */
  query?: InspectorQuery
  /** Required when `mode` is 'match'. */
  match?: MatchRubric
}

export interface Level {
  id: string
  title: string
  brief: string
  /** Module types the palette shows while this level is active. */
  grantedModules: readonly string[]
  mode: 'build' | 'match'
  query?: InspectorQuery
  match?: MatchRubric
  /** `mode: 'build'`: the model solution `inspect()`'s `query` is proven
   *  against (see tests/node/academy-levels.test.ts). `mode: 'match'`: the
   *  target sound itself, rendered offline through `renderPatch` on
   *  demand rather than at author time -- see this file's own header
   *  comment for why. Either way, the academy UI never shows this patch to
   *  the player directly. */
  solution: PatchFile
  /** What loads into the rack when the player enters this level. */
  startingPatch: PatchFile
}

const RUBRICS: LevelRubric[] = [
  rubric01, rubric02, rubric03, rubric04, rubric05, rubric06, rubric07, rubric08,
] as unknown as LevelRubric[]

const SOLUTIONS: Record<string, PatchFile> = {
  '01-first-sound': solution01,
  '02-shape-it': solution02,
  '03-play-notes': solution03,
  '04-modulate': solution04,
  '05-resonance': solution05,
  '06-match-pluck': solution06,
  '07-match-waveform': solution07,
  '08-match-resonance': solution08,
}

function emptyPatch(): PatchFile {
  return {
    version: PATCH_VERSION,
    meta: { name: 'Untitled', created: new Date(0).toISOString(), author: '' },
    modules: [],
    cables: [],
  }
}

/** Levels in play order -- the order a beginner should meet them, and the
 *  order "complete one, unlock the next" walks. */
export const LEVELS: Level[] = RUBRICS.map((r) => {
  const solution = SOLUTIONS[r.id]
  if (!solution) throw new Error(`academy/levels.ts: no solution .sinp registered for level "${r.id}"`)
  const startingPatch = r.startingPatchFrom !== undefined ? SOLUTIONS[r.startingPatchFrom] : emptyPatch()
  if (!startingPatch) {
    throw new Error(
      `academy/levels.ts: level "${r.id}" names startingPatchFrom "${r.startingPatchFrom}", ` +
        `which has no registered solution`,
    )
  }
  const mode = r.mode ?? 'build'
  if (mode === 'build' && !r.query) {
    throw new Error(`academy/levels.ts: level "${r.id}" is mode 'build' but has no query`)
  }
  if (mode === 'match' && !r.match) {
    throw new Error(`academy/levels.ts: level "${r.id}" is mode 'match' but has no match rubric`)
  }
  return {
    id: r.id,
    title: r.title,
    brief: r.brief,
    grantedModules: r.grantedModules,
    mode,
    query: r.query,
    match: r.match,
    solution,
    startingPatch,
  }
})

export function getLevel(id: string): Level | undefined {
  return LEVELS.find((l) => l.id === id)
}

export function levelIndex(id: string): number {
  return LEVELS.findIndex((l) => l.id === id)
}

export function nextLevel(id: string): Level | undefined {
  const i = levelIndex(id)
  return i === -1 ? undefined : LEVELS[i + 1]
}
