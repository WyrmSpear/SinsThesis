# SinsThesis — continuation

**Paused:** 2026-08-18, for a machine restart.
**Branch:** `feat/phase1a-engine` — 33 commits, HEAD `682fbda`.
**State:** 213 tests pass (182 node + 31 browser), `typecheck` clean, working tree clean.
**Not merged.** Two fix waves stand between this and a presentable instrument.

Read this file first. Then `docs/audio/PHASE1A-LEDGER.md` for every decision made
and why.

---

## Resuming in one minute

```bash
cd ~/Desktop/SinsThesis
git checkout feat/phase1a-engine
npm install                 # if node_modules is gone
npx playwright install chromium
npm run build:worklets      # MUST run before browser tests
npm test                    # 182 node tests
npm run test:browser        # 31 browser tests
npm run typecheck
```

`npm test` runs the node project only. No single command runs all 213 — worth
adding.

---

## What exists

A headless audio engine. No UI — that is Phase 1B and deliberately absent.

```
src/engine/
  analysis/   fft.ts, features.ts, inspector.ts    measurement + the academy's grader
  dsp/        wavetable.ts, ladder.ts, wavefolder.ts, segment.ts, polyblep.ts
  worklets/   vco, ladder, wavefolder, segment, passthrough + audioworklet-globals.d.ts
  modules/    fifteen descriptors + index.ts
  graph.ts  patch.ts  cycle.ts  render.ts  clock.ts  midi.ts  types.ts  registry.ts
scripts/build-worklets.mjs    one Rollup bundle per worklet
docs/superpowers/specs/2026-08-18-sinsthesis-phase1-design.md    the binding spec
docs/superpowers/plans/2026-08-18-phase1a-engine.md              the 18-task plan
docs/audio/PHASE1A-LEDGER.md                 every ruling, finding and measurement
docs/audio/oscillator-architecture-study.md  four oscillator architectures, measured
.claude/agents/audio-engineer-critic.md      the audio critic
```

### Measured audio quality, as shipped

| | Measured | Grade |
|---|---|---|
| Saw alias floor, 441 Hz | −143.7 dB | RELEASE |
| Saw alias floor, 5 kHz | −170.3 dB | RELEASE |
| Ladder cutoff accuracy, 50 Hz–19 kHz | <0.4% | RELEASE |
| Ladder passband across resonance | −0.10 dB | RELEASE |
| Self-oscillation THD | −63.7 to −75.9 dB | RELEASE |
| Envelope click at stage transitions | −65 to −83 dBFS | RELEASE |
| LFO amplitude, 0.01–200 Hz | <0.3 dB spread | RELEASE |
| **Wavefolder alias floor, drive 3** | **−31 dB** | **AMATEUR** |
| **Wavefolder alias floor, drive 16–20** | **+7 dB** | **AMATEUR** |
| **Ladder DC, saw in, resonance ≥0.3** | **−29 to −23 dBFS** | **AMATEUR** |
| Triangle mip-boundary tick, 5120/10240 Hz | 0.42–0.74 sample delta | ACCEPTABLE |

The oscillator started at −43 dB and is now −143. That rebuild is the single
biggest thing that happened here, and it happened because the critic prototyped
instead of reasoning.

---

## What to do next

Two fix waves, in this order. Wave A is correctness; wave B is sound. Neither
has been started.

### Fix wave A — the engine is offline-only until these land

**A1. The oscillator builds its wavetables on the audio thread.** *(most serious)*
`src/engine/dsp/wavetable.ts:243` calls `getWavetableSet(sampleRate)` inside
`oscSample` — once per sample. The first non-sine sample builds 24 band-limited
tables, millions of trig calls, inside `process()`. Offline rendering hides this
because it runs faster than real time; **a live `AudioContext` will drop out on
the first note.**
*Fix:* call `getWavetableSet(sampleRate)` at module top level in
`vco.worklet.ts` and `segment.worklet.ts` — top-level worklet code runs during
`audioWorklet.addModule()`, before any node exists — and hoist the lookup out of
the per-sample loop. Prove it with a test that fails against current code.

**A2. The clock stops after 60 seconds.** `clock-module.ts` schedules to
`HORIZON_SECONDS = 60` and only reschedules at create and on param change. Spec
acceptance criterion 5 ("patches evolve unattended") is false past a minute.
*Fix:* rolling horizon. Scheduling must stay on the audio clock —
`setValueAtTime`, never a JS timer generating audio. A timer may only *schedule*
future audio-clock events.

**A3. `disconnect` severs more cables than asked.** `graph.ts:169` calls
`outNode.disconnect(inNode)`, which removes *every* connection between that node
pair. Reachable today: all four `multiple` outputs are the same `GainNode`, so
two cables from one mult into one mixer share an endpoint pair — disconnect
either and both die while `cableList` still lists the survivor.
*Fix:* give each cable its own pass-through `GainNode`. Also covers the
delay-node cleanup gap flagged back in Task 9.

**A4. The sequencer test cannot fail.** `sequencer.test.ts:150` renders 0.4 s at
60 BPM (1 s per step) and asserts only that step 1 reads 440 Hz. It passes
identically if the sequencer is frozen. *Fix:* render across two step
boundaries, assert the second step's pitch, and verify it fails when step
advance is stubbed.

### Fix wave B — audio quality

**B1. The wavefolder. Worst thing in the instrument.** No oversampling anywhere.
Alias floor: drive 1.5 → −45 dB, drive 3 → −31 dB (inside normal creative
range), drive 16–20 → **+7 dB, alias energy louder than the fundamental**. The
one module built to sound aggressive turns into digital noise at exactly the
settings a player reaches for. No test measures any of it.
*Fix:* 4–8× oversampling around the fold with a decimation filter, or a proper
band-limited folder. Ask the critic which — it has the harness.

**B2. The default patch bleeds DC.** Saw into the VCF at resonance 0.3–1.0
injects −29 to −23 dBFS DC (resonance 0 gives −208 dBFS; a sine gives −240
regardless). Cause: `tanh` in the feedback loop acting on a waveform without
half-wave symmetry. Nothing downstream blocks it.
*Fix:* a one-pole DC blocker at the ladder output is cheap and sufficient.

**B3. No parameter smoothing anywhere.** Spec acceptance criterion 3 ("turn
knobs without clicks or zipper noise") is **unimplemented, not merely unproven**.
Every native module ignores the `atTime` argument and assigns `.value` directly;
`PatchGraph.setParam` never passes a time; worklet params are k-rate steps.
*Fix:* thread `atTime` through `setParam`, use `setTargetAtTime` with a short
time constant for continuous params. Then write the click test that criterion
demands.

**B4. Triangle ticks at high mip boundaries.** Worst single-sample delta
0.42–0.74 at the 5120/10240 Hz boundaries, past the codebase's own 0.35
threshold. The shipped test only covers the lower three of seven boundaries.
Portamento across them will tick. *Fix:* crossfade at the upper boundaries, or
denser mips up top. Extend the test to all seven.

### Then

- Re-run the critic's full audit (prompt shape in the ledger).
- Re-run the whole-branch review.
- `superpowers:finishing-a-development-branch`.
- Phase 1B is the UI: rack, panels, eight themes, the power switch. Its plan is
  not written. Write it against the working engine, not speculatively.

---

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
