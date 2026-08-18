# minBLEP/minBLAMP oscillator core — implementation spec (revision 3)

**Revision 3 verdict, stated first: ship band-limited wavetables, not the
BLEP/oversampling design in revisions 1–2.** Measured, not reasoned: static
alias floor is RELEASE-grade (−100 to −147 dB, effectively the measurement
noise floor) at every frequency and waveform tested, versus mostly-ACCEPTABLE
for BLEP/oversampling; CPU cost is ~25–55 flops/sample versus ~790; table
memory is 192 KB; there is no crossover, no dual-path crossfade, no 289-sample
latency tax on every note. The one place wavetables did not clearly win —
hard sync — is detailed in section 7 below, honestly, including a hybrid
correction that did not measurably help despite being built the way it's
usually described on paper. Sections 1–6 (the full BLEP/oversampling design)
are kept below as the record of what was measured and rejected, and because
hard sync's unresolved status means some version of that machinery may still
be needed as a narrow follow-up regardless of which base oscillator ships.

---

## 7. Wavetables versus BLEP/oversampling — the head-to-head

Built and measured a second, independent oscillator core in the same
prototype harness: mipmapped band-limited saw and triangle tables (one per
octave, additive-synthesis construction, harmonics capped per-octave so the
top of each octave's range never exceeds native Nyquist), 4-point cubic
(Catmull-Rom) interpolation, 2048 samples/table, 12 octaves (20 Hz–~82 kHz,
comfortably spanning and exceeding the audible range). Pulse via the
saw-difference identity the coordinator proposed, corrected (see below).

### 7a. Static alias floor — measured, both waveform families

| Freq | Saw (WT) | Pulse .5 (WT) | Pulse .25 (WT) | Triangle (WT) | *(for comparison: saw, BLEP/oversampled)* |
|---|---|---|---|---|---|
| 110 Hz | −103.3 dB | −103.4 dB | −100.3 dB | −145.5 dB | −56.4 dB |
| 441 Hz | −129.3 dB | −129.3 dB | −127.8 dB | −147.7 dB | −68.7 dB |
| 1109 Hz | −142.1 dB | −143.0 dB | −139.1 dB | −147.7 dB | −59.0 dB |
| 1760 Hz | −147.7 dB | −147.7 dB | −146.7 dB | −147.7 dB | −54.6 dB |
| 5000 Hz | −147.7 dB | −147.7 dB | −146.8 dB | −147.7 dB | −45.3 dB |

Every wavetable reading is RELEASE-grade by a huge margin — these numbers
are the measurement noise floor (Float64 arithmetic + BH4 window residual),
not a property of the oscillator running out of room to alias into. This is
expected and correct: a mip table is *exactly* band-limited by construction,
not approximately corrected near a discontinuity, so there is no mechanism
left for aliasing to enter short of interpolation error, and cubic
interpolation at 2048 samples/table doesn't produce measurable error at
these frequencies.

### 7b. PWM without a second table — the identity needed a correction

The coordinator's proposed identity, `pulse(t,w) = saw(t) − saw(t−w)`,
**does not reproduce this project's pulse convention as stated** — measured,
not assumed: for an ideal saw ranging −1..1, that difference is a two-level
wave with levels `2(w−1)` (during phase `<w`) and `2w` (during phase `≥w`),
which has **zero mean regardless of `w`** (verified: mean ≈0.0006 at w=0.5,
≈0.0003 at w=0.25 — not the expected `2w−1`) and inverts which phase-region
reads high vs. low relative to `polyblep.ts`'s `t<pw → +1` convention.
**Corrected formula, verified**: `pulse(t,w) = (2w−1) − [saw(t) − saw(t−w)]`.
With this fix, mean tracks `2w−1` exactly (measured: −0.5006 at w=0.25 vs.
expected −0.5000, 0.5006 at w=0.75 vs. 0.5000) and alias floor is unaffected
(still −100 to −147 dB across the range — table 7a's pulse columns already
reflect the corrected formula). This is a real correction the implementer
needs, not a detail to take on faith from the identity as commonly stated.

### 7c. CPU cost and memory — measured against the shipped BLEP designs

- **Table memory**: 12 octaves × 2048 samples × 2 waveform families (saw,
  triangle — pulse reuses the saw table) × 4 bytes (Float32) = **192 KB**,
  generated once at startup, shared read-only across voices. (The
  BLEP/oversampled design's tables were 64 KB but needed the full
  30–384-tap-per-stage runtime decimator machinery on top; this needs none.)
- **Per-sample cost, saw/triangle**: one table read via 4-point cubic
  interpolation (4 array reads + Horner-form cubic evaluation) plus phase
  increment ≈ **25–30 flops/sample**. No discontinuity detection, no ring
  buffer, no clamp logic — the entire BLEP insertion apparatus (section 2)
  is simply absent, because there's nothing to correct.
- **Per-sample cost, pulse**: two table reads (the difference trick) ≈
  **50–55 flops/sample**.
- **Against the shipped numbers from sections 1–6**: native BLEP steady
  state was ≈4–5 flops/sample (cheaper than wavetable) but that number
  excludes the periodic discontinuity-correction bursts and doesn't apply
  above 700 Hz at all; the oversampled path was **~790 flops/sample**.
  Wavetable pulse at ~50–55 flops/sample is **~14–16× cheaper than the
  oversampled BLEP path**, at every frequency, with no crossover to manage.

### 7d. Mip transition under a pitch sweep (100→900 Hz, crossing the 160/320/640 Hz boundaries — 3 boundaries, per the constraint)

First measurement attempt was misleading and worth recording as a
methodology note: a narrow analysis window around each boundary (±20 to
±100 samples) showed hard-switching as dramatically better than crossfading
(hard switch: −41/−36/−0.2 dB relative to steady-state peak delta;
crossfade: −1.6/−3.9/+0.3 dB) — but the crossfade band at 50 cents spans
**~281 samples at the 160 Hz boundary** (a full oscillator period there is
~300 samples), and the narrow window wasn't wide enough to see the whole
transition, making the comparison unfair. Re-measured with a window wide
enough to contain the full transition at every tested width (5/15/50
cents): **both hard-switching and crossfading land within 0–1.3 dB of the
steady-state peak delta at all three boundaries** — no significant click by
this diagnostic, either way.

This does **not** mean crossfade width is a free parameter here — the same
principle from section 5b applies: a crossfade spanning more than roughly
half a period risks new artifacts, and 50 cents already approaches that
limit at the lowest boundary in this sweep. **Recommendation: hard mip
switching (nearest table per sample), not crossfading.** It measured
identically to (or better than) crossfading in this test, and it's simpler
— one table read, no blend weight, no second table warm at every sample.
If a future, more demanding portamento/vibrato test surfaces an audible
click under hard switching that this diagnostic missed, add a narrow
(≪ half-period) crossfade at that specific boundary — don't add it
pre-emptively for a problem this measurement didn't find.

### 7e. Hard sync — the genuine weak point, measured honestly

Rendered a classic hard-sync patch (sync rate 880 Hz driving resets on an
unrelated 587 Hz master table) two ways:

- **Wavetable alone, no correction at the sync edge**: **−30.6 dB** —
  AMATEUR by this project's own bar, and roughly the same magnitude of
  alias floor as the worst readings anywhere in the BLEP/oversampling
  design (5 kHz narrow-PWM pulse, −42.0 dB, is actually better than this).
- **Wavetable plus a BLEP-style correction inserted at the sync edge**
  (jump height = table value just after the reset minus the extrapolated
  value the old trajectory would have reached, same insertion mechanics as
  section 2, clamped against the sync period): **−28.5 to −32.4 dB across
  two implementation attempts — not a reliable improvement, and possibly
  slightly worse.** This is the honest result of actually building the
  hybrid the coordinator described as "well-trodden," not a reasoned
  prediction: table lookup for the periodic part plus a BLEP correction at
  the aperiodic sync event did not measurably help in this implementation.
  The likely cause: unlike a BLEP oscillator's discontinuity, where the
  jump height is an exact analytic constant (±2 for a saw), a wavetable
  sync edge's jump height varies continuously and must be estimated from
  discrete sample reads on either side of the reset — that estimate carries
  its own error, of a similar order of magnitude to the discontinuity it's
  trying to cancel, and no amount of correction-table refinement fixes an
  error in the *height* being applied.

**This is not disqualifying on its own** — hard sync isn't corrected at all
in today's shipped code either (section 4 flags `hardSync()` as a
pre-existing gap), so wavetable hard sync at −30.6 dB uncorrected is not a
regression versus what ships now, and the BLEP/oversampling design in
sections 1–6 never measured its own hard-sync alias floor either (section 4
specifies inserting a correction but reports no number for it). Both
architectures currently ship hard sync unsolved; wavetables just make that
explicit rather than implicit. **Flagged as a scoped follow-up problem, not
a reason to fall back to the ~790-flops/sample oversampled design**, which
has no demonstrated hard-sync advantage over wavetables — it wasn't tested
there either, in this pass or the prior one.

