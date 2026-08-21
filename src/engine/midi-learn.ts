import type { ParamSpec } from './types'
import { getModule } from './registry'
import type { PatchGraph } from './graph'

/**
 * MIDI learn: bind a hardware CC controller to a live parameter. This file
 * is the engine half -- mapping math and the binding table itself -- kept
 * free of any UI import per `tests/node/boundaries.test.ts`. `rack/`
 * supplies the gesture (right-click a knob, choose "MIDI Learn") and the
 * badge/menu that shows a binding exists; this file supplies what a
 * binding *means* and how an incoming CC message turns into a param value.
 *
 * **Where a binding lives.** `MidiBinding` is designed to be embedded in a
 * `.sinp` (see `patch.ts`'s `PatchFile.midiBindings`), not kept in
 * `localStorage` as a player-wide "rig" setting. Two things pushed that
 * way:
 *
 * 1. A binding only makes sense addressed to one *instance* of a module
 *    (`moduleId`), not a module *type* -- a patch with two VCFs needs to
 *    say which one a knob controls, and this app has no "focused module"
 *    concept that would let a rig-level binding resolve that ambiguity.
 *    Module ids are already patch-scoped (`rack/main.ts`'s `freshId`
 *    assigns them fresh per session), so a binding keyed by `moduleId` is
 *    naturally patch-scoped too.
 * 2. This app's whole persistence model treats a `.sinp` as the complete,
 *    portable description of a sound -- modules, params, cables, and (for
 *    the Sampler) even embedded audio all travel in the one file. A CC
 *    binding is "how this patch is played," which fits that model better
 *    than a separate global settings blob.
 *
 * The real cost of this choice: a patch shared with someone whose
 * controller sends different CC numbers for the same physical knobs will
 * have wrong (or silently absent) bindings. That is accepted deliberately
 * rather than solved -- re-learning a binding is a two-second gesture
 * (right-click, wiggle the knob you actually want), and every binding is
 * visibly labeled with its CC number on the knob itself
 * (`rack/knob-midi.ts`), so a mismatch is discoverable the instant you look
 * at the panel, not a silent trap. Device *selection* (which physical MIDI
 * input to listen to) is the opposite case -- genuinely a property of the
 * player's own hardware, not the patch -- and is kept in `localStorage`
 * instead (`rack/main.ts`).
 */
export interface MidiBinding {
  /** MIDI CC controller number, 0-127. */
  controller: number
  moduleId: string
  paramId: string
}

/**
 * Maps a CC's already-normalized [0, 1] reading (`MidiEvent.value` from
 * `parseMidiMessage` in `midi.ts`, i.e. `ccByte / 127`) onto a param's real
 * range, honoring `curve` -- the identical formula `rack/curve.ts`'s
 * `fromNormalized` uses for an on-screen knob, duplicated rather than
 * imported (that file lives outside `src/engine/**`, and this module must
 * not import across that boundary -- the same reasoning `rack/curve.ts`'s
 * own header comment gives for keeping its copy separate from
 * `dev/controls.ts`'s). Without going through the same curve an
 * exponential parameter (e.g. a cutoff) would feel linear from a hardware
 * knob while still feeling logarithmic from the mouse -- two different
 * instruments wired to the same jack.
 *
 * Two edge values worth knowing when reasoning about test numbers: a raw
 * CC byte of 127 (the maximum a 7-bit controller can send) normalizes to
 * exactly 1.0 and lands exactly on `spec.max`; a raw CC byte of 64 (the
 * "center" position on most hardware) normalizes to 64/127 ≈ 0.5039, not
 * exactly the midpoint, because MIDI's CC range is 128 values wide (0-127)
 * with no exact center.
 */
export function ccToParamValue(normalizedValue: number, spec: Pick<ParamSpec, 'min' | 'max' | 'curve'>): number {
  const t = Math.min(1, Math.max(0, normalizedValue))
  const { min, max, curve } = spec
  if (curve === 'exp') {
    const lo = Math.max(min, 1e-9)
    return lo * Math.pow(max / lo, t)
  }
  return min + t * (max - min)
}

/**
 * Holds the current CC-to-param bindings for one patch and the "armed"
 * state a right-click's "MIDI Learn" choice puts a knob into. One
 * instance per mounted graph (`rack/main.ts` rebuilds it, from the loaded
 * patch's own bindings, on every `mountGraph` the same way `cableLayer` is
 * rebuilt) -- a binding names a `moduleId`, which is only meaningful
 * against the graph it was created in.
 */
