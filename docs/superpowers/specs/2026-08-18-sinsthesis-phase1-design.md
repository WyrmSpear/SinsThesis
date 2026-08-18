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
| Themes | Eight, switchable, Reaktor Dark by default |
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
  ports:  PortSpec[];    // {id, dir, signal: 'audio'|'cv'|'gate', label, pos}
  params: ParamSpec[];   // {id, min, max, default, curve, unit}
  layout: LayoutItem[];  // {kind, ref, x, y}
  create(ctx: AudioContext): ModuleInstance;
}

interface ModuleInstance {
  inputs:  Map<string, AudioNode | AudioParam>;
  outputs: Map<string, AudioNode>;
  setParam(id: string, value: number, atTime?: number): void;
  dispose(): void;
}
```

Modules that genuinely need bespoke UI — the sequencer and, in Phase 2, the
scope — declare a custom panel component instead of a layout grid.

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

Thirteen modules, chosen so the rack can make music rather than demonstrate a
sine wave.

**Sources** — VCO (PolyBLEP saw, pulse, triangle, sine; PWM; exponential and
linear FM inputs; hard sync), Noise.

**Shaping** — Ladder VCF (ZDF/TPT four-pole with transistor nonlinearity,
self-oscillating), VCA (native gain, linear and exponential curves),
Wavefolder.

**Modulation** — ADSR, LFO (the VCO worklet at sub-audio rates, free-running
or clock-synced), Sample and Hold.

**Utility** — Mixer with attenuverters, Multiple, Delay.

**Control** — Clock (BPM and divisions), 16-step Sequencer (CV and gate out),
Keyboard and MIDI interface (pitch CV, gate, velocity CV), Output (level and
meter).

Four hand-written worklets cover all of it: the VCO core, the ladder filter,
the wavefolder, and a segment generator shared by ADSR and Sample and Hold.
Everything else uses native nodes.

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

Reaktor Dark ships as the default because it survives a sixty-module patch
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
