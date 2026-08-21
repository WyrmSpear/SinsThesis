# Roadmap

Ideas captured from working sessions, with an honest read on cost and what the
engine already supports. Nothing here is committed to; it exists so the
thinking survives between sessions.

Current state: thirty modules, three academy grading modes across
twenty-two levels in three tracks, twelve themes, fifteen presets, two
arcade minigames, MIDI hardware in with MIDI learn, recording and WAV
export, live at `ryanoglelmt.com/portfolio/sinsthesis/`.

---

## 1. More modules — where the real gaps are

The inventory looks fuller than it is. Ranked by what unlocks the most patches
per unit of work.

**Read the status markers before planning off this section.** Most of the
original list has since been built, and an audit on 2026-08-21 found four
entries here still describing shipped work as a gap — including the two the
section called the *biggest* gaps. Each is kept, marked, rather than deleted,
because the reasoning about why it mattered is the point of this file.

**~~State-variable filter — the biggest gap.~~ SHIPPED** —
`src/engine/modules/svf.ts`, and it did roughly double what is patchable as
predicted. Built as a second *topology* rather than a mode switch on the
ladder; it deliberately does not self-oscillate. Original note: there was
exactly one filter type, a lowpass ladder, with no highpass, bandpass or
notch, and the ladder's ZDF/TPT machinery in `dsp/ladder.ts` was already most
of the maths.

**~~Stereo and panning — the second biggest.~~ SHIPPED** — see section 1a
below, whose dependency-ordered list is items 1–4 done and item 5 (unison /
detune) still open. The engine is no longer mono end to end: Panner,
Ping-Pong Delay, Width and a channel-count-aware Output all ship. The
original call that this was architectural rather than a module was correct,
and scoping it deliberately is what made it tractable.

**~~Ring modulator.~~ SHIPPED** — `modules/ring.ts`. "Nearly free — a
multiply — and sonically enormous. Highest value-to-effort ratio on the
list" was right, and it was cheaper still than that: `GainNode.gain` is an
a-rate param that *sums* connected signals, so a gain node at `gain.value =
0` driven by a bipolar carrier is a true four-quadrant multiply with no
worklet, no `dsp/` file and no alias floor to measure (a multiply of two
band-limited signals creates no new harmonics). Carrier suppressed to
−128.0 dB, input to −145.1 dB.

**FM operator.** The VCO already has linear and exponential FM inputs; a
dedicated operator with a feedback path opens DX-style territory. Still open.

**Effects, in order of cost:** ~~bitcrusher and sample-rate reducer
(trivial)~~ **SHIPPED** — one module, `modules/bitcrusher.ts`, carrying both
a `bits` knob and a `rate` decimator with CV on each; ~~chorus and flanger (a
modulated delay, and `delay.ts` exists)~~ **SHIPPED as two modules**, see
below; ~~compressor (needs envelope following, which `segment.ts` partly
has)~~ **SHIPPED** — `dsp/compressor.ts`, built rather than wrapping
`DynamicsCompressorNode` so the ratio law is assertable (2:1, 4:1 and 8:1
all land on `threshold + (in − threshold)/ratio` to the digit, and attack
covers 63.2% in one attack-time *independently of input level*); reverb (the
big one — an FDN or convolution, and the only item here that is a project
rather than a module). **Reverb is now the only unshipped item in this
list.**

### What the chorus/flanger rung actually cost, and the one finding worth keeping

They shipped as **two modules, not one with a mode switch** — the switch
would have had to rescale the delay knob by ~100x between the ranges, so one
knob would mean two things. Same reasoning that made the SVF its own
topology rather than a mode on the ladder.

The estimate above ("a modulated delay, and `delay.ts` exists") was right
for the Chorus and **wrong for the Flanger**, for a reason worth recording
before anyone plans another delay-based effect here:

> **Web Audio inserts at least one render quantum (128 samples, 2.667 ms at
> 48 kHz) into any cycle in the graph.** A flanger's regeneration is a
> cycle. So a native `DelayNode` flanger's feedback resonates on a comb of
> period `1/(d + 0.002667)` while its own dry/wet notches sit at `1/(2d)` —
> two unrelated combs. Measured on the native build at d = 1 ms: resonance
> spacing 250–280 Hz, against 1000 Hz predicted with no quantum and 273 Hz
> predicted with one.

The Flanger therefore owns its delay line in a worklet; the Chorus, which
has no feedback and so no cycle, stays on native `DelayNode`s and is
correct. **The rule to carry forward: a delay-based effect needs a worklet
if and only if it has feedback at short delay times.** It never mattered for
`delay.ts` (2.667 ms on a 300 ms echo is 0.9%) and it will matter for
reverb, whose whole structure is short feedback paths.

**~~Sampler.~~ SHIPPED** — `src/engine/modules/sampler.ts`. It did change the
engine's shape as predicted, and the cost landed where expected: a generic
`serializeState`/`restoreState` hook on `ModuleInstance`, and a 141 KB demo
preset that is nearly all base64 audio.


