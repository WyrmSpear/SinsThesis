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
}
