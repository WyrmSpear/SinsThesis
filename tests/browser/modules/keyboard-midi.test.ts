import { describe, it, expect, beforeEach } from 'vitest'
import { PatchGraph } from '../../../src/engine/graph'
import { registerModule, clearRegistry } from '../../../src/engine/registry'
import { keyboardMidiDescriptor, type KeyboardMidiInstance } from '../../../src/engine/modules/keyboard-midi'
import { noteToPitchCv, parseMidiMessage } from '../../../src/engine/midi'

/**
 * `handleMidiEvent` -- the path from a real MIDI controller into the
 * module -- had zero coverage before this file (docs/CONTINUATION.md's
 * "Smaller things"). `midi.ts`'s pure `parseMidiMessage`/`NoteStack` were
 * covered, but nothing ever constructed a keyboard module instance and
 * called `handleMidiEvent` on it, so hardware MIDI was plausibly broken
 * and nobody would know. This drives it with realistic message sequences
 * end to end -- byte parsing through to the module's actual audio outputs
 * moving -- the same way every other module's test file proves its own
 * behavior against rendered output, not against internal state.
 */

const SR = 48000

beforeEach(() => {
  clearRegistry()
  registerModule(keyboardMidiDescriptor)
})

interface Sample {
  pitch: number
  gate: number
  velocity: number
}

/**
 * Renders a lone Keyboard/MIDI module's three outputs (pitch, gate,
 * velocity) onto three channels of one `OfflineAudioContext` render, and
 * samples all three at each of `sampleAt`. `actions` run at real points on
 * the render's own timeline via `ctx.suspend` -- the pattern
 * `tests/browser/param-smoothing.test.ts` established, and the only way to
 * reach a non-zero `ctx.currentTime` from an `OfflineAudioContext`: a plain
 * synchronous callback during graph setup always lands at t=0 regardless
 * of any requested delay, since offline rendering does not run on wall-clock
 * time until `startRendering()` is called. An action at `t <= 0` runs
 * synchronously before rendering starts (there is nothing to suspend at
 * time zero).
 *
 * Built through `PatchGraph`/`registerModule`, not a bare
 * `keyboardMidiDescriptor.create(ctx)` call, so this exercises the exact
 * construction and `setParam` path production code (`rack/main.ts`,
 * `dev/main.ts`) actually uses.
 */
async function renderKeyboard(
  seconds: number,
  actions: Array<[number, (kb: KeyboardMidiInstance, graph: PatchGraph, id: string) => void]>,
  sampleAt: number[],
): Promise<Sample[]> {
  const ctx = new OfflineAudioContext(3, Math.ceil(seconds * SR), SR)
  const graph = new PatchGraph(ctx)
  const id = graph.addModule('keyboard', 'kb')
  const instance = graph.getInstance(id) as KeyboardMidiInstance

  const merger = ctx.createChannelMerger(3)
  instance.outputs.get('pitch')!.connect(merger, 0, 0)
  instance.outputs.get('gate')!.connect(merger, 0, 1)
  instance.outputs.get('velocity')!.connect(merger, 0, 2)
  merger.connect(ctx.destination)

  for (const [at, run] of actions) {
    if (at <= 0) {
      run(instance, graph, id)
    } else {
      ctx.suspend(at).then(() => {
        run(instance, graph, id)
        return ctx.resume()
      }).catch(() => {})
    }
  }

  const buffer = await ctx.startRendering()
  const pitchCh = buffer.getChannelData(0)
  const gateCh = buffer.getChannelData(1)
  const velCh = buffer.getChannelData(2)
  return sampleAt.map((t) => {
    const i = Math.min(buffer.length - 1, Math.round(t * SR))
    return { pitch: pitchCh[i]!, gate: gateCh[i]!, velocity: velCh[i]! }
  })
}

