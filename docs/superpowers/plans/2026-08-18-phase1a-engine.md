# SinsThesis Phase 1A — Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the headless SinsThesis audio engine — DSP cores, module registry, patch graph, patch format, and the analysis layer — so that a patch can be constructed in code, rendered offline, and measured numerically.

**Architecture:** Three concentric rings. Pure functions at the center (DSP math, FFT, feature extraction) run in Node with no audio context. Around them, graph and patch logic operate on an injected `ModuleInstance` interface, so they test against stubs. Only the outermost ring — worklet shells and module factories — needs a real `AudioContext`, and those are exercised in headless Chromium through `OfflineAudioContext`. `engine/` imports nothing from `ui/`, now or ever.

**Tech Stack:** TypeScript 5.6, Vite 6, Vitest 3 (two projects: `node` and `browser` via Playwright Chromium), Node 22.

**Spec:** `docs/superpowers/specs/2026-08-18-sinsthesis-phase1-design.md`

## Global Constraints

- `src/engine/**` must never import from `src/ui/**`, `svelte`, or any DOM global. Task 16 enforces this with a test.
- Every worklet's DSP math lives in a pure module exporting a function; the `AudioWorkletProcessor` is a thin shell around it. No DSP math inside a processor class.
- Signal types are exactly `'audio' | 'cv' | 'gate'`. Any port may connect to any port.
- Pitch CV is 1.0 per octave, referenced to A4 = 440 Hz. Gates are 0 or 1. Audio spans ±1.
- Patch files carry no theme. Unknown module types load as ghosts that preserve params and cables.
- Node 22, ESM only (`"type": "module"`). No CommonJS.
- Every task ends with a commit. Test-first, always: write the failing test, watch it fail, then implement.

---

## File Structure

```
package.json                          toolchain, scripts, deps
tsconfig.json                         strict TS, ESM, DOM + WebAudio libs
vitest.config.ts                      two projects: node (pure) + browser (audio)
src/engine/
  types.ts                            SignalType, PortSpec, ParamSpec, LayoutItem,
                                      ModuleDescriptor, ModuleInstance
  registry.ts                         descriptor registration and lookup
  graph.ts                            PatchGraph: modules, cables, connect/disconnect
  cycle.ts                            pure cycle detection over an edge list
  patch.ts                            .sinp serialize / deserialize / ghost modules
  render.ts                           OfflineAudioContext render harness (browser only)
  clock.ts                            transport: BPM, divisions, scheduling
  midi.ts                             Web MIDI access, note and CC events
  analysis/
    fft.ts                            radix-2 FFT (pure)
    features.ts                       spectrum and time-domain measurements (pure)
    inspector.ts                      graph queries with tolerances
  dsp/
    polyblep.ts                       antialiased oscillator core (pure)
    ladder.ts                         ZDF/TPT four-pole ladder (pure)
    wavefolder.ts                     reflective folder (pure)
    segment.ts                        ADSR and sample-and-hold core (pure)
  worklets/
    vco.worklet.ts                    shell over dsp/polyblep
    ladder.worklet.ts                 shell over dsp/ladder
    wavefolder.worklet.ts             shell over dsp/wavefolder
    segment.worklet.ts                shell over dsp/segment
  modules/
    index.ts                          registers all thirteen descriptors
    vco.ts  noise.ts  vcf.ts  vca.ts  wavefolder.ts
    adsr.ts  lfo.ts  sh.ts
    mixer.ts  multiple.ts  delay.ts
    clock-module.ts  sequencer.ts  keyboard-midi.ts  output.ts
tests/
  node/                               pure tests, no audio context
  browser/                            rendered tests, real OfflineAudioContext
  helpers/stub-instance.ts            fake ModuleInstance for graph tests
```

Files split by responsibility rather than by layer: a module's descriptor and
its factory live in one file, because they change together.

---

### Task 1: Toolchain and the first passing test

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` (append)
- Create: `src/engine/version.ts`
- Test: `tests/node/version.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ENGINE_VERSION: string`. Two runnable commands, `npm test` (node project) and `npm run test:browser` (browser project).

- [ ] **Step 1: Create the toolchain files**

`package.json`:

```json
{
  "name": "sinsthesis",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run --project node",
    "test:watch": "vitest --project node",
    "test:browser": "vitest run --project browser",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@vitest/browser": "^3.0.0",
    "playwright": "^1.48.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vitest": "^3.0.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "types": ["vitest/globals"]
  },
  "include": ["src", "tests", "vitest.config.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/node/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'browser',
          include: ['tests/browser/**/*.test.ts'],
          browser: {
            enabled: true,
            provider: 'playwright',
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})
```

Append to `.gitignore`:

```
node_modules/
dist/
coverage/
```

- [ ] **Step 2: Install dependencies**

Run: `npm install && npx playwright install chromium`
Expected: installs cleanly, Chromium downloads.

- [ ] **Step 3: Write the failing test**

`tests/node/version.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { ENGINE_VERSION } from '../../src/engine/version'

