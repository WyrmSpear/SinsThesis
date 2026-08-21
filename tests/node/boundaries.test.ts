import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

describe('engine boundaries', () => {
  const files = walk('src/engine').filter((f) => f.endsWith('.ts'))

  it('finds engine source to check', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it('never imports from the UI layer or Svelte', () => {
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      expect(source, `${file} must not import UI code`).not.toMatch(/from\s+['"](.*\/ui\/|svelte)/)
    }
  })

  it('keeps DSP math out of worklet shells', () => {
    // passthrough.worklet.ts is a deliberate DSP-free build probe -- it exists
    // to prove the one-bundle-per-worklet build works at all, not to carry
    // any signal processing, so it has nothing to import from dsp/.
    // peak-tap.worklet.ts is the same kind of exception for a different
    // reason: it's test-only instrumentation (tests/browser/startup-thump.test.ts)
    // that copies its input block back to the main thread verbatim to
    // measure it there -- there is no signal processing to delegate to dsp/.
    // recorder.worklet.ts is the same shape again, this time for production
    // use: the studio layer's live recording tap (src/engine/recorder.ts)
    // also just copies its input back to the main thread verbatim, batched,
    // for `wav.ts` to encode later -- no signal processing happens on the
    // audio thread here either.
    // cpu-meter.worklet.ts is the same shape once more: it measures the
    // audio thread's own wall-clock timing (Section 11's CPU-overload
    // failure mode, see its own doc comment), never touching the signal
    // itself, so there is no DSP to delegate to dsp/ either.
    const DSP_FREE_WORKLETS = [
      'passthrough.worklet.ts', 'peak-tap.worklet.ts', 'recorder.worklet.ts', 'cpu-meter.worklet.ts',
    ]
    for (const file of files.filter(
      (f) => f.endsWith('.worklet.ts') && !DSP_FREE_WORKLETS.some((name) => f.endsWith(name)),
    )) {
      const source = readFileSync(file, 'utf8')
      expect(source, `${file} must import its math from dsp/`).toMatch(/from\s+['"]\.\.\/dsp\//)
    }
  })

  it('keeps AudioWorklet globals inside worklet files', () => {
    // `declare global` in audioworklet-globals.d.ts reaches the whole program,
    // so these names typecheck anywhere under src/ but only exist at runtime
    // inside AudioWorkletGlobalScope. This test is the guardrail that scoping
    // would otherwise provide.
    //
    // A naive "does the word appear" check flags many engine files that are
    // legitimately innocent: `sampleRate` is a common *parameter* name (DSP
    // math is pure and gets threaded the sample rate as data, not read from
    // the worklet global), `ctx.currentTime`/`ctx.sampleRate` are ordinary
    // property reads on an AudioContext, and one doc comment merely mentions
    // "sampleRate" in prose. None of those touch the ambient global. So the
    // check below narrows to genuinely bare, un-shadowed references: it
    // strips comments, then for each name skips any file that locally binds
    // that identifier (as a function parameter, a variable, or an
    // object/interface field) since every bare occurrence in such a file
    // resolves to the local binding, not the AudioWorkletGlobalScope global,
    // and it never counts a property-access occurrence (`x.sampleRate`).
    const GLOBAL_NAMES = ['sampleRate', 'currentTime', 'currentFrame']

    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')

    const declaresLocally = (source: string, name: string): boolean => {
      const paramDecl = new RegExp(`[(,]\\s*${name}\\s*[:=,)]`) // fn parameter: typed, defaulted, or bare
      const varDecl = new RegExp(`\\b(?:const|let|var)\\b[^;=]*\\b${name}\\b`) // variable/destructure
      const fieldDecl = new RegExp(`\\b${name}\\s*:`) // object/interface field
      return paramDecl.test(source) || varDecl.test(source) || fieldDecl.test(source)
    }

    const usesBareGlobal = (source: string, name: string): boolean => {
      const stripped = stripComments(source)
      if (declaresLocally(stripped, name)) return false
      return new RegExp(`(?<!\\.)\\b${name}\\b`).test(stripped)
    }

    const offenders = files
      .filter((f) => !f.endsWith('.worklet.ts') && !f.endsWith('audioworklet-globals.d.ts'))
      .filter((f) => {
        const source = readFileSync(f, 'utf8')
        return GLOBAL_NAMES.some((name) => usesBareGlobal(source, name))
      })
    expect(offenders).toEqual([])
  })
})