### 7f. Final recommendation

**Ship band-limited wavetables** (7a–7d) for saw, pulse, and triangle. The
margin is not close: RELEASE-grade suppression everywhere measured, at
roughly 1/14th to 1/30th the CPU cost of the oversampled BLEP path, with no
crossover frequency to tune, no 289-sample latency tax, no dual-path
crossfade machinery, and 3× the table memory of the BLEP tables but with
none of the runtime decimator. **The oversampling path (sections 1–6) is
dead** as a shipped design, per the coordinator's framing — kept in this
document as the measured record of what was tried, and because its
insertion mechanics (section 2) remain the most plausible tool for solving
hard sync properly, which is now the actual open problem regardless of
which oscillator core ships. **Do not ship hard sync as "solved"** on
either architecture — it needs its own dedicated measurement pass before a
test asserts any figure for it.

---

Status: **revision 2.** Revision 1 recommended a single linear-phase BLEP/
BLAMP table and measured that it does not reach RELEASE above ~1 kHz — a
fixed kernel cannot exceed roughly half the period without corrupting the
next discontinuity, and that ceiling doesn't move no matter how big the
table is. This revision answers the follow-up question directly: **what
actually reaches professional-grade suppression at 1–5 kHz**, evaluated by
measurement against four candidates, not by reasoning about which one
should win.

