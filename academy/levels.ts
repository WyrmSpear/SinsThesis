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
 */
export interface LevelRubric {
  id: string
  title: string
  brief: string
  grantedModules: string[]
  startingPatchFrom?: string
  query: InspectorQuery
}

export interface Level {
  id: string
  title: string
  brief: string
  /** Module types the palette shows while this level is active. */
  grantedModules: readonly string[]
  query: InspectorQuery
  /** The solution patch backing this level -- verified (see
   *  tests/node/academy-levels.test.ts) to pass `query` using only
   *  `grantedModules`. The academy UI never shows this to the player; it
   *  exists so completability is provable and so a "show me" hint or a
   *  future match-this-sound mode has a real target to fall back on. */
  solution: PatchFile
  /** What loads into the rack when the player enters this level. */
  startingPatch: PatchFile
}

const RUBRICS: LevelRubric[] = [
  rubric01, rubric02, rubric03, rubric04, rubric05,
] as unknown as LevelRubric[]

const SOLUTIONS: Record<string, PatchFile> = {
  '01-first-sound': solution01,
  '02-shape-it': solution02,
  '03-play-notes': solution03,
  '04-modulate': solution04,
  '05-resonance': solution05,
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
  return {
    id: r.id,
    title: r.title,
    brief: r.brief,
    grantedModules: r.grantedModules,
    query: r.query,
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