## 1a. Stereo — the architectural one

**Status: items 1–4 SHIPPED, item 5 open.** The design below survived contact
intact — the sixteen mono modules did stay untouched, and every stereo module
got its mono-compatibility acceptance test. Kept in full because the
reasoning is what made it work, and because item 5 is still live.

Requested directly: panning, ping-pong delay, spatialisers, thickening.

**The design decision that makes this tractable.** Do not make everything
stereo. Real Eurorack is overwhelmingly mono through the signal path, and
stereo appears at the *destination* — a panner, a stereo delay, a width stage
near the output. Modelling it the same way means the sixteen existing mono
modules stay untouched, and stereo becomes a small set of new modules plus a
stereo-aware output.

What that implies, in dependency order:

1. **A stereo-capable Output.** Today's is mono. Everything downstream of this
   depends on it.
2. **A Panner** — mono in, stereo out, with a CV input so an LFO can auto-pan.
   Equal-power law, not linear, or the centre sags.
3. **A Ping-Pong Delay** — mono in, stereo out, feedback crossing between
   channels. `dsp/` has a delay already; the crossing is the new part.
4. **A Width / spatialiser** — mid-side processing is the honest way to
   "thicken": encode to M/S, scale S, decode. It must stay mono-compatible,
   which is exactly what M/S guarantees and what a naive Haas-delay widener
   does not.
5. **Unison/detune thickening** — arguably belongs in the VCO as a voice-count
   and spread pair rather than a separate module.

**What it touches beyond new modules**, and must not be forgotten: worklets
currently declare `outputChannelCount: [1]`; `renderGraph` renders one channel;
the recorder captures mono and the WAV writer writes mono; the scope and
spectrum read one channel. Each needs a decision — most can stay mono by
summing, but that decision should be deliberate rather than discovered.

**The trap to avoid:** a widener that sounds impressive in headphones and
collapses to thin or hollow in mono. Every stereo module here needs a
mono-compatibility check as an acceptance criterion, not an afterthought.

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


## 3a. The arcade layer — expanded design notes

A second round of ideas from the owner: syncing a siren oscillation to an
animated emergency vehicle; phasers, lasers and "wub disruptors" fired at
targets; a Defender-style sidescroller on clef measure grids; a vertical
Space-Invaders with cascading notes to match; a panning-as-paddle game knocking
out falling blocks; an 8-bit/beepcore arcade challenge; a screensaver mode with
EQ-reactive visuals; and scoring an improvised soundtrack over ASCII animation.

**The distinction that matters.** These are two different products and should
not share a mode:

- **The synth is the controller.** Siren sync, wub disruptor, pan-paddle,
  note-matching. The player performs to affect the game. This is the novel
  idea — the thing nobody else is doing — and it is where the skill-building
  value lives.
- **The game reacts to the sound.** Screensaver, EQ-reactive visuals, video
  mixing. Output-only, no scoring, no skill. Worth building, but it is a
  visualiser, not a game.

**The constraint that should decide build order.** Pitch detection needs an
analysis window — YIN needs a couple of periods, roughly 30 ms at low
frequencies. So anything scored on *pitch* cannot be twitch-responsive.

But **pan position and filter cutoff are parameter reads, not analysis, and
carry no latency at all.** That makes the pan-as-paddle idea mechanically the
strongest of the set: it can be as fast and responsive as any arcade game,
where note-matching structurally cannot.

**Recommended build order:**

1. **Pan paddle.** Zero-latency control, immediately fun, and it teaches
   stereo placement — a thing players otherwise ignore. The `Panner` is
   equal-power and CV-controllable already.
2. **Wub disruptor.** The tempo-locked LFO exists; "hit the target at the
   right wobble rate" is directly measurable, and it teaches a real technique
   the bass track already covers.
3. **Siren sync.** LFO rate matching against an animated target — the same
   mechanic as the wub, with a different skin and a gentler curve.
4. **Note matching** (Space Invaders / clef grid). Design it around *sustained
   accuracy and controlled movement* — gliding onto a target, holding through
   a gate — rather than reflex, because the analysis window forbids reflex.
5. **Screensaver / visualiser.** Separate mode. The analysis layer already
   drives the scope and spectrum; this is rendering, not new DSP.

**Aesthetic note.** The 8-bit/beepcore idea is nearly free now — the Bitcrusher
ships, and a chiptune voice is a preset plus a theme rather than new DSP. An
ASCII or low-RAM visual mode also suits the test-equipment look the app already
has, and costs almost nothing to render.

**~~What the arcade would need that does not exist:~~ BOTH NOW EXIST.** The
game loop and the scoring model were built with Pan Paddle and reused by Wub
Disruptor, so items 1 and 2 of the build order above are SHIPPED and items
3–5 (siren sync, note matching, screensaver) inherit working infrastructure
rather than starting from nothing. Everything else — real-time pitch,
features, stereo, tempo lock — was already built and measured, as this note
originally said.


## 3b. Frequency-steered maze games