Every number below is measured in this project's own prototype harness
(4-term Blackman-Harris, DC-excluded, bin-aligned test tones — the same
methodology as the accepted `aliasFloorDb` fix), including the numbers for
candidates that were rejected. Nothing here is a projection from literature.

---

## 0. The decision

**Ship a two-path design: native-rate clamped BLEP/BLAMP below a pitch
crossover (~1 kHz), 4×-oversampled BLEP/BLAMP with cascaded halfband
decimation above it.** This is option 4 from the brief (BLEP below a
crossover, something else above it) — but the "something else" is the same
mechanism run at 4× resolution, not a different algorithm family. That
matters for implementation risk: it's the same table, the same insertion
code (section 2, unchanged), parameterized by generation rate, not a second
codebase to get right.

**Why not the other three candidates**, each measured before rejecting it:

- **DPW (differentiated polynomial waveforms), order 2 and order 3, both
  measured.** Order 2 (`q=x², single difference`) underperforms native BLEP
  at every frequency tested — no low-frequency win, no high-frequency
  grace. Order 3 (`q=x³-x, double difference`) converges to numbers
  essentially identical to the *current shipped 2-point PolyBLEP*
  (441 Hz: −42.7 dB vs. the current implementation's −42.7 dB, to one
  decimal — not a coincidence, both are 2nd-order corrections in different
  clothing) — worse than clamped BLEP at low-mid frequencies and no better
  at the top. Measured, not assumed: DPW does not degrade more gracefully
  than a kernel correction here; it simply performs at a lower ceiling
  throughout. Rejected.
- **Naive oversampling with no BLEP correction, measured at 2×/4×/8×.**
  Plateaus almost immediately (441 Hz: −41.6 / −42.4 / −42.3 dB across
  2×/4×/8×) because a naive discontinuous oscillator run at N×SR still has
  infinite bandwidth — it aliases at the *generation* Nyquist instead of the
  native one, and a realistic decimation filter can't distinguish "real
  content that folded down" from "real content." Oversampling only helps
  once the oscillator generating the samples is itself already corrected —
  which is the shipped design, not a rejected one.