describe('engine version', () => {
  it('reports a semver string', () => {
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `../../src/engine/version`.

- [ ] **Step 5: Write the minimal implementation**

`src/engine/version.ts`:

```ts
export const ENGINE_VERSION = '0.1.0'
```

- [ ] **Step 6: Run it to verify it passes**

Run: `npm test`
Expected: PASS, 1 test.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src tests
git commit -m "chore(engine): toolchain, two vitest projects, first passing test"
```

---

### Task 2: FFT

**Files:**
- Create: `src/engine/analysis/fft.ts`
- Test: `tests/node/analysis/fft.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `fftMagnitude(samples: Float32Array): Float32Array` — returns `n/2` magnitude bins for an input whose length is a power of two, Hann-windowed, normalized so a full-scale sine reads 1.0 at its bin.

Every DSP task downstream measures its output with this, so it comes first.

- [ ] **Step 1: Write the failing test**

`tests/node/analysis/fft.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { fftMagnitude } from '../../../src/engine/analysis/fft'

function sine(freq: number, sampleRate: number, n: number): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate)
  return out
}

describe('fftMagnitude', () => {
  it('rejects non-power-of-two input', () => {
    expect(() => fftMagnitude(new Float32Array(1000))).toThrow(/power of two/)
  })

  it('returns n/2 bins', () => {
    expect(fftMagnitude(new Float32Array(1024)).length).toBe(512)
  })

  it('puts a 1 kHz sine in the 1 kHz bin', () => {
    const sr = 48000
    const n = 4096
    const mags = fftMagnitude(sine(1000, sr, n))
    let peak = 0
    for (let i = 1; i < mags.length; i++) if (mags[i]! > mags[peak]!) peak = i
    const peakHz = (peak * sr) / n
    expect(peakHz).toBeCloseTo(1000, -1)
  })

  it('normalizes a full-scale sine to about 1.0', () => {
    const mags = fftMagnitude(sine(1000, 48000, 4096))
    const peak = Math.max(...mags)
    expect(peak).toBeGreaterThan(0.9)
    expect(peak).toBeLessThan(1.1)
  })

  it('reports near-zero energy for silence', () => {
    const mags = fftMagnitude(new Float32Array(1024))
    expect(Math.max(...mags)).toBeLessThan(1e-9)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- fft`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`src/engine/analysis/fft.ts`:

```ts
/**
 * Radix-2 FFT with a Hann window, used by every measurement in the engine.
 * Pure: no audio context, no DOM, runs identically in Node and the browser.
 */

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0
}

/** In-place complex FFT. `re` and `im` must be the same power-of-two length. */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j]!, re[i]!]
      ;[im[i], im[j]] = [im[j]!, im[i]!]
    }
  }

  // Danielson-Lanczos butterflies.
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k]!
        const aIm = im[i + k]!
        const bRe = re[i + k + len / 2]! * curRe - im[i + k + len / 2]! * curIm
        const bIm = re[i + k + len / 2]! * curIm + im[i + k + len / 2]! * curRe
        re[i + k] = aRe + bRe
        im[i + k] = aIm + bIm
        re[i + k + len / 2] = aRe - bRe
        im[i + k + len / 2] = aIm - bIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

/**
 * Magnitude spectrum of a real signal.
 *
 * Applies a Hann window and scales so that a full-scale sine reads ~1.0 at
 * its bin. Returns n/2 bins; bin i corresponds to i * sampleRate / n Hz.
 */
export function fftMagnitude(samples: Float32Array): Float32Array {
  const n = samples.length
  if (!isPowerOfTwo(n)) {
    throw new Error(`fftMagnitude: length ${n} is not a power of two`)
  }

  const re = new Float64Array(n)
  const im = new Float64Array(n)

  // Hann window; its coherent gain of 0.5 is corrected in the scale below.
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)))
    re[i] = samples[i]! * w
  }

  fftInPlace(re, im)

  const half = n >> 1
  const out = new Float32Array(half)
  const scale = 4 / n // 2/n for the one-sided spectrum, 2x for Hann's 0.5 gain
  for (let i = 0; i < half; i++) {
    out[i] = Math.hypot(re[i]!, im[i]!) * scale
  }
  return out
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- fft`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/analysis/fft.ts tests/node/analysis/fft.test.ts
git commit -m "feat(analysis): radix-2 FFT with Hann window and normalized magnitude"
```

---

### Task 3: Measurements

**Files:**
- Create: `src/engine/analysis/features.ts`
- Test: `tests/node/analysis/features.test.ts`

**Interfaces:**
- Consumes: `fftMagnitude` from Task 2.
- Produces:
  - `binToHz(bin: number, sampleRate: number, fftSize: number): number`
  - `peakHz(samples: Float32Array, sampleRate: number): number`
  - `rms(samples: Float32Array): number`
  - `rmsEnvelope(samples: Float32Array, windowSize: number): Float32Array`
  - `spectralCentroid(samples: Float32Array, sampleRate: number): number`
  - `slopeDbPerOctave(samples: Float32Array, sampleRate: number, fromHz: number, toHz: number): number`
  - `aliasFloorDb(samples: Float32Array, sampleRate: number, fundamentalHz: number): number`

These are the numbers the whole test suite asserts on, and the same numbers
Phase 2 draws and Phase 4 grades with.

- [ ] **Step 1: Write the failing test**

`tests/node/analysis/features.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  peakHz, rms, rmsEnvelope, spectralCentroid, slopeDbPerOctave, aliasFloorDb,
} from '../../../src/engine/analysis/features'

const SR = 48000
const N = 8192

function gen(n: number, fn: (i: number) => number): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = fn(i)
  return out
}

const sine = (hz: number) => gen(N, (i) => Math.sin((2 * Math.PI * hz * i) / SR))

/** Band-limited saw built from partials, so it has no aliasing by construction. */
function bandlimitedSaw(hz: number): Float32Array {
  const partials = Math.floor(SR / 2 / hz)
  return gen(N, (i) => {
    let v = 0
    for (let k = 1; k <= partials; k++) v += Math.sin((2 * Math.PI * k * hz * i) / SR) / k
    return (v * 2) / Math.PI
  })
}

describe('peakHz', () => {
  it('finds the fundamental of a sine', () => {
    expect(peakHz(sine(440), SR)).toBeCloseTo(440, -1)
  })
})

describe('rms', () => {
  it('reads 1/sqrt(2) for a unit sine', () => {
    expect(rms(sine(1000))).toBeCloseTo(Math.SQRT1_2, 2)
  })

  it('reads zero for silence', () => {
    expect(rms(new Float32Array(1024))).toBe(0)
  })
})

describe('rmsEnvelope', () => {
  it('tracks a decaying signal downward', () => {
    const decaying = gen(4096, (i) => Math.sin(i * 0.1) * (1 - i / 4096))
    const env = rmsEnvelope(decaying, 256)
    expect(env.length).toBe(16)
    expect(env[0]!).toBeGreaterThan(env[env.length - 1]!)
  })
})

describe('spectralCentroid', () => {
  it('sits near the fundamental for a sine', () => {
    expect(spectralCentroid(sine(1000), SR)).toBeCloseTo(1000, -2)
  })

  it('is higher for a saw than for a sine at the same pitch', () => {
    expect(spectralCentroid(bandlimitedSaw(200), SR))
      .toBeGreaterThan(spectralCentroid(sine(200), SR))
  })
})

describe('slopeDbPerOctave', () => {
  it('measures about -6 dB/oct across a saw\'s partials', () => {
    // A saw's partial amplitudes fall as 1/k, which is -6 dB per octave.
    const slope = slopeDbPerOctave(bandlimitedSaw(100), SR, 400, 3200)
    expect(slope).toBeGreaterThan(-8)
    expect(slope).toBeLessThan(-4)
  })
})

describe('aliasFloorDb', () => {
  it('reports a very low floor for a band-limited saw', () => {
    expect(aliasFloorDb(bandlimitedSaw(2000), SR, 2000)).toBeLessThan(-60)
  })

  it('reports a high floor for a naive saw', () => {
    // A naive saw at 2 kHz folds partials back below the fundamental.
    const naive = gen(N, (i) => 2 * (((i * 2000) / SR) % 1) - 1)
    expect(aliasFloorDb(naive, SR, 2000)).toBeGreaterThan(-40)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- features`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`src/engine/analysis/features.ts`:

```ts
import { fftMagnitude } from './fft'

/** Largest power of two that fits in `n`. */
function fitPow2(n: number): number {
  let p = 1
  while (p * 2 <= n) p *= 2
  return p
}

function spectrumOf(samples: Float32Array): Float32Array {
  const size = fitPow2(samples.length)
  return fftMagnitude(samples.subarray(0, size))
}

export function binToHz(bin: number, sampleRate: number, fftSize: number): number {
  return (bin * sampleRate) / fftSize
}

export function peakHz(samples: Float32Array, sampleRate: number): number {
  const size = fitPow2(samples.length)
  const mags = fftMagnitude(samples.subarray(0, size))
  let peak = 1
  for (let i = 1; i < mags.length; i++) if (mags[i]! > mags[peak]!) peak = i
  return binToHz(peak, sampleRate, size)
}

export function rms(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!
  return Math.sqrt(sum / samples.length)
}

/** One RMS value per `windowSize` samples. Trailing partial window is dropped. */
export function rmsEnvelope(samples: Float32Array, windowSize: number): Float32Array {
  const count = Math.floor(samples.length / windowSize)
  const out = new Float32Array(count)
  for (let w = 0; w < count; w++) {
    out[w] = rms(samples.subarray(w * windowSize, (w + 1) * windowSize))
  }
  return out
}

export function spectralCentroid(samples: Float32Array, sampleRate: number): number {
  const size = fitPow2(samples.length)
  const mags = fftMagnitude(samples.subarray(0, size))
  let weighted = 0
  let total = 0
  for (let i = 1; i < mags.length; i++) {
    weighted += binToHz(i, sampleRate, size) * mags[i]!
    total += mags[i]!
  }
  return total === 0 ? 0 : weighted / total
}

const EPS = 1e-12
const db = (x: number) => 20 * Math.log10(Math.max(x, EPS))

/**
 * Least-squares slope of the spectrum in dB against log2(Hz), measured between
 * `fromHz` and `toHz`. A one-pole filter reads about -6, a four-pole about -24.
 */
export function slopeDbPerOctave(
  samples: Float32Array, sampleRate: number, fromHz: number, toHz: number,
): number {
  const size = fitPow2(samples.length)
  const mags = fftMagnitude(samples.subarray(0, size))
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 1; i < mags.length; i++) {
    const hz = binToHz(i, sampleRate, size)
    if (hz < fromHz || hz > toHz) continue
    xs.push(Math.log2(hz))
    ys.push(db(mags[i]!))
  }
  if (xs.length < 2) throw new Error('slopeDbPerOctave: band too narrow to fit')

  const n = xs.length
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  const meanY = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - meanX) * (ys[i]! - meanY)
    den += (xs[i]! - meanX) ** 2
  }
  return num / den
}

/**
 * Loudest non-harmonic content, in dB relative to the fundamental.
 *
 * Bins within a quarter-tone of any integer multiple of `fundamentalHz` count
 * as harmonic and are excluded; everything else is alias or noise. An
 * antialiased oscillator should stay below -60.
 */
export function aliasFloorDb(
  samples: Float32Array, sampleRate: number, fundamentalHz: number,
): number {
  const size = fitPow2(samples.length)
  const mags = fftMagnitude(samples.subarray(0, size))
  const binHz = sampleRate / size
  const tolerance = Math.max(binHz * 2, fundamentalHz * 0.03)

  let fundamental = 0
  let worstAlias = 0
  for (let i = 1; i < mags.length; i++) {
    const hz = binToHz(i, sampleRate, size)
    const nearestHarmonic = Math.round(hz / fundamentalHz) * fundamentalHz
    const isHarmonic = nearestHarmonic > 0 && Math.abs(hz - nearestHarmonic) <= tolerance
    if (isHarmonic) {
      if (Math.abs(nearestHarmonic - fundamentalHz) <= tolerance) {
        fundamental = Math.max(fundamental, mags[i]!)
      }
    } else if (mags[i]! > worstAlias) {
      worstAlias = mags[i]!
    }
  }
  if (fundamental === 0) throw new Error('aliasFloorDb: no energy at the fundamental')
  return db(worstAlias) - db(fundamental)
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- features`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/analysis/features.ts tests/node/analysis/features.test.ts
git commit -m "feat(analysis): spectrum and envelope measurements"
```

---

### Task 4: PolyBLEP oscillator core

**Files:**
- Create: `src/engine/dsp/polyblep.ts`
- Test: `tests/node/dsp/polyblep.test.ts`

**Interfaces:**
- Consumes: `peakHz`, `aliasFloorDb` from Task 3.
- Produces:
  - `type OscShape = 'saw' | 'pulse' | 'tri' | 'sine'`
  - `interface OscState { phase: number; triIntegrator: number }`
  - `createOscState(phase?: number): OscState`
  - `oscSample(state: OscState, shape: OscShape, freq: number, sampleRate: number, pulseWidth?: number): number`
  - `hardSync(state: OscState): void`

The LFO reuses this core at sub-audio rates, so it must stay stable below 1 Hz.

- [ ] **Step 1: Write the failing test**

`tests/node/dsp/polyblep.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createOscState, oscSample, hardSync, type OscShape } from '../../../src/engine/dsp/polyblep'
import { peakHz, aliasFloorDb, rms } from '../../../src/engine/analysis/features'

const SR = 48000
const N = 8192

function render(shape: OscShape, freq: number, pw = 0.5): Float32Array {
  const state = createOscState()
  const out = new Float32Array(N)
  for (let i = 0; i < N; i++) out[i] = oscSample(state, shape, freq, SR, pw)
  return out
}

describe.each(['saw', 'pulse', 'tri', 'sine'] as OscShape[])('%s oscillator', (shape) => {
  it('oscillates at the requested frequency', () => {
    expect(peakHz(render(shape, 440), SR)).toBeCloseTo(440, -1)
  })

  it('stays inside +/-1.05', () => {
    const out = render(shape, 220)
    for (const v of out) expect(Math.abs(v)).toBeLessThan(1.05)
  })

  it('produces signal, not silence', () => {
    expect(rms(render(shape, 220))).toBeGreaterThan(0.05)
  })
})

describe('antialiasing', () => {
  it('holds the saw alias floor below -60 dB at 2 kHz', () => {
    expect(aliasFloorDb(render('saw', 2000), SR, 2000)).toBeLessThan(-60)
  })

  it('holds the pulse alias floor below -60 dB at 2 kHz', () => {
    expect(aliasFloorDb(render('pulse', 2000), SR, 2000)).toBeLessThan(-60)
  })
})

describe('pulse width', () => {
  it('shifts the duty cycle away from square', () => {
    // A 25% pulse spends less time high, so its mean sits lower than a square's.
    const mean = (a: Float32Array) => a.reduce((s, v) => s + v, 0) / a.length
    expect(mean(render('pulse', 100, 0.25))).toBeLessThan(mean(render('pulse', 100, 0.5)) - 0.2)
  })
})

describe('sub-audio rates', () => {
  it('runs an LFO at 0.5 Hz without going unstable', () => {
    const state = createOscState()
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < SR * 4; i++) {
      const v = oscSample(state, 'tri', 0.5, SR)
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
    expect(max).toBeGreaterThan(0.8)
    expect(min).toBeLessThan(-0.8)
    expect(Number.isFinite(max)).toBe(true)
  })
})

describe('hardSync', () => {
  it('resets phase so the next sample restarts the cycle', () => {
    const state = createOscState()
    for (let i = 0; i < 100; i++) oscSample(state, 'saw', 440, SR)
    hardSync(state)
    expect(state.phase).toBe(0)
    const first = oscSample(state, 'saw', 440, SR)
    expect(first).toBeLessThan(-0.9)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- polyblep`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`src/engine/dsp/polyblep.ts`:

```ts
/**
 * PolyBLEP oscillator core.
 *
 * A naive saw or pulse steps discontinuously once per cycle, and that step
 * folds energy back below Nyquist as audible alias tones. PolyBLEP subtracts a
 * polynomial approximation of a band-limited step at each discontinuity, which
 * buys roughly 60 dB of alias rejection for a few arithmetic operations.
 *
 * Pure by design: no audio context, no DOM. The worklet is a shell over this.
 */

export type OscShape = 'saw' | 'pulse' | 'tri' | 'sine'

export interface OscState {
  /** Normalized phase in [0, 1). */
  phase: number
  /** Leaky integrator state used to derive triangle from a square. */
  triIntegrator: number
}

export function createOscState(phase = 0): OscState {
  return { phase, triIntegrator: 0 }
}

/** Restart the cycle. Used by the VCO's hard-sync input. */
export function hardSync(state: OscState): void {
  state.phase = 0
  state.triIntegrator = 0
}

/**
 * Correction applied near a discontinuity. `t` is the phase, `dt` the phase
 * increment per sample; the polynomial spans one sample either side of the step.
 */
function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt
    return x + x - x * x - 1
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt
    return x * x + x + x + 1
  }
  return 0
}

const TWO_PI = Math.PI * 2

/** Advance one sample and return the oscillator's output in [-1, 1]. */
export function oscSample(
  state: OscState,
  shape: OscShape,
  freq: number,
  sampleRate: number,
  pulseWidth = 0.5,
): number {
  const dt = Math.abs(freq) / sampleRate
  state.phase += dt
  if (state.phase >= 1) state.phase -= 1

  const t = state.phase

  switch (shape) {
    case 'sine':
      return Math.sin(TWO_PI * t)

    case 'saw':
      return 2 * t - 1 - polyBlep(t, dt)

    case 'pulse': {
      const pw = Math.min(Math.max(pulseWidth, 0.01), 0.99)
      let v = t < pw ? 1 : -1
      v += polyBlep(t, dt)
      let fall = t - pw
      if (fall < 0) fall += 1
      v -= polyBlep(fall, dt)
      return v
    }

    case 'tri': {
      // Integrate a band-limited square. The leak keeps DC from accumulating
      // over long runs, which matters when this core drives an LFO for minutes.
      let square = t < 0.5 ? 1 : -1
      square += polyBlep(t, dt)
      let half = t + 0.5
      if (half >= 1) half -= 1
      square -= polyBlep(half, dt)

      state.triIntegrator = state.triIntegrator * 0.9995 + 4 * dt * square
      return Math.min(Math.max(state.triIntegrator, -1), 1)
    }
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- polyblep`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/dsp/polyblep.ts tests/node/dsp/polyblep.test.ts
git commit -m "feat(dsp): PolyBLEP oscillator core with saw, pulse, triangle, sine"
```

---

### Task 5: ZDF ladder filter core

**Files:**
- Create: `src/engine/dsp/ladder.ts`
- Test: `tests/node/dsp/ladder.test.ts`

**Interfaces:**
- Consumes: `slopeDbPerOctave`, `peakHz`, `rms` from Task 3.
- Produces:
  - `interface LadderState { s: [number, number, number, number] }`
  - `createLadderState(): LadderState`
  - `ladderSample(state: LadderState, input: number, cutoffHz: number, resonance: number, sampleRate: number): number` — `resonance` spans 0 to 1, where 1 self-oscillates.

This is the character of the instrument. A one-pole cascade would be cheaper
and would sound wrong: the ladder's four poles share one feedback path through
a saturating stage, which is why resonance thickens instead of merely peaking.

- [ ] **Step 1: Write the failing test**

`tests/node/dsp/ladder.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createLadderState, ladderSample } from '../../../src/engine/dsp/ladder'
import { slopeDbPerOctave, peakHz, rms } from '../../../src/engine/analysis/features'

const SR = 48000
const N = 16384

function noise(n: number, amp = 0.25): Float32Array {
  // Deterministic pseudo-noise: a fixed seed keeps the test reproducible.
  let seed = 12345
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    out[i] = ((seed / 0x7fffffff) * 2 - 1) * amp
  }
  return out
}

function filter(input: Float32Array, cutoff: number, res: number): Float32Array {
  const state = createLadderState()
  const out = new Float32Array(input.length)
  for (let i = 0; i < input.length; i++) {
    out[i] = ladderSample(state, input[i]!, cutoff, res, SR)
  }
  return out
}

describe('ladder response', () => {
  it('rolls off about -24 dB per octave above cutoff', () => {
    const slope = slopeDbPerOctave(filter(noise(N), 1000, 0), SR, 2000, 12000)
    expect(slope).toBeLessThan(-18)
    expect(slope).toBeGreaterThan(-30)
  })

  it('passes low frequencies close to unity', () => {
    const input = new Float32Array(N)
    for (let i = 0; i < N; i++) input[i] = Math.sin((2 * Math.PI * 100 * i) / SR) * 0.5
    const out = filter(input, 8000, 0)
    // Skip the first 1000 samples so the filter has settled.
    expect(rms(out.subarray(1000))).toBeGreaterThan(rms(input.subarray(1000)) * 0.8)
  })

  it('attenuates a tone an octave above cutoff', () => {
    const input = new Float32Array(N)
    for (let i = 0; i < N; i++) input[i] = Math.sin((2 * Math.PI * 2000 * i) / SR) * 0.5
    const out = filter(input, 1000, 0)
    expect(rms(out.subarray(1000))).toBeLessThan(rms(input) * 0.2)
  })
})

describe('resonance', () => {
  it('self-oscillates at the cutoff frequency when driven to the limit', () => {
    // A brief noise burst starts it; the rest is silence, so any remaining
    // signal is the filter ringing on its own.
    const input = new Float32Array(N)
    input.set(noise(256, 0.5))
    const out = filter(input, 1000, 1)
    const tail = out.subarray(N / 2)
    expect(rms(tail)).toBeGreaterThan(0.01)
    expect(peakHz(tail, SR)).toBeCloseTo(1000, -2)
  })

  it('does not self-oscillate with resonance at zero', () => {
    const input = new Float32Array(N)
    input.set(noise(256, 0.5))
    const out = filter(input, 1000, 0)
    expect(rms(out.subarray(N / 2))).toBeLessThan(0.001)
  })

  it('stays bounded when driven hard at full resonance', () => {
    const out = filter(noise(N, 4), 2000, 1)
    for (const v of out) expect(Number.isFinite(v) && Math.abs(v) < 4).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- ladder`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`src/engine/dsp/ladder.ts`:

```ts
/**
 * Zero-delay-feedback (TPT) four-pole ladder filter.
 *
 * Four one-pole stages sit inside a single feedback loop. A naive
 * implementation delays that loop by one sample, which detunes the resonant
 * peak and turns self-oscillation unstable near the top of the range. Solving
 * the loop algebraically (the `u` term below) removes the delay, so the peak
 * lands where the cutoff says it should and full resonance oscillates cleanly.
 *
 * The tanh on the loop input is the transistor nonlinearity: it compresses as
 * resonance climbs, which is why the real circuit thickens rather than
 * screaming into clipping.
 */

export interface LadderState {
  /** Integrator state, one per pole. */
  s: [number, number, number, number]
}

export function createLadderState(): LadderState {
  return { s: [0, 0, 0, 0] }
}

/**
 * Process one sample.
 *
 * @param resonance 0 to 1. 1 places the loop gain at self-oscillation.
 */
export function ladderSample(
  state: LadderState,
  input: number,
  cutoffHz: number,
  resonance: number,
  sampleRate: number,
): number {
  const nyquist = sampleRate * 0.5
  const fc = Math.min(Math.max(cutoffHz, 10), nyquist * 0.99)

  // Bilinear prewarp, so the digital cutoff matches the analog one.
  const wd = 2 * Math.PI * fc
  const T = 1 / sampleRate
  const wa = (2 / T) * Math.tan((wd * T) / 2)
  const g = (wa * T) / 2
  const G = g / (1 + g)

  const k = Math.min(Math.max(resonance, 0), 1) * 4

  const [s0, s1, s2, s3] = state.s

  // Contribution of the stored state to the loop output, folded back to the input.
  const S = (((s0 * G + s1) * G + s2) * G + s3) / (1 + g)

  // Zero-delay solve for the ladder input.
  const G4 = G * G * G * G
  const u = Math.tanh((input - k * S) / (1 + k * G4))

  // Four TPT one-poles in series.
  let x = u
  for (let i = 0; i < 4; i++) {
    const v = (x - state.s[i]!) * G
    const y = v + state.s[i]!
    state.s[i] = y + v
    x = y
  }
  return x
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- ladder`
Expected: PASS, 6 tests.

If the self-oscillation test rings at the wrong frequency, the prewarp is
wrong; if it decays to silence, `k` is not reaching 4.

- [ ] **Step 5: Commit**

```bash
git add src/engine/dsp/ladder.ts tests/node/dsp/ladder.test.ts
git commit -m "feat(dsp): zero-delay-feedback ladder filter with transistor saturation"
```

---

### Task 6: Wavefolder and segment generator cores

**Files:**
- Create: `src/engine/dsp/wavefolder.ts`, `src/engine/dsp/segment.ts`
- Test: `tests/node/dsp/wavefolder.test.ts`, `tests/node/dsp/segment.test.ts`

**Interfaces:**
- Consumes: `spectralCentroid`, `rms` from Task 3.
- Produces:
  - `foldSample(input: number, drive: number, symmetry?: number): number`
  - `type EnvStage = 'idle' | 'attack' | 'decay' | 'sustain' | 'release'`
  - `interface EnvState { stage: EnvStage; level: number }`
  - `interface AdsrParams { attack: number; decay: number; sustain: number; release: number }`
  - `createEnvState(): EnvState`
  - `envSample(state: EnvState, gate: number, p: AdsrParams, sampleRate: number): number`
  - `interface SampleHoldState { held: number; lastTrigger: number }`
  - `createSampleHoldState(): SampleHoldState`
  - `sampleHold(state: SampleHoldState, input: number, trigger: number): number`

ADSR and sample-and-hold share this file because both are gate-driven state
machines over a held level, and they change together.

- [ ] **Step 1: Write the failing tests**

`tests/node/dsp/wavefolder.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { foldSample } from '../../../src/engine/dsp/wavefolder'
import { spectralCentroid } from '../../../src/engine/analysis/features'

const SR = 48000
const N = 8192

function foldedSine(drive: number): Float32Array {
  const out = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    out[i] = foldSample(Math.sin((2 * Math.PI * 200 * i) / SR), drive)
  }
  return out
}

describe('foldSample', () => {
  it('passes signal through unchanged at unity drive', () => {
    expect(foldSample(0.5, 1)).toBeCloseTo(0.5, 6)
    expect(foldSample(-0.5, 1)).toBeCloseTo(-0.5, 6)
  })

  it('reflects a value that exceeds +1', () => {
    // 1.5 folds back to 2 - 1.5 = 0.5
    expect(foldSample(1.5, 1)).toBeCloseTo(0.5, 6)
  })

  it('reflects a value below -1', () => {
    expect(foldSample(-1.5, 1)).toBeCloseTo(-0.5, 6)
  })

  it('keeps output inside +/-1 even at extreme drive', () => {
    for (let d = 1; d <= 20; d += 0.5) {
      for (let x = -1; x <= 1; x += 0.05) {
        expect(Math.abs(foldSample(x, d))).toBeLessThanOrEqual(1.0001)
      }
    }
  })

  it('adds harmonics as drive rises', () => {
    expect(spectralCentroid(foldedSine(6), SR))
      .toBeGreaterThan(spectralCentroid(foldedSine(1), SR) * 2)
  })
})
```

`tests/node/dsp/segment.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  createEnvState, envSample, createSampleHoldState, sampleHold, type AdsrParams,
} from '../../../src/engine/dsp/segment'

const SR = 48000
const P: AdsrParams = { attack: 0.01, decay: 0.05, sustain: 0.5, release: 0.1 }

function run(gate: number, seconds: number, state = createEnvState(), p = P): {
  state: ReturnType<typeof createEnvState>; last: number; values: number[]
} {
  const values: number[] = []
  let last = 0
  for (let i = 0; i < SR * seconds; i++) {
    last = envSample(state, gate, p, SR)
    values.push(last)
  }
  return { state, last, values }
}

describe('envSample', () => {
  it('sits at zero while idle', () => {
    expect(run(0, 0.05).last).toBe(0)
  })

  it('rises monotonically during attack', () => {
    const { values } = run(1, 0.008)
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!)
    }
  })

  it('reaches the peak by the end of attack', () => {
    expect(run(1, 0.05).last).toBeGreaterThan(0.9)
  })

  it('settles at the sustain level while the gate is held', () => {
    expect(run(1, 0.5).last).toBeCloseTo(P.sustain, 2)
  })

  it('falls to near silence after the gate releases', () => {
    const held = run(1, 0.5)
    expect(run(0, 0.6, held.state).last).toBeLessThan(0.01)
  })

  it('retriggers from the current level instead of jumping to zero', () => {
    const held = run(1, 0.5)
    const releasing = run(0, 0.02, held.state)
    const levelAtRetrigger = releasing.last
    expect(levelAtRetrigger).toBeGreaterThan(0.01)
    const retriggered = run(1, 0.001, releasing.state)
    expect(retriggered.values[0]!).toBeGreaterThanOrEqual(levelAtRetrigger * 0.9)
  })
})

describe('sampleHold', () => {
  it('holds its output until the next rising edge', () => {
    const state = createSampleHoldState()
    expect(sampleHold(state, 0.7, 1)).toBeCloseTo(0.7)
    expect(sampleHold(state, 0.2, 1)).toBeCloseTo(0.7) // still high, no new edge
    expect(sampleHold(state, 0.2, 0)).toBeCloseTo(0.7)
    expect(sampleHold(state, 0.2, 1)).toBeCloseTo(0.2) // rising edge captures
  })

  it('starts at zero', () => {
    expect(sampleHold(createSampleHoldState(), 0.9, 0)).toBe(0)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- wavefolder segment`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementations**

`src/engine/dsp/wavefolder.ts`:

```ts
/**
 * Reflective wavefolder.
 *
 * Clipping flattens a peak; folding reflects it back down, so the waveform
 * gains inflection points instead of losing them. That is why a folded sine
 * grows a bright, metallic harmonic series while a clipped sine just gets
 * buzzy. Drive scales the signal into the folding region.
 */
export function foldSample(input: number, drive: number, symmetry = 0): number {
  let v = input * Math.max(drive, 0) + symmetry

  // Each pass reflects one excursion past the rails. Extreme drive needs
  // several; the bound keeps the loop finite in the audio thread.
  for (let i = 0; i < 32; i++) {
    if (v > 1) v = 2 - v
    else if (v < -1) v = -2 - v
    else break
  }
  return Math.min(Math.max(v, -1), 1)
}
```

`src/engine/dsp/segment.ts`:

```ts
/**
 * Gate-driven envelope and sample-and-hold cores.
 *
 * The envelope approaches each target exponentially, the way an analog RC
 * stage does, rather than moving in straight lines. Stages advance when the
 * level gets close enough to its target, and release starts from wherever the
 * level currently sits, so a retrigger mid-release never clicks.
 */

export type EnvStage = 'idle' | 'attack' | 'decay' | 'sustain' | 'release'

export interface EnvState {
  stage: EnvStage
  level: number
  /** Previous gate value, used to detect edges. */
  lastGate: number
}

export interface AdsrParams {
  /** Seconds. */
  attack: number
  decay: number
  /** 0 to 1. */
  sustain: number
  /** Seconds. */
  release: number
}

export function createEnvState(): EnvState {
  return { stage: 'idle', level: 0, lastGate: 0 }
}

/** Per-sample coefficient for an exponential approach to a target. */
function coeff(seconds: number, sampleRate: number): number {
  const samples = Math.max(seconds, 0.0001) * sampleRate
  return 1 - Math.exp(-1 / samples)
}

/** Overshoot the target slightly so the stage completes in about its stated time. */
const ATTACK_TARGET = 1.05
const CLOSE_ENOUGH = 0.001

export function envSample(
  state: EnvState,
  gate: number,
  p: AdsrParams,
  sampleRate: number,
): number {
  const high = gate >= 0.5

  if (high && state.lastGate < 0.5) state.stage = 'attack'
  if (!high && state.lastGate >= 0.5) state.stage = 'release'
  state.lastGate = gate

  switch (state.stage) {
    case 'idle':
      state.level = 0
      break

    case 'attack':
      state.level += (ATTACK_TARGET - state.level) * coeff(p.attack, sampleRate)
      if (state.level >= 1) {
        state.level = 1
        state.stage = 'decay'
      }
      break

    case 'decay':
      state.level += (p.sustain - state.level) * coeff(p.decay, sampleRate)
      if (Math.abs(state.level - p.sustain) < CLOSE_ENOUGH) {
        state.level = p.sustain
        state.stage = 'sustain'
      }
      break

    case 'sustain':
      state.level = p.sustain
      break

    case 'release':
      state.level += (0 - state.level) * coeff(p.release, sampleRate)
      if (state.level < CLOSE_ENOUGH) {
        state.level = 0
        state.stage = 'idle'
      }
      break
  }

  return state.level
}

export interface SampleHoldState {
  held: number
  lastTrigger: number
}

export function createSampleHoldState(): SampleHoldState {
  return { held: 0, lastTrigger: 0 }
}

/** Capture `input` on each rising edge of `trigger`, and hold it otherwise. */
export function sampleHold(
  state: SampleHoldState,
  input: number,
  trigger: number,
): number {
  if (trigger >= 0.5 && state.lastTrigger < 0.5) state.held = input
  state.lastTrigger = trigger
  return state.held
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test -- wavefolder segment`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/dsp tests/node/dsp
git commit -m "feat(dsp): reflective wavefolder, ADSR envelope, sample-and-hold"
```

---

### Task 7: Module contract and registry

**Files:**
- Create: `src/engine/types.ts`, `src/engine/registry.ts`
- Create: `tests/helpers/stub-instance.ts`
- Test: `tests/node/registry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the whole module contract, which every later task builds on.
  - `type SignalType = 'audio' | 'cv' | 'gate'`, `type PortDir = 'in' | 'out'`
  - `interface PortSpec { id, dir, signal, label, pos: [number, number] }`
  - `interface ParamSpec { id, label, min, max, default: number, curve: 'lin' | 'exp', unit: string }`
  - `interface LayoutItem { kind: 'knob' | 'jack' | 'switch' | 'button' | 'display', ref: string, x: number, y: number }`
  - `interface ModuleDescriptor { type, name, hp, ports, params, layout, customPanel?, create(ctx) }`
  - `interface ModuleInstance { inputs, outputs, setParam, dispose }`
  - `registerModule(d: ModuleDescriptor): void`, `getModule(type): ModuleDescriptor | undefined`, `listModules(): ModuleDescriptor[]`, `clearRegistry(): void`
  - Test helper: `stubDescriptor(type, opts?)`, `stubContext()`, `type StubNode`

- [ ] **Step 1: Write the failing test**

`tests/node/registry.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { registerModule, getModule, listModules, clearRegistry } from '../../src/engine/registry'
import { stubDescriptor } from '../helpers/stub-instance'

describe('registry', () => {
  beforeEach(() => clearRegistry())

  it('returns undefined for an unregistered type', () => {
    expect(getModule('vco')).toBeUndefined()
  })

  it('stores and retrieves a descriptor', () => {
    const d = stubDescriptor('vco')
    registerModule(d)
    expect(getModule('vco')).toBe(d)
  })

  it('lists registered descriptors', () => {
    registerModule(stubDescriptor('vco'))
    registerModule(stubDescriptor('vcf'))
    expect(listModules().map((d) => d.type).sort()).toEqual(['vcf', 'vco'])
  })

  it('rejects a duplicate type', () => {
    registerModule(stubDescriptor('vco'))
    expect(() => registerModule(stubDescriptor('vco'))).toThrow(/already registered/)
  })

  it('rejects duplicate port ids within a module', () => {
    const d = stubDescriptor('bad')
    d.ports = [
      { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [0, 0] },
      { id: 'out', dir: 'in', signal: 'audio', label: 'In', pos: [0, 1] },
    ]
    expect(() => registerModule(d)).toThrow(/duplicate port/)
  })

  it('rejects a param whose default sits outside its range', () => {
    const d = stubDescriptor('bad')
    d.params = [
      { id: 'freq', label: 'Freq', min: 20, max: 20000, default: 0, curve: 'exp', unit: 'Hz' },
    ]
    expect(() => registerModule(d)).toThrow(/default/)
  })

  it('rejects a layout item referencing an unknown port or param', () => {
    const d = stubDescriptor('bad')
    d.layout = [{ kind: 'knob', ref: 'nonexistent', x: 0, y: 0 }]
    expect(() => registerModule(d)).toThrow(/unknown reference/)
  })
})
```

`tests/helpers/stub-instance.ts`:

```ts
import type {
  ModuleDescriptor, ModuleInstance, PortSpec, ParamSpec,
} from '../../src/engine/types'

/** Records connect and disconnect calls so graph tests can assert on wiring. */
export interface StubNode {
  connections: unknown[]
  connect(target: unknown): void
  disconnect(target?: unknown): void
}

export function stubNode(): StubNode {
  const node: StubNode = {
    connections: [],
    connect(target) {
      node.connections.push(target)
    },
    disconnect(target) {
      if (target === undefined) node.connections.length = 0
      else node.connections = node.connections.filter((c) => c !== target)
    },
  }
  return node
}

/** Minimal stand-in for BaseAudioContext. Only what the graph actually calls. */
export function stubContext(): BaseAudioContext {
  return {
    sampleRate: 48000,
    createDelay: () => stubNode() as unknown as DelayNode,
  } as unknown as BaseAudioContext
}

export function stubDescriptor(
  type: string,
  opts: { ports?: PortSpec[]; params?: ParamSpec[] } = {},
): ModuleDescriptor {
  const ports: PortSpec[] = opts.ports ?? [
    { id: 'in', dir: 'in', signal: 'audio', label: 'In', pos: [0, 0] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [0, 1] },
  ]
  const params: ParamSpec[] = opts.params ?? [
    { id: 'level', label: 'Level', min: 0, max: 1, default: 0.5, curve: 'lin', unit: '' },
  ]
  return {
    type,
    name: type.toUpperCase(),
    hp: 8,
    ports,
    params,
    layout: [],
    create(): ModuleInstance {
      const values = new Map<string, number>()
      const inputs = new Map<string, AudioNode | AudioParam>()
      const outputs = new Map<string, AudioNode>()
      for (const p of ports) {
        const node = stubNode() as unknown as AudioNode
        if (p.dir === 'in') inputs.set(p.id, node)
        else outputs.set(p.id, node)
      }
      return {
        inputs,
        outputs,
        setParam: (id, value) => values.set(id, value),
        dispose: () => values.clear(),
        // Exposed for assertions; not part of the interface.
        ...({ __values: values } as object),
      } as ModuleInstance
    },
  }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- registry`
Expected: FAIL — `src/engine/registry` not found.

- [ ] **Step 3: Write the implementation**

`src/engine/types.ts`:

```ts
/** Ports declare a type for cable color and for the co-pilot to reason about;
 *  the engine still permits any port to reach any port, because voltage is
 *  voltage. Patching audio into a cutoff is a technique, not a mistake. */
export type SignalType = 'audio' | 'cv' | 'gate'

export type PortDir = 'in' | 'out'

export interface PortSpec {
  id: string
  dir: PortDir
  signal: SignalType
  label: string
  /** Grid position on the panel, in panel units. */
  pos: [number, number]
}

export interface ParamSpec {
  id: string
  label: string
  min: number
  max: number
  default: number
  /** `exp` for anything the ear hears logarithmically: frequency, time. */
  curve: 'lin' | 'exp'
  unit: string
}

export interface LayoutItem {
  kind: 'knob' | 'jack' | 'switch' | 'button' | 'display'
  /** A port id or a param id. */
  ref: string
  x: number
  y: number
}

/**
 * Everything the UI needs to draw a module and everything the engine needs to
 * build one. One generic renderer reads this, which is why thirty modules
 * across eight themes do not become 240 hand-maintained panels.
 */
export interface ModuleDescriptor {
  type: string
  name: string
  /** Panel width in horizontal pitch units, as in a physical rack. */
  hp: number
  ports: PortSpec[]
  params: ParamSpec[]
  layout: LayoutItem[]
  /** Escape hatch for modules that genuinely need bespoke UI. */
  customPanel?: string
  create(ctx: BaseAudioContext): ModuleInstance
}

/**
 * The seam that makes the planned monolithic-worklet engine real. Today an
 * instance wraps native nodes and worklets; later one can wrap a message port
 * into a single DSP worklet, one module at a time, with no change to panels,
 * themes, or patch files.
 */
export interface ModuleInstance {
  inputs: Map<string, AudioNode | AudioParam>
  outputs: Map<string, AudioNode>
  setParam(id: string, value: number, atTime?: number): void
  dispose(): void
}
```

`src/engine/registry.ts`:

```ts
import type { ModuleDescriptor } from './types'

const descriptors = new Map<string, ModuleDescriptor>()

function validate(d: ModuleDescriptor): void {
  if (descriptors.has(d.type)) {
    throw new Error(`registerModule: type "${d.type}" is already registered`)
  }

  const portIds = new Set<string>()
  for (const p of d.ports) {
    if (portIds.has(p.id)) {
      throw new Error(`registerModule: "${d.type}" has a duplicate port id "${p.id}"`)
    }
    portIds.add(p.id)
  }

  const paramIds = new Set<string>()
  for (const p of d.params) {
    if (paramIds.has(p.id)) {
      throw new Error(`registerModule: "${d.type}" has a duplicate param id "${p.id}"`)
    }
    paramIds.add(p.id)
    if (p.default < p.min || p.default > p.max) {
      throw new Error(
        `registerModule: "${d.type}" param "${p.id}" default ${p.default} ` +
          `falls outside [${p.min}, ${p.max}]`,
      )
    }
  }

  for (const item of d.layout) {
    if (!portIds.has(item.ref) && !paramIds.has(item.ref)) {
      throw new Error(
        `registerModule: "${d.type}" layout has an unknown reference "${item.ref}"`,
      )
    }
  }
}

export function registerModule(d: ModuleDescriptor): void {
  validate(d)
  descriptors.set(d.type, d)
}

export function getModule(type: string): ModuleDescriptor | undefined {
  return descriptors.get(type)
}

export function listModules(): ModuleDescriptor[] {
  return [...descriptors.values()]
}

/** Test-only. Production code registers once at startup. */
export function clearRegistry(): void {
  descriptors.clear()
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- registry`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/types.ts src/engine/registry.ts tests/helpers tests/node/registry.test.ts
git commit -m "feat(engine): module descriptor contract and validating registry"
```

---

### Task 8: Cycle detection

**Files:**
- Create: `src/engine/cycle.ts`
- Test: `tests/node/cycle.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `createsCycle(edges: ReadonlyArray<readonly [string, string]>, from: string, to: string): boolean` — reports whether adding a `from → to` edge would close a loop, where each element is a `[sourceModuleId, targetModuleId]` pair.

This lands before the graph, because the graph consumes it on every connect.

- [ ] **Step 1: Write the failing test**

`tests/node/cycle.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createsCycle } from '../../src/engine/cycle'

describe('createsCycle', () => {
  it('permits an edge in an empty graph', () => {
    expect(createsCycle([], 'a', 'b')).toBe(false)
  })

  it('detects a direct self-connection', () => {
    expect(createsCycle([], 'a', 'a')).toBe(true)
  })

  it('detects a two-module loop', () => {
    expect(createsCycle([['a', 'b']], 'b', 'a')).toBe(true)
  })

  it('detects a long loop', () => {
    const edges = [['a', 'b'], ['b', 'c'], ['c', 'd']] as const
    expect(createsCycle(edges, 'd', 'a')).toBe(true)
  })

  it('permits a diamond, which is not a cycle', () => {
    const edges = [['a', 'b'], ['a', 'c'], ['b', 'd']] as const
    expect(createsCycle(edges, 'c', 'd')).toBe(false)
  })

  it('permits a second cable between the same pair in the same direction', () => {
    expect(createsCycle([['a', 'b']], 'a', 'b')).toBe(false)
  })

  it('ignores unrelated branches', () => {
    const edges = [['x', 'y'], ['y', 'z']] as const
    expect(createsCycle(edges, 'a', 'b')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- cycle`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`src/engine/cycle.ts`:

```ts
/**
 * Feedback detection for the patch graph.
 *
 * WebAudio permits a graph cycle only through a DelayNode. Rather than hiding
 * that, the engine detects the loop on connect, inserts the required delay,
 * and marks the cable so the operator can see which cable costs them 2.7 ms.
 */

/**
 * Would adding `from -> to` close a loop?
 *
 * True when `to` already reaches `from`, or when the edge is a self-connection.
 */
export function createsCycle(
  edges: ReadonlyArray<readonly [string, string]>,
  from: string,
  to: string,
): boolean {
  if (from === to) return true

  const adjacency = new Map<string, string[]>()
  for (const [src, dst] of edges) {
    const list = adjacency.get(src)
    if (list) list.push(dst)
    else adjacency.set(src, [dst])
  }

  // Depth-first search from `to`, looking for `from`.
  const seen = new Set<string>()
  const stack = [to]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node === from) return true
    if (seen.has(node)) continue
    seen.add(node)
    const next = adjacency.get(node)
    if (next) stack.push(...next)
  }
  return false
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- cycle`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/cycle.ts tests/node/cycle.test.ts
git commit -m "feat(engine): patch-graph cycle detection"
```

---

### Task 9: PatchGraph

**Files:**
- Create: `src/engine/graph.ts`
- Test: `tests/node/graph.test.ts`

**Interfaces:**
- Consumes: `types.ts` and `registry.ts` (Task 7), `createsCycle` (Task 8), the stub helpers.
- Produces:
  - `interface Cable { id: string; from: [string, string]; to: [string, string]; delayed: boolean; active: boolean }`
  - `class PatchGraph` with `constructor(ctx: BaseAudioContext)`, `addModule(type: string, id?: string): string`, `removeModule(id: string): void`, `connect(from: [string, string], to: [string, string]): Cable`, `disconnect(cableId: string): void`, `getInstance(id: string): ModuleInstance | undefined`, `getType(id: string): string | undefined`, `setParam(moduleId: string, paramId: string, value: number): void`, `readonly cables: readonly Cable[]`, `readonly moduleIds: readonly string[]`, `addGhost(id: string, type: string, params: Record<string, number>): void`, `dispose(): void`

The graph never touches the DOM and never assumes a real audio context, which
is what lets these tests run in Node against stubs.

- [ ] **Step 1: Write the failing test**

`tests/node/graph.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { PatchGraph } from '../../src/engine/graph'
import { registerModule, clearRegistry } from '../../src/engine/registry'
import { stubDescriptor, stubContext, type StubNode } from '../helpers/stub-instance'

function nodeOf(graph: PatchGraph, moduleId: string, port: string): StubNode {
  const inst = graph.getInstance(moduleId)!
  return (inst.outputs.get(port) ?? inst.inputs.get(port)) as unknown as StubNode
}

describe('PatchGraph', () => {
  let graph: PatchGraph

  beforeEach(() => {
    clearRegistry()
    registerModule(stubDescriptor('vco'))
    registerModule(stubDescriptor('vcf'))
    graph = new PatchGraph(stubContext())
  })

  it('adds a module and returns its id', () => {
    const id = graph.addModule('vco')
    expect(typeof id).toBe('string')
    expect(graph.moduleIds).toContain(id)
    expect(graph.getType(id)).toBe('vco')
  })

  it('honors an explicit id', () => {
    expect(graph.addModule('vco', 'osc1')).toBe('osc1')
  })

  it('refuses an unregistered type', () => {
    expect(() => graph.addModule('nonexistent')).toThrow(/unknown module type/)
  })

  it('refuses a duplicate id', () => {
    graph.addModule('vco', 'osc1')
    expect(() => graph.addModule('vco', 'osc1')).toThrow(/already in the patch/)
  })

  it('connects two modules and wires the underlying nodes', () => {
    const a = graph.addModule('vco', 'a')
    const b = graph.addModule('vcf', 'b')
    const cable = graph.connect([a, 'out'], [b, 'in'])
    expect(cable.delayed).toBe(false)
    expect(cable.active).toBe(true)
    expect(graph.cables).toHaveLength(1)
    expect(nodeOf(graph, 'a', 'out').connections).toHaveLength(1)
  })

  it('refuses a cable to an unknown port', () => {
    graph.addModule('vco', 'a')
    graph.addModule('vcf', 'b')
    expect(() => graph.connect(['a', 'nope'], ['b', 'in'])).toThrow(/no output port/)
    expect(() => graph.connect(['a', 'out'], ['b', 'nope'])).toThrow(/no input port/)
  })

  it('marks a feedback cable as delayed and routes it through a delay node', () => {
    graph.addModule('vco', 'a')
    graph.addModule('vcf', 'b')
    graph.connect(['a', 'out'], ['b', 'in'])
    const feedback = graph.connect(['b', 'out'], ['a', 'in'])
    expect(feedback.delayed).toBe(true)
    // The output feeds the delay, not the destination directly.
    expect(nodeOf(graph, 'b', 'out').connections).toHaveLength(1)
  })

  it('disconnects a cable and unwires the nodes', () => {
    graph.addModule('vco', 'a')
    graph.addModule('vcf', 'b')
    const cable = graph.connect(['a', 'out'], ['b', 'in'])
    graph.disconnect(cable.id)
    expect(graph.cables).toHaveLength(0)
    expect(nodeOf(graph, 'a', 'out').connections).toHaveLength(0)
  })

  it('removes a module along with every cable touching it', () => {
    graph.addModule('vco', 'a')
    graph.addModule('vcf', 'b')
    graph.connect(['a', 'out'], ['b', 'in'])
    graph.removeModule('a')
    expect(graph.cables).toHaveLength(0)
    expect(graph.moduleIds).not.toContain('a')
  })

  it('permits any signal type to reach any other', () => {
    // Voltage is voltage: audio into a CV input is a technique, not an error.
    const a = graph.addModule('vco', 'a')
    const b = graph.addModule('vcf', 'b')
    expect(() => graph.connect([a, 'out'], [b, 'in'])).not.toThrow()
  })

  it('holds ghost modules without wiring them', () => {
    graph.addModule('vco', 'a')
    graph.addGhost('mystery', 'quantum-vco', { drift: 0.7 })
    const cable = graph.connect(['a', 'out'], ['mystery', 'in'])
    expect(cable.active).toBe(false)
    expect(graph.getType('mystery')).toBe('quantum-vco')
    expect(nodeOf(graph, 'a', 'out').connections).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- graph`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`src/engine/graph.ts`:

```ts
import { getModule } from './registry'
import { createsCycle } from './cycle'
import type { ModuleInstance } from './types'

export interface Cable {
  id: string
  /** [moduleId, portId] */
  from: [string, string]
  to: [string, string]
  /** True when this cable closes a loop and carries the 128-sample delay. */
  delayed: boolean
  /** False when either end is a ghost, so no audio flows. */
  active: boolean
}

interface GraphNode {
  type: string
  instance: ModuleInstance | null // null for ghosts
  params: Record<string, number>
}

/** WebAudio permits a cycle only through a DelayNode; one render quantum is
 *  the smallest delay that satisfies it. */
const FEEDBACK_DELAY_SECONDS = 128 / 48000

export class PatchGraph {
  private readonly nodes = new Map<string, GraphNode>()
  private readonly cableList: Cable[] = []
  private readonly delays = new Map<string, DelayNode>()
  private counter = 0

  constructor(private readonly ctx: BaseAudioContext) {}

  get moduleIds(): readonly string[] {
    return [...this.nodes.keys()]
  }

  get cables(): readonly Cable[] {
    return this.cableList
  }

  addModule(type: string, id?: string): string {
    const descriptor = getModule(type)
    if (!descriptor) throw new Error(`addModule: unknown module type "${type}"`)

    const moduleId = id ?? `${type}-${++this.counter}`
    if (this.nodes.has(moduleId)) {
      throw new Error(`addModule: id "${moduleId}" is already in the patch`)
    }

    const instance = descriptor.create(this.ctx)
    const params: Record<string, number> = {}
    for (const p of descriptor.params) {
      params[p.id] = p.default
      instance.setParam(p.id, p.default)
    }

    this.nodes.set(moduleId, { type, instance, params })
    return moduleId
  }

  /**
   * Hold a module the registry does not know about, preserving its type and
   * params so the patch round-trips instead of losing data quietly.
   */
  addGhost(id: string, type: string, params: Record<string, number>): void {
    if (this.nodes.has(id)) {
      throw new Error(`addGhost: id "${id}" is already in the patch`)
    }
    this.nodes.set(id, { type, instance: null, params: { ...params } })
  }

  getInstance(id: string): ModuleInstance | undefined {
    return this.nodes.get(id)?.instance ?? undefined
  }

  getType(id: string): string | undefined {
    return this.nodes.get(id)?.type
  }

  getParams(id: string): Readonly<Record<string, number>> {
    const node = this.nodes.get(id)
    if (!node) throw new Error(`getParams: no module "${id}"`)
    return node.params
  }

  setParam(moduleId: string, paramId: string, value: number): void {
    const node = this.nodes.get(moduleId)
    if (!node) throw new Error(`setParam: no module "${moduleId}"`)
    node.params[paramId] = value
    node.instance?.setParam(paramId, value)
  }

  connect(from: [string, string], to: [string, string]): Cable {
    const [fromId, fromPort] = from
    const [toId, toPort] = to
    const source = this.nodes.get(fromId)
    const target = this.nodes.get(toId)
    if (!source) throw new Error(`connect: no module "${fromId}"`)
    if (!target) throw new Error(`connect: no module "${toId}"`)

    const active = source.instance !== null && target.instance !== null

    let outNode: AudioNode | undefined
    let inNode: AudioNode | AudioParam | undefined
    if (active) {
      outNode = source.instance!.outputs.get(fromPort)
      if (!outNode) throw new Error(`connect: "${source.type}" has no output port "${fromPort}"`)
      inNode = target.instance!.inputs.get(toPort)
      if (!inNode) throw new Error(`connect: "${target.type}" has no input port "${toPort}"`)
    }

    const edges = this.cableList.map((c) => [c.from[0], c.to[0]] as const)
    const delayed = createsCycle(edges, fromId, toId)

    const cable: Cable = {
      id: `cable-${++this.counter}`,
      from,
      to,
      delayed,
      active,
    }

    if (active) {
      if (delayed) {
        const delay = this.ctx.createDelay(1)
        delay.delayTime.value = FEEDBACK_DELAY_SECONDS
        this.delays.set(cable.id, delay)
        outNode!.connect(delay)
        delay.connect(inNode as AudioNode)
      } else {
        outNode!.connect(inNode as AudioNode)
      }
    }

    this.cableList.push(cable)
    return cable
  }

  disconnect(cableId: string): void {
    const index = this.cableList.findIndex((c) => c.id === cableId)
    if (index === -1) throw new Error(`disconnect: no cable "${cableId}"`)
    const cable = this.cableList[index]!

    if (cable.active) {
      const source = this.nodes.get(cable.from[0])
      const target = this.nodes.get(cable.to[0])
      const outNode = source?.instance?.outputs.get(cable.from[1])
      const inNode = target?.instance?.inputs.get(cable.to[1])
      const delay = this.delays.get(cableId)
      if (delay) {
        outNode?.disconnect(delay)
        if (inNode) delay.disconnect(inNode as AudioNode)
        this.delays.delete(cableId)
      } else if (outNode && inNode) {
        outNode.disconnect(inNode as AudioNode)
      }
    }

    this.cableList.splice(index, 1)
  }

  removeModule(id: string): void {
    const node = this.nodes.get(id)
    if (!node) throw new Error(`removeModule: no module "${id}"`)

    for (const cable of [...this.cableList]) {
      if (cable.from[0] === id || cable.to[0] === id) this.disconnect(cable.id)
    }
    node.instance?.dispose()
    this.nodes.delete(id)
  }

  dispose(): void {
    for (const id of [...this.nodes.keys()]) this.removeModule(id)
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- graph`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/graph.ts tests/node/graph.test.ts
git commit -m "feat(engine): patch graph with feedback delay insertion and ghost modules"
```

---

### Task 10: The .sinp patch format

**Files:**
- Create: `src/engine/patch.ts`
- Test: `tests/node/patch.test.ts`

**Interfaces:**
- Consumes: `PatchGraph` (Task 9), `getModule` (Task 7).
- Produces:
  - `interface PatchFile { version: 1; meta: { name: string; created: string; author: string }; modules: Array<{ id: string; type: string; slot: [number, number]; params: Record<string, number> }>; cables: Array<{ from: [string, string]; to: [string, string] }> }`
  - `serializePatch(graph: PatchGraph, meta?: Partial<PatchFile['meta']>): PatchFile`
  - `loadPatch(ctx: BaseAudioContext, file: PatchFile): { graph: PatchGraph; ghosts: string[] }`
  - `PATCH_VERSION = 1`

The format carries no theme, so a patch travels across all eight skins
unchanged.

- [ ] **Step 1: Write the failing test**

`tests/node/patch.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { serializePatch, loadPatch, type PatchFile } from '../../src/engine/patch'
import { PatchGraph } from '../../src/engine/graph'
import { registerModule, clearRegistry } from '../../src/engine/registry'
import { stubDescriptor, stubContext } from '../helpers/stub-instance'

function buildPatch(): PatchGraph {
  const graph = new PatchGraph(stubContext())
  graph.addModule('vco', 'osc')
  graph.addModule('vcf', 'filter')
  graph.setParam('osc', 'level', 0.8)
  graph.connect(['osc', 'out'], ['filter', 'in'])
  return graph
}

describe('patch format', () => {
  beforeEach(() => {
    clearRegistry()
    registerModule(stubDescriptor('vco'))
    registerModule(stubDescriptor('vcf'))
  })

  it('serializes modules, params, and cables', () => {
    const file = serializePatch(buildPatch(), { name: 'Test' })
    expect(file.version).toBe(1)
    expect(file.meta.name).toBe('Test')
    expect(file.modules.map((m) => m.id).sort()).toEqual(['filter', 'osc'])
    expect(file.modules.find((m) => m.id === 'osc')!.params.level).toBe(0.8)
    expect(file.cables).toEqual([{ from: ['osc', 'out'], to: ['filter', 'in'] }])
  })

  it('stores no theme, so a patch travels across skins', () => {
    expect(JSON.stringify(serializePatch(buildPatch()))).not.toMatch(/theme/i)
  })

  it('round-trips a patch without loss', () => {
    const original = serializePatch(buildPatch(), { name: 'Round' })
    const { graph, ghosts } = loadPatch(stubContext(), original)
    expect(ghosts).toEqual([])
    const again = serializePatch(graph, { name: 'Round', created: original.meta.created })
    expect(again).toEqual(original)
  })

  it('loads an unknown module type as a ghost and reports it', () => {
    const file: PatchFile = {
      version: 1,
      meta: { name: 'Future', created: '2026-08-18T00:00:00.000Z', author: '' },
      modules: [
        { id: 'osc', type: 'vco', slot: [0, 0], params: { level: 0.5 } },
        { id: 'x', type: 'quantum-vco', slot: [0, 1], params: { drift: 0.7 } },
      ],
      cables: [{ from: ['osc', 'out'], to: ['x', 'in'] }],
    }
    const { graph, ghosts } = loadPatch(stubContext(), file)
    expect(ghosts).toEqual(['quantum-vco'])
    expect(graph.getType('x')).toBe('quantum-vco')
    expect(graph.cables[0]!.active).toBe(false)
  })

  it('writes a ghost back out with its params and cables intact', () => {
    const file: PatchFile = {
      version: 1,
      meta: { name: 'Future', created: '2026-08-18T00:00:00.000Z', author: '' },
      modules: [{ id: 'x', type: 'quantum-vco', slot: [2, 3], params: { drift: 0.7 } }],
      cables: [],
    }
    const { graph } = loadPatch(stubContext(), file)
    const out = serializePatch(graph, file.meta)
    expect(out.modules[0]).toEqual({
      id: 'x', type: 'quantum-vco', slot: [2, 3], params: { drift: 0.7 },
    })
  })

  it('rejects a file from a newer format version', () => {
    const file = { ...serializePatch(buildPatch()), version: 99 } as unknown as PatchFile
    expect(() => loadPatch(stubContext(), file)).toThrow(/version 99/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- patch`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`src/engine/patch.ts`:

```ts
import { PatchGraph } from './graph'
import { getModule } from './registry'

export const PATCH_VERSION = 1

export interface PatchModuleEntry {
  id: string
  type: string
  /** Rack position: [row, column], in horizontal pitch units. */
  slot: [number, number]
  params: Record<string, number>
}

export interface PatchCableEntry {
  from: [string, string]
  to: [string, string]
}

export interface PatchFile {
  version: typeof PATCH_VERSION
  meta: { name: string; created: string; author: string }
  modules: PatchModuleEntry[]
  cables: PatchCableEntry[]
}

export function serializePatch(
  graph: PatchGraph,
  meta: Partial<PatchFile['meta']> = {},
): PatchFile {
  return {
    version: PATCH_VERSION,
    meta: {
      name: meta.name ?? 'Untitled',
      created: meta.created ?? new Date().toISOString(),
      author: meta.author ?? '',
    },
    modules: graph.moduleIds.map((id) => ({
      id,
      type: graph.getType(id)!,
      slot: graph.getSlot(id),
      params: { ...graph.getParams(id) },
    })),
    cables: graph.cables.map((c) => ({ from: c.from, to: c.to })),
  }
}

/**
 * Rebuild a graph from a file.
 *
 * A module type the registry does not know becomes a ghost: it keeps its
 * params and its cables, so a file written by a later version of SinsThesis
 * round-trips through an older one instead of losing data. The returned
 * `ghosts` array names the missing types so the UI can say what did not load.
 */
export function loadPatch(
  ctx: BaseAudioContext,
  file: PatchFile,
): { graph: PatchGraph; ghosts: string[] } {
  if (file.version !== PATCH_VERSION) {
    throw new Error(
      `loadPatch: this build reads patch version ${PATCH_VERSION}, ` +
        `but the file declares version ${file.version}`,
    )
  }

  const graph = new PatchGraph(ctx)
  const ghosts: string[] = []

  for (const entry of file.modules) {
    if (getModule(entry.type)) {
      graph.addModule(entry.type, entry.id)
      for (const [paramId, value] of Object.entries(entry.params)) {
        graph.setParam(entry.id, paramId, value)
      }
    } else {
      graph.addGhost(entry.id, entry.type, entry.params)
      if (!ghosts.includes(entry.type)) ghosts.push(entry.type)
    }
    graph.setSlot(entry.id, entry.slot)
  }

  for (const cable of file.cables) {
    graph.connect(cable.from, cable.to)
  }

  return { graph, ghosts }
}
```

- [ ] **Step 4: Add slot storage to PatchGraph**

`src/engine/graph.ts` needs the rack position the patch format reads. Add
`slot` to `GraphNode`, default it in `addModule` and `addGhost`, and add the
two accessors:

```ts
// In the GraphNode interface:
//   slot: [number, number]
// In addModule, when building the node:
//   this.nodes.set(moduleId, { type, instance, params, slot: [0, 0] })
// In addGhost:
//   this.nodes.set(id, { type, instance: null, params: { ...params }, slot: [0, 0] })

  getSlot(id: string): [number, number] {
    const node = this.nodes.get(id)
    if (!node) throw new Error(`getSlot: no module "${id}"`)
    return [...node.slot] as [number, number]
  }

  setSlot(id: string, slot: [number, number]): void {
    const node = this.nodes.get(id)
    if (!node) throw new Error(`setSlot: no module "${id}"`)
    node.slot = [...slot] as [number, number]
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, every node test including the graph suite from Task 9.

- [ ] **Step 6: Commit**

```bash
git add src/engine/patch.ts src/engine/graph.ts tests/node/patch.test.ts
git commit -m "feat(engine): .sinp patch format with lossless ghost-module round-trip"
```

---

### Task 11: Worklet build and the offline render harness

**Files:**
- Create: `vite.worklets.config.ts`, `src/engine/worklets/registry.ts`, `src/engine/render.ts`
- Create: `src/engine/worklets/passthrough.worklet.ts` (proves the pipeline before real DSP rides on it)
- Modify: `package.json` (add `build:worklets`, make `test:browser` depend on it)
- Test: `tests/browser/render.test.ts`

**Interfaces:**
- Consumes: `PatchGraph` (Task 9).
- Produces:
  - `WORKLET_MODULES: readonly string[]` — worklet base names
  - `ensureWorklets(ctx: BaseAudioContext): Promise<void>`
  - `renderGraph(seconds: number, build: (ctx: OfflineAudioContext, graph: PatchGraph) => string, sampleRate?: number): Promise<Float32Array>` — `build` returns the id of the module whose `out` port feeds the destination.

**Engine convention established here, and every module obeys it:** every input
port is fronted by its own `GainNode`. Connecting therefore stays a two-argument
`out.connect(in)` call, even when the underlying worklet has several numbered
inputs, and the graph never needs to know about input indices.

- [ ] **Step 1: Add the worklet build**

`vite.worklets.config.ts`:

```ts
import { defineConfig } from 'vite'
import { resolve } from 'node:path'

/**
 * Worklets build separately from the app: each becomes one self-contained ES
 * module in public/worklets/, which is what audioWorklet.addModule() loads.
 * Bundling each to a single file avoids import resolution inside
 * AudioWorkletGlobalScope, where the usual module graph is not available.
 */
export default defineConfig({
  build: {
    outDir: 'public/worklets',
    emptyOutDir: true,
    lib: {
      entry: {
        passthrough: resolve(__dirname, 'src/engine/worklets/passthrough.worklet.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: { output: { entryFileNames: '[name].js' } },
  },
})
```

Add to `package.json` scripts:

```json
"build:worklets": "vite build --config vite.worklets.config.ts",
"test:browser": "npm run build:worklets && vitest run --project browser"
```

Add `public/worklets/` to `.gitignore` — it is build output.

- [ ] **Step 2: Write the failing test**

`tests/browser/render.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { renderGraph, ensureWorklets } from '../../src/engine/render'
import { registerModule, clearRegistry } from '../../src/engine/registry'
import type { ModuleDescriptor, ModuleInstance } from '../../src/engine/types'

/** A 440 Hz sine built from native nodes, used to prove the harness works. */
const toneDescriptor: ModuleDescriptor = {
  type: 'test-tone',
  name: 'Test Tone',
  hp: 4,
  ports: [{ id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [0, 0] }],
  params: [{ id: 'freq', label: 'Freq', min: 20, max: 20000, default: 440, curve: 'exp', unit: 'Hz' }],
  layout: [],
  create(ctx): ModuleInstance {
    const osc = ctx.createOscillator()
    osc.frequency.value = 440
    osc.start()
    return {
      inputs: new Map(),
      outputs: new Map([['out', osc as AudioNode]]),
      setParam: (id, value) => { if (id === 'freq') osc.frequency.value = value },
      dispose: () => osc.disconnect(),
    }
  },
}

describe('render harness', () => {
  it('loads every worklet module without error', async () => {
    const ctx = new OfflineAudioContext(1, 128, 48000)
    await expect(ensureWorklets(ctx)).resolves.toBeUndefined()
  })

  it('renders a graph to a buffer', async () => {
    clearRegistry()
    registerModule(toneDescriptor)
    const samples = await renderGraph(0.1, (_ctx, graph) => graph.addModule('test-tone', 'tone'))
    expect(samples.length).toBe(4800)
    const peak = Math.max(...samples)
    expect(peak).toBeGreaterThan(0.9)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm run test:browser`
Expected: FAIL — `src/engine/render` not found.

- [ ] **Step 4: Write the implementation**

`src/engine/worklets/passthrough.worklet.ts`:

```ts
/// <reference lib="webworker" />

/** Proves the worklet build and loader before any DSP depends on them. */
class PassthroughProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0]
    const output = outputs[0]?.[0]
    if (output) {
      if (input) output.set(input)
      else output.fill(0)
    }
    return true
  }
}

registerProcessor('passthrough', PassthroughProcessor)
```

`src/engine/worklets/registry.ts`:

```ts
/** Base names of every worklet bundle in public/worklets/. */
export const WORKLET_MODULES = ['passthrough'] as const

export const workletUrl = (name: string): string => `/worklets/${name}.js`
```

`src/engine/render.ts`:

```ts
import { PatchGraph } from './graph'
import { WORKLET_MODULES, workletUrl } from './worklets/registry'

const loaded = new WeakSet<BaseAudioContext>()

/** Load every worklet into a context. Safe to call repeatedly. */
export async function ensureWorklets(ctx: BaseAudioContext): Promise<void> {
  if (loaded.has(ctx)) return
  await Promise.all(WORKLET_MODULES.map((name) => ctx.audioWorklet.addModule(workletUrl(name))))
  loaded.add(ctx)
}

/**
 * Render a patch offline and return the mono result.
 *
 * This is the same entry point the test suite and the academy's graders use:
 * build a graph, render it, then measure the buffer with engine/analysis.
 *
 * @param build receives the context and an empty graph, and returns the id of
 *              the module whose `out` port should feed the destination.
 */
export async function renderGraph(
  seconds: number,
  build: (ctx: OfflineAudioContext, graph: PatchGraph) => string,
  sampleRate = 48000,
): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * sampleRate), sampleRate)
  await ensureWorklets(ctx)

  const graph = new PatchGraph(ctx)
  const outputId = build(ctx, graph)

  const instance = graph.getInstance(outputId)
  if (!instance) throw new Error(`renderGraph: no module "${outputId}"`)
  const out = instance.outputs.get('out')
  if (!out) throw new Error(`renderGraph: module "${outputId}" has no "out" port`)
  out.connect(ctx.destination)

  const buffer = await ctx.startRendering()
  return buffer.getChannelData(0)
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npm run test:browser`
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add vite.worklets.config.ts package.json .gitignore src/engine/render.ts src/engine/worklets tests/browser
git commit -m "feat(engine): worklet build pipeline and offline render harness"
```

---

### Task 12: VCO

**Files:**
- Create: `src/engine/worklets/vco.worklet.ts`, `src/engine/modules/vco.ts`
- Modify: `vite.worklets.config.ts` (add the entry), `src/engine/worklets/registry.ts` (add the name)
- Test: `tests/browser/modules/vco.test.ts`

**Interfaces:**
- Consumes: `oscSample`, `createOscState`, `hardSync` (Task 4); the render harness (Task 11).
- Produces: `vcoDescriptor: ModuleDescriptor` with ports `pitch` (cv in), `fm` (cv in), `sync` (gate in), `out` (audio out); params `tune` (semitones), `octave`, `shape` (0 saw, 1 pulse, 2 tri, 3 sine), `pulseWidth`, `fmAmount`.

- [ ] **Step 1: Write the failing test**

`tests/browser/modules/vco.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { renderGraph } from '../../../src/engine/render'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { vcoDescriptor } from '../../../src/engine/modules/vco'
import { peakHz, aliasFloorDb, rms } from '../../../src/engine/analysis/features'

const SR = 48000

describe('VCO module', () => {
  beforeEach(() => {
    clearRegistry()
    registerModule(vcoDescriptor)
  })

  it('sounds A4 at its default tuning', async () => {
    const out = await renderGraph(0.2, (_ctx, g) => g.addModule('vco', 'osc'))
    expect(peakHz(out, SR)).toBeCloseTo(440, -1)
  })

  it('transposes an octave when the octave param moves', async () => {
    const out = await renderGraph(0.2, (_ctx, g) => {
      const id = g.addModule('vco', 'osc')
      g.setParam(id, 'octave', 1)
      return id
    })
    expect(peakHz(out, SR)).toBeCloseTo(880, -1)
  })

  it('holds the alias floor below -60 dB up at 2 kHz', async () => {
    const out = await renderGraph(0.3, (_ctx, g) => {
      const id = g.addModule('vco', 'osc')
      g.setParam(id, 'tune', 29) // 440 Hz up 29 semitones is about 2349 Hz
      return id
    })
    expect(aliasFloorDb(out, SR, peakHz(out, SR))).toBeLessThan(-60)
  })

  it('produces sound on every shape', async () => {
    for (const shape of [0, 1, 2, 3]) {
      const out = await renderGraph(0.2, (_ctx, g) => {
        const id = g.addModule('vco', 'osc')
        g.setParam(id, 'shape', shape)
        return id
      })
      expect(rms(out)).toBeGreaterThan(0.05)
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:browser -- vco`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the worklet and the descriptor**

`src/engine/worklets/vco.worklet.ts`:

```ts
/// <reference lib="webworker" />
import { createOscState, hardSync, oscSample, type OscShape } from '../dsp/polyblep'

const SHAPES: OscShape[] = ['saw', 'pulse', 'tri', 'sine']

/** Thin shell. All the math lives in dsp/polyblep, which Node tests directly. */
class VcoProcessor extends AudioWorkletProcessor {
  private readonly state = createOscState()
  private lastSync = 0

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'tune', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'k-rate' },
      { name: 'octave', defaultValue: 0, minValue: -4, maxValue: 4, automationRate: 'k-rate' },
      { name: 'shape', defaultValue: 0, minValue: 0, maxValue: 3, automationRate: 'k-rate' },
      { name: 'pulseWidth', defaultValue: 0.5, minValue: 0.01, maxValue: 0.99, automationRate: 'k-rate' },
      { name: 'fmAmount', defaultValue: 0, minValue: 0, maxValue: 4, automationRate: 'k-rate' },
    ]
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0]
    if (!out) return true

    const pitchCv = inputs[0]?.[0]
    const fmCv = inputs[1]?.[0]
    const syncGate = inputs[2]?.[0]

    const tune = params.tune![0]!
    const octave = params.octave![0]!
    const shape = SHAPES[Math.round(params.shape![0]!)] ?? 'saw'
    const pw = params.pulseWidth![0]!
    const fmAmount = params.fmAmount![0]!

    // A4 = 440 Hz; pitch CV is 1.0 per octave, tune is in semitones.
    const base = 440 * Math.pow(2, octave + tune / 12)

    for (let i = 0; i < out.length; i++) {
      const sync = syncGate?.[i] ?? 0
      if (sync >= 0.5 && this.lastSync < 0.5) hardSync(this.state)
      this.lastSync = sync

      const cv = (pitchCv?.[i] ?? 0) + (fmCv?.[i] ?? 0) * fmAmount
      const freq = base * Math.pow(2, cv)
      out[i] = oscSample(this.state, shape, freq, sampleRate, pw)
    }
    return true
  }
}

registerProcessor('vco', VcoProcessor)
```

`src/engine/modules/vco.ts`:

```ts
import type { ModuleDescriptor, ModuleInstance } from '../types'

/**
 * Every input port is fronted by its own GainNode, so the graph connects with
 * a plain two-argument connect() and never needs to know that the worklet has
 * three numbered inputs.
 */
export const vcoDescriptor: ModuleDescriptor = {
  type: 'vco',
  name: 'VCO',
  hp: 12,
  ports: [
    { id: 'pitch', dir: 'in', signal: 'cv', label: '1V/Oct', pos: [0, 3] },
    { id: 'fm', dir: 'in', signal: 'cv', label: 'FM', pos: [1, 3] },
    { id: 'sync', dir: 'in', signal: 'gate', label: 'Sync', pos: [2, 3] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [3, 3] },
  ],
  params: [
    { id: 'tune', label: 'Tune', min: -24, max: 24, default: 0, curve: 'lin', unit: 'st' },
    { id: 'octave', label: 'Octave', min: -4, max: 4, default: 0, curve: 'lin', unit: '' },
    { id: 'shape', label: 'Shape', min: 0, max: 3, default: 0, curve: 'lin', unit: '' },
    { id: 'pulseWidth', label: 'Width', min: 0.01, max: 0.99, default: 0.5, curve: 'lin', unit: '' },
    { id: 'fmAmount', label: 'FM', min: 0, max: 4, default: 0, curve: 'lin', unit: '' },
  ],
  layout: [
    { kind: 'knob', ref: 'tune', x: 0, y: 0 },
    { kind: 'knob', ref: 'octave', x: 1, y: 0 },
    { kind: 'knob', ref: 'shape', x: 2, y: 0 },
    { kind: 'knob', ref: 'pulseWidth', x: 0, y: 1 },
    { kind: 'knob', ref: 'fmAmount', x: 1, y: 1 },
    { kind: 'jack', ref: 'pitch', x: 0, y: 3 },
    { kind: 'jack', ref: 'fm', x: 1, y: 3 },
    { kind: 'jack', ref: 'sync', x: 2, y: 3 },
    { kind: 'jack', ref: 'out', x: 3, y: 3 },
  ],
  create(ctx): ModuleInstance {
    const node = new AudioWorkletNode(ctx, 'vco', {
      numberOfInputs: 3,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })

    const fronts = ['pitch', 'fm', 'sync'].map((_, index) => {
      const gain = ctx.createGain()
      gain.connect(node, 0, index)
      return gain
    })

    return {
      inputs: new Map<string, AudioNode | AudioParam>([
        ['pitch', fronts[0]!],
        ['fm', fronts[1]!],
        ['sync', fronts[2]!],
      ]),
      outputs: new Map([['out', node as AudioNode]]),
      setParam(id, value, atTime) {
        const param = node.parameters.get(id)
        if (!param) return
        if (atTime === undefined) param.value = value
        else param.setValueAtTime(value, atTime)
      },
      dispose() {
        node.disconnect()
        for (const gain of fronts) gain.disconnect()
      },
    }
  },
}
```

- [ ] **Step 4: Register the worklet in the build and the loader**

In `vite.worklets.config.ts`, add to `lib.entry`:

```ts
vco: resolve(__dirname, 'src/engine/worklets/vco.worklet.ts'),
```

In `src/engine/worklets/registry.ts`:

```ts
export const WORKLET_MODULES = ['passthrough', 'vco'] as const
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:browser -- vco`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/engine/worklets src/engine/modules/vco.ts vite.worklets.config.ts tests/browser/modules/vco.test.ts
git commit -m "feat(modules): VCO with pitch CV, FM, hard sync, four shapes"
```

---

### Task 13: VCF and Wavefolder

**Files:**
- Create: `src/engine/worklets/ladder.worklet.ts`, `src/engine/worklets/wavefolder.worklet.ts`
- Create: `src/engine/modules/vcf.ts`, `src/engine/modules/wavefolder.ts`
- Modify: `vite.worklets.config.ts`, `src/engine/worklets/registry.ts`
- Test: `tests/browser/modules/vcf.test.ts`

**Interfaces:**
- Consumes: `ladderSample`, `createLadderState` (Task 5), `foldSample` (Task 6), `vcoDescriptor` (Task 12).
- Produces: `vcfDescriptor` — ports `in` (audio in), `cutoffCv` (cv in), `out` (audio out); params `cutoff`, `resonance`, `cutoffCvAmount`, `drive`. And `wavefolderDescriptor` — ports `in`, `foldCv`, `out`; params `drive`, `symmetry`.

Both follow the VCO's shape exactly: a thin worklet shell over a pure core,
with a GainNode fronting each input.

- [ ] **Step 1: Write the failing test**

`tests/browser/modules/vcf.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { renderGraph } from '../../../src/engine/render'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { vcoDescriptor } from '../../../src/engine/modules/vco'
import { vcfDescriptor } from '../../../src/engine/modules/vcf'
import { wavefolderDescriptor } from '../../../src/engine/modules/wavefolder'
import { slopeDbPerOctave, peakHz, rms, spectralCentroid } from '../../../src/engine/analysis/features'

const SR = 48000

beforeEach(() => {
  clearRegistry()
  registerModule(vcoDescriptor)
  registerModule(vcfDescriptor)
  registerModule(wavefolderDescriptor)
})

describe('VCF module', () => {
  it('rolls off about -24 dB per octave above cutoff', async () => {
    const out = await renderGraph(0.4, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const vcf = g.addModule('vcf', 'vcf')
      g.setParam(osc, 'tune', -24) // low saw, dense harmonics
      g.setParam(vcf, 'cutoff', 500)
      g.setParam(vcf, 'resonance', 0)
      g.connect([osc, 'out'], [vcf, 'in'])
      return vcf
    })
    const slope = slopeDbPerOctave(out, SR, 1000, 8000)
    expect(slope).toBeLessThan(-16)
    expect(slope).toBeGreaterThan(-32)
  })

  it('self-oscillates at cutoff with no input patched', async () => {
    const out = await renderGraph(0.5, (_ctx, g) => {
      const vcf = g.addModule('vcf', 'vcf')
      g.setParam(vcf, 'cutoff', 800)
      g.setParam(vcf, 'resonance', 1)
      return vcf
    })
    const tail = out.subarray(out.length >> 1)
    expect(rms(tail)).toBeGreaterThan(0.005)
    expect(peakHz(tail, SR)).toBeCloseTo(800, -2)
  })
})

describe('Wavefolder module', () => {
  it('brightens the signal as drive rises', async () => {
    const render = (drive: number) =>
      renderGraph(0.3, (_ctx, g) => {
        const osc = g.addModule('vco', 'osc')
        const fold = g.addModule('wavefolder', 'fold')
        g.setParam(osc, 'shape', 3) // sine in, so every harmonic out comes from folding
        g.setParam(fold, 'drive', drive)
        g.connect([osc, 'out'], [fold, 'in'])
        return fold
      })
    const [plain, driven] = await Promise.all([render(1), render(6)])
    expect(spectralCentroid(driven, SR)).toBeGreaterThan(spectralCentroid(plain, SR) * 1.5)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:browser -- vcf`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the worklets**

`src/engine/worklets/ladder.worklet.ts`:

```ts
/// <reference lib="webworker" />
import { createLadderState, ladderSample } from '../dsp/ladder'

class LadderProcessor extends AudioWorkletProcessor {
  private readonly state = createLadderState()

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'cutoff', defaultValue: 1000, minValue: 20, maxValue: 20000, automationRate: 'k-rate' },
      { name: 'resonance', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'cutoffCvAmount', defaultValue: 0, minValue: -8, maxValue: 8, automationRate: 'k-rate' },
      { name: 'drive', defaultValue: 1, minValue: 0.1, maxValue: 8, automationRate: 'k-rate' },
    ]
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0]
    if (!out) return true

    const audio = inputs[0]?.[0]
    const cv = inputs[1]?.[0]

    const cutoff = params.cutoff![0]!
    const resonance = params.resonance![0]!
    const cvAmount = params.cutoffCvAmount![0]!
    const drive = params.drive![0]!

    for (let i = 0; i < out.length; i++) {
      // CV is 1.0 per octave, matching the pitch convention everywhere else.
      const fc = cutoff * Math.pow(2, (cv?.[i] ?? 0) * cvAmount)
      out[i] = ladderSample(this.state, (audio?.[i] ?? 0) * drive, fc, resonance, sampleRate)
    }
    return true
  }
}

registerProcessor('ladder', LadderProcessor)
```

`src/engine/worklets/wavefolder.worklet.ts`:

```ts
/// <reference lib="webworker" />
import { foldSample } from '../dsp/wavefolder'

class WavefolderProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'drive', defaultValue: 1, minValue: 0.1, maxValue: 20, automationRate: 'k-rate' },
      { name: 'symmetry', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' },
      { name: 'foldCvAmount', defaultValue: 0, minValue: 0, maxValue: 10, automationRate: 'k-rate' },
    ]
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0]
    if (!out) return true

    const audio = inputs[0]?.[0]
    const cv = inputs[1]?.[0]
    const drive = params.drive![0]!
    const symmetry = params.symmetry![0]!
    const cvAmount = params.foldCvAmount![0]!

    for (let i = 0; i < out.length; i++) {
      const d = Math.max(drive + (cv?.[i] ?? 0) * cvAmount, 0.1)
      out[i] = foldSample(audio?.[i] ?? 0, d, symmetry)
    }
    return true
  }
}

registerProcessor('wavefolder', WavefolderProcessor)
```

- [ ] **Step 4: Write the descriptors**

`src/engine/modules/vcf.ts`:

```ts
import type { ModuleDescriptor, ModuleInstance } from '../types'

export const vcfDescriptor: ModuleDescriptor = {
  type: 'vcf',
  name: 'Ladder VCF',
  hp: 12,
  ports: [
    { id: 'in', dir: 'in', signal: 'audio', label: 'In', pos: [0, 3] },
    { id: 'cutoffCv', dir: 'in', signal: 'cv', label: 'Cutoff CV', pos: [1, 3] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [3, 3] },
  ],
  params: [
    { id: 'cutoff', label: 'Cutoff', min: 20, max: 20000, default: 1000, curve: 'exp', unit: 'Hz' },
    { id: 'resonance', label: 'Res', min: 0, max: 1, default: 0, curve: 'lin', unit: '' },
    { id: 'cutoffCvAmount', label: 'CV Amt', min: -8, max: 8, default: 0, curve: 'lin', unit: 'oct' },
    { id: 'drive', label: 'Drive', min: 0.1, max: 8, default: 1, curve: 'exp', unit: '' },
  ],
  layout: [
    { kind: 'knob', ref: 'cutoff', x: 0, y: 0 },
    { kind: 'knob', ref: 'resonance', x: 1, y: 0 },
    { kind: 'knob', ref: 'cutoffCvAmount', x: 0, y: 1 },
    { kind: 'knob', ref: 'drive', x: 1, y: 1 },
    { kind: 'jack', ref: 'in', x: 0, y: 3 },
    { kind: 'jack', ref: 'cutoffCv', x: 1, y: 3 },
    { kind: 'jack', ref: 'out', x: 3, y: 3 },
  ],
  create(ctx): ModuleInstance {
    const node = new AudioWorkletNode(ctx, 'ladder', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    const audioIn = ctx.createGain()
    const cvIn = ctx.createGain()
    audioIn.connect(node, 0, 0)
    cvIn.connect(node, 0, 1)

    return {
      inputs: new Map<string, AudioNode | AudioParam>([['in', audioIn], ['cutoffCv', cvIn]]),
      outputs: new Map([['out', node as AudioNode]]),
      setParam(id, value, atTime) {
        const param = node.parameters.get(id)
        if (!param) return
        if (atTime === undefined) param.value = value
        else param.setValueAtTime(value, atTime)
      },
      dispose() {
        node.disconnect()
        audioIn.disconnect()
        cvIn.disconnect()
      },
    }
  },
}
```

`src/engine/modules/wavefolder.ts`: identical in shape to `vcf.ts` — ports
`in` (audio in, pos [0,3]), `foldCv` (cv in, pos [1,3]), `out` (audio out, pos
[3,3]); params `drive` (0.1–20, default 1, exp), `symmetry` (−1–1, default 0,
lin), `foldCvAmount` (0–10, default 0, lin); layout places a knob per param on
rows 0–1 and a jack per port on row 3; `create` builds an `AudioWorkletNode`
for `'wavefolder'` with two inputs, fronts each with a `GainNode`, and returns
the same `setParam` and `dispose` implementations.

- [ ] **Step 5: Register both worklets**

`vite.worklets.config.ts` gains two entries:

```ts
ladder: resolve(__dirname, 'src/engine/worklets/ladder.worklet.ts'),
wavefolder: resolve(__dirname, 'src/engine/worklets/wavefolder.worklet.ts'),
```

`src/engine/worklets/registry.ts`:

```ts
export const WORKLET_MODULES = ['passthrough', 'vco', 'ladder', 'wavefolder'] as const
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test:browser -- vcf`
Expected: PASS, 3 tests.

- [ ] **Step 7: Commit**

```bash
git add src/engine/worklets src/engine/modules vite.worklets.config.ts tests/browser/modules/vcf.test.ts
git commit -m "feat(modules): ladder VCF and wavefolder"
```

---

### Task 14: ADSR, LFO, and Sample & Hold

**Files:**
- Create: `src/engine/worklets/segment.worklet.ts`, `src/engine/modules/adsr.ts`, `src/engine/modules/lfo.ts`, `src/engine/modules/sh.ts`
- Modify: `vite.worklets.config.ts`, `src/engine/worklets/registry.ts`
- Test: `tests/browser/modules/modulation.test.ts`

**Interfaces:**
- Consumes: `envSample`, `sampleHold`, `createEnvState`, `createSampleHoldState` (Task 6), `oscSample` (Task 4).
- Produces: `adsrDescriptor` (in: `gate`; out: `out`; params `attack`, `decay`, `sustain`, `release`), `lfoDescriptor` (in: `sync`; out: `out`; params `rate`, `shape`, `depth`), `shDescriptor` (in: `in`, `trigger`; out: `out`).

One worklet file registers all three processors, because they share the
segment core and change together.

- [ ] **Step 1: Write the failing test**

`tests/browser/modules/modulation.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { renderGraph } from '../../../src/engine/render'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { adsrDescriptor } from '../../../src/engine/modules/adsr'
import { lfoDescriptor } from '../../../src/engine/modules/lfo'
import { rmsEnvelope, peakHz, rms } from '../../../src/engine/analysis/features'

const SR = 48000

beforeEach(() => {
  clearRegistry()
  registerModule(adsrDescriptor)
  registerModule(lfoDescriptor)
})

describe('ADSR module', () => {
  it('stays silent with no gate patched', async () => {
    const out = await renderGraph(0.2, (_ctx, g) => g.addModule('adsr', 'env'))
    expect(rms(out)).toBeLessThan(1e-6)
  })

  it('rises then settles at sustain when its gate is held', async () => {
    // A constant source stands in for a held gate.
    const out = await renderGraph(0.5, (ctx, g) => {
      const env = g.addModule('adsr', 'env')
      g.setParam(env, 'attack', 0.05)
      g.setParam(env, 'decay', 0.05)
      g.setParam(env, 'sustain', 0.5)
      const source = ctx.createConstantSource()
      source.offset.value = 1
      source.start()
      source.connect(g.getInstance(env)!.inputs.get('gate') as AudioNode)
      return env
    })
    const env = rmsEnvelope(out, 2400) // 50 ms windows
    expect(env[0]!).toBeLessThan(env[2]!)          // rising through attack
    expect(env[env.length - 1]!).toBeCloseTo(0.5, 1) // holding at sustain
  })
})

describe('LFO module', () => {
  it('runs at its rate param', async () => {
    const out = await renderGraph(4, (_ctx, g) => {
      const lfo = g.addModule('lfo', 'lfo')
      g.setParam(lfo, 'rate', 8)
      g.setParam(lfo, 'shape', 3) // sine, so the peak bin is unambiguous
      return lfo
    })
    expect(peakHz(out, SR)).toBeCloseTo(8, 0)
  })

  it('scales its output with depth', async () => {
    const at = (depth: number) =>
      renderGraph(1, (_ctx, g) => {
        const lfo = g.addModule('lfo', 'lfo')
        g.setParam(lfo, 'rate', 10)
        g.setParam(lfo, 'depth', depth)
        return lfo
      })
    const [half, full] = await Promise.all([at(0.5), at(1)])
    expect(rms(full)).toBeGreaterThan(rms(half) * 1.5)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:browser -- modulation`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the worklet**

`src/engine/worklets/segment.worklet.ts`:

```ts
/// <reference lib="webworker" />
import { createEnvState, envSample, createSampleHoldState, sampleHold } from '../dsp/segment'
import { createOscState, oscSample, hardSync, type OscShape } from '../dsp/polyblep'

class AdsrProcessor extends AudioWorkletProcessor {
  private readonly state = createEnvState()

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'attack', defaultValue: 0.01, minValue: 0.001, maxValue: 10, automationRate: 'k-rate' },
      { name: 'decay', defaultValue: 0.1, minValue: 0.001, maxValue: 10, automationRate: 'k-rate' },
      { name: 'sustain', defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.2, minValue: 0.001, maxValue: 10, automationRate: 'k-rate' },
    ]
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0]
    if (!out) return true
    const gate = inputs[0]?.[0]
    const p = {
      attack: params.attack![0]!,
      decay: params.decay![0]!,
      sustain: params.sustain![0]!,
      release: params.release![0]!,
    }
    for (let i = 0; i < out.length; i++) {
      out[i] = envSample(this.state, gate?.[i] ?? 0, p, sampleRate)
    }
    return true
  }
}

const SHAPES: OscShape[] = ['saw', 'pulse', 'tri', 'sine']

class LfoProcessor extends AudioWorkletProcessor {
  private readonly state = createOscState()
  private lastSync = 0

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'rate', defaultValue: 2, minValue: 0.01, maxValue: 200, automationRate: 'k-rate' },
      { name: 'shape', defaultValue: 2, minValue: 0, maxValue: 3, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ]
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0]
    if (!out) return true
    const sync = inputs[0]?.[0]
    const rate = params.rate![0]!
    const shape = SHAPES[Math.round(params.shape![0]!)] ?? 'tri'
    const depth = params.depth![0]!

    for (let i = 0; i < out.length; i++) {
      const s = sync?.[i] ?? 0
      if (s >= 0.5 && this.lastSync < 0.5) hardSync(this.state)
      this.lastSync = s
      out[i] = oscSample(this.state, shape, rate, sampleRate) * depth
    }
    return true
  }
}

class SampleHoldProcessor extends AudioWorkletProcessor {
  private readonly state = createSampleHoldState()

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0]
    if (!out) return true
    const signal = inputs[0]?.[0]
    const trigger = inputs[1]?.[0]
    for (let i = 0; i < out.length; i++) {
      out[i] = sampleHold(this.state, signal?.[i] ?? 0, trigger?.[i] ?? 0)
    }
    return true
  }
}

registerProcessor('adsr', AdsrProcessor)
registerProcessor('lfo', LfoProcessor)
registerProcessor('sample-hold', SampleHoldProcessor)
```

- [ ] **Step 4: Write the three descriptors**

Each follows the `vcf.ts` template exactly — worklet node, one `GainNode` per
input port, `setParam` writing to `node.parameters`, `dispose` disconnecting
everything.

`src/engine/modules/adsr.ts` — `adsrDescriptor`, type `'adsr'`, name `'ADSR'`,
hp 8. Ports: `gate` (gate in, [0,3]), `out` (cv out, [3,3]). Params: `attack`
(0.001–10 s, default 0.01, exp), `decay` (same range, default 0.1, exp),
`sustain` (0–1, default 0.7, lin), `release` (0.001–10 s, default 0.2, exp).
Layout: four knobs on row 0, two jacks on row 3. Worklet processor name
`'adsr'`, one input.

`src/engine/modules/lfo.ts` — `lfoDescriptor`, type `'lfo'`, name `'LFO'`, hp 8.
Ports: `sync` (gate in, [0,3]), `out` (cv out, [3,3]). Params: `rate`
(0.01–200 Hz, default 2, exp), `shape` (0–3, default 2, lin), `depth` (0–1,
default 1, lin). Worklet processor name `'lfo'`, one input.

`src/engine/modules/sh.ts` — `shDescriptor`, type `'sh'`, name `'S&H'`, hp 6.
Ports: `in` (cv in, [0,3]), `trigger` (gate in, [1,3]), `out` (cv out, [3,3]).
No params. Worklet processor name `'sample-hold'`, two inputs.

- [ ] **Step 5: Register the worklet**

Add `segment: resolve(__dirname, 'src/engine/worklets/segment.worklet.ts')` to
`vite.worklets.config.ts`, and `'segment'` to `WORKLET_MODULES`. One bundle
registers all three processors.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test:browser -- modulation`
Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add src/engine/worklets/segment.worklet.ts src/engine/modules vite.worklets.config.ts tests/browser/modules/modulation.test.ts
git commit -m "feat(modules): ADSR, LFO, and sample-and-hold"
```

---

### Task 15: The native modules

**Files:**
- Create: `src/engine/modules/noise.ts`, `vca.ts`, `mixer.ts`, `multiple.ts`, `delay.ts`, `output.ts`
- Test: `tests/browser/modules/native.test.ts`

**Interfaces:**
- Consumes: `types.ts`, the render harness.
- Produces: `noiseDescriptor`, `vcaDescriptor`, `mixerDescriptor`, `multipleDescriptor`, `delayDescriptor`, `outputDescriptor`.

Six modules, no worklets: native nodes do these correctly and cheaply, which
is exactly the hybrid the spec chose.

| Module | Built from | Ports | Params |
|---|---|---|---|
| Noise | `AudioBufferSourceNode` looping two seconds of white noise | `out` (audio) | `color` (0 white, 1 pink; applied as a −3 dB/oct `BiquadFilterNode` when above 0.5) |
| VCA | `GainNode`, with `cv` fronted by a `GainNode` feeding `gain` | `in`, `cv`, `out` | `level` (0–1), `cvAmount` (0–1) |
| Mixer | four input `GainNode`s summing into one | `in1`–`in4`, `out` | `level1`–`level4` (−1 to 1, attenuverters) |
| Multiple | one `GainNode` fanned to four outputs | `in`, `out1`–`out4` | none |
| Delay | `DelayNode` + feedback `GainNode` + wet/dry `GainNode`s | `in`, `timeCv`, `out` | `time` (0.001–2 s), `feedback` (0–0.95), `mix` (0–1) |
| Output | `GainNode` into an `AnalyserNode` | `in`, `out` | `level` (0–1) |

The Output module keeps an `AnalyserNode` so Phase 2's meter has a source, and
exposes an `out` port so the render harness can read the final signal.

- [ ] **Step 1: Write the failing test**

`tests/browser/modules/native.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { renderGraph } from '../../../src/engine/render'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { noiseDescriptor } from '../../../src/engine/modules/noise'
import { vcaDescriptor } from '../../../src/engine/modules/vca'
import { mixerDescriptor } from '../../../src/engine/modules/mixer'
import { multipleDescriptor } from '../../../src/engine/modules/multiple'
import { delayDescriptor } from '../../../src/engine/modules/delay'
import { outputDescriptor } from '../../../src/engine/modules/output'
import { vcoDescriptor } from '../../../src/engine/modules/vco'
import { rms, rmsEnvelope } from '../../../src/engine/analysis/features'

beforeEach(() => {
  clearRegistry()
  for (const d of [
    noiseDescriptor, vcaDescriptor, mixerDescriptor,
    multipleDescriptor, delayDescriptor, outputDescriptor, vcoDescriptor,
  ]) registerModule(d)
})

describe('native modules', () => {
  it('Noise produces broadband signal', async () => {
    const out = await renderGraph(0.2, (_ctx, g) => g.addModule('noise', 'n'))
    expect(rms(out)).toBeGreaterThan(0.1)
  })

  it('VCA at zero level silences its input', async () => {
    const out = await renderGraph(0.2, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const vca = g.addModule('vca', 'vca')
      g.setParam(vca, 'level', 0)
      g.connect([osc, 'out'], [vca, 'in'])
      return vca
    })
    expect(rms(out)).toBeLessThan(1e-5)
  })

  it('VCA passes its input at full level', async () => {
    const out = await renderGraph(0.2, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const vca = g.addModule('vca', 'vca')
      g.setParam(vca, 'level', 1)
      g.connect([osc, 'out'], [vca, 'in'])
      return vca
    })
    expect(rms(out)).toBeGreaterThan(0.3)
  })

  it('Mixer sums two inputs louder than one', async () => {
    const build = (both: boolean) =>
      renderGraph(0.2, (_ctx, g) => {
        const a = g.addModule('vco', 'a')
        const b = g.addModule('vco', 'b')
        const mix = g.addModule('mixer', 'mix')
        g.setParam(b, 'tune', 7)
        g.connect([a, 'out'], [mix, 'in1'])
        if (both) g.connect([b, 'out'], [mix, 'in2'])
        return mix
      })
    const [one, two] = await Promise.all([build(false), build(true)])
    expect(rms(two)).toBeGreaterThan(rms(one) * 1.2)
  })

  it('Multiple copies its input to every output', async () => {
    const out = await renderGraph(0.2, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const mult = g.addModule('multiple', 'mult')
      const mix = g.addModule('mixer', 'mix')
      g.connect([osc, 'out'], [mult, 'in'])
      g.connect([mult, 'out1'], [mix, 'in1'])
      g.connect([mult, 'out2'], [mix, 'in2'])
      return mix
    })
    expect(rms(out)).toBeGreaterThan(0.3)
  })

  it('Delay produces audible repeats after the dry signal stops', async () => {
    const out = await renderGraph(1.0, (ctx, g) => {
      const noise = g.addModule('noise', 'n')
      const vca = g.addModule('vca', 'vca')
      const delay = g.addModule('delay', 'd')
      g.setParam(vca, 'level', 0)
      g.setParam(vca, 'cvAmount', 1)
      g.setParam(delay, 'time', 0.25)
      g.setParam(delay, 'feedback', 0.6)
      g.setParam(delay, 'mix', 1)
      // A 50 ms burst at the start, then silence.
      const burst = ctx.createConstantSource()
      burst.offset.setValueAtTime(1, 0)
      burst.offset.setValueAtTime(0, 0.05)
      burst.start()
      burst.connect(g.getInstance(vca)!.inputs.get('cv') as AudioNode)
      g.connect([noise, 'out'], [vca, 'in'])
      g.connect([vca, 'out'], [delay, 'in'])
      return delay
    })
    const env = rmsEnvelope(out, 4800) // 100 ms windows
    // Window 0 holds the burst; window 2 or 3 should hold its first repeat.
    expect(Math.max(env[2]!, env[3]!)).toBeGreaterThan(0.01)
  })

  it('Output attenuates according to its level', async () => {
    const at = (level: number) =>
      renderGraph(0.2, (_ctx, g) => {
        const osc = g.addModule('vco', 'osc')
        const out = g.addModule('output', 'out')
        g.setParam(out, 'level', level)
        g.connect([osc, 'out'], [out, 'in'])
        return out
      })
    const [quiet, loud] = await Promise.all([at(0.25), at(1)])
    expect(rms(loud)).toBeGreaterThan(rms(quiet) * 2)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:browser -- native`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the six descriptors**

Two representative implementations; the other four follow the same shape and
the table above.

`src/engine/modules/vca.ts`:

```ts
import type { ModuleDescriptor, ModuleInstance } from '../types'

export const vcaDescriptor: ModuleDescriptor = {
  type: 'vca',
  name: 'VCA',
  hp: 6,
  ports: [
    { id: 'in', dir: 'in', signal: 'audio', label: 'In', pos: [0, 3] },
    { id: 'cv', dir: 'in', signal: 'cv', label: 'CV', pos: [1, 3] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [2, 3] },
  ],
  params: [
    { id: 'level', label: 'Level', min: 0, max: 1, default: 1, curve: 'lin', unit: '' },
    { id: 'cvAmount', label: 'CV Amt', min: 0, max: 1, default: 0, curve: 'lin', unit: '' },
  ],
  layout: [
    { kind: 'knob', ref: 'level', x: 0, y: 0 },
    { kind: 'knob', ref: 'cvAmount', x: 1, y: 0 },
    { kind: 'jack', ref: 'in', x: 0, y: 3 },
    { kind: 'jack', ref: 'cv', x: 1, y: 3 },
    { kind: 'jack', ref: 'out', x: 2, y: 3 },
  ],
  create(ctx): ModuleInstance {
    const vca = ctx.createGain()
    vca.gain.value = 1
    // CV rides on top of the level knob: the depth stage scales incoming CV
    // before it sums into the same gain param.
    const cvDepth = ctx.createGain()
    cvDepth.gain.value = 0
    cvDepth.connect(vca.gain)

    return {
      inputs: new Map<string, AudioNode | AudioParam>([['in', vca], ['cv', cvDepth]]),
      outputs: new Map([['out', vca as AudioNode]]),
      setParam(id, value) {
        if (id === 'level') vca.gain.value = value
        else if (id === 'cvAmount') cvDepth.gain.value = value
      },
      dispose() {
        vca.disconnect()
        cvDepth.disconnect()
      },
    }
  },
}
```

`src/engine/modules/noise.ts`:

```ts
import type { ModuleDescriptor, ModuleInstance } from '../types'

export const noiseDescriptor: ModuleDescriptor = {
  type: 'noise',
  name: 'Noise',
  hp: 4,
  ports: [{ id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [0, 3] }],
  params: [{ id: 'color', label: 'Color', min: 0, max: 1, default: 0, curve: 'lin', unit: '' }],
  layout: [
    { kind: 'knob', ref: 'color', x: 0, y: 0 },
    { kind: 'jack', ref: 'out', x: 0, y: 3 },
  ],
  create(ctx): ModuleInstance {
    const seconds = 2
    const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.loop = true
    source.start()

    // Pink-ish tilt: a gentle lowpass, bypassed by leaving color at 0.
    const tilt = ctx.createBiquadFilter()
    tilt.type = 'lowpass'
    tilt.frequency.value = 20000
    source.connect(tilt)

    return {
      inputs: new Map(),
      outputs: new Map([['out', tilt as AudioNode]]),
      setParam(id, value) {
        if (id === 'color') tilt.frequency.value = value > 0.5 ? 1200 : 20000
      },
      dispose() {
        source.stop()
        source.disconnect()
        tilt.disconnect()
      },
    }
  },
}
```

`mixer.ts`, `multiple.ts`, `delay.ts`, and `output.ts` follow the table: build
the listed native nodes in `create`, front every input port with its own
`GainNode`, map each output port to the node that carries it, write params
directly onto the relevant `AudioParam` in `setParam`, and disconnect
everything in `dispose`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:browser -- native`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/engine/modules tests/browser/modules/native.test.ts
git commit -m "feat(modules): noise, VCA, mixer, multiple, delay, output"
```

---

### Task 16: Clock and Sequencer

**Files:**
- Create: `src/engine/clock.ts`, `src/engine/modules/clock-module.ts`, `src/engine/modules/sequencer.ts`
- Test: `tests/node/clock.test.ts`, `tests/browser/modules/sequencer.test.ts`

**Interfaces:**
- Consumes: `types.ts`.
- Produces:
  - `stepDuration(bpm: number, division: number): number` — seconds per step, where `division` counts steps per beat.
  - `scheduleSteps(startTime: number, count: number, bpm: number, division: number): number[]` — absolute times for `count` steps.
  - `clockDescriptor` — out: `gate`, `reset`; params `bpm` (20–300), `division` (1–8), `pulseWidth` (0.05–0.95).
  - `sequencerDescriptor` — in: `clock`, `reset`; out: `cv`, `gate`; params `steps` (1–16), `glide` (0–1), and `step1`–`step16` (−2 to 2 octaves).

Timing math is pure, so it tests in Node; the modules that use it test in the
browser.

- [ ] **Step 1: Write the failing tests**

`tests/node/clock.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { stepDuration, scheduleSteps } from '../../src/engine/clock'

describe('stepDuration', () => {
  it('gives half a second per beat at 120 BPM', () => {
    expect(stepDuration(120, 1)).toBeCloseTo(0.5, 6)
  })

  it('divides the beat into steps', () => {
    expect(stepDuration(120, 4)).toBeCloseTo(0.125, 6)
  })

  it('rejects a non-positive tempo', () => {
    expect(() => stepDuration(0, 4)).toThrow(/bpm/)
  })
})

describe('scheduleSteps', () => {
  it('spaces steps evenly from the start time', () => {
    expect(scheduleSteps(1, 4, 120, 2)).toEqual([1, 1.25, 1.5, 1.75])
  })

  it('returns nothing for a count of zero', () => {
    expect(scheduleSteps(0, 0, 120, 4)).toEqual([])
  })
})
```

`tests/browser/modules/sequencer.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { renderGraph } from '../../../src/engine/render'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { clockDescriptor } from '../../../src/engine/modules/clock-module'
import { sequencerDescriptor } from '../../../src/engine/modules/sequencer'
import { vcoDescriptor } from '../../../src/engine/modules/vco'
import { peakHz, rmsEnvelope } from '../../../src/engine/analysis/features'

const SR = 48000

beforeEach(() => {
  clearRegistry()
  for (const d of [clockDescriptor, sequencerDescriptor, vcoDescriptor]) registerModule(d)
})

describe('Clock and Sequencer', () => {
  it('pulses the gate at the tempo', async () => {
    const out = await renderGraph(2, (_ctx, g) => {
      const clock = g.addModule('clock', 'clk')
      g.setParam(clock, 'bpm', 120)
      g.setParam(clock, 'division', 1)
      return clock
    })
    // 120 BPM with one step per beat is 2 Hz. Measure gate-high windows.
    const env = rmsEnvelope(out, 2400) // 50 ms windows
    let transitions = 0
    for (let i = 1; i < env.length; i++) {
      const wasHigh = env[i - 1]! > 0.5
      const isHigh = env[i]! > 0.5
      if (wasHigh !== isHigh) transitions++
    }
    expect(transitions).toBeGreaterThanOrEqual(6)
    expect(transitions).toBeLessThanOrEqual(10)
  })

  it('steps a VCO through its programmed pitches', async () => {
    const first = await renderGraph(0.4, (_ctx, g) => {
      const clock = g.addModule('clock', 'clk')
      const seq = g.addModule('seq', 'seq')
      const osc = g.addModule('vco', 'osc')
      g.setParam(clock, 'bpm', 60)
      g.setParam(clock, 'division', 1)
      g.setParam(seq, 'steps', 2)
      g.setParam(seq, 'step1', 0) // A4
      g.setParam(seq, 'step2', 1) // an octave up
      g.connect([clock, 'gate'], [seq, 'clock'])
      g.connect([seq, 'cv'], [osc, 'pitch'])
      return osc
    })
    // The first second holds step 1, so the pitch is A4.
    expect(peakHz(first.subarray(0, 16384), SR)).toBeCloseTo(440, -1)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- clock` then `npm run test:browser -- sequencer`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the timing math**

`src/engine/clock.ts`:

```ts
/**
 * Transport math. Pure, so it tests in Node and the modules that consume it
 * stay thin.
 */

/** Seconds per step. `division` counts steps per beat: 4 gives sixteenths. */
export function stepDuration(bpm: number, division: number): number {
  if (bpm <= 0) throw new Error(`stepDuration: bpm must be positive, got ${bpm}`)
  if (division <= 0) throw new Error(`stepDuration: division must be positive, got ${division}`)
  return 60 / bpm / division
}

/** Absolute times for `count` steps beginning at `startTime`. */
export function scheduleSteps(
  startTime: number,
  count: number,
  bpm: number,
  division: number,
): number[] {
  const step = stepDuration(bpm, division)
  const times: number[] = []
  for (let i = 0; i < count; i++) times.push(startTime + i * step)
  return times
}
```

- [ ] **Step 4: Write the two modules**

`src/engine/modules/clock-module.ts` — `clockDescriptor`, type `'clock'`, hp 6.
Ports: `gate` (gate out, [0,3]), `reset` (gate out, [1,3]). Params: `bpm`
(20–300, default 120, lin), `division` (1–8, default 1, lin), `pulseWidth`
(0.05–0.95, default 0.5, lin).

`create` builds a `ConstantSourceNode` whose `offset` is scheduled with
`setValueAtTime` calls, alternating 1 and 0 at the times `scheduleSteps`
returns, out to `ctx.currentTime + 60` seconds. Rescheduling on a param change
cancels with `cancelScheduledValues(ctx.currentTime)` and rebuilds from now.
This keeps every gate edge sample-accurate on the audio clock rather than
depending on JavaScript timers.

`src/engine/modules/sequencer.ts` — `sequencerDescriptor`, type `'seq'`, hp 24,
`customPanel: 'sequencer'` because a sixteen-step row needs bespoke UI. Ports:
`clock` (gate in, [0,3]), `reset` (gate in, [1,3]), `cv` (cv out, [2,3]),
`gate` (gate out, [3,3]). Params: `steps` (1–16, default 8, lin), `glide` (0–1,
default 0, lin), and `step1`–`step16` (−2 to 2, default 0, lin, unit `oct`).

`create` builds a `ConstantSourceNode` for `cv`, a second for `gate`, and a
`sample-hold` style advance driven by an `AudioWorkletNode` registered as
`'sequencer'` in `segment.worklet.ts`: it counts rising edges on its clock
input, wraps at `steps`, and emits the corresponding `stepN` value on its CV
output and a gate pulse on its second output. Add
`{ name: 'steps' }` plus `step1`–`step16` to that processor's
`parameterDescriptors`, all `k-rate`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- clock && npm run test:browser -- sequencer`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add src/engine/clock.ts src/engine/modules tests/node/clock.test.ts tests/browser/modules/sequencer.test.ts
git commit -m "feat(engine): transport math, clock module, sixteen-step sequencer"
```

---

### Task 17: Keyboard and MIDI

**Files:**
- Create: `src/engine/midi.ts`, `src/engine/modules/keyboard-midi.ts`
- Test: `tests/node/midi.test.ts`

**Interfaces:**
- Consumes: `types.ts`.
- Produces:
  - `noteToPitchCv(midiNote: number): number` — A4 (note 69) maps to 0.0, one octave to 1.0.
  - `keyToNote(code: string, octave: number): number | undefined` — the ASDF row as piano keys.
  - `type MidiEvent = { kind: 'noteOn'; note: number; velocity: number } | { kind: 'noteOff'; note: number } | { kind: 'cc'; controller: number; value: number }`
  - `parseMidiMessage(data: Uint8Array): MidiEvent | undefined`
  - `class NoteStack` with `press(note)`, `release(note)`, `current(): number | undefined` — last-note priority.
  - `keyboardMidiDescriptor` — out: `pitch` (cv), `gate`, `velocity` (cv); params `octave`, `glide`.

Message parsing and note priority are pure, so the interesting logic tests in
Node. Web MIDI itself needs a browser and a device; the descriptor requests
access lazily and degrades to computer-keyboard input when permission is
refused.

- [ ] **Step 1: Write the failing test**

`tests/node/midi.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { noteToPitchCv, parseMidiMessage, NoteStack, keyToNote } from '../../src/engine/midi'

describe('noteToPitchCv', () => {
  it('places A4 at zero', () => {
    expect(noteToPitchCv(69)).toBeCloseTo(0, 6)
  })

  it('places one octave up at 1.0', () => {
    expect(noteToPitchCv(81)).toBeCloseTo(1, 6)
  })

  it('places one octave down at -1.0', () => {
    expect(noteToPitchCv(57)).toBeCloseTo(-1, 6)
  })
})

describe('parseMidiMessage', () => {
  it('reads a note-on', () => {
    expect(parseMidiMessage(new Uint8Array([0x90, 60, 100])))
      .toEqual({ kind: 'noteOn', note: 60, velocity: 100 / 127 })
  })

  it('reads a note-on with zero velocity as a note-off', () => {
    expect(parseMidiMessage(new Uint8Array([0x90, 60, 0])))
      .toEqual({ kind: 'noteOff', note: 60 })
  })

  it('reads a note-off', () => {
    expect(parseMidiMessage(new Uint8Array([0x80, 60, 64])))
      .toEqual({ kind: 'noteOff', note: 60 })
  })

  it('reads a control change', () => {
    expect(parseMidiMessage(new Uint8Array([0xb0, 74, 127])))
      .toEqual({ kind: 'cc', controller: 74, value: 1 })
  })

  it('ignores messages it does not handle', () => {
    expect(parseMidiMessage(new Uint8Array([0xf8]))).toBeUndefined()
  })
})

describe('NoteStack', () => {
  it('reports nothing when empty', () => {
    expect(new NoteStack().current()).toBeUndefined()
  })

  it('gives the most recent note priority', () => {
    const stack = new NoteStack()
    stack.press(60)
    stack.press(64)
    expect(stack.current()).toBe(64)
  })

  it('falls back to the held note when the newest releases', () => {
    const stack = new NoteStack()
    stack.press(60)
    stack.press(64)
    stack.release(64)
    expect(stack.current()).toBe(60)
  })

  it('ignores a release for a note that is not held', () => {
    const stack = new NoteStack()
    stack.press(60)
    stack.release(99)
    expect(stack.current()).toBe(60)
  })
})

describe('keyToNote', () => {
  it('maps the A key to C in the given octave', () => {
    expect(keyToNote('KeyA', 4)).toBe(60)
  })

  it('returns undefined for an unmapped key', () => {
    expect(keyToNote('Escape', 4)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- midi`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`src/engine/midi.ts`:

```ts
/** MIDI note 69 is A4, and the engine references pitch CV to A4 at 0.0. */
const A4_NOTE = 69

export function noteToPitchCv(midiNote: number): number {
  return (midiNote - A4_NOTE) / 12
}

export type MidiEvent =
  | { kind: 'noteOn'; note: number; velocity: number }
  | { kind: 'noteOff'; note: number }
  | { kind: 'cc'; controller: number; value: number }

/** Parse one MIDI message. Returns undefined for messages the engine ignores. */
export function parseMidiMessage(data: Uint8Array): MidiEvent | undefined {
  const status = data[0]
  if (status === undefined) return undefined
  const command = status & 0xf0
  const a = data[1] ?? 0
  const b = data[2] ?? 0

  if (command === 0x90) {
    // Running-status keyboards send note-on with zero velocity for note-off.
    return b === 0 ? { kind: 'noteOff', note: a } : { kind: 'noteOn', note: a, velocity: b / 127 }
  }
  if (command === 0x80) return { kind: 'noteOff', note: a }
  if (command === 0xb0) return { kind: 'cc', controller: a, value: b / 127 }
  return undefined
}

/**
 * Last-note priority, the behavior of a Mother-32 or an MS-20: the newest key
 * wins, and releasing it hands the voice back to whatever is still held.
 */
export class NoteStack {
  private readonly held: number[] = []

  press(note: number): void {
    this.release(note)
    this.held.push(note)
  }

  release(note: number): void {
    const index = this.held.lastIndexOf(note)
    if (index !== -1) this.held.splice(index, 1)
  }

  current(): number | undefined {
    return this.held[this.held.length - 1]
  }

  get size(): number {
    return this.held.length
  }
}

/** The ASDF row as a piano keyboard, so anyone can play without hardware. */
const KEY_MAP: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6,
  KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14,
}

/** `octave` 4 puts KeyA on middle C (MIDI 60). */
export function keyToNote(code: string, octave: number): number | undefined {
  const offset = KEY_MAP[code]
  return offset === undefined ? undefined : offset + (octave + 1) * 12
}
```

- [ ] **Step 4: Write the module descriptor**

`src/engine/modules/keyboard-midi.ts` — `keyboardMidiDescriptor`, type
`'keyboard'`, hp 10, `customPanel: 'keyboard'`. Ports: `pitch` (cv out, [0,3]),
`gate` (gate out, [1,3]), `velocity` (cv out, [2,3]). Params: `octave` (0–8,
default 4, lin), `glide` (0–1 s, default 0, exp).

`create` builds three `ConstantSourceNode`s, one per output. A `NoteStack`
holds pressed notes. On note-on it sets `pitch.offset` with
`setTargetAtTime(value, ctx.currentTime, glide)` — which is the glide — and
`gate.offset.setValueAtTime(1, ctx.currentTime)`; on the last note-off it sets
the gate to 0. The instance exposes `handleMidiEvent(e: MidiEvent)` and
`handleKey(code: string, down: boolean)` so the UI layer can drive it without
the engine touching the DOM.

Web MIDI access lives behind `requestMidiAccess(): Promise<MIDIAccess | null>`
in `src/engine/midi.ts`, returning null when the browser refuses. Refusal is
not an error: the computer keyboard keeps working, and the module reports its
unpatched MIDI state.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- midi`
Expected: PASS, 14 tests.

- [ ] **Step 6: Commit**

```bash
git add src/engine/midi.ts src/engine/modules/keyboard-midi.ts tests/node/midi.test.ts
git commit -m "feat(engine): MIDI parsing, last-note priority, computer-keyboard mapping"
```

---

### Task 18: Graph inspector, module index, and the acceptance suite

**Files:**
- Create: `src/engine/analysis/inspector.ts`, `src/engine/modules/index.ts`
- Test: `tests/node/inspector.test.ts`, `tests/node/boundaries.test.ts`, `tests/browser/acceptance.test.ts`

**Interfaces:**
- Consumes: everything.
- Produces:
  - `interface InspectorQuery { hasModule?: string[]; connected?: Array<[string, string, string, string]>; params?: Array<{ module: string; param: string; value: number; tolerance?: number }> }`
  - `interface InspectorResult { pass: boolean; failures: string[] }`
  - `inspect(graph: PatchGraph, query: InspectorQuery): InspectorResult`
  - `registerAllModules(): void` — registers all fifteen descriptors.
  - `ALL_DESCRIPTORS: ModuleDescriptor[]` — the Phase 1 module set, which the UI palette reads and a Phase 4 level filters.

The inspector is the academy's topology grader, written now because the test
suite wants it anyway. It also closes Phase 1 by proving the engine's
boundaries hold.

- [ ] **Step 1: Write the failing tests**

`tests/node/inspector.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { inspect } from '../../src/engine/analysis/inspector'
import { PatchGraph } from '../../src/engine/graph'
import { registerModule, clearRegistry } from '../../src/engine/registry'
import { stubDescriptor, stubContext } from '../helpers/stub-instance'

function patch(): PatchGraph {
  const g = new PatchGraph(stubContext())
  g.addModule('vco', 'osc')
  g.addModule('vcf', 'filter')
  g.setParam('filter', 'level', 0.5)
  g.connect(['osc', 'out'], ['filter', 'in'])
  return g
}

describe('inspect', () => {
  beforeEach(() => {
    clearRegistry()
    registerModule(stubDescriptor('vco'))
    registerModule(stubDescriptor('vcf'))
  })

  it('passes when every requirement holds', () => {
    const result = inspect(patch(), {
      hasModule: ['vco', 'vcf'],
      connected: [['osc', 'out', 'filter', 'in']],
      params: [{ module: 'filter', param: 'level', value: 0.5 }],
    })
    expect(result).toEqual({ pass: true, failures: [] })
  })

  it('names the missing module type', () => {
    const result = inspect(patch(), { hasModule: ['vca'] })
    expect(result.pass).toBe(false)
    expect(result.failures[0]).toMatch(/vca/)
  })

  it('names the missing connection', () => {
    const result = inspect(patch(), { connected: [['filter', 'out', 'osc', 'in']] })
    expect(result.pass).toBe(false)
    expect(result.failures[0]).toMatch(/filter/)
  })

  it('accepts a param within tolerance', () => {
    const result = inspect(patch(), {
      params: [{ module: 'filter', param: 'level', value: 0.52, tolerance: 0.05 }],
    })
    expect(result.pass).toBe(true)
  })

  it('rejects a param outside tolerance', () => {
    const result = inspect(patch(), {
      params: [{ module: 'filter', param: 'level', value: 0.9, tolerance: 0.05 }],
    })
    expect(result.pass).toBe(false)
  })

  it('collects every failure rather than stopping at the first', () => {
    const result = inspect(patch(), {
      hasModule: ['vca', 'delay'],
      params: [{ module: 'filter', param: 'level', value: 0.9 }],
    })
    expect(result.failures.length).toBe(3)
  })
})
```

`tests/node/boundaries.test.ts`:

```ts
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
    for (const file of files.filter((f) => f.endsWith('.worklet.ts'))) {
      const source = readFileSync(file, 'utf8')
      expect(source, `${file} must import its math from dsp/`).toMatch(/from\s+['"]\.\.\/dsp\//)
    }
  })
})
```

`tests/browser/acceptance.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { renderGraph } from '../../src/engine/render'
import { clearRegistry, listModules } from '../../src/engine/registry'
import { registerAllModules, ALL_DESCRIPTORS } from '../../src/engine/modules'
import { serializePatch, loadPatch } from '../../src/engine/patch'
import { PatchGraph } from '../../src/engine/graph'
import { peakHz, rms, slopeDbPerOctave, aliasFloorDb } from '../../src/engine/analysis/features'

const SR = 48000

beforeEach(() => {
  clearRegistry()
  registerAllModules()
})

describe('Phase 1 acceptance', () => {
  it('registers every module in the set', () => {
    expect(listModules()).toHaveLength(ALL_DESCRIPTORS.length)
    expect(ALL_DESCRIPTORS.length).toBe(15)
  })

  it('renders the classic voice: VCO into VCF into VCA into Output', async () => {
    const out = await renderGraph(0.4, (_ctx, g) => {
      const osc = g.addModule('vco', 'osc')
      const vcf = g.addModule('vcf', 'vcf')
      const vca = g.addModule('vca', 'vca')
      const output = g.addModule('output', 'out')
      g.setParam(vcf, 'cutoff', 1200)
      g.connect([osc, 'out'], [vcf, 'in'])
      g.connect([vcf, 'out'], [vca, 'in'])
      g.connect([vca, 'out'], [output, 'in'])
      return output
    })
    expect(rms(out)).toBeGreaterThan(0.05)
    expect(peakHz(out, SR)).toBeCloseTo(440, -1)
  })

  it('proves the spec\'s four numeric claims', async () => {
    const osc = await renderGraph(0.3, (_ctx, g) => {
      const id = g.addModule('vco', 'osc')
      g.setParam(id, 'tune', 29)
      return id
    })
    expect(aliasFloorDb(osc, SR, peakHz(osc, SR))).toBeLessThan(-60)

    const tuned = await renderGraph(0.3, (_ctx, g) => g.addModule('vco', 'osc'))
    expect(peakHz(tuned, SR)).toBeCloseTo(440, -1)

    const filtered = await renderGraph(0.4, (_ctx, g) => {
      const o = g.addModule('vco', 'osc')
      const f = g.addModule('vcf', 'vcf')
      g.setParam(o, 'tune', -24)
      g.setParam(f, 'cutoff', 500)
      g.connect([o, 'out'], [f, 'in'])
      return f
    })
    expect(slopeDbPerOctave(filtered, SR, 1000, 8000)).toBeLessThan(-16)

    const ringing = await renderGraph(0.5, (_ctx, g) => {
      const f = g.addModule('vcf', 'vcf')
      g.setParam(f, 'cutoff', 800)
      g.setParam(f, 'resonance', 1)
      return f
    })
    expect(peakHz(ringing.subarray(ringing.length >> 1), SR)).toBeCloseTo(800, -2)
  })

  it('round-trips a saved patch through the file format', async () => {
    const ctx = new OfflineAudioContext(1, 128, SR)
    const graph = new PatchGraph(ctx)
    const osc = graph.addModule('vco', 'osc')
    const vcf = graph.addModule('vcf', 'vcf')
    graph.setParam(vcf, 'cutoff', 1234)
    graph.connect([osc, 'out'], [vcf, 'in'])

    const file = serializePatch(graph, { name: 'Acceptance' })
    const { graph: restored, ghosts } = loadPatch(ctx, file)
    expect(ghosts).toEqual([])
    expect(restored.getParams('vcf').cutoff).toBe(1234)
    expect(restored.cables).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- inspector boundaries`
Expected: FAIL — `inspector` and `modules/index` not found.

- [ ] **Step 3: Write the inspector**

`src/engine/analysis/inspector.ts`:

```ts
import type { PatchGraph } from '../graph'

/**
 * Structural queries over a patch.
 *
 * The test suite uses this to assert wiring; Phase 4's academy uses the same
 * calls to grade build-this-patch levels. Every failure is a sentence, because
 * a grade that says only "72%" teaches nothing.
 */
export interface InspectorQuery {
  /** Module types that must be present. */
  hasModule?: string[]
  /** [fromModuleId, fromPort, toModuleId, toPort] tuples that must be patched. */
  connected?: Array<[string, string, string, string]>
  params?: Array<{ module: string; param: string; value: number; tolerance?: number }>
}

export interface InspectorResult {
  pass: boolean
  failures: string[]
}

export function inspect(graph: PatchGraph, query: InspectorQuery): InspectorResult {
  const failures: string[] = []

  const presentTypes = graph.moduleIds.map((id) => graph.getType(id))
  for (const type of query.hasModule ?? []) {
    if (!presentTypes.includes(type)) failures.push(`the patch needs a ${type} module`)
  }

  for (const [fromId, fromPort, toId, toPort] of query.connected ?? []) {
    const found = graph.cables.some(
      (c) =>
        c.from[0] === fromId && c.from[1] === fromPort &&
        c.to[0] === toId && c.to[1] === toPort,
    )
    if (!found) failures.push(`${fromId}.${fromPort} is not patched to ${toId}.${toPort}`)
  }

  for (const check of query.params ?? []) {
    const tolerance = check.tolerance ?? 1e-6
    let actual: number | undefined
    try {
      actual = graph.getParams(check.module)[check.param]
    } catch {
      actual = undefined
    }
    if (actual === undefined) {
      failures.push(`${check.module} has no param "${check.param}"`)
    } else if (Math.abs(actual - check.value) > tolerance) {
      failures.push(
        `${check.module}.${check.param} reads ${actual}, but should be ` +
          `${check.value} (within ${tolerance})`,
      )
    }
  }

  return { pass: failures.length === 0, failures }
}
```

- [ ] **Step 4: Write the module index**

`src/engine/modules/index.ts`:

```ts
import { registerModule } from '../registry'
import { vcoDescriptor } from './vco'
import { noiseDescriptor } from './noise'
import { vcfDescriptor } from './vcf'
import { vcaDescriptor } from './vca'
import { wavefolderDescriptor } from './wavefolder'
import { adsrDescriptor } from './adsr'
import { lfoDescriptor } from './lfo'
import { shDescriptor } from './sh'
import { mixerDescriptor } from './mixer'
import { multipleDescriptor } from './multiple'
import { delayDescriptor } from './delay'
import { clockDescriptor } from './clock-module'
import { sequencerDescriptor } from './sequencer'
import { keyboardMidiDescriptor } from './keyboard-midi'
import { outputDescriptor } from './output'

/** The Phase 1 module set. The UI's palette reads this and may filter it,
 *  which is how a Phase 4 level grants four modules and withholds the rest. */
export const ALL_DESCRIPTORS = [
  vcoDescriptor, noiseDescriptor,
  vcfDescriptor, vcaDescriptor, wavefolderDescriptor,
  adsrDescriptor, lfoDescriptor, shDescriptor,
  mixerDescriptor, multipleDescriptor, delayDescriptor,
  clockDescriptor, sequencerDescriptor, keyboardMidiDescriptor, outputDescriptor,
]

export function registerAllModules(): void {
  for (const d of ALL_DESCRIPTORS) registerModule(d)
}
```

Fifteen descriptors, matching the fifteen panels the spec enumerates in its
module-set section.

- [ ] **Step 5: Run everything**

Run: `npm run typecheck && npm test && npm run test:browser`
Expected: PASS across all three.

- [ ] **Step 6: Commit**

```bash
git add src/engine/analysis/inspector.ts src/engine/modules/index.ts tests
git commit -m "feat(engine): graph inspector, module index, Phase 1 acceptance suite"
```

---

## Definition of done

Phase 1A is complete when `npm run typecheck && npm test && npm run test:browser`
passes and the engine can:

1. Register all fifteen module descriptors.
2. Build a patch in code, connect any port to any port, and detect feedback.
3. Render that patch offline and measure it: pitch within 1 Hz, filter slope
   steeper than −16 dB/octave, self-oscillation at cutoff, alias floor below
   −60 dB.
4. Serialize to `.sinp`, reload without loss, and preserve unknown modules as
   ghosts.
5. Grade a patch structurally through `inspect`, which Phase 4 reuses verbatim.

Phase 1B — the rack, panels, themes, and the power switch — gets its own plan,
written against this working engine.

---

## Spec coverage, and what this plan deliberately leaves out

Every spec section maps to a task above, except these, which need a live
`AudioContext` or a UI surface and therefore belong to Phase 1B:

| Spec section | Where it lands |
|---|---|
| §8 Themes | Phase 1B. Themes are token files consumed by panels; the engine has no opinion |
| §11 power switch | Phase 1B. `OfflineAudioContext` needs no user gesture, so this failure mode cannot appear until there is a page |
| §11 worklet-load fallback badge | Phase 1B. `ensureWorklets` is the place to catch the failure, but the visible badge is a panel concern; 1B wires both together |
| §11 CPU overload meter | Phase 1B. Render-quantum overruns only exist on a real-time context, which offline rendering does not have |

Two further honesty notes for whoever executes this:

**Six descriptors are specified rather than spelled out.** Tasks 13, 14, 15,
16, and 17 give the full port list, param ranges, defaults, layout, and native
node graph for `wavefolder`, `adsr`, `lfo`, `sh`, `mixer`, `multiple`,
`delay`, `output`, `clock-module`, `sequencer`, and `keyboard-midi`, and point
at `vcf.ts` or `vca.ts` as the structural template. Those templates exist in
the repository by the time those tasks run, so the tasks are executable — but
they carry more judgment than the fully-written ones. Expect a longer review
on them.

**The sequencer's worklet is the least-proven piece.** Task 16 describes a
`'sequencer'` processor added to `segment.worklet.ts` that counts clock edges
and emits step CV. It is the one component in this plan whose interface has
not been exercised by an earlier task. If it fights back, the fallback is to
drive step advance from the main thread with `setValueAtTime` scheduling, the
same way the clock module works, and accept the coarser timing.