A further idea from the owner, prompted by two real bodies of research: work on
insects made to turn left or right under specific-frequency stimulation, and
studies on frequency-based non-invasive stimulation guiding blindfolded
subjects. The proposal: a maze, Pac-Man, Snake or Centipede where **the hero's
orientation changes according to the frequencies the player injects.**

**Why this is a good fit mechanically.** The pan-paddle proved a continuous
control maps well. Direction is different — it wants *discrete* commands from a
*continuous* instrument, which is a genuinely different and more interesting
mapping problem. Candidates worth prototyping:

- Frequency bands as directions — a note in one octave turns left, another
  turns right. The Frequency Bank module already produces exact tuned pitches,
  and the YIN tracker resolves pitch to sub-cent accuracy from 65 Hz to 8 kHz.
- Interval relationships rather than absolute pitch, which would teach
  something musical rather than rote.
- Rate of change — a rising sweep versus a falling one — which suits the
  30 ms analysis window better than discrete note onsets do.

**The latency constraint still governs.** Pitch needs an analysis window, so a
maze game must be turn-based, grid-stepped, or slow enough that ~30 ms of
detection lag is invisible. Snake and Pac-Man are grid-stepped by nature and
therefore fit; Centipede is twitch and fits worse unless the player's input
steers something with momentum rather than issuing instant commands.

**On framing.** The inspiration is real research, but the game is a game. It
should not imply the app does anything to a player neurologically — the same
line already drawn for the psychoacoustic modules, and for the same reason.

## 3c. Ferrofluid / nano-ferrite reactive visualiser

Owner's idea: a 3D fluid that dances over the "magnetic resonance" of
whatever the patch is doing, the way ferrofluid spikes over a magnet — and
then a game layered on it, matching tone or signal to drive the shape.

**Why it fits.** The visual language is already right for this project: real
ferrofluid spikes along field lines at discrete points, which is close to
what a spectrum *is*. Map bins to field sources and the fluid becomes a
spectrum analyser nobody has to be taught to read. It is the same "make the
measurement legible" idea the scope and the academy overlays already use,
one step further.

**The honest technical read.** The physics is the cheap part; the rendering
is not.

- Real ferrofluid is a Rosensweig instability — a free-surface problem that
  is genuinely expensive and completely unnecessary here. The look people
  recognise is spikes along field lines, and that is reproducible with a
  height field or a metaball/implicit surface over N field sources driven by
  FFT bins. `src/engine/analysis/fft.ts` already produces the input.
- WebGL is required; this is the project's first hard GPU dependency. Every
  visual so far is 2D canvas and degrades on anything. A raymarched metaball
  surface at full resolution will not hold 60fps on the phone the owner
  already measured at 100% CPU — and that phone is the constraint that
  matters, since it is the device the bug reports come from.
- The viable shape is therefore tiered, decided by measurement rather than
  by guessing: a full raymarched surface where the GPU allows, a cheaper
  displaced-mesh or instanced-spike version below that, and the existing 2D
  visuals as the floor. That tiering has to be built in from the start, not
  retrofitted — the CPU meter in the toolbar already gives a place to hang
  the decision.
- Audio-thread cost stays near zero either way: this reads an
  `AnalyserNode`, it does not add DSP.

**As a game.** Match-the-shape is a better fit than match-the-number: the
player is shown a target silhouette and has to find the timbre that produces
it, which is the academy's match-this-sound level with a visual target
instead of an audible one — and it reuses that grading path rather than
needing a new one.

**Sequencing note.** This is a large piece of work whose main cost is
rendering, not audio, and it competes with rungs that make the *instrument*
better (reverb, the effects rung, MIDI file playback). Worth doing, worth
doing after those.

## 4. Known gaps, already recorded elsewhere

- **~~The two spec'd failure modes never implemented~~ — BOTH SHIPPED.** The
  native fallback with a visible badge landed as
  `src/engine/modules/worklet-fallback.ts` plus the badge `rack/panel.ts`
  draws from `ModuleInstance.fallback`, and the CPU-overload meter as
  `worklets/cpu-meter.worklet.ts` plus `rack/cpu-meter-panel.ts`. They did
  matter more once the project went public, exactly as this line predicted.
  **One caveat worth keeping:** the meter *reports* load, and the Drive /
  Wavefolder `quality` remedy it motivated is **opt-in with Full as the
  default**. Nothing degrades automatically, so a device that reads 100%
  still reads 100% until a player flips those switches by hand. That is a
  deliberate choice — the trade is real and measured, not free — but it means
  "the CPU work is done" and "slow devices are fixed" are different claims.
- `LiveRecorder.stop()` drops up to one 512-sample batch (3–8 ms) at the tail.
  Bounded, documented, needs an async flush protocol to fix. **Still true** —
  `finish()` disconnects and flattens synchronously, so any batch still in
  flight on the worklet's message port is lost.
- Deployment to the site is a manual build-and-commit. Automating it needs a
  deploy key so a GitHub Action can push the built output. **Still true** —
  there is no `.github/workflows/`.