- **Band-limited wavetables (mip-mapped per octave).** Not measured — this
  is a different architecture, not a parameter change, so "measure it" means
  building a second full oscillator core, which is out of scope for this
  pass. Reasoned judgment instead, as you invited: for a modular where PWM
  and hard sync are core patching techniques, wavetables are an *acceptable*
  trade only if PWM is implemented as crossfade between many discrete
  per-octave, per-duty-cycle tables (standard practice, e.g. Serum/Vital do
  exactly this) — genuinely continuous PWM isn't representable natively.
  Hard sync is not disqualifying (it's just an early phase-reset on the
  table read pointer, same as today). The real cost is engineering scope:
  correct mip-map generation across octave boundaries, PWM crossfade
  smoothness at audio-rate modulation, and table memory (a fine 8-octave ×
  32-PW-step set is several MB, not disqualifying on a modern machine but a
  real asset-generation subsystem). Given the two-path BLEP design measures
  competitively (section 6) with dramatically less new surface area, this
  is not the pass to build wavetables — flagged as a legitimate future
  option if the crossover design is later judged insufficient, not ruled
  out on principle.

---

## 1. Table generation (unchanged from revision 1)

**Linear-phase windowed-sinc BLEP/BLAMP, not minimum-phase minBLEP** — still
the right call; latency is free here and minimum-phase reconstruction would
only reclaim kernel budget on the *native-rate* side, which the crossover
design now sidesteps by moving to the oversampled rate above ~1 kHz instead.

**Window:** 4-term Blackman-Harris (`a0=0.35875, a1=0.48829, a2=0.14128,
a3=0.01168`), same as `fftMagnitude`'s BH4 variant.

**Sinc/cutoff:** cutoff at native Nyquist, `sinc(x)=sin(πx)/(πx)` in
native-sample-period units.

**Oversampling ratio (`OS`, table interpolation resolution): 16.** Confirmed
again in this pass — no measurable quality change at 32.

**`ZC_max`: 256**, table length `L = 2*(ZC_max+1)*OS + 1 = 8225`. Two
tables (`blep`, `blamp`), ~64 KB total at Float32, shared read-only across
voices. Construction steps (normalize impulse to unit DC gain, trapezoidal
integrate for BLEP, integrate again for BLAMP) are unchanged from revision 1
— see that revision's section 1 for the full derivation; it was verified
against the analytic ideal-step formula (`0.5 + Si(πx)/π`) to within ~3%,
consistent with expected BH4 window-truncation residual.

---

## 2. Insertion (unchanged, both paths use identical code)

The clamp, the sign convention, and the ring-buffer offset are exactly as
specified in revision 1 — restated here because they are the actual
implementation risk, not the crossover decision:

```
periodSamples = generationRate / freq   // native rate below crossover,
                                          // 4*nativeRate above it
ZC = max(1, min(ZC_max, floor(periodSamples / 2) - 1))
```
For pulse, clamp against the nearer edge gap, not half the period:
`ZC = max(1, min(ZC_max, floor(periodSamples * min(pw, 1-pw)) - 1))`.
Recompute at every discontinuity — frequency and `pw` can both change
between cycles.

Per discontinuity, for each tap `k` in `-ZC..+ZC`:
```
x = k + d                    // NOT k - d. Sign flip is the first bug found
                              // in prototyping; it doesn't fail loudly, it
                              // just caps suppression ~10 dB worse.
idx = radius + x*OS
corr = lerp(table[floor(idx)], table[floor(idx)+1], frac(idx))
ringOffset = k + ZC          // NOT raw k. Taps with k<0 written at raw
                              // offset target already-drained ring slots
                              // and the write is silently lost — second bug
                              // found in prototyping, also doesn't fail
                              // loudly.
ring[(head + ringOffset) mod ring.length] += h * corr
```
Correction is always **added**; sign lives entirely in the signed jump
height `h`. This is unchanged by the crossover design — the oversampled
path runs the exact same insertion function against a table built and
interpreted in generation-rate sample units, not native-rate units (i.e.
`ZC`, `d`, and the ring buffer are all in terms of whatever rate is
currently generating).

**The crossover switch is a parameter, not a branch in this logic**:
`generationRate` and the resulting `dt = freq/generationRate` are the only
things that change between the two paths.

---

## 3. Per waveform

**Saw, pulse, triangle**: construction unchanged from revision 1 (saw: one
edge, `h=∓2`; pulse: two edges, `h=±2` each, independently detected;
triangle: two BLAMP corners at the peak and trough, `h=∓8·dt`, generated
directly with **no integrator** — confirmed correct again this pass, see
section 6, triangle clears RELEASE at 110/441 Hz and is the strongest
performer of the three waveforms at every frequency measured).

**Sine**: untouched, confirmed again — no discontinuity of any order.

