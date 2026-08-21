# SinsThesis — continuation

**Updated:** 2026-08-21.
**Branch:** `main` — 138 commits. Public at github.com/WyrmSpear/SinsThesis (MIT).
**Live** at `ryanoglelmt.com/portfolio/sinsthesis/`.
**State:** 1169 tests pass (886 node + 283 browser), `typecheck` clean, tree clean.

**Run it:** `npm run dev`, open the URL, POWER ON.

- **Free play** — thirty module types, drag-to-patch cables, twelve themes,
  `.sinp` save/load with autosave, sequencer, Sampler, Scope, stereo output.
- **Presets** — eleven patches, lazy-loaded.
- **Academy** — twenty-two levels across three tracks (foundations, bass,
  history), three grading modes.
- **Arcade** — two minigames, Pan Paddle and Wub Disruptor. The synth is the
  controller.
- **Studio** — stereo recording and offline bounce, WAV export, pitch display.
- **Dev harness** at `/harness.html`.

---

## READ FIRST — mobile CPU (fixed, opt-in), one unverified report

**The owner loaded the deployed app on a phone and the CPU meter read 100%.**
Investigated, measured, and addressed — see
`.superpowers/sdd/mobile-perf-report.md` for the full per-module and
per-preset cost table. Short version: Node microbenchmarks confirmed Drive
and the Wavefolder's 4x-oversampled ADAA path costs 16-19x the naive
curve/fold (~550/~485 ns/sample vs ~31/~26 ns), the wavetable oscillator
costs ~33 ns/sample against PolyBLEP's ~11 ns, and the CPU meter's own
reporting cost is negligible (~0.001% of a quantum's budget, confirmed not
just documented). None of the shipped presets stack more than one Drive or
Wavefolder instance, so the oversampling tax alone doesn't explain a 100%
reading on an ordinary preset — it matters most for a player-built free-play
patch that stacks several of these modules. Shipped a `quality` param
(Full/Fast, default Full) on both Drive and Wavefolder: Fast mode skips both
oversampling FIRs and runs ADAA-1 alone at the native rate, ~9-13x cheaper,
with the resulting alias floor re-measured and stated honestly in each
module's own doc comment and enforced by tests (it's a real trade, not "free" —
worst case for the Wavefolder's Fast mode is RELEASE-grade only in the bass
register). See commit `e6715e4`.

**The arcade paddle only reaching the left half of the playfield — fixed.**
`buildTap` in `rack/arcade-panel.ts` now up-mixes mono to stereo (a
`channelCount: 2` / `'speakers'`-interpretation gain stage) before the signal
reaches the `ChannelSplitterNode` that reads L/R balance, mirroring
`src/engine/modules/output.ts`'s own up-mix. Investigating turned up a
wrinkle: Output's own gain node (the exact node the tap connects to)
already up-mixes anything routed through the live Output module, so the
originally diagnosed failure isn't reachable via today's normal integration
path — confirmed by reverting just the new stage and rerunning the
rack-level regression test, which still passed. Fixed anyway, unconditionally,
since `buildTap` accepts any `OutputInstance`-shaped value, not specifically
that one node, and a future refactor could silently reintroduce this with no
coverage watching for it. `tests/browser/modules/arcade-tap.test.ts` (new)
calls `buildTap` directly against a raw, genuinely single-channel source to
prove the fix is load-bearing on its own, independent of Output's behavior;
`tests/browser/rack-arcade.test.ts` adds the rack-level "mono patch reads
centered, not pinned left" guarantee. See commit `ba9e95b`.

