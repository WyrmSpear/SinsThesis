# SDD ledger — plan: docs/superpowers/plans/2026-08-18-phase1a-engine.md

Spec: docs/superpowers/specs/2026-08-18-sinsthesis-phase1-design.md (read, binding authority)
Branch: feat/phase1a-engine

## Pre-flight conflict scan

### Shared files across tasks

| Tasks | Shared file | Produces vs consumes | Finding |
|---|---|---|---|
| 1 → 11 | package.json | 1 creates scripts; 11 adds build:worklets and rewrites test:browser | clean |
| 1 → 11 | .gitignore | 1 appends node_modules/dist/coverage; 11 appends public/worklets/ | clean |
| 11 → 12,13,14 | vite.worklets.config.ts | 11 creates lib.entry map; each later task adds one entry | clean |
| 11 → 12,13,14 | worklets/registry.ts | 11 creates WORKLET_MODULES; later tasks append names | clean |
| 9 → 10 | engine/graph.ts | 10 step 4 adds `slot` to GraphNode plus getSlot/setSlot | clean; T9's Produces block omits getParams/getSlot/setSlot, doc-only gap |
| 14 → 16 | worklets/segment.worklet.ts | 14 registers adsr/lfo/sample-hold; 16 adds a `sequencer` processor to the same bundle | clean — 'segment' already in WORKLET_MODULES, no registry change |
| 12..17 → 18 | modules/index.ts | 18 imports all fifteen descriptors | clean |

### Interface chains

| Producer | Consumer | Finding |
|---|---|---|
| 2 fftMagnitude | 3 features | clean |
| 3 features | 4,5,6 tests; 12–16 tests | clean |
| 4 polyblep | 12 vco.worklet, 14 lfo processor | clean |
| 5 ladder / 6 wavefolder+segment | 13, 14 worklets | clean |
| 7 types+registry | 9,10,12–18 | clean |
| 8 createsCycle | 9 graph.connect | clean |
| 9 PatchGraph | 10 patch, 11 render, 18 inspector | clean |
| 10 patch | 18 acceptance | clean |
| 11 renderGraph | 12–16 browser tests | CONFLICT — see R3 |
| 17 midi | 18 index | clean |

### Per-task self-agreement

Tasks 1–10, 12–14, 17: text agrees with itself; tests match the code specified; files created match files later touched.
Task 11: see R3. Task 15: see R2. Task 16: see R3. Task 18: see R4.

## Rulings

Ruling: work on branch `feat/phase1a-engine` in the main checkout rather than a
git worktree — the repo has no parallel work, and the plan installs npm
dependencies plus a Playwright Chromium download that a worktree would force us
to duplicate. Cost if wrong: none beyond a branch rename; nothing else touches
this repo.

R2 — Ruling: Task 15's table names params for mixer, delay, and output without
defaults, and three tests would fail on a default of 0. Defaults are
mixer `level1`–`level4` = 1 (attenuverter at unity), output `level` = 1,
delay `time` = 0.3, `feedback` = 0.3, `mix` = 0.3. Spec §6 lists these as
utility modules with no stated defaults, so the plan is the only authority and
it is silent. Cost if wrong: a knob starts in the wrong place; one-line fix.

R3 — Ruling: `renderGraph`'s build callback returns `string | [string, string]`,
where a bare string means port `'out'`. Task 11 as written only reads an `out`
port, but Task 16's clock module has ports `gate` and `reset` and no `out`, so
its test cannot render. Extending the harness is smaller than inventing an
`out` alias on every control module. Task 11's dispatch carries this; Task 16's
clock test returns `['clk', 'gate']`. Cost if wrong: harness signature churn in
Phase 1B.

R4 — Ruling: Task 18's boundaries test, which asserts every `*.worklet.ts`
imports from `../dsp/`, must exclude `passthrough.worklet.ts`. Passthrough is a
build-pipeline probe with no DSP by design (Task 11), so the rule does not
apply to it. Cost if wrong: none; the exclusion is one filter clause.

## Progress

Task 1: implementer a70ae969dd8692e00, commit d8a1271 (toolchain + first test, 1/1 node test passing).

R5 — Ruling: `@types/node` and `"node"` in tsconfig `types` belong in Task 1, not
deferred. The brief's package.json omits them and `npm run typecheck` therefore
fails, but typecheck is an explicit gate in Task 18 step 5, and Tasks 11 and 18
import `node:path` and `node:fs`. Folded into Task 1 via implementer resume.
Cost if wrong: one extra dev dependency.