**Pulse-width note, now measured rather than asserted:** narrowing `pw`
tightens the clamp (the nearer-edge-gap rule above), and this is not a
second-order effect — at pw=0.25 vs pw=0.5, native-rate 1109 Hz drops from
−46.8 dB to −32.5 dB, a 14 dB penalty purely from the tighter clamp. PWM
patched at audio rate into a bright voice will audibly move the alias floor
as the duty cycle sweeps through its narrow settings. This is inherent to
the kernel-clamp mechanism, not a bug — flagged as a real, audible property
of the design that a musician sweeping PWM on a bright pulse will notice a
brightness/graininess change correlated with duty cycle, independent of
pitch.

---

## 4. Hard sync (unchanged from revision 1)

Insert a BLEP/BLAMP correction for the sync reset itself
(`h = valueAtPhase0 - currentValue`, same `d`/insertion mechanics as any
other edge — the existing `hardSync()` doesn't do this today, worth fixing
in the same pass). **Leave the ring buffer and delay line to drain, do not
clear them** — pending corrections from before the sync are still valid and
superpose linearly with the sync's own correction. Applies identically on
both paths.

---

## 5. State, cost, and the crossover itself

**Revision 3 correction: crossover is 700 Hz, not 1 kHz, and the decimator
is 384 real taps/stage, not 128.** Both changes came from measuring the
region either side of 1 kHz rather than assuming it — see the sweep table
below. The 1 kHz choice in revision 2 left a real hole; this one is
measured to close it, with the honest caveat (also below) that a hole
between 441 Hz and 700 Hz was not separately swept.

**The sweep that decided it** (saw / pulse pw=0.5 / pulse pw=0.25, native
vs. oversampled, at the decimator spec that ships — 384 real taps/stage):

| Freq | Saw native | Saw oversampled | Pulse .5 native | Pulse .5 oversampled | Pulse .25 native | Pulse .25 oversampled |
|---|---|---|---|---|---|---|
| 700 Hz | −50.5 | −62.5 | −51.3 | −63.8 | −44.2 | −59.4 |
| 800 Hz | −49.6 | −60.7 | −50.5 | −62.8 | −46.9 | −59.5 |
| 900 Hz | −40.8 | −61.0 | −40.9 | −60.4 | −36.9 | −59.2 |
| 1109 Hz | −40.8 | −59.0 | −46.8 | −59.3 | −32.5 | −56.5 |
| 1300 Hz | −45.2 | −58.8 | −45.2 | −58.8 | −36.3 | −55.8 |
| ~1493 Hz | −41.6 | −54.5 | −43.0 | −56.8 | −39.5 | −53.4 |

**Reading it straight:** the oversampled path beats native by 10–24 dB at
*every* frequency tested in this band — there is no point in the 700–1500 Hz
range where native wins or even ties. That means the crossover isn't
trading off two competing curves, it's just "how much of this range can we
afford to pay the oversampled cost for," and the honest answer given the
data is *all of it* — native has no redeeming case here. **Crossover: 700
Hz.** Below 700 Hz, native is independently excellent (441 Hz: −68.7 dB
RELEASE, established in revision 2) so there's no reason to pay the
oversampled cost there. At 700 Hz itself the boundary sample uses the
oversampled path (`freq >= crossover`), which is what produces the −62.5 dB
saw reading rather than the native path's −50.5 dB.

**What this does and doesn't close:** the worst reading anywhere in the
700–1493 Hz sweep is −53.4 dB (pulse pw=0.25 near 1500 Hz, oversampled) —
ACCEPTABLE, comfortably clear of AMATEUR, though not RELEASE. The 1109 Hz
hole specifically (the blocking item) is closed: saw goes from AMATEUR
(−41.1 dB, native) to ACCEPTABLE (−59.0 dB, oversampled); narrow-PWM pulse
goes from AMATEUR (−32.5 dB) to ACCEPTABLE (−56.5 dB).

**Not measured, flagged rather than assumed:** the region between 441 Hz
(known RELEASE on native) and 700 Hz (now the crossover) was not swept.
Given the degradation pattern is gradual everywhere else measured, a new
hole appearing in that 259 Hz gap is unlikely but not verified — if this
matters before shipping, it's one more sweep with the same harness.