**Memory growth — measured, flat.** Real Chromium session (chrome-devtools,
`performance.memory` sampling plus two heap snapshots), arcade mode active,
CPU meter reporting, ~50 preset swaps churning module graphs, with and
without a live recording. With recording OFF, heap oscillated in a tight
band (e.g. 31.4-32.4 MB across 40 late-session preset swaps, ~80s) with no
sustained trend — flat, no leak found in the arcade rAF loop, the CPU
meter's 5 Hz reporting, the analyser taps, or preset/module churn. With
recording ON, heap grew ~12.46 MB over 31s against an expected ~11.9 MB for
31s of 48 kHz stereo Float32 PCM (`31 * 48000 * 2 * 4` bytes) — the growth is
the recorder's own buffer, accounted for almost exactly, not an
unexplained leak, and it stops growing the moment recording stops (also
confirmed: heap went flat again immediately after Stop). Worst case by
design: the Studio's 5-minute recording cap bounds this buffer at
`300 * 48000 * 2 * 4` ≈ 115 MB — a real number worth knowing, not a leak to
fix. This closes the open question; see
`.superpowers/sdd/mobile-perf-report.md` for the full sample series.

**Still unverified:** the owner reported **no sound on first load** on both
phone and desktop, then sound on a later attempt. Could be the power-gesture
requirement behaving as designed, or something real. Not reproduced, not
investigated this pass.

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
door, the academy lives inside it) and the dev harness (kept for engine
work — it has the scope and spectrum the rack doesn't).

```
src/engine/
  analysis/   fft.ts, features.ts, inspector.ts, compare.ts, rubric.ts
              measurement + the academy's three graders (topology, sound distance, feature bounds)
  dsp/        wavetable.ts, ladder.ts, wavefolder.ts, segment.ts, flanger.ts,
              chorus.ts (geometry only -- no per-sample DSP, see its own header),
              compressor.ts, polyblep.ts (unimported, kept as reference)
  worklets/   vco, ladder, wavefolder, segment, flanger, compressor,
              passthrough, peak-tap (test-only)
              + registry.ts (WORKLET_MODULES) + audioworklet-globals.d.ts
  modules/    thirty descriptors + index.ts
  graph.ts  patch.ts  cycle.ts  render.ts  clock.ts  midi.ts  param-smoothing.ts
  types.ts  registry.ts  version.ts
rack/         main.ts, panel.ts, ghost-panel.ts, knob.ts, slider.ts, switch.ts,
              curve.ts, cables.ts, cable-inspector.ts, palette.ts, reorder.ts,
              keyboard-panel.ts, sequencer-panel.ts, scope-panel.ts, academy-panel.ts,
              match-sound-panel.ts, patch-io.ts, theme-switcher.ts, style.css,
              theme-*.css (12 themes: Graphite, Walnut & Cream, Phosphor Lab,
              Flat Grid, Circuit/PCB, Brushed Steel, Toy Piano, Patch Lab,
              Brimstone, Space Station, Vaporwave, Psychedelic)
academy/      levels.ts, feedback.ts, sound-feedback.ts, constrained-feedback.ts,
              progress.ts, sinp-raw.d.ts,
              levels/ (11 levels, each a .sinp solution/target/proof-patch + a .rubric.json)
dev/          main.ts, piano.ts, controls.ts, presets.ts, scope.ts,
              thump-harness.ts (test-only, see tests/browser/startup-thump.test.ts), style.css
index.html    the rack — npm run dev — the product's front door
harness.html  the dev harness — engine work, scope + spectrum
scripts/build-worklets.mjs    one Rollup bundle per worklet
README.md                                    front door for a fresh clone
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

The table above is all **Full quality (`quality` param = 0), the default and
what every existing patch keeps.** Drive and the Wavefolder also ship an
opt-in **Fast** mode (added for the mobile CPU finding above) that trades a
real, measured amount of this table's alias-floor headroom for ~9-13x less
CPU — see each module's own doc comment (`src/engine/dsp/drive.ts`,
`src/engine/dsp/wavefolder.ts`) and `.superpowers/sdd/mobile-perf-report.md`
for the re-measured Fast-mode floors. Never applied silently; a patch has to
opt in.

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

## What happened after Phase 1A closed

This section originally flagged two risks Phase 1B would hit immediately.
Both are resolved — recorded here so nobody goes looking for them as open
problems:

- `PatchGraph.dispose()` is now called on every graph swap. `rack/main.ts`'s
  `mountGraph()` calls `graph?.dispose()` before mounting the replacement, on
  initial boot, an explicit Load, and autosave restore alike — so an
  abandoned clock's interval is torn down instead of scheduling onto a
  discarded node forever.
- A default patch exists. `rack/main.ts`'s `buildDefaultPatch()` wires
  Keyboard → VCO → VCF → (ADSR → VCA) → Output and mounts it on first boot
  when no autosave is present, satisfying spec acceptance criterion 1 (press
  power, hear something) — proven by `tests/browser/rack-page.test.ts`'s
  "makes sound on a real keydown through the rack keyboard module".

Phase 1B (the rack itself) and Phase 2's first slice (the scope module, the
cable inspector, and the academy's first mode) are both built — see the two
sections below for what each proved. What remains open is listed under
"Still to build" and "Smaller things" further down.

---

## Phase 1B — what the rack proved

The spec made two architectural bets. Both were tested by building, and both
held.

**Panels are declarative.** One renderer in `rack/panel.ts` draws every
module from `ports`/`params`/`layout`/`hp`. No module is special-cased; the
keyboard, sequencer, and (added in Phase 2) the scope use the `customPanel`
escape hatch the spec provided, and even they get generic knobs and jacks
where they don't need bespoke UI.

**A theme is a token file.** Twelve themes ship — Graphite, Walnut & Cream,
Phosphor Lab, Flat Grid, Circuit/PCB, Brushed Steel, Toy Piano, Patch Lab,
Brimstone, Space Station, Vaporwave, Psychedelic — and adding the last
eleven forced **zero** new tokens and **zero** component edits. (Six of these
were renamed away from a third-party trademark after the fact — see "Since
the academy closed" below and
`.superpowers/sdd/theme-rename-report.md` — the names above are current.) Panel widths,
knob sizes, jack positions and panel height are pixel-identical across all
twelve, asserted by test.

**Brimstone (the ninth) was the harder test.** Every theme before it carried
its texture (scanlines, wood grain, a PCB trace grid) as a procedural CSS
gradient smuggled through `--surface-rack`/`--rail-surface` — both tokens are
substituted as an entire `background` value in `rack/style.css`, with no
gradient wrapped around them, so a token can hand back more than a flat
color. Brimstone's brief asked for something harder: a *figurative* repeating
silhouette (a heretic's fork), not an abstract pattern. It turned out to be
the same trick: the CSS `background` shorthand accepts a `url(...)` layer
exactly as readily as a `repeating-linear-gradient` one, so a small inline
SVG, base64-encoded into a `data:` URI, rides through those same two tokens
unchanged. Zero new tokens, zero component edits, nine for nine — see
`rack/theme-brimstone.css`'s own header comment and
`.superpowers/sdd/brimstone-theme-report.md` for the full account, including
where the single `--knob-indicator` token had to arbitrate between the
brief's two accent colors (ember for indicators, sulfur for "active") and a
`--text-dim` contrast pass the other themes didn't need.

**Space Station, Vaporwave and Psychedelic (the tenth through twelfth) held
the same claim under the widest brief yet.** NASA-console restraint, an
80s-retro-futurist reimagining, and 1970s warmth are about as far from each
other — and from the original nine — as this token set has been asked to
stretch, and it still needed **zero** new tokens and **zero** component
edits, twelve for twelve. Psychedelic reuses Brimstone's inline-SVG-through-
`--surface-rack`/`--rail-surface` trick for its paisley-swirl watermark (an
organic, all-curves path this time, no straight line in it); Vaporwave's
"grid horizon" is the same trick Walnut & Cream's grain and Phosphor Lab's
scanlines already established, just three gradient layers instead of two.
Legibility was the real risk on the two low-contrast palettes (Vaporwave,
Psychedelic) — every text token was measured against all three panel
surfaces, not eyeballed; Psychedelic's `--text-warn` went through the same
"measured, not assumed" brightening pass Brimstone's `--text-dim` did on
this project's first go-round. Full color tables and the contrast
measurements are in
`.superpowers/sdd/themes-ten-eleven-twelve-report.md`, and each theme's own
header comment carries the reasoning specific to it.

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

## The academy's second mode

*Match-this-sound* grades sound rather than topology. A level is a `.sinp` that
IS the target; the player's rack is rendered offline with `renderGraph` and
compared.

The metric lives in `src/engine/analysis/compare.ts`: a mel-scaled,
level-invariant, mean-subtracted spectral distance (weight 0.65) plus a
peak-normalised envelope RMS distance (0.35). Deliberately not raw FFT
bin-by-bin L2, which punishes an inaudible phase or pitch difference as harshly
as a wrong filter — that is the "a near-miss can score badly in ways that feel
unfair" failure the mode was warned about when it was chosen.

Thresholds were set by measurement, not intuition — correct patch versus a
deliberately-close-but-wrong one:

| level | correct | close-but-wrong | threshold |
|---|---|---|---|
| Bright Pluck | 0.0000 | 0.4930 | 0.35 |
| Hollow Pulse | 0.0000 | 0.5353 | 0.35 |
| Resonant Sweep | 0.0000 | 0.1133 | 0.08 |

Resonant Sweep needed the tighter bar: at 0.35 a zero-resonance patch passed.

Two bugs surfaced only by measuring against real DSP and playing the levels by
hand, not by the synthetic tests: an absolute dB floor that broke
level-invariance and scored inaudible tweaks worse than a wrong waveform, and a
whole-buffer resonance measurement that smeared a swept peak into backwards
"add more resonance" advice.

`engine/analysis` was extended deliberately — `compare.ts` is the third and last
predicted consumer, and `features.ts` gained `spectralPeakinessDb`. The spec's
bet that one measurement layer would serve tests, displays and graders has now
been tested by all three.

## The academy's third mode

*Constrained challenge* grades a **class** of sounds, not one exact patch or
one exact target — "make a convincing kick using three modules and no
sequencer" has many right answers. A level's rubric (`mode: 'constrained'` in
`academy/levels.ts`) combines two halves: `maxModules` (a new field on
`InspectorQuery`, graded structurally by `inspect()`, which already counted
what was present — Output is excluded from the count, since it's mandatory
plumbing every patch needs to be heard at all) and `features` (a set of
bounds, graded perceptually by `gradeFeatures`, new in
`src/engine/analysis/rubric.ts`, against the player's own patch rendered
offline through the same `renderPatch` match-this-sound already uses). The
module counter is shown live in `rack/academy-panel.ts` from the moment a
player enters the level, not only after a Check — the task's own warning that
withholding it "they will not know they have broken the rule until they
check."

Three levels, each teaching something different: **09-thump** (percussive —
one ADSR shared between the VCA's amplitude and the VCO's FM, teaching that
pitch and amplitude envelopes are separate destinations even off one
generator), **10-drift** (texture — an LFO modulating a filter's cutoff or an
oscillator's pitch, teaching modulation, self-running with no keyboard),
**11-fold-pluck** (hard-constrained — no VCF granted at all, forcing the
non-obvious discovery that a wavefolder's `foldCv`, envelope-driven, can fake
a filter's brightness-over-time with no filter in the rack).

`engine/analysis` needed real extension here, not just composition:
`features.ts` gained `peakNormalizedEnvelope`/`attackMs`/`decayMs` (generalized
out of what `compare.ts` had kept private), `peakRms`, `driftOctaves` and its
two wrappers `pitchDropOctaves`/`brightnessDropOctaves` (early-vs-late window
comparison, in octaves), and `spectralCentroidMotionOctaves`. The pitch one
needed a second pass: `peakHz`'s "loudest FFT bin" definition of pitch is the
*spectral* peak, not the fundamental, and a heavily wavefolded tone can have a
harmonic louder than its own fundamental — measured directly, a
perfectly-steady-pitch wavefolder patch read a spurious ~0.8 octave "pitch
drift" purely because the fold's own intensity changes which harmonic
dominates. `pitchDropOctaves` now runs on the new `autocorrelationPitchHz`
instead, which tracks the waveform's repetition period — unmoved by
distortion reshaping the spectral envelope.

Verified with the three-pass/two-fail matrix the task demanded for each
level (real DSP, `tests/browser/analysis/rubric-render.test.ts`): at least
three genuinely different patches pass, at least two plausible-but-wrong ones
fail. Full numbers, the rubric-shape reasoning, and the two brief rewrites
that came out of playing all three by hand are in
`.superpowers/sdd/academy-constrained-report.md`.

This closes out the academy's three-mode arc the spec laid out: build the
patch, match the sound, satisfy the constraint.

## Since the academy closed

**Stereo, at the destination stage.** The design decision was not to thread
stereo through all the mono modules but to put it where hardware does — a
stereo-capable Output, a Panner (equal-power, measured flat to 0.000 dB centre
versus extremes), a Ping-Pong Delay with crossed feedback, and a mid-side Width
stage. Every stereo module is mono-compatible as a first-class acceptance test:
Width's mono sum is RMS-identical to five decimals across its whole range,
which is why M/S was chosen over a Haas widener. Recording and bounce were made
genuinely stereo rather than scoped down, so a stereo patch exports a stereo
WAV.

`renderGraph`/`renderPatch` stay deliberately mono with a `renderPatchStereo`
sibling for the bounce; the Scope's mono read is `AnalyserNode`'s own spec'd
down-mix. Both are documented choices, not oversights.

**A second filter type.** There was exactly one filter — a four-pole lowpass
ladder — so hi-hats, formant sweeps and bandpass wahs were impossible. The
state-variable filter gives simultaneous lp/bp/hp/notch, cutoff accurate to
0.18% from 50 Hz to 19 kHz, genuinely two-pole at −12.6 dB/oct. It deliberately
does **not** self-oscillate: a first attempt mirroring the ladder's
push-past-threshold trick produced a relaxation oscillator detached from the
knob, so this one is provably BIBO-stable instead.

**A bass toolkit, driven by tester requests** for dubstep, bass house, trap and
grime. The LFO now locks to clock divisions (measured error 0.003–0.006%,
survives a tempo change mid-note), and an antialiased Drive module adds
saturation with soft and hard curves (alias floor −95.8 / −85.1 dB at drive 20,
worst case −74.1 across a four-fundamental sweep).

**Ten presets and a second academy track.** Four of the five bass level
solutions *are* the shipped presets — the academy's founding decision that
levels are authored by patching means a solution and a preset can be one file.
Listening to them caught a load-time transient clip affecting **every** patch
anyone loads, which measurement alone had missed.

**Twelve themes.** Space Station, Vaporwave and Psychedelic joined the nine.
Still zero new tokens and zero component edits — twelve for twelve.

**Researched history.** `docs/history-of-synthesis-research.md` holds cited
research on Kurzweil and the wider lineage, with disputed claims flagged
unverified, plus a design for a history academy track where players rebuild
historically important sounds rather than reading a timeline. Not yet built.
That research document's own IP section flagged the live legal question it
found already shipped: six theme names (Reaktor Dark, Moog Wood, Ableton
Live, Geist Groovebox, Casiotone, Korg MS-20) used a manufacturer's mark as
the theme's own selectable UI name, the weakest possible fair-use position.
Renamed to Graphite, Walnut & Cream, Flat Grid, Brushed Steel, Toy Piano and
Patch Lab — ids, filenames and every reference, not just the display
labels — with a `localStorage` migration so a returning visitor keeps their
theme. In their place: an honest, nominative lineage note in each renamed
theme's own CSS file, plus one in each of the ladder filter, wavefolder and
state-variable filter's doc comments crediting Moog, Buchla and Oberheim by
name — describing a real lineage in prose instead of borrowing it as a
product name. Full rename map and reasoning in
`.superpowers/sdd/theme-rename-report.md`.

## The most recent arcs

**A sampler, and what it cost.** The first module whose state is not just
numbers. Samples embed in the `.sinp` as base64 PCM16 through a generic
`serializeState`/`restoreState` hook, chosen over a file reference a browser
cannot durably resolve, and over silently dropping the audio. The demo preset
is 141 KB, nearly all audio — real bloat, taken deliberately.

Two audit findings followed and both were real. A **hot sample was silently
hard-clipped on save** (1.4 peak reloading as 1.0) and the round-trip test only
checked `fileName` and `durationSeconds`, never the audio — which is why it
shipped. Now samples normalise on save with the gain recorded, and the test
compares actual sample values, verified by disabling the fix and watching it go
red. Separately the **DC test was measuring a truncation artifact**, reading
−42.9 dB where real DC control is −123 to −157 dB; it now measures DC on a
window the source actually fills, against a bar ten times stricter.

**Psychoacoustic modules, deliberately claim-free.** Binaural, Isochronic and a
sixteen-entry Frequency Bank. Because this ships from a licensed therapist's
practice site, the modules describe mechanisms and never assert physiological
effects — a grep for benefit language across every new file returns exactly one
hit, the disclaimer saying what is not claimed. Binaural holds a 0.3 Hz beat
with zero measurable drift over three minutes; the isochronic gate's edge
discontinuity is 0.0027 against 1.0000 for a hard gate; every bank frequency is
within 3.6e-5 Hz of its claim.

That work also corrected its own doc comment after measuring it: summing a
binaural signal to mono does **not** silence the beat, it produces real acoustic
interference amplitude modulation.

**Trademarks out of the UI.** Six themes shipped third-party marks as
selectable names. They were renamed (Graphite, Walnut & Cream, Flat Grid, Patch
Lab, Brushed Steel, Toy Piano) with a localStorage migration so returning
players keep their theme, and the real names moved into prose — module doc
comments now credit Moog's ladder, Buchla's wavefolder and Oberheim's
state-variable topology, which is nominative fair use and the honest place for
them. The README carries a non-affiliation line.

**A history track.** Six levels tracing the lineage, graded by the existing
modes rather than presented as prose. The strongest is East Coast / West Coast,
which uses a mechanism-agnostic feature so the ladder route and the wavefolder
route both satisfy the same bound — you learn the Moog/Buchla fork by walking
both paths. Titles stay descriptive; real names live in the briefs.

## The effects rung — ring mod, flanger, chorus, compressor

ROADMAP section 1's effects list, built out. **Reverb is now the only
unshipped item on it.** Four modules, 26 → 30.

**Ring Modulator.** The roadmap called it the highest value-to-effort ratio
on the list and undersold it: `GainNode.gain` is an a-rate `AudioParam` and
a connected signal *sums into* it, so a gain node at `gain.value = 0` driven
by a bipolar carrier is a true four-quadrant multiply in float — no worklet,
no `dsp/` file. It also needs no alias floor, because multiplying two
band-limited signals produces only their sum and difference where a fold or
a saturation curve produces an infinite harmonic series. Carrier suppressed
to **−128.0 dB**, input to **−145.1 dB**. `shape` morphs ring→AM as one
continuous knob (`in * (shape + carrier)`) rather than a mode switch, with a
`1/(1+shape)` trim so it isn't secretly a volume knob — verified by forcing
the trim to 1 and watching the ratio hit 1.7315 and the test go red.

**The finding worth carrying forward, from the Flanger.** It was built
first as the obvious native `DelayNode` + LFO + feedback gain, exactly how
`delay.ts` is built, and its feedback measured wrong. **Web Audio inserts at
least one render quantum (128 samples, 2.667 ms at 48 kHz) into any cycle in
the graph**, and a flanger's regeneration is a cycle — so its feedback
resonated on a comb of period `1/(d + 0.002667)` while its own dry/wet
notches sat at `1/(2d)`. Measured at d = 1 ms: resonance spacing **250–280
Hz**, against 1000 Hz predicted with no quantum and **273 Hz** with one. The
quantum wins conclusively.

So the Flanger owns its delay line in a worklet, and the numbers came right:
notches at **−240 dB** (the float64 floor), **−133 dB** at a deliberately
fractional 47.5-sample delay (which is what the Catmull-Rom read buys over a
linear one), regeneration spacing **999.8 Hz**, and feedback tilt **+19.1 /
−19.1 dB** at ±0.8 — equal and opposite, which is precisely the symmetry the
quantum destroys. The node test names 273 Hz in a comment as the failure
mode to watch for, so a future revert to a `DelayNode` gets caught rather
than merely sounding worse. The native path survives as an honest
`'degraded'` fallback whose badge says the Feedback knob does nothing there.

**The rule: a delay-based effect needs a worklet if and only if it has
feedback at short delay times.** The Chorus has no feedback, so no cycle, so
no quantum — native `DelayNode`s are correct for it, and the two modules
landing on opposite answers is one rule applied to two graphs, not an
inconsistency. It will matter again for reverb, which is short feedback
paths all the way down.

**Chorus.** Three voices at 120°, with the phase carried in `PeriodicWave`
coefficients (`real[1] = sin p`, `imag[1] = cos p`) rather than by staggering
three oscillators' start times — a time stagger encodes a fixed number of
*seconds*, so it silently stops being a third of a cycle the moment the Rate
knob moves. Measured offsets **120.0° / −120.0°**, and **still 120.0° /
−120.0° at a different rate**, which is the assertion a staggered-start
implementation would fail. Taps land at samples 576/960/1344 = exactly
12/20/28 ms, each weighted 0.3333.

**Compressor.** Built rather than wrapping `DynamicsCompressorNode`, whose
knee, detector and lookahead are unspecified in ways you cannot predict and
therefore cannot assert, and which has neither a sidechain nor a
gain-reduction output. Static curve lands on `threshold + (in −
threshold)/ratio` to the digit at 2:1, 4:1 and 8:1. Attack and release are
true time constants — 63.2% coverage after one knob-time — and, the figure
worth keeping, **63.2% at every input level from −12 to 0 dB**: smoothing the
detected level instead of the gain reduction is the classic error and makes
attack time drift with how far over threshold the signal sits. The knee is
quadratic and provably joins both straight segments at both edges. Ships
with a sidechain key (switch-selected, since `ModuleInstance` still has no
connect notification — same reason as the Ring Mod's carrier) and a GR jack
carrying reduction in real dB.

## Smaller things, recorded but not urgent

- `handleKey` is proven only end-to-end: `tests/browser/dev-page.test.ts` and
  `tests/browser/rack-page.test.ts` both drive a real trusted keydown and
  assert sound starts and stops, which exercises `handleKey` through the
  whole engine. Nothing isolates it as a unit, and nothing proves `octave`
  moves the right note. `handleMidiEvent` (the actual MIDI-controller path)
  has no coverage at any level beyond `midi.ts`'s pure `parseMidiMessage`
  helper — no test ever constructs a keyboard module instance and calls
  `handleMidiEvent` on it, so spec acceptance criterion 4's "MIDI
  controller" half is unproven even though "computer keyboard" now is.
- `registerAllModules()` throws on a second call — breaks HMR and a second
  engine instance. Both `dev/main.ts` and `rack/main.ts` work around it with
  an `if (!getModule('vco')) registerAllModules()` guard rather than fixing
  the registry.
- `loadPatch` throws when a cable names a port a known module no longer has.
  Ghosts cover unknown *types* but not removed *ports*, so partial version drift
  loses the whole file.
- The wavetable set is duplicated per worklet bundle (~384 KB) — accepted cost
  of one-bundle-per-worklet. `dsp/wavetable.ts` is pulled into both
  `vco.worklet.ts` and `segment.worklet.ts`.
- Noise module: exactly-periodic 2 s loop, and `color` is a binary
  20 kHz/1200 Hz switch behind a continuous-looking knob. It snaps at the
  midpoint.
- ~~Spec section 11's "worklet fails to load → native approximation + badge"
  and "CPU overload → load meter" failure modes were never built.~~
  **Both shipped since** — `modules/worklet-fallback.ts` and the badge
  `rack/panel.ts` draws from `ModuleInstance.fallback` (commit `f9073c3`),
  and `worklets/cpu-meter.worklet.ts` + `rack/cpu-meter-panel.ts` (commit
  `f3c44b0`). This bullet outlived its own fix by a day and was caught by the
  2026-08-21 stale-rung audit, not by anything failing. The caveat that
  matters: the meter reports load and the Drive/Wavefolder `quality` remedy
  is opt-in at Full by default, so nothing degrades automatically on a slow
  device — see ROADMAP section 4.

---

## The audio critic

`.claude/agents/audio-engineer-critic.md`. Invoke it for anything touching an
oscillator, filter, envelope, or the analysis layer, and whenever a test asserts
an audio-quality number.

If the agent type is not registered in a fresh session, dispatch a
general-purpose agent whose prompt begins:

> **Adopt the role defined in this file and follow it exactly:**
> `.claude/agents/audio-engineer-critic.md`

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
10. **Retiming the Clock module does not reset a downstream Sequencer's step
    index**, and it shouldn't (a tempo knob rewinding a running sequence
    would be wrong on real hardware too). `tests/browser/rack-sequencer.test.ts`
    assumed otherwise and was flaky under full-suite contention as a result —
    the sequencer drifts however many steps the old schedule fired during
    setup, and `graph.setParam(clockId, 'bpm', ...)` only re-times the
    clock's own gate edges from "now," it has no idea a sequencer is even
    downstream. Fixed by driving the sequencer's own `reset` port directly
    (a throwaway `ConstantSourceNode` pulsed onto its front `GainNode`), with
    two more traps under that one, both found by reproducing under 4-way
    parallel full-suite contention rather than reasoning: the reset pulse
    must fire *after* retiming the clock (retiming first is what atomically
    kills the old schedule, closing the gap it could otherwise sneak one
    more edge through), and its scheduled time must be an explicit future
    `ctx.currentTime` offset, not bare "now" (`ctx.currentTime` only
    advances once per render quantum, ~2.7 ms, so "now" scheduled from two
    calls microseconds apart routinely lands both edges in the same
    quantum). Full account in
    `.superpowers/sdd/themes-ten-eleven-twelve-report.md`.
11. **Web Audio silently adds one render quantum (128 samples, 2.667 ms at
    48 kHz) to any cycle in the graph.** Spec'd behaviour, not a Chrome
    quirk, and it makes a native `DelayNode` unusable for any effect whose
    feedback path is short. It cost a complete build of the Flanger to
    find: that version's regeneration resonated at `1/(d + 0.002667)` while
    its own dry/wet notches sat at `1/(2d)` — two unrelated combs, which is
    not what a flanger is. Measured at d = 1 ms, resonance spacing came out
    **250–280 Hz**, against 1000 Hz predicted with no quantum and **273 Hz**
    with one. **The rule: a delay-based effect needs its own worklet delay
    line if and only if it has feedback at short delay times.** It does not
    bite `delay.ts` (2.667 ms on a 300 ms echo is 0.9%) or the Chorus (no
    feedback, so no cycle at all), and it *will* bite reverb, which is short
    feedback paths all the way down. The regression guard is in
    `tests/node/dsp/flanger.test.ts`, which asserts the spacing reads
    1000 Hz and names 273 in a comment as the failure mode to watch for.

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