R6 — Ruling: Task 11's `vite.worklets.config.ts` must resolve entry paths with
`fileURLToPath(new URL('./src/...', import.meta.url))`, not `resolve(__dirname, ...)`
as the plan text writes it. `__dirname` is undefined in an ESM config file, and
Global Constraints mandate `"type": "module"`. This is a plan defect found before
Task 11 ran; carried into its dispatch. Cost if wrong: Task 11's worklet build
fails at config load, caught immediately by its own test.
Task 1: fix round 1/5 (typecheck concern addressed, 0 open; commits d8a1271..8babf3d)
Task 1: minor (deferred): tsconfig applies DOM + node lib/types project-wide with no per-directory boundary; nothing stops src/engine/** typechecking against window/document/process. Task 18's boundaries test enforces the stated import constraint but not DOM globals. Candidate for an eslint no-restricted-globals rule in Phase 1B.
Task 1: ⚠️ resolved by controller — reviewer could not see whether the engine/UI boundary is enforced anywhere; it is, by Task 18's boundaries.test.ts, which asserts no src/engine file imports from ui/ or svelte. That matches the constraint as written.
Task 1: complete (commits 070d07c..8babf3d, review clean)
Task 2: minor (deferred): fftInPlace has no direct unit test, only transitive coverage through fftMagnitude.
Task 2: minor (deferred): the 1 kHz normalization test passes at 0.930 against a 0.9 floor — thin margin caused by Hann scalloping loss at that (freq, n, sampleRate) triple. Deterministic, so it will not flake, but editing those constants could flip it with no code regression. Worth a comment if a later task touches them.
Task 2: complete (commits 8babf3d..b59d417, review clean; reviewer independently re-derived the FFT math and confirmed the 4/n normalization)
Task 3: implementer a00aba8eef5c8d91d, commit e4f7325, DONE_WITH_CONCERNS — slopeDbPerOctave test failed (measured -8.78, test window was (-8,-4)).

R7 — Ruling: the slope estimator is correct and stays as written; Task 3's
saw-based test bound widens to (-10, -4) with a comment explaining why, and the
function's doc comment gains a caveat. Verified independently by controller: over
400-3200 Hz on the band-limited saw, fitting all 478 bins gives -8.78 dB/oct
while fitting the 28 harmonic peaks gives -5.79, against a theoretical -6. The
band holds ~450 inter-harmonic bins whose magnitude is Hann leakage floor, and
those dominate the least-squares fit. Fitting every bin is the right behavior for
the estimator's real use — filter tilt on dense spectra (noise), where no gaps
exist and the fit is unbiased. Cost if wrong: a slope figure read off a
harmonic-rich signal reads steeper than the true envelope; Task 13's VCF-on-saw
test window (-32, -16) is wide enough to absorb it, and Task 5's ladder test uses
noise, where the bias does not apply.
Task 3: fix round 1/5 (slope bound + doc caveat per R7 addressed; commits e4f7325..f845206)
Task 3: review — spec ✅, quality approved with one Important (plan-mandated).

R8 — Ruling: the Important finding is real and gets fixed now rather than
inherited. `spectrumOf` in features.ts is dead code while its body is duplicated
verbatim at four call sites; the brief left it dead because the sites also need
the FFT `size`, which `spectrumOf` did not return. Fix is to return
`{ mags, size }` and call it from all four. Pure refactor, no behavior change,
existing tests must pass unchanged. The spec is silent on internal factoring, so
the plan is the only authority and it is self-contradictory here. Cost if wrong:
none — a behavior-preserving refactor covered by nine existing tests.

Task 3: ⚠️ unresolved — reviewer could not confirm from the report that the
initial test run was watched failing before implementation. The code is verified
numerically correct, which is what the gate is for; recording the process gap
rather than re-litigating it.
Task 3: fix round 2/5 (1 addressed, 0 open — spectrumOf refactor verified behavior-preserving, size provenance checked; commits f845206..80607b4)
Task 3: complete (commits b59d417..80607b4, review clean)

R9 — Ruling: Task 4's triangle integrator is wrong in the plan and is corrected
before dispatch. The plan writes `triIntegrator = triIntegrator * 0.9995 + 4 * dt * square`,
a fixed leak that makes amplitude frequency-dependent. Measured by controller
across five rates: plan gives +/-0.083 at 0.5 Hz, +/-0.332 at 2 Hz, +/-0.99 at
220 Hz — so the LFO is nearly silent at useful rates and the waveform is a
clipped square at audio rates. Corrected to the standard dt-scaled leaky
integrator, `triIntegrator = dt * square + (1 - dt) * triIntegrator` with output
`4 * triIntegrator` clamped, which measures +/-0.93 to +/-0.98 from 0.5 Hz to
2 kHz. The plan's own sub-audio LFO test would have caught this; ruling ahead of
dispatch saves a fix round. Cost if wrong: triangle amplitude drifts from unity;
caught by the shape tests in the same task.
Task 4: minor (deferred): hardSync zeroes triIntegrator, so a hard-synced triangle fades in over a few cycles instead of restarting instantly like saw and pulse. Disclosed in the report but not in a code doc comment; no test covers hardSync for 'tri'. Candidate coverage in Task 12/14.
Task 4: ⚠️ resolved by controller — reviewer flagged untested behavior as freq approaches sampleRate, where the triangle's (1 - dt) leak goes to zero or negative. Real: Task 12's VCO can reach 440 * 2^6 = 28 kHz from octave and tune alone, before pitch CV. Resolved by R11 rather than a fix round here, since clamping belongs at the module boundary, not in the core.
Task 4: complete (commits 80607b4..d3875a4, review clean; alias floor -71.36 dB against a -60 requirement, verified independently by the reviewer)

R10 — Ruling: Task 5 maps resonance to k = resonance * 4.2, not * 4 as the plan
writes. Measured by controller at cutoff 1 kHz: k=4.0 (the theoretical
self-oscillation threshold) gives a tail rms of 0.0124 against the test's 0.01
bar — technically oscillating, but a 24% margin on a marginally-stable loop, and
musically a whisper where a Moog at full resonance screams. k=4.2 gives 0.076,
a 7.6x margin. Real ladder circuits are driven past the linear threshold for
exactly this reason; tanh's unity small-signal gain puts k=4 exactly at
marginal. All other Task 5 assertions measured clean at 4.2: slope -26.24 dB/oct
(window -30..-18), passband ratio 0.942 (bar 0.8), octave-up 0.037 (bar 0.2),
resonance-0 tail rms 0.0, hot-drive peak 0.476 and finite. Cost if wrong:
full-resonance oscillation is louder than a purist would set it; one constant.

R11 — Ruling: Task 12's VCO worklet clamps its computed frequency to
sampleRate * 0.49 before calling oscSample. Octave and tune alone reach 28 kHz,
and pitch CV goes further, at which point dt >= 1 breaks phase wrapping and the
triangle's (1 - dt) leak goes negative. The clamp belongs at the module
boundary, not in the pure core, so that the core stays a plain function of its
arguments. Cost if wrong: extreme pitch-CV excursions fold at Nyquist instead of
aliasing chaotically, which is the desired behavior anyway.
Task 5: minor (deferred): ladder.ts module doc says the loop is "solved algebraically", which a future reader could take to mean the tanh nonlinearity is solved implicitly too. It is not — tanh is applied to the linear-solved drive signal, the standard cheap approximation. One comment line would settle it.
Task 5: ⚠️ resolved by controller — the -24 dB/oct figure is not a uniform asymptote. Reviewer probed sub-bands: -20.7 (1.2-2k), -21.8 (2-4k), -25.2 (4-8k), -37.2 (8-16k), steepening near Nyquist from bilinear-transform warping. The test's 2-12 kHz fit lands at -26.24 partly by averaging a shallow region against a steep one. This is inherent to any BLT-designed filter, not a defect, but the spec's acceptance line ("the filter measures -24 dB/octave above cutoff") should be read as a band-limited measurement rather than a claim about the whole stopband. Recording rather than changing the spec.
Task 5: note for Task 13 — at very low cutoffs (20 Hz) full resonance does not reliably self-oscillate (tail rms 0.0022) though it stays bounded. Relevant to the module's usable cutoff range, not a core defect. Reviewer also confirmed stability at 20 Hz, 23.9 kHz, amp-20 noise, and a sustained DC step of 10.
Task 5: complete (commits d3875a4..518bdde, review clean; ZDF solve independently re-derived and confirmed)

R12 — Ruling: Task 6's ADSR test "reaches the peak by the end of attack" asserts
`run(1, 0.05).last > 0.9`, which measures the wrong thing. With attack 0.01 s and
ATTACK_TARGET 1.05 the envelope hits 1.0 at t = 0.0305 s, then decays toward
sustain 0.5 with tau 0.05 s, so at t = 0.05 s it reads about 0.838 and the
assertion fails. The test's stated intent is that attack reaches the peak, so it
should assert on the maximum over the run rather than its final value. Cost if
wrong: none — asserting the peak tests the named behavior more directly than
sampling one arbitrary later instant, whether or not the original would have
passed.
Task 6: implementer a8ba459f7a15391e9, commit 5eb258f (13 new tests, 51 total). R12 confirmed necessary — implementer measured 0.838 independently.
Task 6: review — spec ✅, quality approved with one Important (missing regression coverage for gate-falls-during-attack and gate-falls-during-decay).
Task 6: minor (deferred): `case 'idle': state.level = 0` in segment.ts is redundant; idle is only reachable via release driving level to 0, and createEnvState already inits to 0.

R13 — Ruling: the Important coverage gap gets fixed rather than deferred. The
reviewer verified the code is correct by inspection, but segment.ts's own
docstring promises click-free release from any stage, and an untested promise in
a file two later tasks wrap is exactly what regresses silently. Two tests added,
no implementation change. Cost if wrong: two redundant tests.
Task 6: fix round 1/5 (1 addressed, 0 open — both new tests pass with segment.ts unmodified, confirming a coverage gap rather than a bug; re-reviewer verified the 90% lower bound is a real pin, not tautological; commits 5eb258f..0af309b)
Task 6: complete (commits 518bdde..0af309b, review clean). 53 tests, typecheck clean.

R14 — Ruling: Task 7's `stubContext()` must return a delay stub carrying a
`delayTime` property. The plan writes `createDelay: () => stubNode() as unknown as DelayNode`,
but Task 9's PatchGraph sets `delay.delayTime.value = FEEDBACK_DELAY_SECONDS`
when inserting a feedback delay, and `stubNode()` has no `delayTime` — the
feedback-cable test would throw on a property access rather than exercising the
behavior. Corrected before Task 7 creates the helper, since Task 9 consumes it.
Cost if wrong: the stub carries one unused property.
Task 7: minor (deferred): StubNode.connect supports only the single-argument form; Task 12's real VCO uses gain.connect(node, 0, index), but that runs against a real AudioContext in the browser project, so the gap is latent rather than live. One comment line in stub-instance.ts would settle it.
Task 7: minor (deferred): stubDescriptor's setParam silently drops the optional atTime argument rather than documenting the no-op.
Task 7: complete (commits 0af309b..541c178, review clean). 60 tests. Reviewer verified the contract against Tasks 9/12/15/16 briefs — no cast or escape hatch defeats it, and customPanel is used as designed.
Task 8: minor (deferred): createsCycle rebuilds the adjacency map on every call. Verified negligible at target scale (60-node dense graph, 3540 edges, 1000 calls well under 2s), but worth revisiting if connect ever becomes a hot path.
Task 8: complete (commits 541c178..4f9b484, review clean). 67 tests. Reviewer probed pre-existing cycles, self-loops, parallel edges and 60-module scale beyond the seven spec tests.
Task 9: implementer a1049e16fb8de7a0c, commit 0d666e0 (11 new tests, 78 total).
Task 9: ⚠️ resolved by controller — reviewer could not see authorization for `getParams`, which is absent from the brief's Produces list. It was authorized in the dispatch and is required by Task 10. No action.
Task 9: minor (deferred): cycle detection maps edges from all cables including ghost-touching inactive ones, so a real→ghost→real chain could force an unnecessary delay onto a non-feedback active cable. Untested edge case; filtering to active cables would be the fix. Left for final-review triage rather than widened here, since changing it without a test trades one unverified behavior for another.

R15 — Ruling: both Important findings get fixed, including the plan-mandated one.
The `cables` getter returned the live internal array while `moduleIds` copied, so
a caller could splice out a delayed cable and orphan its DelayNode; and `Cable`'s
fields carry no per-field `readonly`, so `graph.cables[0].active = true` compiles
and mutates engine state. The brief specified the mutable interface, but the spec
makes PatchGraph the object every later task builds on, and `moduleIds`'s own
copy pattern shows the safer form was already available in the same file. Fields
are only ever set at construction, so adding `readonly` breaks nothing. Also
added three tests for behaviors the reviewer had to verify by reading code.
Cost if wrong: a call site needing mutable cable tuples has to copy first, which
the implementer was told to report rather than silently widen.
Task 9: fix round 1/5 (3 addressed, 0 open — re-reviewer confirmed the mutation-defense test is non-vacuous and that no cast was introduced to paper over the readonly tuples; commits 0d666e0..582048f)
Task 9: minor (deferred): the delay-drop test asserts cable count and that a fresh feedback cable is still marked delayed, but never inspects the stub node's connections to confirm the stale DelayNode was disconnected. A leak that still cleaned up cableList would slip past.
Task 9: complete (commits 4f9b484..582048f, review clean). 81 tests, typecheck clean.

R16 — Ruling: R15's readonly Cable tuples collide with Task 10's serializer, and
the collision is resolved by widening `connect` rather than casting. `Cable.from`
is now `readonly [string, string]`, but the plan's `PatchCableEntry` declares
`from: [string, string]`, and TypeScript rejects assigning a readonly tuple to a
mutable one — so `serializePatch` as written will not compile. Two changes:
`PatchGraph.connect` accepts `readonly [string, string]` for both parameters
(strictly more permissive, breaks no caller), and `serializePatch` builds fresh
mutable tuples elementwise rather than aliasing the cable's own. Keeping the
patch entries mutable matters because they are plain JSON that `loadPatch` feeds
straight back into `connect`. Cost if wrong: a cast would have been needed
somewhere instead; this is the version with none.
Task 10: implementer a62589fae4bf3523f, commit 68f66e8 (6 new tests, 87 total). R16 confirmed necessary by the implementer — without both corrections the readonly/mutable tuple mismatch fails typecheck.
Task 10: minor (deferred): serializePatch double-copies params, since getParams already returns a copy. Harmless redundancy.
Task 10: review — spec ✅, quality approved with one Important.

R17 — Ruling: `connect` must copy its endpoint tuples rather than storing them by
reference. The aliasing is pre-existing from Task 9, but Task 10 is what first
routes externally-parsed JSON through it: `loadPatch` passes `PatchFile.cables`
entries straight in, so a caller holding the parsed file can mutate a live
graph's cable endpoints. `serializePatch` already guards the outbound direction;
this closes the inbound one. Also folded in the two Minor coverage gaps — a
cable between two ghosts, and a nonzero slot on a real module in the round-trip
test, which is named for catching loss but never exercised a real module's slot.
Cost if wrong: two extra array allocations per connect, on an operation that
happens at human speed.
Task 10: fix round 1/5 (3 addressed, 0 open — re-reviewer confirmed no cable lookup depended on endpoint identity, and that no existing assertion now passes for the wrong reason; commits 68f66e8..3fb86dc)
Task 10: complete (commits 582048f..3fb86dc, review clean). 88 tests, typecheck clean. Pure-logic half of the engine done.
Task 11: implementer a0376cfd0cf7281c6, commit 43b60db. First browser tests pass — 88 node + 3 browser. All three pre-dispatch corrections (R6 ESM __dirname, R3 tuple port addressing, tuple test) confirmed necessary. No Playwright or OfflineAudioContext surprises.
Task 11: minor (deferred): no test constructs an actual AudioWorkletNode('passthrough'), so the passthrough processor's process() body is unexercised. Matches the brief, and Task 12 exercises a real worklet end to end.
Task 11: minor (deferred): the ambient AudioWorkletProcessor.process is declared as a required member where the spec leaves it undeclared on the base type. Harmless — nothing instantiates the base.

R18 — Ruling: `/// <reference lib="webworker" />`, which the plan puts in every
worklet, must be dropped from Tasks 12, 13, 14 and 16 as well. The implementer
found that TypeScript declares neither AudioWorkletProcessor nor
registerProcessor, and that adding the webworker lib alongside this project's
DOM lib collides on ~30 global names. Its fix — a shared
src/engine/worklets/audioworklet-globals.d.ts — is the right one and is now in
place; later worklets just use it. Carried into every remaining worklet
dispatch. Cost if wrong: typecheck breaks loudly and immediately.

R19 — Ruling: the ambient globals leak (declare global reaches the whole
program, so `sampleRate` typechecks in any engine file) is accepted rather than
fixed with per-directory tsconfig scoping. Project references plus a second
build config is disproportionate machinery for one guardrail at this stage.
Enforced instead as a convention: Task 18's boundaries suite asserts
`sampleRate`/`currentTime`/`currentFrame` appear only in *.worklet.ts files,
mirroring how the engine/UI boundary is already enforced. The trade-off is
documented in the .d.ts itself. Cost if wrong: a stray global reference
typechecks and fails at runtime, until the Task 18 guard catches it.

R20 — Ruling: `ensureWorklets`'s WeakSet completion flag is replaced with a
WeakMap of in-flight promises. Two overlapping calls on the same unloaded
context both pass the has() check before either adds, so both call addModule and
the second registerProcessor throws. Not reachable today because renderGraph
builds a fresh context per call, but it is plan-mandated code that Tasks 12-16
inherit and a live AudioContext will mount modules concurrently. Cost if wrong:
none — the promise form is a superset of the flag form.
Task 11: fix round 1/5 (2 addressed — R20 ensureWorklets in-flight promise, R19 trade-off documented in the .d.ts; commits 43b60db..54c4d3e)
Task 11: fix round 2/5 — implementer's own report flagged that nothing exercises the concurrency fix. Ruled to close rather than defer: the guarded failure is exactly what returns if someone later simplifies the WeakMap back to a flag, and it is directly testable because the old code registers the same processor name twice.
Task 11: fix round 2/5 (1 addressed, 2 open — commits 54c4d3e..6b86fb1). Re-review found the concurrency test VACUOUS: reviewer checked out pre-fix 43b60db into a worktree, pasted the tests in, and got 5/5 passing. addModule dedupes by URL within a context's module map, so a duplicate call resolves without re-evaluating the module and registerProcessor never runs twice. My assumption that it would throw was wrong.
Task 11: fix round 3/5 dispatched — poisoned-WeakMap regression plus a discriminating test.

R21 — Ruling: my own R20 fix introduced a regression and it is corrected rather
than accepted. The WeakMap caches the promise before it settles, so a transient
addModule failure is stored permanently and every later call to that context
returns the same dead rejection. The old WeakSet only recorded success, so a
failed load retried naturally. Added a catch that deletes the entry and rethrows.
Cost if wrong: none — this restores the retry behavior the original code had,
while keeping the concurrency guarantee.

R22 — Ruling: the concurrency test I specified is replaced, not loosened. The
property worth pinning is not "concurrent calls do not throw" — which holds
either way — but "concurrent callers issue one addModule per worklet rather than
one per caller", which is observable by counting calls through a wrapped
addModule. Also added a retry-after-failure test covering R21. The implementer
must verify non-vacuity by temporarily reverting to the flag form and recording
the observed call counts both ways. Cost if wrong: a test that passes for the
wrong reason, which is what this round exists to eliminate.
Task 11: fix round 3/5 (2 addressed, 0 open — vacuity demonstrated at 3 calls vs 1, retry test confirmed to fail against the previous round's cached-rejection code, no test leakage since each builds its own context; commits 6b86fb1..ea573e1)
Task 11: complete (commits 3fb86dc..ea573e1, review clean). 88 node + 6 browser tests. The bridge to real Web Audio works.
Task 12: implementer a5c342d4f28c5c92d reported BLOCKED, implementation complete but uncommitted. Alias-floor test measured -30.7 dB against a -60 dB assertion. Implementer correctly refused to loosen the threshold or hand-pick a lucky frequency.

R23 — Ruling (LOAD-BEARING, spans Tasks 3, 4 and 12; amends a spec acceptance
criterion). Controller measured the core directly to separate worklet fault from
measurement fault:

  polyblep saw, Hann-windowed aliasFloorDb, 8192-point FFT
    110 Hz -32.3 | 440 -41.3 | 1000 -53.9 | 1760 -30.7 | 2000 -71.4 | 2349 -30.1 | 3000 -126.4 | 5000 -22.3

The pattern is the giveaway: -71 at 2000 Hz and -126 at 3000 Hz are the only
strong readings, and 48000/2000 = 24 and 48000/3000 = 16 are exactly the
frequencies where every alias folds back onto an exact harmonic and is excluded
from the measurement by the harmonic-detection window. Everything else clusters
at -30 to -32, which is the Hann window's first sidelobe (-31.5 dB). The metric
was measuring its own window, not the oscillator.

Re-measured with a 4-term Blackman-Harris window (-92 dB sidelobes) and an
8-bin exclusion:
    110 -60.2 | 440 -48.3 | 1000 -95.2 | 1760 -30.9 | 2349 -30.0 | 5000 -22.3
    naive saw for comparison: 110 -52.3 | 440 -40.0 | 1760 -22.6 | 5000 -13.8

Low frequencies recover ~28 dB of headroom, confirming those were window
artifacts. The upper range does not move, so -30 dB at 1760 Hz is PolyBLEP's
genuine alias floor there — which is correct for a two-point BLEP correction and
degrades with fewer samples per cycle.

Consequences: (1) Task 4's headline -71.36 dB figure was an artifact of testing
at exactly 2000 Hz; (2) the spec's acceptance line "PolyBLEP holds the alias
floor below -60 dB" is FALSE as written for the upper range; (3) Task 3's
"reports a high floor for a naive saw" test at 2000 Hz was also passing for the
wrong reason — the Hann sidelobe floor, not the naive saw's aliases.

Decided: switch aliasFloorDb to Blackman-Harris, restate the criterion in terms
that are true and still discriminating (below -45 dB at A4; beats a naive saw by
at least 8 dB across the range), move Task 3's naive-saw test off the 2000 Hz
folding frequency, and surface the spec amendment to the user rather than
quietly rewriting an acceptance criterion they approved. Cost if wrong: the
instrument's antialiasing is characterized honestly but less flatteringly, and
a future arc wanting a true -60 dB floor needs second-order BLEP or BLIT.

## Professional-audio arc (user directive: "make it sound professional")

Created .claude/agents/audio-engineer-critic.md — measures rather than opines,
grades against commercial soft-synth bars, required to reproduce any number it
is given.

First audit findings:
- aliasFloorDb untrustworthy three ways (Hann sidelobe floor, no DC exclusion,
  single-bin fundamental). Confirmed a positive "alias floor" on a pulse with
  zero real aliasing. Also caught a commensurate-frequency artifact in MY OWN
  Blackman-Harris re-measurement (1000 Hz, 48000/1000 = 48) that I had missed.
- Oscillator graded AMATEUR at every frequency. Two-point PolyBLEP degrades at
  ~-5 dB/octave as pitch rises; the gap to the release bar is 30-40 dB and no
  polynomial-order bump closes it. Remedy: minBLEP/minBLAMP table.
- Ladder cutoff graded AMATEUR — CHALLENGED BY CONTROLLER AND REVERSED. See R24.
- Self-oscillation amplitude graded AMATEUR — RETRACTED by the critic on
  re-measurement: it had allowed 0.34 s at 20 Hz where buildup needs ~4 s. Given
  time, 20 Hz and 1000 Hz converge to the identical steady-state amplitude
  (0.07593, matching to five decimals). The earlier Task 5 review's 0.0022
  reading was the same artifact.
- Resonance passband loss -9.86 dB: real, one-line fix.

M1: complete, commits eecd95d (trustworthy metric) + 5ce69b5 (VCO landed).
    Saw alias floor at 441 Hz: -43.2 dB node, -42.8 dB browser. The previous
    -71.36 dB was fiction.

R24 — Ruling: the ladder's cutoff calibration is correct and stays. The critic
graded it AMATEUR because dialling 1000 Hz puts the passive -3 dB corner at
~410 Hz (0.435x, the four-pole cascade factor). I challenged it on the grounds
that self-oscillation tracks the per-stage pole, the cutoffCv input is specified
at 1 V/octave, and musicians play a self-oscillating ladder as a pitched voice.
The critic reversed: Diva and Repro both calibrate the knob to the
self-oscillation frequency, this is what the hardware does, and its own sweep
already showed self-osc tracking cutoff to under 1% at 20 Hz, 1 kHz and 10 kHz.
It also rejected the decoupling option as real cost for a non-problem. Recorded
as a stated invariant instead: two tests (self-osc peak = cutoff +/-2%, passive
corner = cutoff x 0.435 +/-5%) plus a doc comment. Cost if wrong: none — this
preserves behavior and documents it.

R25 — Ruling: resonance passband makeup gain ships as `input * (1 + k)` before
the tanh solve. The closed-loop DC gain is 1/(1+k), so full resonance loses
9.86 dB of passband — audible as a patch going thin as resonance opens. Critic
verified the one-line fix takes passband gain across resonance 0->1 from
-0.38 dB to -0.05 dB, flat. Cost if wrong: one multiply.
M1: review clean (spec ✅, approved). Reviewer independently confirmed: BH window normalizes a full-scale sine to 1.000; aliasFloorDb reports -20.29 dB against a deliberately injected -20 dB alias; zero-alias fixtures read -96.8 dB, which is the metric's honest noise floor and leaves headroom to measure the -80 dB minBLEP target; 441 and 1109 Hz are genuinely non-commensurate against 48 kHz (nearest collisions at harmonic 599 and 282, carrying no energy).
M1: one Important (plan-mandated) — see R26. One stray critic prototype file removed by controller.

R26 — Ruling: the VCO worklet computes its pitch-CV-to-frequency mapping inline
in process(), violating the global constraint that all DSP math lives in a pure
module with the processor as a thin shell. The brief's own code did this, so it
is my defect. Deferred into M2 rather than fixed now: M2 rewrites the oscillator
and needs the same helper, so extracting `pitchToFreq(base, cv, sampleRate)`
once there avoids touching the worklet twice. Consequence until then: that
arithmetic is only reachable through the slower browser harness. Cost if wrong:
the mapping stays untested at the node level for one more task.
M3: complete @8df82b7 (ladder professional pass). Passband gain at full resonance -11.14 dB -> -0.10 dB; res 0 unchanged at -0.56 dB. Self-oscillation tracks dialled cutoff within 0.04-0.39% at 200/1000/5000 Hz. Asymptotic slope in the 4-8 kHz band -25.17 dB/oct; knee region -18.3, near-Nyquist -68.4 — confirming the old 2-12 kHz test was landing in range by cancellation. Hot-drive peak 0.67 at 5.2x harder input. 95 node + 10 browser tests.
M3: review clean by audio critic — ACCEPTABLE overall, RELEASE on passband gain (<=0.6 dB deviation swept 50 Hz-16 kHz, so the fix is not a 2 kHz artifact), self-osc tracking and slope methodology. Notable: the critic measured a real tone change and judged it correct — THD across resonance 0->1 used to go -21.5 -> -54.2 dB (quieter and cleaner as resonance opens, backwards) and now goes -21.5 -> -16.4 dB (louder and dirtier), because resonance now drives the same nonlinearity a hardware ladder does. Confirmed (1+k) is the Stilson-Smith static input-gain trick used by Huovilainen and D'Angelo/Valimaki, and that the resonant peak is correctly NOT compensated away.

M2 BLOCKED ON A DECISION — critic prototyped the BLEP rather than projecting
from literature, and REVERSED its own predictions. Its earlier estimate was
441 Hz <= -85, 1760 <= -80, 5000 <= -70/-75. Measured from the working
prototype: 441 Hz -68.7 (RELEASE), 110 Hz -56.4 (ACCEPTABLE), 1109 -41,
1760 -36, 5000 -22 (AMATEUR, and statistically level with the PolyBLEP we
already have). Root cause is architectural, not a coding error: a fixed kernel
cannot be widened past about half the period without corrupting the next edge,
so correction quality collapses as samples-per-cycle falls. Prototyping also
surfaced two real implementation traps (a sign flip in the position formula and
a ring-buffer offset that silently drops past taps), both documented in the spec.
Spec at minblep-spec.md. Pulse and triangle figures are estimated by symmetry,
not measured — flagged by the critic as the riskiest part.
Task 13: complete @9a40d39 (VCF + wavefolder modules). Slope -25.07 dB/oct in the corrected 2-4 kHz band at 500 Hz cutoff; self-osc tail rms 0.0759 at 802.7 Hz for an 800 Hz dial. 13 browser tests.

R27 — Ruling: accept the implementer's self-start seed. It found a fourth gap
beyond the three corrections I gave it: with nothing patched into the filter's
input, the ladder recursion has zero as an exact fixed point (measured rms
exactly 0.0, not marginal), so a digital ladder can never self-oscillate from
silence the way an analog one starts from its own thermal noise. Fixed with a
single-sample 1e-4 seed on the worklet's first process() call only. This is
standard practice in virtual-analog designs, does not touch dsp/ladder.ts, and
washes out under any real signal. Flagged by the implementer for review rather
than slipped in, which is the right instinct. To be confirmed by the audio
critic in the final audit. Cost if wrong: an inaudible -80 dBFS single-sample
tick at worklet construction.
Task 13: review — spec ✅, quality NEEDS FIXES (one Important). The one-shot seed cannot re-arm: leave the input unpatched, then crank resonance mid-session, and self-oscillation silently never starts because the seed already fired and decayed below threshold. The existing test misses it by setting resonance=1 before the first tick. Critic notes commercial VA ladders model thermal noise as continuous dither, not a startup transient — which fixes the shape objection and the re-arm hole together.
Task 14: complete @0e05ccf (ADSR, LFO, S&H). 90 node + 17 browser.

R28 — Ruling: R27's one-shot seed is replaced by continuous dither at 1e-5
(about -100 dBFS), deterministic LCG rather than Math.random so tests stay
reproducible, added after drive scaling. This is the faithful emulation — a real
ladder's noise floor is always present, so the filter can enter oscillation at
any moment rather than only during its first render quantum. Plus a doc comment
on createLadderState recording that zero is an exact fixed point of the
recursion, since that property has now been independently rediscovered twice.
Cost if wrong: a -100 dBFS noise floor on the filter output, roughly 40 dB below
the quietest thing anyone will hear.

M2 DECISION PENDING — critic's oversampling answer priced honestly: 700 Hz
crossover, ~80x native CPU (101k flops/quantum/oscillator), a fixed 289-sample
(6 ms) latency on every note to keep both paths phase-coherent, a 384-tap
halfband decimator, and the result is still mostly ACCEPTABLE with one AMATEUR
left (5 kHz narrow-PWM pulse, -42.0 dB) and triangle unmeasured in 700-1300 Hz.
Notable sub-findings: the decimator had its own soft spot at 900-1109 Hz,
separable from the BLEP clamp; and a narrower crossfade beats a wider one
(16 samples -17.7 dBFS residual vs 128 samples at +6.5 dBFS, worse than a hard
switch) because the blend must stay well inside one period.

Commissioned one more measurement before spending that: band-limited mipmapped
wavetables, with the two standard answers to the objections the critic used to
set them aside — PWM as the difference of two saws a phase apart (exact,
continuously variable, no second table), and BLEP correction applied only at
hard-sync edges on top of a wavetable base. Required to measure mip transitions
under a pitch sweep crossing three boundaries, not at static pitches, since
that is where table artifacts actually appear.
Task 13: fix round 1/5 (1 addressed — continuous dither replaces the one-shot seed; commit a8b1322). Implementer could not use the review's setTimeout form because OfflineAudioContext is not wall-clock driven, and instead scheduled the param change on the AudioParam at t=0.5 s, which is genuinely mid-render and a better test than the two-render fallback I offered.
Task 15: complete @a122946 (noise, VCA, mixer, multiple, delay, output). 98 node + 25 browser.

PROCESS FAILURE — controller ran two implementers concurrently (Task 13's fix
and Task 15) against one working tree and one git index, violating the skill's
explicit rule. The Task 13 agent observed the other task's untracked files
appearing STAGED in the index through no git add of its own, unstaged them, and
verified its own diff before committing. Both commits were verified clean
afterwards by the controller: a8b1322 holds 3 files, a122946 holds 7, no
overlap, index and tree clean. No damage, but only because both agents checked.
Serializing strictly from here.

R29 — Ruling: output ports fronted by their own GainNode when the source node
has multiple outputs, mirroring the established input convention. The plan never
covers a multi-output module: the graph connects with a two-argument
out.connect(in), which always takes output index 0, so the sequencer's separate
cv and gate outputs from one worklet node would collapse onto the same signal.
Fronting each output index with a GainNode keeps the ModuleInstance contract
(Map<string, AudioNode>) intact and costs one node per port. Cost if wrong: one
extra gain node per multi-output module.
Task 16: complete @edc3708 (clock + sequencer). Worklet approach worked first pass, no fallback needed. Clock measured exactly 2.000 Hz against 120 BPM/division 1, sample-accurate, no drift. Sequencer stepped 220/440/880/1760 Hz expected vs 222.7/439.5/878.9/1757.8 measured, all within FFT bin resolution. 102 node + 27 browser. Note: the sequencer's `glide` param is declared per the brief but unwired — a silent no-op until a future portamento task.

R30 — Ruling (M2 DECIDED): ship band-limited mipmapped wavetables. The margin is
not close. Measured alias floors, wavetable vs the oversampled-BLEP design I was
about to commission:

         110 Hz    441      1109     1760     5000
  WT     -103.3   -129.3   -142.1   -147.7   -147.7   (all at the measurement noise floor)
  BLEP    -56.4    -68.7    -59.0    -54.6    -45.3

Cost: ~25-30 flops/sample for saw and triangle, ~50-55 for pulse, against ~790
for oversampled BLEP — so wavetables are 14-16x CHEAPER as well as 50-90 dB
better. No 700 Hz crossover, no dual-path crossfade, no 289-sample latency tax,
192 KB of tables. This is why I asked for the measurement instead of accepting
the first recommendation: the option the critic had set aside as "reasoned, not
built" beat the one it had spent two rounds designing, on both axes at once.

Two corrections the critic found while building it: the PWM identity
saw(t) - saw(t-w) that I proposed has zero mean regardless of w and inverted
polarity — the correct form is (2w - 1) - [saw(t) - saw(t-w)]. And its first
mip-transition measurement was itself an artifact of too narrow an analysis
window; re-measured properly, hard switching and crossfading land within 1.3 dB
of steady state at all three boundaries, so hard switching ships.

KNOWN LIMITATION, accepted: hard sync measures -30.6 dB (AMATEUR) with
wavetables, and a BLEP correction at the sync edge did not reliably improve it
(-28.5 to -32.4 dB) because the jump height must be estimated from discrete
samples and that error is comparable to what it corrects. Sync is unsolved in
both architectures — the oversampled path was never measured there either. To be
documented as a limitation rather than papered over, with the BLEP insertion
mechanics kept in the spec as the likely tool for a future fix.
M2: wavetable oscillator built. 158 node + 27 browser tests. Measured saw alias
floor -143.7 dB at 441 Hz (bar -120) and -170.3 dB at 5000 Hz (bar -140) —
against -43.2 dB for the PolyBLEP it replaces. Cost 42.7 ns/sample vs 4.0 for
PolyBLEP: about 2 ms of CPU per second of audio per oscillator, a fifth of one
percent of real time, for roughly 100 dB of alias rejection.

Implementer found a real build defect while integrating: sharing
dsp/wavetable.ts between the vco and segment worklet entries made Rollup hoist
it into a shared chunk, so the emitted bundles contained cross-file imports —
which AudioWorkletGlobalScope cannot resolve. Replaced vite.worklets.config.ts
with scripts/build-worklets.mjs running one Rollup build per worklet, verified
by grepping the output for import statements. This is exactly the failure the
one-bundle-per-worklet design existed to prevent, and it only appeared once two
worklets shared a module.

Controller omission: the M2 dispatch did not say "commit", so the work sat
uncommitted. Requested as two commits (build fix separate from oscillator) with
the honest cost multiple stated rather than smoothed.
Tasks 17+18: complete @8e528dd + @682fbda. 182 node + 31 browser = 213 tests.
Acceptance suite measures alias floor -143.68 dB and filter slope -26.25 dB/oct.
Boundaries guardrail initially found 10 false positives (params named sampleRate,
ctx.currentTime property reads); implementer tightened the regex rather than
weakening the test — 0 genuine offenders.

## FINAL GATES — both came back "not ready", with specifics

Whole-branch review (opus) — MUST FIX before presenting:
1. wavetable.ts:243 — getWavetableSet(sampleRate) is called inside oscSample,
   i.e. once per sample. The first non-sine sample builds 24 band-limited tables
   on the audio thread inside process(). Offline rendering hides this entirely;
   a live AudioContext drops out on the first note. This is the branch's one
   assumption that only holds offline.
2. clock-module.ts — HORIZON_SECONDS = 60 and rescheduleGate runs only at create
   and on param change, so the clock stops after one minute. Acceptance
   criterion 5 ("evolves unattended") is false past 60 s.
3. graph.ts:169 — outNode.disconnect(inNode) removes ALL connections between
   that node pair, not one cable. Reachable today: all four `multiple` outputs
   are the same GainNode, so two cables from a mult to one mixer share an
   endpoint pair and disconnecting either kills both.
4. Acceptance criterion 3 (no clicks) is UNIMPLEMENTED, not merely unproven. No
   smoothing exists outside keyboard glide; every native module ignores atTime
   and assigns .value directly. Every knob turn is a step discontinuity.
Test integrity: sequencer.test.ts renders 0.4 s at 60 BPM (1 s/step) and asserts
only step 1 — it passes identically if the sequencer is frozen.
Also: keyboard-midi.ts has zero tests; registerAllModules throws on a second
call; loadPatch throws when a cable names a removed port on a known type.

Audio audit — worst-first:
- WAVEFOLDER, AMATEUR and the worst thing in the instrument: no oversampling
  anywhere. Alias floor drive 1.5 -> -45 dB, drive 3 -> -31 dB (inside normal
  creative range), drive 16-20 -> +7 dB, alias energy LOUDER than the
  fundamental. No test measures any of it.
- LADDER DC, AMATEUR, previously unmeasured: saw into the VCF at resonance
  0.3-1.0 injects -29 to -23 dBFS DC (resonance 0 gives -208 dBFS; a sine input
  gives -240 regardless). tanh in the feedback loop acting on a shape without
  half-wave symmetry. Nothing downstream blocks DC. This is the default patch.
- NaN poisoning: one non-finite sample permanently poisons all four ladder
  integrators; confirmed still NaN 1900 samples later under normal input.
- Mip-boundary ticks, ACCEPTABLE not RELEASE: the critic swept all 7 audible
  boundaries where the shipped test covers 3. Triangle's worst single-sample
  delta at 5120/10240 Hz is 0.42-0.74 (-2.6 to -7.3 dBFS), past the codebase's
  own 0.35 threshold. Portamento across those boundaries will tick.
- Noise: exactly-periodic 2 s loop, and "color" is a binary 20 kHz/1200 Hz
  switch behind a continuous-looking knob — snaps at the midpoint.
Graded RELEASE as shipped: oscillator, envelope, LFO, ladder linear behavior,
ladder self-oscillation purity, ladder cutoff accuracy.