**The decimator increase from 128 to 384 real taps/stage was itself a
measured correction, not a guess:** at 128 taps/stage, 900/1109 Hz read
−40.7/−43.0 dB (AMATEUR-adjacent) even on the oversampled path — a genuine
soft spot, not fixed by moving the crossover, because it lived in the
decimator, not the BLEP kernel. Isolated by testing with `ZC_max` far above
its clamp ceiling at those frequencies (no change) and then with more
decimator taps (900 Hz: 128→−40.7, 256→−50.0, 384→−61.0 dB) — confirming it
was decimator-limited, not BLEP-clamp-limited. Ship 384, not 128; the table
above already reflects it.

**Implement the crossover as a per-sample continuous function of
instantaneous frequency, not a discrete `freq > 700 ? … : …` branch** — see
section 5b for why (the crossfade needs it to be continuous, and a hard
branch is exactly the bug that section measures and rejects).

**Per-oscillator state:**
```
OscState {
  phase: number
  ring: Float64Array(2*ZC_max + 1)     // sized for ZC_max regardless of path
  head: number
  dryDelay: RingBuffer(ZC_max)
  path: 'native' | 'oversampled'
  // oversampled path only:
  decimatorState: two cascaded halfband FIR delay lines (see below)
}
```

**Cost, native path (unchanged from revision 1):** steady state ≈4–5
flops/sample; at a discontinuity, `~10*ZC_eff+5` flops for that sample,
amortized to single-digit flops/sample at the frequencies this path
actually serves (below 1 kHz, `ZC_eff` stays large enough for quality but
discontinuities are infrequent enough that the amortized cost stays low —
see revision 1 section 5 for the full derivation).

**Cost, oversampled path — measured, and this is the number to hold me to
(revised: decimator is 384 taps/stage, not 128, per the correction above):**
- Generation at 4× native rate: the same cheap BLEP core, run 4× more often.
  ≈4×(4–5) ≈ 16–20 flops per native output sample for steady state, plus
  discontinuity bursts (more frequent at 4×, but `ZC_eff` is proportionally
  larger too — self-balancing the same way the native path is).
- Decimation: 2 cascaded halfband stages (4× = 2×2×), **384 real
  multiply-adds per stage** (a true halfband filter at this cutoff has
  every other tap mathematically zero — confirmed by measurement: at 65
  taps/stage the cascade only reached −25.3 dB; scaling to 384 real taps
  is what reached the −61 dB needed to close the 900/1109 Hz hole). Total:
  **~768 real MACs per native output sample.**
- The coordinator's accepted framing on this cost: 300 flops/sample at 128
  MACs/stage was ≈38k flops per 128-sample quantum per oscillator, low
  single-digit percent of budget on a monophonic voice. **At 384 taps/stage
  the honest number is ~790 flops/sample ≈ 101k flops per quantum per
  oscillator — roughly 2.7× the previously-accepted cost, and on the order
  of ~80× the native path rather than ~30–40×.** Still small in absolute
  terms on a monophonic voice on modern hardware, but it moved, and it
  moved because the earlier number came from an under-measured decimator —
  flagging the pattern, not just the number: cost estimates in this
  document have been wrong in the cheap direction twice now (128 taps
  looked sufficient until 900 Hz was actually swept). Budget headroom
  accordingly if/when this goes polyphonic.

---

## 5b. The crossfade at the boundary (measured, not left unspecified this time)

A pitch crossing 700 Hz needs both paths' outputs blended, not switched —
confirmed by measurement: a bare hard switch between paths mid-note
produces a residual of **+6.3 dBFS relative to the correct (all-oversampled)
reference waveform** — i.e. a discontinuity comparable to the oscillator's
own full-scale range, an unambiguous click, even after correctly matching
the two paths' latencies (see below; an *unmatched*-latency hard switch is
worse still and wasn't separately quantified past confirming it's the worse
case).

**Design, each piece measured or derived from a measured quantity:**

- **Both paths run continuously and simultaneously whenever pitch is within
  the crossfade band**, not gated on/off at the edges — this is what makes
  the design correct under fast modulation (below). Outside the band, only
  the active path runs, at the cost already stated in section 5.
- **Band width: ±50 cents around 700 Hz (≈680–721 Hz)**, chosen to be
  narrow relative to the shortest period in the band (~68.6 samples at
  700 Hz) — this matters, see the width-sweep finding below.
