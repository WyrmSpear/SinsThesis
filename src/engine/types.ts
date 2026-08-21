/** Ports declare a type for cable color and for the co-pilot to reason about;
 *  the engine still permits any port to reach any port, because voltage is
 *  voltage. Patching audio into a cutoff is a technique, not a mistake. */
export type SignalType = 'audio' | 'cv' | 'gate'

export type PortDir = 'in' | 'out'

export interface PortSpec {
  id: string
  dir: PortDir
  signal: SignalType
  label: string
  /** Grid position on the panel, in panel units. */
  pos: [number, number]
}

export interface ParamSpec {
  id: string
  label: string
  min: number
  max: number
  default: number
  /** `exp` for anything the ear hears logarithmically: frequency, time. */
  curve: 'lin' | 'exp'
  unit: string
  /** Discrete positions rather than a continuous range. The UI should draw a
   *  switch, and the engine snaps rather than smooths. Length must equal
   *  (max - min + 1) when present. */
  labels?: readonly string[]
}

/** The five palette sections the rack groups modules into. A closed set
 *  (not a free string) so every descriptor's `group` sorts into the same
 *  bucket a human would expect, rather than each module author inventing
 *  its own label and the palette silently growing a sixth column. */
export const MODULE_GROUPS = ['source', 'shaping', 'modulation', 'utility', 'control'] as const
export type ModuleGroup = (typeof MODULE_GROUPS)[number]

export interface LayoutItem {
  kind: 'knob' | 'jack' | 'switch' | 'button' | 'display'
  /** A port id or a param id. */
  ref: string
  x: number
  y: number
}

/**
 * Everything the UI needs to draw a module and everything the engine needs to
 * build one. One generic renderer reads this, which is why thirty modules
 * across eight themes do not become 240 hand-maintained panels.
 */
export interface ModuleDescriptor {
  type: string
  name: string
  /** Panel width in horizontal pitch units, as in a physical rack. */
  hp: number
  /** Which palette section this module sorts into. Optional so a
   *  hand-rolled test descriptor need not classify itself; every shipped
   *  module in `src/engine/modules/` sets one. */
  group?: ModuleGroup
  ports: PortSpec[]
  params: ParamSpec[]
  layout: LayoutItem[]
  /** Escape hatch for modules that genuinely need bespoke UI. */
  customPanel?: string
  create(ctx: BaseAudioContext): ModuleInstance
}

/**
 * The seam that makes the planned monolithic-worklet engine real. Today an
 * instance wraps native nodes and worklets; later one can wrap a message port
 * into a single DSP worklet, one module at a time, with no change to panels,
 * themes, or patch files.
 */
export interface ModuleInstance {
  inputs: Map<string, AudioNode | AudioParam>
  outputs: Map<string, AudioNode>
  setParam(id: string, value: number, atTime?: number): void
  dispose(): void
  /**
   * Escape hatch for state a module needs to persist that isn't a plain
   * number `ParamSpec` can carry -- the Sampler's loaded audio is the
   * motivating case (see `modules/sampler.ts`'s own doc comment for the
   * full reasoning): `.sinp` is otherwise exactly `{params, cables}`, and
   * every existing module's entire state already fits `Record<string,
   * number>`. Adding a second, JSON-serializable channel here -- rather
   * than stretching `ParamSpec`'s numeric contract to also carry strings
   * or binary data -- keeps every other module's file shape untouched
   * (this is optional; a module that never defines it never gains an
   * empty `state` key in its saved entry) while giving `patch.ts` a
   * generic place to round-trip whatever a future stateful module needs,
   * without either module or engine caring what the payload means.
   * `serializeState` returning `undefined` means "nothing to save," not
   * "save undefined" -- `patch.ts` omits the field entirely in that case.
   */
  serializeState?(): unknown
  /**
   * Present only when this instance is not running the module's real
   * worklet DSP -- absent (not `undefined`-valued, actually omitted) is
   * the overwhelmingly common case and means "running normally." Set by a
   * descriptor's own `create()` when `worklets/registry.ts`'s
   * `workletAvailable()` read `false` for the processor this module needs
   * (see `docs/superpowers/specs/2026-08-18-sinsthesis-phase1-design.md`
   * section 11's "worklet fails to load" failure mode, and
   * `.superpowers/sdd/robustness-report.md` for which modules land in
   * which bucket and why):
   *
   * - `'degraded'` -- a native Web Audio node stands in for the worklet.
   *   It is a genuinely different signal path (an `OscillatorNode`
   *   aliasing where a wavetable wouldn't, a `BiquadFilterNode` in place
   *   of a four-pole ladder, ...), not a hidden compromise -- `reason`
   *   says what changed in a sentence a player can act on.
   * - `'failed'` -- no honest native equivalent exists for this module
   *   (the segment-based envelope/LFO/S&H/sequencer family, and the
   *   bitcrusher's deliberately-unfiltered aliasing) or none was built;
   *   this instance is a silent structural stub -- its ports exist so
   *   cabling and patch save/load don't break, but no signal passes
   *   through it -- rather than a fabricated approximation that would
   *   behave differently in a way nothing tells the player about.
   *
   * `rack/panel.ts` reads this to draw the badge every module -- degraded
   * or failed -- must show rather than failing silently; nothing in
   * `src/engine/**` itself renders anything from it.
   */
  fallback?: { level: 'degraded' | 'failed'; reason: string }
  /** Called after `setParam` has applied every saved param, with exactly
   *  what this instance's own `serializeState` last returned (or, loading
   *  a file saved by a different build, whatever shape *that* build's
   *  `serializeState` produced -- so implementations should validate
   *  rather than trust the shape blindly). Never called when the entry
   *  carried no `state` field. */
  restoreState?(data: unknown): void
}
