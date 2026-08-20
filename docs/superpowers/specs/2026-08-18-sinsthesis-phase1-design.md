# SinsThesis Phase 1 — Core Engine and Rack

**Date:** 2026-08-18
**Status:** design approved, awaiting implementation plan
**Scope:** Phase 1 of five. The instrument makes sound and you can patch it.

## 1. What SinsThesis is

A deep modular synthesizer that runs in a browser. Its ancestors are Moog's
hardware, circuit synthesis, and Native Instruments Reaktor. It is a full
instrument worked out numerically, not a marketing page with audio attached.

Five phases, each with its own spec:

1. **Core engine + rack** — audio graph, modules, cables, knobs. *This spec.*
2. **Analysis** — scopes, spectrum, signal-flow visualization on every cable.
3. **Studio** — recording, export, preset management.
4. **Academy** — instructional levels graded by the engine.
5. **Sharing** — patch library, URL and file sharing.

Academy precedes sharing because teaching a stranger why they should care
must come before giving them a library to browse.

## 2. Decisions this spec inherits

The 2026-08-17 design session settled these. `docs/DECISIONS-recovered.md`
records how each was reached.

| Question | Decision |
|---|---|
| Patching paradigm | Rack of panels at the top level; any module opens to reveal its internal node graph |
| DSP depth | Native WebAudio for gain, delay, mixing and routing; hand-written AudioWorklets for character |
| Engine architecture | Approach 1 now, with a monolithic-worklet engine planned behind the same interface |
| Themes | Eight, switchable, Graphite by default (named Reaktor Dark until a post-launch trademark rename — see `docs/CONTINUATION.md`) |
| Theme semantics | Skin only. No feature ever hides behind a look, and geometry stays identical across themes |
| Voices | Monophonic, last-note priority with glide. Polyphony waits |
| AI | Co-pilot, generative modulation, and patch morphing, against a local OpenAI-compatible endpoint. Not Phase 1 |

## 3. Architecture

Three layers. Dependencies run one way, and `engine/` imports nothing from
`ui/`.

```
engine/    graph, modules, dsp, analysis, midi, clock, persist   ← zero DOM
ui/        controls, rack, node-graph, panels                    ← Svelte 5
themes/    eight token files                                     ← CSS custom properties
```

**Stack:** TypeScript, Svelte 5, Vite, Vitest, Playwright. Node 22.