describe('Keyboard/MIDI: handleMidiEvent', () => {
  it('a note-on sets pitch and opens the gate; a note-off closes it', async () => {
    const [before, on, off] = await renderKeyboard(
      0.6,
      [
        [0.1, (kb) => kb.handleMidiEvent(parseMidiMessage(new Uint8Array([0x90, 60, 100]))!)],
        [0.3, (kb) => kb.handleMidiEvent(parseMidiMessage(new Uint8Array([0x80, 60, 64]))!)],
      ],
      [0.05, 0.2, 0.4],
    )
    expect(before!.gate).toBeCloseTo(0, 5)
    expect(on!.gate).toBeCloseTo(1, 5)
    expect(on!.pitch).toBeCloseTo(noteToPitchCv(60), 5)
    expect(off!.gate).toBeCloseTo(0, 5)
  })

  it('a note-on with velocity zero behaves as a note-off, the running-status keyboard case', async () => {
    const [on, off] = await renderKeyboard(
      0.6,
      [
        [0.1, (kb) => kb.handleMidiEvent(parseMidiMessage(new Uint8Array([0x90, 64, 90]))!)],
        // Same status byte (0x90, note-on), velocity 0 -- parseMidiMessage
        // already converts this to a `noteOff` event; this proves
        // handleMidiEvent actually closes the gate for it end to end.
        [0.3, (kb) => kb.handleMidiEvent(parseMidiMessage(new Uint8Array([0x90, 64, 0]))!)],
      ],
      [0.2, 0.4],
    )
    expect(on!.gate).toBeCloseTo(1, 5)
    expect(off!.gate).toBeCloseTo(0, 5)
  })

  it('velocity reaches the velocity output', async () => {
    const [sample] = await renderKeyboard(
      0.3,
      [[0.05, (kb) => kb.handleMidiEvent(parseMidiMessage(new Uint8Array([0x90, 67, 64]))!)]],
      [0.15],
    )
    expect(sample!.velocity).toBeCloseTo(64 / 127, 3)
  })

  it('overlapping notes respect last-note priority, and release falls back correctly', async () => {
    const NOTE_A = 55
    const NOTE_B = 62
    const [afterA, afterB, afterBOff, afterAOff] = await renderKeyboard(
      0.9,
      [
        [0.1, (kb) => kb.handleMidiEvent({ kind: 'noteOn', note: NOTE_A, velocity: 1 })],
        [0.3, (kb) => kb.handleMidiEvent({ kind: 'noteOn', note: NOTE_B, velocity: 1 })],
        [0.5, (kb) => kb.handleMidiEvent({ kind: 'noteOff', note: NOTE_B })],
        [0.7, (kb) => kb.handleMidiEvent({ kind: 'noteOff', note: NOTE_A })],
      ],
      [0.2, 0.4, 0.6, 0.8],
    )
    expect(afterA!.pitch).toBeCloseTo(noteToPitchCv(NOTE_A), 5)
    expect(afterA!.gate).toBeCloseTo(1, 5)
    // B was pressed last, without releasing A -- B wins.
    expect(afterB!.pitch).toBeCloseTo(noteToPitchCv(NOTE_B), 5)
    expect(afterB!.gate).toBeCloseTo(1, 5)
    // Releasing B (the newer note) hands the voice back to A, not silence.
    expect(afterBOff!.pitch).toBeCloseTo(noteToPitchCv(NOTE_A), 5)
    expect(afterBOff!.gate).toBeCloseTo(1, 5)
    // Only once the last held note (A) releases does the gate close.
    expect(afterAOff!.gate).toBeCloseTo(0, 5)
  })

  it('ignores a MIDI note outside the zone, and still plays one inside it', async () => {
    const [outside, inside] = await renderKeyboard(
      0.6,
      [
        [
          0,
          (_kb, graph, id) => {
            graph.setParam(id, 'rangeLow', 60)
            graph.setParam(id, 'rangeHigh', 72)
          },
        ],
        [0.1, (kb) => kb.handleMidiEvent({ kind: 'noteOn', note: 59, velocity: 1 })], // just below the zone
        [0.3, (kb) => kb.handleMidiEvent({ kind: 'noteOn', note: 65, velocity: 1 })], // inside the zone
      ],
      [0.2, 0.4],
    )
    expect(outside!.gate).toBeCloseTo(0, 5)
    expect(inside!.gate).toBeCloseTo(1, 5)
    expect(inside!.pitch).toBeCloseTo(noteToPitchCv(65), 5)
  })
})

describe('Keyboard/MIDI: computer keyboard, zones, and playing both together', () => {
  it('ignores a computer-keyboard note outside the zone, and still plays one inside it', async () => {
    const [outside, inside] = await renderKeyboard(
      0.9,
      [
        [
          0,
          (_kb, graph, id) => {
            graph.setParam(id, 'rangeLow', 60)
            graph.setParam(id, 'rangeHigh', 84)
            graph.setParam(id, 'octave', 3) // KeyA -> 48, below the zone
          },
        ],
        [0.1, (kb) => kb.handleKey('KeyA', true)],
        [0.3, (kb) => kb.handleKey('KeyA', false)],
        [0.4, (_kb, graph, id) => graph.setParam(id, 'octave', 4)], // KeyA -> 60, the zone's own low boundary
        [0.5, (kb) => kb.handleKey('KeyA', true)],
      ],
      [0.2, 0.7],
    )
    expect(outside!.gate).toBeCloseTo(0, 5)
    expect(inside!.gate).toBeCloseTo(1, 5)
    expect(inside!.pitch).toBeCloseTo(noteToPitchCv(60), 5)
  })

  it('works from the computer keyboard alone, needing nothing from handleMidiEvent -- the documented requestMidiAccess-returns-null case', async () => {
    const [sample] = await renderKeyboard(
      0.3,
      [
        [
          0.05,
          (kb, graph, id) => {
            graph.setParam(id, 'octave', 4)
            kb.handleKey('KeyA', true)
          },
        ],
      ],
      [0.15],
    )
    expect(sample!.gate).toBeCloseTo(1, 5)
    expect(sample!.pitch).toBeCloseTo(noteToPitchCv(60), 5)
  })

  it('a MIDI controller and the computer keyboard play together without one clobbering the other', async () => {
    const NOTE_KEY = 60 // KeyA at octave 4
    const NOTE_MIDI = 67
    const [both, afterMidiOff, afterKeyOff] = await renderKeyboard(
      1.0,
      [
        [0, (_kb, graph, id) => graph.setParam(id, 'octave', 4)],
        [0.1, (kb) => kb.handleKey('KeyA', true)],
        [0.3, (kb) => kb.handleMidiEvent({ kind: 'noteOn', note: NOTE_MIDI, velocity: 1 })],
        [0.5, (kb) => kb.handleMidiEvent({ kind: 'noteOff', note: NOTE_MIDI })],
        [0.7, (kb) => kb.handleKey('KeyA', false)],
      ],
      [0.4, 0.6, 0.8],
    )
    // The MIDI note came in later, without releasing the held key -- it wins.
    expect(both!.pitch).toBeCloseTo(noteToPitchCv(NOTE_MIDI), 5)
    expect(both!.gate).toBeCloseTo(1, 5)
    // Releasing the MIDI note falls back to the computer key's note, still
    // held -- proof the MIDI release did not clobber the key's own entry.
    expect(afterMidiOff!.pitch).toBeCloseTo(noteToPitchCv(NOTE_KEY), 5)
    expect(afterMidiOff!.gate).toBeCloseTo(1, 5)
    // Only once the key releases too does the gate finally close.
    expect(afterKeyOff!.gate).toBeCloseTo(0, 5)
  })
})
