# Roadmap

Ideas captured from working sessions, with an honest read on cost and what the
engine already supports. Nothing here is committed to; it exists so the
thinking survives between sessions.

Current state: sixteen modules, three academy grading modes across eleven
levels, nine themes, recording and WAV export, live at
`ryanoglelmt.com/portfolio/sinsthesis/`.

---

## 1. More modules — where the real gaps are

The inventory looks fuller than it is. Ranked by what unlocks the most patches
per unit of work:

**State-variable filter — the biggest gap.** There is exactly one filter type,
a lowpass ladder. No highpass, no bandpass, no notch. An SVF gives all three
from one module and roughly doubles what is patchable. The ladder's ZDF/TPT
machinery in `dsp/ladder.ts` is most of the maths already.

**Stereo and panning — the second biggest.** The engine is mono end to end.
Every `ModuleInstance` output is a single channel. Stereo is the difference
between a patch that sounds like a demo and one that sounds like a record, but
it touches the module contract, so it is an architectural change, not a module.
Worth scoping deliberately.

**Ring modulator.** Nearly free — a multiply — and sonically enormous. Highest
value-to-effort ratio on the list.

**FM operator.** The VCO already has linear and exponential FM inputs; a
dedicated operator with a feedback path opens DX-style territory.

**Effects, in order of cost:** bitcrusher and sample-rate reducer (trivial),
chorus and flanger (a modulated delay, and `delay.ts` exists), compressor
(needs envelope following, which `segment.ts` partly has), reverb (the big one
— an FDN or convolution, and the only item here that is a project rather than a
module).

**Sampler.** Changes the engine's shape rather than extending it: file loading,
buffer lifetime, playback that is not oscillator-shaped, and a UI for trimming
and looping. Genuinely wanted, genuinely not a casual afternoon.

## 2. Sequencing, deeper

A 16-step sequencer module ships. What a musician expects beyond it:
multiple patterns with chaining, per-step gate length and ratchets, swing,
probability per step, and polyrhythm from independent clock divisions. The
clock module already does divisions, and `.sinp` already round-trips patterns,
so this is mostly UI and pattern data rather than new DSP.

## 3. The arcade layer — skill-building through play

The idea: vertical side-scrolling action where you match and disrupt
frequencies. Bass and treble clef lanes. Something between Defender and the old
typing invaders games.

**Why it is closer than it looks.** The hard part already exists — a YIN pitch
tracker accurate to sub-cent from 65 Hz to 8 kHz (`analysis/pitch.ts`), note
naming with cents, and an audio thread cleanly isolated from the main one. What
is missing is a canvas game loop and a scoring rule.

**The strongest version of the idea:** the player's *patch is the controller*.
Not buttons — you tune, sweep and shape a sound to hit things. That is genuinely
novel and it is the reason to build this rather than another rhythm game.

**The constraint to design around, not discover later:** pitch detection needs a
window. YIN at low frequencies needs a couple of periods — roughly 30 ms at
65 Hz. Fine for "hold this note", lethal for "react in 8 ms". So mechanics
should reward sustained accuracy and controlled movement — gliding onto a
target, holding a drone through a gate, sweeping a filter to break a barrier —
rather than reflex. That suits a synth better anyway.

**Where it fits:** the academy grades a finished artefact; the arcade would
grade *control over time*. They teach different halves of the same skill, so it
is a fourth mode rather than a replacement.

## 4. Known gaps, already recorded elsewhere

- The two spec'd failure modes never implemented: a native fallback with a
  visible badge when a worklet fails to load, and a CPU-overload meter. Both
  matter more now the project is public and loading on unknown hardware.
- `LiveRecorder.stop()` drops up to one 512-sample batch (3–8 ms) at the tail.
  Bounded, documented, needs an async flush protocol to fix.
- Deployment to the site is a manual build-and-commit. Automating it needs a
  deploy key so a GitHub Action can push the built output.