> **Recorded deviation (Phase 1B, built).** The UI layer did not use Svelte
> and the three-directory split above is not what shipped. What actually
> exists is `src/engine/` (unchanged — still zero DOM, still the layer this
> section's dependency rule protects), plus three plain-TypeScript-and-DOM
> entry points at the repo root: `rack/` (the product's front door),
> `dev/` (the engine-work harness), and `academy/` (Phase 4's first mode,
> which arrived early — see Section 12 and `docs/CONTINUATION.md`). Themes
> are CSS custom-property files living inside `rack/` (`rack/theme-*.css`),
> not a separate top-level `themes/` directory. The dependency rule itself
> held: `tests/node/boundaries.test.ts` asserts nothing under `src/engine/`
> imports from a `ui/` path or `svelte`, which remains true regardless of
> what the UI layer is actually built with. This is recorded here rather
> than rewritten into the original text because it was a real decision this
> spec made and later abandoned, not a typo.

The engine holds no reference to the DOM, which lets it render patches in
`OfflineAudioContext` under Node and headless Chrome. Section 9 turns that
property into a feature.

## 4. The module contract

Panels are declarative. Every module ships a descriptor, and one generic
renderer draws it. Thirty modules across eight themes stay tractable because
they share a single renderer instead of forking into 240 hand-maintained
panels.

```ts
interface ModuleDescriptor {
  type: string; name: string; hp: number;
  group?: 'source' | 'shaping' | 'modulation' | 'utility' | 'control';
  ports:  PortSpec[];    // {id, dir, signal: 'audio'|'cv'|'gate', label, pos}
  params: ParamSpec[];   // {id, min, max, default, curve, unit, labels?}
  layout: LayoutItem[];  // {kind, ref, x, y}
  customPanel?: string;  // escape hatch for bespoke UI (Section 4, below)
  create(ctx: BaseAudioContext): ModuleInstance;
}

interface ModuleInstance {
  inputs:  Map<string, AudioNode | AudioParam>;
  outputs: Map<string, AudioNode>;
  setParam(id: string, value: number, atTime?: number): void;
  dispose(): void;
}
```

As shipped in `src/engine/types.ts`: `create` takes `BaseAudioContext`, not
`AudioContext` — the parent class both `AudioContext` and
`OfflineAudioContext` extend, which is what lets `engine/render.ts` render a
patch under `OfflineAudioContext` in tests and Node with no code path
difference from the live rack. `customPanel` was always described in prose
two paragraphs below but omitted from this code block; it is included above
for completeness. As shipped, three modules use it, not the one the prose
below names: the sequencer (as written), plus the keyboard/MIDI module (its
on-screen piano — omitted from the sentence below since Phase 1B, not a
later addition) and the scope (Phase 2, as the prose already anticipated).

A `ParamSpec` with `labels` (one string per integer position, `min` through
`max`) is discrete rather than continuous — a waveform switch, not a cutoff
knob. The renderer draws it as a switch showing the current label instead of
a 270° knob, and the engine snaps it rather than smoothing it. The registry
rejects a `labels` array whose length does not equal `max - min + 1` at
registration time, the same way it already rejects an out-of-range default.

Modules that genuinely need bespoke UI — the sequencer and, in Phase 2, the
scope — declare a custom panel component instead of a layout grid.

`group` sorts a module into one of the rack's five palette sections —
source, shaping, modulation, utility, control — the same five names the
palette UI groups its module list under. It lives on the descriptor rather
than being inferred in the UI from `type` or `name`, for the same reason
`labels` lives on `ParamSpec` rather than being guessed from a param's
range: the descriptor is the one place a module's own author states what
it is, so the palette never drifts out of sync with a name-matching rule
maintained separately in the UI layer. It is optional — a hand-rolled test
descriptor need not classify itself — but every shipped module sets one.
The registry rejects a `group` that is not one of the five known values at
registration time, the same way it already rejects an out-of-range default
or a mismatched `labels` length.

`ModuleInstance` is the seam that makes the planned engine upgrade real.
Today each instance wraps native nodes and worklets. Later an instance can
wrap a message port into a monolithic worklet, one module at a time, while
panels, themes, and patch files stay untouched.

## 5. Signals and patching

Ports declare one of three types — `audio`, `cv`, `gate` — and all three
travel as a-rate `AudioNode` connections, because voltage is voltage. The
engine therefore permits any port to reach any port. Patching audio into a
filter's cutoff is a technique, not a mistake. Types drive cable color per
theme and give the Phase 4 co-pilot something to reason about.

Conventions: pitch CV moves 1.0 per octave from A4, gates are 0 or 1, audio
spans ±1.

**Feedback loops stay visible.** WebAudio permits a graph cycle only through
a `DelayNode`. On connect, the engine detects the cycle, inserts the required
128-sample delay, and marks that cable with a distinct style. You always know
which cable costs you 2.7 ms. Feedback inside a module — the ladder's
resonance, the wavefolder — lives inside a single worklet and stays
sample-exact.

## 6. The Phase 1 module set

Fifteen modules, chosen so the rack can make music rather than demonstrate a
sine wave.

**Sources** — VCO (PolyBLEP saw, pulse, triangle, sine; PWM; exponential and
linear FM inputs; hard sync)&#42;, Noise.

> &#42; **Recorded deviation.** The VCO ships on band-limited mipmapped
> wavetables (`src/engine/dsp/wavetable.ts`), not PolyBLEP — Decision R30 in
> `docs/audio/PHASE1A-LEDGER.md`, made mid-Phase-1A on measurement: 50–90 dB
> better alias rejection and 14–16× cheaper. `dsp/polyblep.ts` is kept
> unimported as the reference implementation the wavetables were measured
> against; it is not wired into any module. Waveform set, PWM, FM inputs,
> and hard sync are otherwise as specified.

**Shaping** — Ladder VCF (ZDF/TPT four-pole with transistor nonlinearity,
self-oscillating), VCA (native gain, linear and exponential curves),
Wavefolder.

**Modulation** — ADSR, LFO (the VCO's oscillator core at sub-audio rates,
free-running or clock-synced)&#42;&#42;, Sample and Hold.

> &#42;&#42; **Recorded deviation.** LFO shares the VCO's *DSP core*
> (`dsp/wavetable.ts`), reused as intended, but not literally "the VCO
> worklet": its `AudioWorkletProcessor` (registered as `'lfo'`) lives in
> `segment.worklet.ts` alongside ADSR, Sample and Hold, and the sequencer —
> not in `vco.worklet.ts`. This follows from trap 4 in
> `docs/CONTINUATION.md` (one Rollup bundle per worklet; a module shared
> between two worklet *entry points* gets hoisted into an unresolvable
> chunk), so every low-rate/control module that needed the oscillator core
> had to bundle its own copy rather than share the VCO's own worklet file.

**Utility** — Mixer with attenuverters, Multiple, Delay.

**Control** — Clock (BPM and divisions), 16-step Sequencer (CV and gate out),
Keyboard and MIDI interface (pitch CV, gate, velocity CV), Output (level and
meter).

Four hand-written worklets cover all of it: the VCO core, the ladder filter,
the wavefolder, and a segment generator — as shipped, shared by ADSR, Sample
and Hold, LFO, and the Sequencer (Section 6's Control group), not only the
two named here. Everything else uses native nodes.

> **Recorded update (Phase 2, first slice, built).** A sixteenth module,
> Scope, shipped ahead of the rest of Phase 2 — see
> `docs/CONTINUATION.md`'s "Phase 2 and the academy". It has `in` and `thru`
> ports so it inserts mid-patch like a piece of hardware, and draws a
> zero-crossing-triggered waveform plus a dB-labelled spectrum via a
> `customPanel`, reusing `engine/analysis` (Section 9) exactly as that
> section predicted a Phase 2 consumer would. The fifteen-module count and
> list above are left as originally written: they were Phase 1's actual
> module set, and this note records the addition rather than folding it in
> as if it had always been there. Everywhere else in the documentation
> (`docs/CONTINUATION.md`, the registry's own doc comment, `README.md`) the
> live count is sixteen.

## 7. The patch format

`.sinp` files hold JSON:

```json
{
  "version": 1,
  "meta": { "name": "", "created": "", "author": "" },
  "modules": [{ "id": "", "type": "", "slot": [0, 0], "params": {} }],
  "cables":  [{ "from": ["modId", "portId"], "to": ["modId", "portId"] }]
}
```

The patch stores no theme, so a patch travels across all eight skins
unchanged. A patch that names an unknown module type loads as a ghost module
that preserves its parameters and cables, so a file written by a later
version round-trips instead of losing data quietly.

Patches autosave to localStorage. Export and import move them as files.

## 8. Themes

Each theme is a token file of CSS custom properties: surfaces, engraving,
knob materials, cable colors per signal type, lamp colors, type scale.
Switching a theme rewrites tokens and nothing else. Geometry — panel widths,
knob sizes, jack positions — stays identical across all eight, so a
screenshot of one patch matches structurally in every skin, and a Playwright
test asserts exactly that.

Graphite ships as the default because it survives a sixty-module patch
and a second zoom altitude without turning to soup.

## 9. engine/analysis

Measurement is a first-class engine module, not test scaffolding. Three
consumers need the same numbers:

- **Tests** assert on them (Section 10).
- **Phase 2** renders them as scopes and spectra.
- **Phase 4** grades levels with them.

Two entry points:

**Graph inspector** — reports modules present, connections, and parameter
values, and answers queries with tolerances.

**Feature extraction over a rendered buffer** — spectral centroid,
mel-spectrogram, RMS envelope, fundamental pitch, harmonic content, alias
floor.

Building this in Phase 1 costs almost nothing, because the test suite needs
every one of these measurements anyway. Leaving it in the test folder would
force us to write the engine's introspection twice.

## 10. Testing

**Pure DSP cores.** Every worklet's math lives in a module exporting
`process(input, params) → output`. The `AudioWorkletProcessor` is a thin
shell around it. The ladder filter is therefore unit-testable in Node with no
browser and no audio context.

**Rendered assertions.** `OfflineAudioContext` renders a patch, and
`engine/analysis` measures the result:

- a VCO at 440 Hz peaks at 440 ±1 Hz, with saw-correct harmonic rolloff
- the ladder filter measures −24 dB/octave above cutoff
- maximum resonance self-oscillates at the cutoff frequency
- PolyBLEP holds the alias floor below −60 dB

**Graph logic** — connect, disconnect, cycle detection, serialize round-trip,
ghost-module preservation — runs in Vitest as plain TypeScript.

**UI** — Playwright covers cable drag, knob drag, and the geometry-invariance
assertion from Section 8.

## 11. Failure modes

Every failure states itself. None fails silently.

| Condition | Behavior |
|---|---|
| AudioContext needs a user gesture | The rack boots to a themed power switch. Authentic, not a workaround |
| A worklet fails to load | That module degrades to a native approximation and shows a badge. The rack keeps running |
| CPU overload | The engine counts render-quantum overruns and shows a load meter. Past a threshold it refuses new modules and says why |
| A patch names unknown modules | They load as ghosts, and a report lists what did not return |
| MIDI permission denied | The computer keyboard keeps working, and the MIDI module shows its unpatched state |

**Recorded gap.** The "worklet fails to load" and "CPU overload" rows above
were never built: `engine/render.ts`'s `ensureWorklets()` rethrows on a
failed `audioWorklet.addModule()` with no native-approximation fallback and
no badge, and nothing in the codebase counts render-quantum overruns or
shows a load meter — CPU overload has no handling at all today. The other
three rows (power-gesture boot, ghost modules, MIDI-permission graceful
degradation) are built and match this table. This gap was found during a
documentation audit, not fixed as part of it — see `docs/CONTINUATION.md`
for what is and isn't tracked as open work.

## 12. Forward compatibility

Phase 1 leaves four seams open. Each costs little now and would cost a
rewrite later.

**Monolithic engine.** `ModuleInstance` hides whether a module runs on native
nodes or a message port, so modules migrate one at a time.

**Academy.** Levels grade three ways, and all three read `engine/analysis`:
build-this-patch scores against the graph inspector, match-this-sound scores
perceptual distance between rendered buffers, and constrained challenges
weigh extracted features against a per-level rubric. A grade never arrives as
a bare number — Phase 2's scopes and spectra show the miss, overlaying your
result on the target. The module palette reads from data and accepts a
filter, so a level can grant four modules and withhold the rest. Level
definitions are `.sinp` files plus a rubric, which means levels are authored
by patching rather than by writing JSON.

**AI.** The co-pilot reads the serialized patch, so stable module ids in the
patch format are all it needs. Generative modulation arrives as an ordinary
CV module whose LLM emits a pattern spec at composition rate while a
deterministic worklet plays it at audio rate. The LLM never touches the audio
thread.

Patch morphing needs its scope stated honestly. No learned latent space
exists here, and building one is a research project with a dataset attached.
What ships is parameter-space interpolation between two patches with topology
reconciliation — shared modules interpolate, unique modules crossfade — where
the model chooses the path rather than navigating a learned manifold. A true
latent space remains a far-future arc.

**Polyphony.** Voice allocation will wrap the graph rather than thread
through it. Phase 1 builds one voice and does not assume there will only ever
be one.

## 13. Out of scope for Phase 1

Scopes and spectrum displays, recording and export, preset browsing, the
academy, patch sharing, polyphony, the monolithic worklet engine, and every
AI feature. Phase 1 delivers an instrument that makes sound, holds a patch,
plays from keyboard and MIDI, runs a sequence, and saves its work.

## 14. Acceptance

Phase 1 is done when an operator can:

1. Open the site, press the power switch, and hear a default patch.
2. Drag modules into the rack and patch cables between any two ports.
3. Turn knobs and hear the change without clicks or zipper noise.
4. Play from the computer keyboard and from a MIDI controller.
5. Run the clock and sequencer so a patch evolves unattended.
6. Save a patch, reload the page, and get it back.
7. Switch all eight themes without the patch changing structurally.
8. Watch the test suite prove the filter slope, the oscillator pitch, and the
   alias floor numerically.

**Recorded status, checked against the shipped tests (not re-asserted, just
verified):**

1. **Met.** `rack/main.ts`'s `buildDefaultPatch()` wires a playable voice on
   first boot; `tests/browser/rack-page.test.ts` proves a real keydown makes
   sound through it.
2. **Met.** `tests/browser/rack-page.test.ts` covers palette-add and
   cable-drag; `tests/browser/rack-scope.test.ts` and
   `tests/browser/rack-sequencer.test.ts` add module-specific cases.
3. **Met.** `param-smoothing.ts` schedules every knob write; measured at
   0.029 sample delta (was 0.775 before Wave B — see
   `docs/CONTINUATION.md`), well under `tests/browser/param-smoothing.test.ts`'s
   threshold.
4. **Half met.** The computer-keyboard half is proven end-to-end
   (`tests/browser/dev-page.test.ts`, `tests/browser/rack-page.test.ts`, real
   trusted keydowns). The MIDI-controller half has no coverage beyond
   `midi.ts`'s pure `parseMidiMessage` unit tests — nothing calls
   `handleMidiEvent` on a live module instance, in a unit test or an e2e one.
   See `docs/CONTINUATION.md`'s "Smaller things" for detail.
5. **Met.** `tests/node/clock.test.ts` and
   `tests/browser/modules/sequencer.test.ts`/`rack-sequencer.test.ts` cover
   drift-free operation to 600 s and step advancement under a real clock.
6. **Met.** `.sinp` export/import plus autosave;
   `tests/browser/rack-page.test.ts`'s save/load round trip and ghost-module
   test cover it.
7. **Met.** `tests/browser/theme-geometry.test.ts` asserts pixel-identical
   geometry across all eight themes.
8. **Met**, on updated numbers. The oscillator moved from PolyBLEP to
   band-limited wavetables (Decision R30, `docs/audio/PHASE1A-LEDGER.md`)
   partway through Phase 1A, so the alias-floor bar this criterion was
   written against (−60 dB) is stale; `tests/browser/acceptance.test.ts`
   documents why inline and asserts the honest, far-stronger number
   (≤ −120 dB) instead of quietly keeping the old bar.
