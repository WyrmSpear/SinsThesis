# SinsThesis — continuation

**Updated:** 2026-08-19. Engine, rack, analysis and the academy's first mode all shipped.
**Branch:** `master` — 72 commits.
**State:** 322 tests pass (257 node + 65 browser), `typecheck` clean, tree clean.

**Run it:** `npm run dev`, open the URL, POWER ON.

- **Free play** — a modular rack. Sixteen modules in a palette, drag-to-patch
  cables, drag-to-reorder, eight themes, `.sinp` save/load with autosave, a
  programmable 16-step sequencer, and a Scope module.
- **Academy** — five build-this-patch levels that teach subtractive synthesis,
  graded on the actual patch graph, with failures phrased in the player's own
  words.
- **Dev harness** at `/harness.html` — scope and spectrum for engine work.

Read this file first. Then `docs/audio/PHASE1A-LEDGER.md` for every decision made
and why.

---

## Resuming in one minute

```bash
cd ~/Desktop/SinsThesis
git checkout master
npm install                 # if node_modules is gone
npx playwright install chromium
npm run build:worklets      # MUST run before browser tests
npm test                    # node tests
npm run test:browser        # browser tests
npm run typecheck
```

`npm test` runs the node project only. No single command runs both.

---

## What exists

The audio engine, plus two pages that play it: the rack (the product's front
door) and the dev harness (kept for engine work — it has the scope and
spectrum the rack doesn't).

```
src/engine/
  analysis/   fft.ts, features.ts, inspector.ts    measurement + the academy's grader
  dsp/        wavetable.ts, ladder.ts, wavefolder.ts, segment.ts, polyblep.ts
  worklets/   vco, ladder, wavefolder, segment, passthrough + audioworklet-globals.d.ts
  modules/    fifteen descriptors + index.ts
  graph.ts  patch.ts  cycle.ts  render.ts  clock.ts  midi.ts  types.ts  registry.ts
rack/         main.ts, panel.ts, knob.ts, switch.ts, cables.ts, palette.ts,
              patch-io.ts, theme-switcher.ts, style.css, theme-*.css (4 themes)
dev/          main.ts, piano.ts, controls.ts, presets.ts, scope.ts, style.css
index.html    the rack — npm run dev — the product's front door
harness.html  the dev harness — engine work, scope + spectrum
scripts/build-worklets.mjs    one Rollup bundle per worklet
docs/superpowers/specs/2026-08-18-sinsthesis-phase1-design.md    the binding spec
docs/superpowers/plans/2026-08-18-phase1a-engine.md              the 18-task plan
docs/audio/PHASE1A-LEDGER.md                 every ruling, finding and measurement
docs/audio/oscillator-architecture-study.md  four oscillator architectures, measured
.claude/agents/audio-engineer-critic.md      the audio critic
```

### Measured audio quality, as shipped

All figures reproduced independently by the audio critic, not accepted from the
implementers.

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
| Ladder DC, saw in, full resonance | −188.5 dBFS | RELEASE |
| Knob-turn discontinuity | 0.029 sample delta | RELEASE |
| Triangle mip-boundary, 5120/10240 Hz | 0.407 / 0.599 | ACCEPTABLE — inherent, see below |

The wavefolder above drive ~12 on bright material is the one area still graded
AMATEUR. It is documented in the module's own doc comment with a four-frequency
table, and the drive range was deliberately left at 0.1–20 rather than narrowed:
a player may want that texture, and now they know what it is.

The mip-boundary residual was verified inherent rather than a switching
artifact — the unswitched steady-playback delta at the same mip level measures
0.44–0.68, the same order. The crossfade removes all of the switching
contribution.

The oscillator started at −43 dB and is now −143. That rebuild is the single
biggest thing that happened here, and it happened because the critic prototyped
instead of reasoning.

---

## What was fixed, and what it cost

Two fix waves closed after the first full audit. Every figure below is
before → after, reproduced independently.

**Wave A — correctness. The engine worked offline but was not a live instrument.**

| | Before | After |
|---|---|---|
| Wavetable build | inside `process()`, per sample | once at module load: 49 ms once, 0.29 µs/sample steady |
| Clock lifetime | stopped at 60 s | drift-free to 600 s, verified |
| Backgrounded tab | gate stalled 91.7% of the time under Chrome's default throttling | survives one tick per minute (90 s lookahead) |
| Clock after machine sleep | ~48,000 scheduled events in one synchronous burst | bounded ~3,600 regardless of gap |
| `disconnect` | severed every cable sharing an endpoint pair | per-cable; stress-tested to 30 cables and 1000 cycles |
| Sequencer test | passed even if the sequencer was frozen | fails when step advance is stubbed |

**Wave B — sound.**

| | Before | After |
|---|---|---|
| Wavefolder, drive 3 | −31.9 dB | −87.8 dB |
| Wavefolder, drive 20 | +6.8 dB (alias louder than signal) | −45.6 dB |
| Wavefolder bass loss at 20 Hz | −6.63 dB (its own DC blocker) | −0.167 dB |
| Ladder DC, full resonance | −15.8 dBFS | −188.5 dBFS |
| Knob-turn discontinuity | 0.775 | 0.029 |
| PWM under modulation (k-rate vs a-rate) | 1.975 | 0.649 |
| Fast filter sweep vs continuous reference | 0.6506 | 0.0000658 |

The wavefolder fix is first-order antiderivative antialiasing plus 4×
oversampling scoped to the fold. Plain ADAA alone was prototyped and rejected on
measurement — it bought 4–8 dB, because its local-linearity assumption fails
once the kink rate approaches the sample rate.

## What to do next

1. **`superpowers:finishing-a-development-branch`** — the branch is clean, both
   audits are satisfied, and the only outstanding audio finding is documented
   rather than hidden.
2. **Phase 1B, the UI**: rack, panels, eight themes, the power switch. Its plan
   is not written. Write it against this working engine, not speculatively —
   that was the point of splitting Phase 1 in two.

Two things Phase 1B will immediately need, both known:

- **`PatchGraph.dispose()` is the only thing that clears the clock's interval,
  and nothing in `src/` calls it.** Harmless while everything is offline. The
  moment the UI swaps patches live, every abandoned clock keeps a timer
  scheduling onto a discarded node forever.
- **No default patch exists**, so spec acceptance criterion 1 ("open the site,
  press power, hear something") has nothing to test against yet.

---

## Phase 1B — what the rack proved

The spec made two architectural bets. Both were tested by building, and both
held.

**Panels are declarative.** One renderer in `rack/panel.ts` draws all fifteen
modules from `ports`/`params`/`layout`/`hp`. No module is special-cased; the
keyboard and sequencer use the `customPanel` escape hatch the spec provided,
and even they get generic knobs and jacks.

**A theme is a token file.** Eight themes ship — Reaktor Dark, Moog Wood,
Phosphor Lab, Ableton Live, Circuit/PCB, Geist Groovebox, Casiotone, Korg
MS-20 — and adding the last seven forced **zero** new tokens and **zero**
component edits. Panel widths, knob sizes, jack positions and panel height are
pixel-identical across all eight, asserted by test.

Two contract gaps the build exposed, both since closed:

- `ParamSpec` could not say a param was **discrete**, so a four-position
  waveform switch rendered as a continuous knob. Added `labels?: readonly
  string[]`, which carries the positions and their display text.
- `ModuleDescriptor` had no **group**, so a palette would have needed its own
  drifting `type -> group` table. Added `group?: ModuleGroup`.

Both are validated at registration and documented in the spec.

One correction worth remembering: an early fix for theme-dependent panel width
inflated every module's `hp` (ADSR 8→26, keyboard 10→30) until content fit.
That solved the symptom and broke the unit — `hp` is real Eurorack horizontal
pitch, and a 26 HP ADSR is nonsense. The actual bug was that every `layout`
put its knobs on one row. Layouts now stack, `hp` values are realistic (4–38),
and panels are a uniform 3U as hardware is.

## Phase 2 and the academy

**Phase 2, first slice.** A `scope` module (the sixteenth) with `in` and `thru`
so it inserts mid-patch like hardware, drawing a zero-crossing-triggered
waveform and a dB-labelled spectrum. Clicking a cable inspects what is flowing
on it — waveform, fundamental and RMS — via a parallel `AnalyserNode` attached
on select and detached on deselect. Removal moved to an explicit button in that
popover, so inspecting and deleting are no longer the same gesture.

`engine/analysis` needed no extension to serve it. The spec bet that one
measurement layer would serve tests, displays and graders alike; two of the
three consumers now exist and `peakHz`/`rms` dropped straight in.

**The academy's first mode.** Five levels — First Sound, Shape It, Play Notes,
Modulate the Filter, Push the Resonance — each a real `.sinp` solution plus a
rubric, chained so each starts from the previous level's proven-passing patch.
Graded by `inspect()`, which was written for this and finally has a caller.
The palette filters to a level's granted modules; progress persists.

Two things this exposed and closed:

- `inspect` addressed modules by exact id, so rubrics only worked because the
  palette happened to number ids `${type}-1`. A player who deleted and re-added
  a module would be told they were wrong when they were right. It now accepts
  type refs, resolving "any VCO" consistently across clauses.
- Feedback spoke engine identifiers to beginners — "vco-1.out is not patched to
  output-1.in" — while the brief said "the VCO's Out jack". A presentation layer
  in `academy/feedback.ts` now renders `InspectorResult.detail` using
  descriptor names and port labels: "patch the VCO's \"Out\" jack into the
  Output's \"In\" jack". The engine still returns id-based sentences for tests.

Still to build: match-this-sound and constrained-challenge grading modes. Both
need feature extraction over a rendered buffer, which `engine/analysis` already
provides.

## Smaller things, recorded but not urgent

- `keyboard-midi.ts` has zero tests. `midi.ts`'s pure helpers are well covered;
  nothing proves `handleKey` moves the pitch and gate nodes.
- `registerAllModules()` throws on a second call — breaks HMR and a second
  engine instance.
- `loadPatch` throws when a cable names a port a known module no longer has.
  Ghosts cover unknown *types* but not removed *ports*, so partial version drift
  loses the whole file.
- The sequencer's `glide` param is a live knob wired to nothing. Hide or remove
  it before the UI renders it.
- No default patch exists, so spec criterion 1 has nothing to test.
- The wavetable set is duplicated per worklet bundle (~384 KB) — accepted cost
  of one-bundle-per-worklet.
- Noise module: exactly-periodic 2 s loop, and `color` is a binary
  20 kHz/1200 Hz switch behind a continuous-looking knob. It snaps at the
  midpoint.

---

## The audio critic

`.claude/agents/audio-engineer-critic.md`. Invoke it for anything touching an
oscillator, filter, envelope, or the analysis layer, and whenever a test asserts
an audio-quality number.

If the agent type is not registered in a fresh session, dispatch a
general-purpose agent whose prompt begins:

> **Adopt the role defined in this file and follow it exactly:**
> `/home/an4n51/Desktop/SinsThesis/.claude/agents/audio-engineer-critic.md`

That is how it was used throughout this run and it works.

**It is worth trusting because it argues back.** Across this run it reversed its
own AMATEUR grade on the ladder cutoff when challenged, retracted a
self-oscillation finding after discovering three of us had measured a 20 Hz
filter before it finished building up, caught a measurement artifact in a figure
*I* produced, and reversed its own oscillator recommendation twice by building
prototypes rather than reasoning from literature. Give it the chance to
disagree; it earns it.

---

## Traps specific to this codebase

Each of these cost real time. Do not rediscover them.

1. **Never test at a frequency where `sampleRate / f0` is at or near an integer.**
   48000/2000 = 24 folds every alias onto an exact harmonic, where the metric
   excludes it — this produced a fictitious −71 dB alias floor that stood for
   several tasks. Safe frequencies in use: 441, 1109, 1760.
2. **Use Blackman-Harris for anything measuring a noise floor.** Hann's first
   sidelobe is −31.5 dB, so a Hann-windowed metric cannot see below about −31 dB
   — it measures its own window. `fftMagnitude` takes a window parameter;
   `aliasFloorDb` already passes `'blackman-harris'`.
3. **No `/// <reference lib="webworker" />` in worklets.** TypeScript declares
   neither `AudioWorkletProcessor` nor `registerProcessor`, and the `webworker`
   lib collides with this project's `DOM` lib on ~30 global names.
   `worklets/audioworklet-globals.d.ts` covers it. Its `declare global` leaks
   project-wide; `boundaries.test.ts` is the guardrail.
4. **One Rollup bundle per worklet.** A module shared between entries makes
   Rollup hoist it to a chunk, and the emitted bundle contains cross-file
   imports that `AudioWorkletGlobalScope` cannot resolve. Verify with
   `grep "^import" public/worklets/*.js` returning nothing.
5. **The ladder's cutoff knob marks the self-oscillation frequency**, not the
   passive corner, which sits 0.435× lower. Deliberate — it is the 1 V/octave
   landmark so a resonant ladder plays in tune. Documented in `ladder.ts`. It
   has been mistaken for a bug once already.
6. **Self-oscillation takes seconds to build at low cutoffs.** At 20 Hz it needs
   about 4 s of samples. Measuring earlier reads a near-silent tail and looks
   like a defect — this fooled two reviews and the critic once each.
7. **Filter slope is not uniform.** It ramps from about −18 dB/oct near the knee
   to −68 dB/oct approaching Nyquist. Measure in a band 4–8× the cutoff. A wide
   band lands in range by cancellation and proves nothing.
8. **`__dirname` does not exist** in this ESM project's config files.
9. **Never run two implementer agents concurrently in this tree.** It happened
   once here and one agent found the other's files staged in its index. Both
   commits survived only because both agents checked their own diffs.

---

## Decisions not to re-litigate

Full reasoning for all 30 rulings is in `docs/audio/PHASE1A-LEDGER.md`. The load-bearing ones:

- **R24** — ladder cutoff calibration is correct as-is (see trap 5).
- **R25** — resonance makeup gain `input * (1 + k)`; the Stilson-Smith trick,
  and it correctly leaves the resonant peak uncompensated.
- **R28** — continuous −100 dBFS dither in the ladder worklet, because the
  digital recursion has zero as an exact fixed point and cannot self-start.
- **R29** — output ports need a fronting `GainNode` when a worklet node has
  several outputs, mirroring the input convention.
- **R30** — band-limited mipmapped wavetables, chosen over oversampled BLEP on
  measurement: 50–90 dB better *and* 14–16× cheaper. The full four-architecture
  comparison is in `docs/audio/oscillator-architecture-study.md`.
- **Known limitation:** hard sync measures −30.6 dB and a BLEP correction at the
  sync edge did not reliably help, because the jump height must be estimated
  from discrete samples and that error is comparable to what it corrects. Sync
  is unsolved in both architectures studied. The BLEP insertion mechanics are
  retained in the study as the likely tool for a future fix.
- `dsp/polyblep.ts` is retained unimported on purpose, as the reference
  implementation the wavetables were measured against. It is commented as such.
  Do not delete it, and do not wire it back in.