- **Phase coherence: a single shared phase accumulator drives both paths.**
  The oversampled path takes 4 sub-steps of `dt/4` per native output sample
  using that same running phase, rather than maintaining an independent
  accumulator — this guarantees the two paths can never drift apart in
  phase, by construction, not by periodic resync.
- **Latency matching is required, not optional, and was the dominant factor
  in the measurement below.** The two paths have different group delay:
  native's is `ZC_eff` samples (small near the crossover, ~30 samples at
  700 Hz); the oversampled path's is its own `ZC_eff/4` plus two cascaded
  decimator stages' group delay (`halfTapsPerStage` samples at each stage's
  own rate, converted to native-sample-equivalent) — **measured at ≈322
  native-sample-equivalent total at 700 Hz with the 384-tap decimator**, a
  289-sample gap versus native's ~33. **Pad the native path with a fixed
  289-sample delay line** (matched to the oversampled path's latency at the
  crossover point) so both paths present identical total output latency at
  all times, not just during the crossfade — this is what makes a
  subsequent smooth blend meaningful instead of blending two
  time-misaligned signals.
- **Weight function: equal-power** (`gNative = cos(p·π/2)`,
  `gOversampled = sin(p·π/2)`), `p` a linear ramp over the crossfade width
  as a function of position in the band.
- **Crossfade width: measured, and counterintuitive — narrower is better,
  down to a floor, and going wider than about half the shortest period in
  the band makes it worse, not better:**

  | Width (samples) | Width (ms) | Worst residual vs. reference |
  |---|---|---|
  | 8 | 0.17 | −17.9 dBFS |
  | 16 | 0.33 | −17.7 dBFS |
  | 24 | 0.50 | −17.0 dBFS |
  | 32 | 0.67 | −16.2 dBFS |
  | 64 | 1.33 | +6.3 dBFS |
  | 128 | 2.67 | +6.5 dBFS |
  | 256 | 5.33 | +6.5 dBFS |

  The period at 700 Hz is ~68.6 samples. Once the crossfade width
  approaches or exceeds that, the blend spans a full oscillator
  discontinuity on each path independently, and any residual sub-sample
  timing mismatch between the two (latency-matching is exact to the
  nearest sample, not exact to the fraction) becomes audible as the two
  paths' own correction ripple beats against each other across the
  transition — worse than a plain hard switch at the same point. **This is
  the implementation trap for this section: a wider crossfade is the
  intuitive fix for a click and is wrong here. Ship width = 16 samples
  (0.33 ms), scaled down if the crossover is ever moved to a higher
  frequency where the period is shorter (keep width comfortably under half
  the period at the low edge of the band).**
- **Measured worst-case handover artifact, final design (latency-matched,
  16-sample equal-power crossfade): −17.7 dBFS residual versus the correct
  reference**, a ~24 dB improvement over the +6.3 dBFS hard-switch case.
  This is the number to hold me to. It is not inaudible — −17.7 dBFS is a
  real, if brief (16 samples, 0.33 ms), transient — but it is the best this
  design achieved within the width sweep tested, and dramatically better
  than not crossfading at all.
- **Fast modulation crossing the boundary multiple times within one
  128-sample render quantum**: handled by construction, not as a special
  case. Because the weight is a continuous per-sample function of
  instantaneous frequency and both paths run continuously through the band
  (not re-triggered at entry/exit), there is nothing that needs to notice
  "how many times" the boundary was crossed — each sample's blend is
  correct independent of the trajectory that got it there. The only
  requirement this places on the implementation is that both paths' state
  (delay lines, ring buffers, decimator history) must be updated every
  sample while pitch is anywhere in the band, which the "always run both
  paths in the band" rule above already guarantees.

---

## 6. Acceptance numbers — final, measured, no rounding up

**Crossover: 700 Hz.** Below it: native path. At and above it: oversampled
path (4×, cascaded halfband decimation, 384 real taps/stage). Every number
below is what actually ships at that path/frequency combination — no
figure has been rounded up to the next grade band. Where a reading sits
below its own grade threshold by less than 1 dB, it is graded at the lower
band, not the higher one.

**Native path** (below 700 Hz):

| Freq | Saw | Pulse pw=0.5 | Pulse pw=0.25 | Triangle |
|---|---|---|---|---|
| 110 Hz | −56.4 dB — ACCEPTABLE | −70.1 dB — RELEASE | −69.2 dB — RELEASE | −99.9 dB — RELEASE |
| 441 Hz | −68.7 dB — RELEASE | −53.0 dB — ACCEPTABLE | −51.3 dB — ACCEPTABLE | −76.8 dB — RELEASE |