export class MidiLearnController {
  private bindings: MidiBinding[]
  private armed: { moduleId: string; paramId: string } | undefined

  constructor(initial: readonly MidiBinding[] = []) {
    this.bindings = initial.map((b) => ({ ...b }))
  }

  /** A defensive copy -- see `patch.ts`'s `serializePatch`, the only
   *  caller that needs the whole list, and `getExtraState`'s identical
   *  convention for why callers never get a live reference to hand back
   *  out. */
  get all(): readonly MidiBinding[] {
    return this.bindings.map((b) => ({ ...b }))
  }

  bindingFor(moduleId: string, paramId: string): MidiBinding | undefined {
    const found = this.bindings.find((b) => b.moduleId === moduleId && b.paramId === paramId)
    return found ? { ...found } : undefined
  }

  /** Arms `moduleId`/`paramId` as the target of the next incoming CC
   *  message. Arming a second target silently replaces the first --
   *  there is only ever one pending "listening" knob at a time, mirroring
   *  how only one cable inspector or one drag can be active at once
   *  elsewhere in this rack. */
  arm(moduleId: string, paramId: string): void {
    this.armed = { moduleId, paramId }
  }

  disarm(): void {
    this.armed = undefined
  }

  isArmed(moduleId: string, paramId: string): boolean {
    return this.armed?.moduleId === moduleId && this.armed?.paramId === paramId
  }

  get armedTarget(): { moduleId: string; paramId: string } | undefined {
    return this.armed ? { ...this.armed } : undefined
  }

  unbind(moduleId: string, paramId: string): void {
    this.bindings = this.bindings.filter((b) => !(b.moduleId === moduleId && b.paramId === paramId))
  }

  /** Drops every binding addressed to `moduleId` -- called when a module
   *  is removed from the patch, so a stale binding never lingers pointing
   *  at nothing. */
  unbindModule(moduleId: string): void {
    this.bindings = this.bindings.filter((b) => b.moduleId !== moduleId)
  }

  /**
   * Routes one incoming CC message (controller number and its already-
   * normalized [0, 1] value, i.e. a `MidiEvent` of `kind: 'cc'`).
   *
   * If a target is armed, this message completes the binding: any existing
   * binding sharing this controller (so one hardware knob drives only one
   * param) or this exact target (so one param is driven by only one
   * controller) is replaced, the new binding is recorded, the target is
   * disarmed, and the value that arrived is applied immediately -- the
   * knob should visibly respond to the very wiggle that bound it, not sit
   * at its old value until the next message.
   *
   * Otherwise, the message is applied to every binding matching this
   * controller (ordinarily zero or one, but nothing stops a player
   * binding the same physical knob to two different params). `graph`'s
   * own `setParam` is called with no `atTime`, the identical live-turn
   * path an on-screen knob drag already uses -- see `param-smoothing.ts` --
   * so a hardware knob glides through the same `PARAM_SMOOTH_TIME_CONSTANT`
   * ramp an on-screen one does, rather than stepping.
   *
   * Returns the bindings this call touched (created or applied to), so a
   * caller (`rack/main.ts`) knows which on-screen knobs to refresh without
   * re-reading the whole list.
   */
  handleCc(graph: PatchGraph, controller: number, normalizedValue: number): MidiBinding[] {
    if (this.armed) {
      const { moduleId, paramId } = this.armed
      this.bindings = this.bindings.filter(
        (b) => b.controller !== controller && !(b.moduleId === moduleId && b.paramId === paramId),
      )
      const binding: MidiBinding = { controller, moduleId, paramId }
      this.bindings.push(binding)
      this.armed = undefined

      const spec = paramSpecFor(graph, moduleId, paramId)
      if (spec) graph.setParam(moduleId, paramId, ccToParamValue(normalizedValue, spec))
      return [binding]
    }

    const touched: MidiBinding[] = []
    for (const b of this.bindings) {
      if (b.controller !== controller) continue
      const spec = paramSpecFor(graph, b.moduleId, b.paramId)
      if (!spec) continue
      graph.setParam(b.moduleId, b.paramId, ccToParamValue(normalizedValue, spec))
      touched.push({ ...b })
    }
    return touched
  }
}

function paramSpecFor(graph: PatchGraph, moduleId: string, paramId: string): ParamSpec | undefined {
  const type = graph.getType(moduleId)
  if (!type) return undefined
  return getModule(type)?.params.find((p) => p.id === paramId)
}
