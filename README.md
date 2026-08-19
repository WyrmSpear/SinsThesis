# SinsThesis

A deep modular synthesizer that runs in a browser. Patch modules together —
oscillators, filters, envelopes, a sequencer — on a rack of panels styled
after real hardware, and play it from a computer keyboard or a MIDI
controller. Its ancestors are Moog's hardware, circuit synthesis, and Native
Instruments Reaktor: a full instrument worked out numerically, not a demo
page with audio bolted on.

What makes this project unusual is that its audio quality is *measured*, not
asserted. Every oscillator, filter and wavefolder ships with a number an
independent audit reproduced — see below.

## Running it

Requires Node ≥22.

```bash
npm install
npx playwright install chromium   # only needed for the browser tests
npm run build:worklets            # MUST run before browser tests or `npm run dev`
npm run dev                       # open the printed URL, click POWER
```

`npm run dev` runs `build:worklets` for you, so that step is only something
you need to remember by hand before `npm run test:browser` — running the
browser/e2e suite directly (without going through `dev` first) is the one
path that doesn't build the worklets automatically, and the tests fail
confusingly if you skip it.

```bash
npm test              # node tests only (fast, no browser)
npm run test:browser  # browser tests: builds worklets, then runs them
npm run typecheck     # tsc --noEmit
```

There is no single command that runs both test suites — `npm test` covers
`tests/node/`, and `npm run test:browser` covers `tests/browser/`.

## Building for deployment

```bash
npm run build     # builds the worklets, then the app, into dist/
npm run preview   # serve dist/ locally to sanity-check it before deploying
```

`dist/` is a self-contained static directory — `index.html`, `harness.html`,
their bundled JS/CSS, and `dist/worklets/` (the same worklet bundles
`build:worklets` produces, carried through unchanged). Upload it to any
static host.

**It can be dropped at the domain root or in a subdirectory — e.g.
`https://example.com/portfolio/sinsthesis/` — with no rebuild and no
configuration.** Every reference the build emits (script/link tags, and the
worklet URLs `src/engine/worklets/registry.ts` hands to
`audioWorklet.addModule()`) is relative to wherever the HTML page that loaded
it actually sits, not to the domain root. `vite.config.ts` sets `base: './'`
for this reason — a generic, deployment-agnostic value, never a specific
subpath — and `registry.ts` reads `import.meta.env.BASE_URL` rather than
hardcoding a leading `/`. Move `dist/`'s contents anywhere and it works; there
is nothing to reconfigure per deployment.

If you build without `npm run build` (which runs `build:worklets` first), the
worklets are missing from `dist/` and every module goes silent with no
visible error, only a console 404 for each `dist/worklets/*.js` — the exact
failure mode this build was designed to make impossible from the standard
entry point.

## What's built

- **The rack** (`index.html`, `npm run dev`) — the product's front door. A
  modular rack with sixteen module types in a palette (VCO, Noise, ladder
  VCF, VCA, Wavefolder, ADSR, LFO, Sample & Hold, Mixer, Multiple, Delay,
  Clock, 16-step Sequencer, Keyboard/MIDI, Output, Scope), drag-to-patch
  cables, drag-to-reorder panels, nine switchable themes, and `.sinp`
  save/load with autosave. Click a cable to see what's actually flowing on
  it — waveform, fundamental, RMS.
- **The academy** (inside the rack) — five build-this-patch levels that
  teach subtractive synthesis, graded on the real patch graph rather than a
  canned answer, with failures explained in plain language ("patch the
  VCO's Out jack into the Filter's In jack") instead of engine identifiers.
- **The dev harness** (`harness.html`) — a lighter page for engine work,
  with a scope and spectrum display the rack doesn't have. Kept around
  specifically for DSP development, not for playing.

The engine itself (`src/engine/`) has no DOM dependency and renders patches
under `OfflineAudioContext` in plain Node, which is what makes the
measurements below possible: the same measurement code that proves a test
also drives the rack's own inspector.

## Audio quality, as measured

All figures below were reproduced independently by an audio-critic review,
not accepted from the people who wrote the DSP.

| | Measured | Grade |
|---|---|---|
| Saw alias floor, 441 Hz | −143.7 dB | RELEASE |
| Saw alias floor, 5 kHz | −170.3 dB | RELEASE |
| Ladder cutoff accuracy, 50 Hz–19 kHz | <0.4% | RELEASE |
| Ladder passband across resonance | −0.10 dB | RELEASE |
| Self-oscillation THD | −63.7 to −75.9 dB | RELEASE |
| Envelope click at stage transitions | −65 to −83 dBFS | RELEASE |
| LFO amplitude, 0.01–200 Hz | <0.3 dB spread | RELEASE |
| Wavefolder alias floor, drive 3 | −87.8 dB | RELEASE |
| Wavefolder alias floor, drive 8 | −63.8 dB (−55.7 at 2637 Hz) | RELEASE / ACCEPTABLE |
| Wavefolder alias floor, drive 16–20 | −45.6 dB (−38.3 at 2637 Hz) | ACCEPTABLE / AMATEUR |
| Knob-turn discontinuity | 0.029 sample delta | RELEASE |

**The honest caveat:** the wavefolder is the one part of the instrument
still graded AMATEUR, specifically on bright material above drive ~12 —
audible, unmasked alias, not a stylistically "aggressive" fold. It ships
anyway, on purpose: a player may want that texture, the drive range (0.1–20)
was deliberately left unnarrowed, and the module's own doc comment
(`src/engine/dsp/wavefolder.ts`) documents exactly where it degrades with a
four-frequency measurement table. Everything else in the table above is
RELEASE-grade by the same bars a commercial soft synth would be measured
against.

## Where to go next

`docs/CONTINUATION.md` is the entry point for resuming work on this project
— current state, a full file tree, what's fixed vs. still open, and nine
traps that have already cost someone real time. Read it before touching the
engine.

Beyond that:

- `docs/superpowers/specs/2026-08-18-sinsthesis-phase1-design.md` — the
  binding design spec, kept current with recorded deviations where shipped
  behavior moved past what it originally said.
- `docs/audio/PHASE1A-LEDGER.md` — every ruling, finding and measurement
  from the engine's original build and audit.
- `docs/audio/oscillator-architecture-study.md` — four oscillator
  architectures, measured against each other, and why wavetables won.
- `.claude/agents/audio-engineer-critic.md` — the audio critic used
  throughout this project's history to keep the numbers above honest.

## License

MIT — see [LICENSE](LICENSE).