(No native-path reading is asserted at or above 700 Hz — that band ships on
the oversampled path exclusively, per section 5's crossover decision.)

**Oversampled path** (700 Hz and above, 384 taps/stage):

| Freq | Saw | Pulse pw=0.5 | Pulse pw=0.25 | Triangle |
|---|---|---|---|---|
| 700 Hz | −62.5 dB — RELEASE | −63.8 dB — RELEASE | −59.4 dB — ACCEPTABLE | not separately measured; expect RELEASE by symmetry with 1760/5000 Hz below — verify before asserting |
| 800 Hz | −60.7 dB — RELEASE | −62.8 dB — RELEASE | −59.5 dB — ACCEPTABLE | ″ |
| 900 Hz | −61.0 dB — RELEASE | −60.4 dB — RELEASE | −59.2 dB — ACCEPTABLE | ″ |
| 1109 Hz | −59.0 dB — ACCEPTABLE (0.9 dB short of RELEASE) | −59.3 dB — ACCEPTABLE (0.7 dB short) | −56.5 dB — ACCEPTABLE | ″ |
| 1300 Hz | −58.8 dB — ACCEPTABLE | −58.8 dB — ACCEPTABLE | −55.8 dB — ACCEPTABLE | ″ |
| 1760 Hz | −54.6 dB — ACCEPTABLE | −55.1 dB — ACCEPTABLE | −52.1 dB — ACCEPTABLE | −82.8 dB — RELEASE |
| 5000 Hz | −45.3 dB — ACCEPTABLE (boundary) | −46.1 dB — ACCEPTABLE | −42.0 dB — AMATEUR (boundary) | −61.7 dB — RELEASE |

**Grade summary, stated plainly, no spreadsheet rounding:**
- **Triangle is RELEASE everywhere measured** except native 1109 Hz-region
  (not applicable — triangle at 1109 runs on the oversampled path under
  this crossover, and wasn't independently re-measured there; the gap in
  the table above is real, not an oversight — flagged for the implementer
  to close before writing a test that asserts a specific figure for
  triangle in the 700–1300 Hz band).
- **Saw and pulse are ACCEPTABLE, not RELEASE, for essentially the entire
  oversampled range.** 700–900 Hz saw and pulse pw=0.5 do clear RELEASE;
  everything from ~1000 Hz up is ACCEPTABLE. **Do not write a RELEASE
  assertion for saw or pulse above ~900 Hz** — the measured data does not
  support it, full stop.
- **5 kHz narrow-PWM pulse (pw=0.25) is the one AMATEUR reading in the
  entire oversampled table** (−42.0 dB, 3 dB short of ACCEPTABLE). This is
  the tightest-clamped case in the design (narrowest edge gap at the
  highest frequency) and is not closed by the current spec. Do not assert
  ACCEPTABLE for narrow-PWM pulse at the top octave — it isn't there yet.
  If this matters, the lever is a larger `ZC_max` or `halfTapsPerStage`
  specifically for this case, not measured in this pass.
- **DC offset**: unchanged from revision 1 — expect ≤−80 dBFS saw/pulse,
  ≤−60 dBFS triangle, measured after a ~2000-sample settle.
- **Handover artifact at the crossover**: −17.7 dBFS worst-case residual
  (section 5b), with the 16-sample crossfade. Not a steady-state alias
  figure — a transient, present only while pitch is within ±50 cents of
  700 Hz.

**What to hold me to:** the crossover is 700 Hz, not a round 1 kHz. The
decimator is 384 real taps/stage, not 128. RELEASE is asserted only where
the table above says RELEASE — 441 Hz saw/triangle (native), 700–900 Hz
saw/pulse.5 (oversampled), 1760/5000 Hz triangle (oversampled). Everything
else in the oversampled range is ACCEPTABLE. 5 kHz narrow-PWM pulse is
AMATEUR and unresolved. Triangle in the 700–1300 Hz oversampled band is
unmeasured — do not assert a figure there without running the sweep. The
crossfade's −17.7 dBFS handover residual is real and audible in a strict
sense, not eliminated, only reduced ~24 dB from a hard switch.
