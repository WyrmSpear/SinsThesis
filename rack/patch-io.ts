import type { PatchFile } from '../src/engine/patch'

/**
 * The non-engine half of persistence: turning a `PatchFile` into a
 * downloaded `.sinp` file, turning a chosen `File` back into a `PatchFile`,
 * and the localStorage side of autosave. `src/engine/patch.ts` owns the
 * graph <-> `PatchFile` conversion and format versioning; nothing here
 * touches `PatchGraph` or the registry, so this file could be deleted and
 * the engine would not notice.
 */

const AUTOSAVE_KEY = 'sinsthesis:autosave:v1'

/** A patch/export name turned into a filesystem-safe stem -- shared by
 *  every download this file offers, so a `.sinp` and a `.wav` exported
 *  from the same patch land on matching filenames (`Lead Pluck.sinp`,
 *  `Lead Pluck.wav`) and a folder of exports stays navigable. */
function safeFileStem(name: string): string {
  return (name || 'patch').trim().replace(/[^a-z0-9_-]+/gi, '_') || 'patch'
}

/** Triggers a browser download of `blob` under `filename`. The one seam
 *  every download in this file goes through, so a test can intercept a
 *  download by overriding `URL.createObjectURL` once and catch every kind
 *  of export (see rack-page.test.ts's save/load round trip for the
 *  pattern). */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.append(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** Triggers a browser download of `file` as a `.sinp` (JSON) document. */
export function downloadPatch(file: PatchFile): void {
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
  triggerDownload(blob, `${safeFileStem(file.meta.name)}.sinp`)
}

/** Triggers a browser download of a WAV file, named from the patch that
 *  made it -- the studio layer's "keep the sound you made" (see
 *  docs/CONTINUATION.md's Phase 3 note): a recording or a bounce and the
 *  patch that produced it share a filename stem so a folder of exports
 *  stays navigable and a `.sinp` saved alongside (see rack/main.ts's
 *  export handling) is unambiguous about which recording it belongs to. */
export function downloadWav(patchName: string, wavBuffer: ArrayBuffer): void {
  const blob = new Blob([wavBuffer], { type: 'audio/wav' })
  triggerDownload(blob, `${safeFileStem(patchName)}.wav`)
}

/**
 * Reads a chosen file as JSON. Throws a message naming the file on
 * anything that is not parseable JSON -- a `.sinp` is JSON by definition
 * (`src/engine/patch.ts`), so a parse failure here always means "not a
 * patch file at all," distinct from the version/shape errors `loadPatch`
 * itself raises once the JSON is at least well-formed.
 */
export async function readPatchFile(file: File): Promise<PatchFile> {
  const text = await file.text()
  try {
    return JSON.parse(text) as PatchFile
  } catch (err) {
    throw new Error(`"${file.name}" is not a valid .sinp file (not JSON): ${(err as Error).message}`)
  }
}

/** Autosave is a convenience, not a guarantee: a `localStorage` write can
 *  throw (quota exceeded, private browsing in some browsers), and losing
 *  that write should never surface as if the operator's own save failed. */
export function saveAutosave(file: PatchFile): void {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(file))
  } catch {
    /* best-effort; explicit Save/Load is the durable path */
  }
}

export function loadAutosave(): PatchFile | undefined {
  const raw = localStorage.getItem(AUTOSAVE_KEY)
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as PatchFile
  } catch {
    return undefined
  }
}

export function clearAutosave(): void {
  try {
    localStorage.removeItem(AUTOSAVE_KEY)
  } catch {
    /* best-effort, see saveAutosave */
  }
}

/** Coalesces a burst of rapid changes (a knob drag fires on every
 *  `pointermove`) into one write, trailing-edge. */
export function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  return () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(fn, ms)
  }
}
