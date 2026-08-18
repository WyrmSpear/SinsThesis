# SinsThesis — locked decisions (recovered)

Recovered 2026-08-18 from the 2026-08-17 brainstorming session transcript
(`~/.claude/projects/-home-an4n51/67bcdcb3-6381-415a-838c-1cc9aa512ec1.jsonl`).
That session locked every major fork but ended before any spec was written.
This file exists so the decisions survive independently of transcripts.

## What it is

A deep modular synthesizer as a web instrument. Ancestry: Moog, circuit
synthesis, Native Instruments Reaktor/Generator. Full synth studio, not a
showpiece — real DSP, worked out numerically.

## Locked forks

| Question | Decision |
|---|---|
| Purpose | Full synth studio instrument (playable + learning + studio layers) |
| Patching paradigm | **Hybrid: rack + zoom-in** — Eurorack-style panel rack at top level; any module opens to reveal its internal node graph |
| DSP depth | **Hybrid: native + custom hotspots** — native WebAudio for gain/delay/mix/envelope, hand-written AudioWorklets for character (PolyBLEP osc, ZDF ladder filter w/ transistor nonlinearity, saturator, wavefolder) |
| Engine architecture | **Approach 1 now, monolithic-worklet upgrade planned** behind the same `ModuleInstance` interface (deferred to a later phase) |
| AI role | **Patch co-pilot/critic + latent morphing + generative modulation.** Explicitly NOT text→patch. AI must work against a local OpenAI-compatible endpoint (vLLM/Ollama), hosted API optional fallback |
| Phase 1 scope | Computer-keyboard playing, MIDI hardware input, clock + step sequencer, save/load patches — all four non-negotiable |
| Themes | 8 ship as switchable token sets; **Reaktor Dark is the default** |
| Theme semantics | **Skin only** — no feature is ever gated behind a look; identical geometry across themes |
| Voice architecture | Monophonic in Phase 1 (last-note priority + glide). Polyphony is a later phase |

## The 8 themes

A Moog Wood · B Circuit/PCB · **C Reaktor Dark (default)** · D Phosphor Lab ·
E Ableton Live · F Geist Groovebox (FXpansion Geist2, confirmed — not Vercel
Geist) · G Casiotone · H Korg MS-20

Rendered side by side as real panels in
`.superpowers/brainstorm/105777-1787017251/content/visual-direction-v3.html`.

## Phase decomposition

1. **Core engine + rack** — audio graph, modules, patch cables, knobs. The instrument makes sound.
2. **Analysis layer** — scopes, spectrum, signal-flow visualization on every cable.
3. **Studio layer** — sequencer, clock, recording/export, presets.
4. **Sharing** — patch serialization, URL/file share, library.

Phase 1 is the one being specced. Later phases get their own spec each.

## Where the design stopped

Section 1 of 3 (architecture + module contract) was presented and never
approved. Sections 2 and 3 were never written. Nothing was implemented.
