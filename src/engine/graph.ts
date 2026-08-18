import { getModule } from './registry'
import { createsCycle } from './cycle'
import type { ModuleInstance } from './types'

export interface Cable {
  readonly id: string
  /** [moduleId, portId] */
  readonly from: readonly [string, string]
  readonly to: readonly [string, string]
  /** True when this cable closes a loop and carries the 128-sample delay. */
  readonly delayed: boolean
  /** False when either end is a ghost, so no audio flows. */
  readonly active: boolean
}

interface GraphNode {
  type: string
  instance: ModuleInstance | null // null for ghosts
  params: Record<string, number>
  slot: [number, number]
}

/** WebAudio permits a cycle only through a DelayNode; one render quantum is
 *  the smallest delay that satisfies it. */
const FEEDBACK_DELAY_SECONDS = 128 / 48000

export class PatchGraph {
  private readonly nodes = new Map<string, GraphNode>()
  private readonly cableList: Cable[] = []
  private readonly delays = new Map<string, DelayNode>()
  // A3: every non-delayed cable gets its own pass-through GainNode between
  // source and destination, so `disconnect` can sever exactly the one
  // cable being removed. Without this, `outNode.disconnect(inNode)` (the
  // WebAudio API only offers node-pair granularity, not per-connection)
  // would tear out *every* cable between that pair -- reachable today
  // because all four `multiple` outputs are the same GainNode, so two
  // cables from one mult landing on the same input share an
  // (outNode, inNode) pair.
  private readonly passthroughs = new Map<string, GainNode>()
  private counter = 0

  constructor(private readonly ctx: BaseAudioContext) {}

  get moduleIds(): readonly string[] {
    return [...this.nodes.keys()]
  }

  get cables(): readonly Cable[] {
    return [...this.cableList]
  }

  addModule(type: string, id?: string): string {
    const descriptor = getModule(type)
    if (!descriptor) throw new Error(`addModule: unknown module type "${type}"`)

    const moduleId = id ?? `${type}-${++this.counter}`
    if (this.nodes.has(moduleId)) {
      throw new Error(`addModule: id "${moduleId}" is already in the patch`)
    }

    const instance = descriptor.create(this.ctx)
    const params: Record<string, number> = {}
    for (const p of descriptor.params) {
      params[p.id] = p.default
      instance.setParam(p.id, p.default)
    }

    this.nodes.set(moduleId, { type, instance, params, slot: [0, 0] })
    return moduleId
  }

  /**
   * Hold a module the registry does not know about, preserving its type and
   * params so the patch round-trips instead of losing data quietly.
   */
  addGhost(id: string, type: string, params: Record<string, number>): void {
    if (this.nodes.has(id)) {
      throw new Error(`addGhost: id "${id}" is already in the patch`)
    }
    this.nodes.set(id, { type, instance: null, params: { ...params }, slot: [0, 0] })
  }

  getInstance(id: string): ModuleInstance | undefined {
    return this.nodes.get(id)?.instance ?? undefined
  }

  getType(id: string): string | undefined {
    return this.nodes.get(id)?.type
  }

  getParams(id: string): Readonly<Record<string, number>> {
    const node = this.nodes.get(id)
    if (!node) throw new Error(`getParams: no module "${id}"`)
    return { ...node.params }
  }

  /**
   * @param atTime When given, schedules an exact change at that audio-clock
   *   time. When omitted -- the ordinary live-knob-turn case -- the module
   *   smoothly ramps to `value` instead of snapping to it (B3; see
   *   param-smoothing.ts). Either way `getParams` reflects the new target
   *   value immediately, not the value mid-ramp.
   */
  setParam(moduleId: string, paramId: string, value: number, atTime?: number): void {
    const node = this.nodes.get(moduleId)
    if (!node) throw new Error(`setParam: no module "${moduleId}"`)
    node.params[paramId] = value
    node.instance?.setParam(paramId, value, atTime)
  }

  getSlot(id: string): [number, number] {
    const node = this.nodes.get(id)
    if (!node) throw new Error(`getSlot: no module "${id}"`)
    return [...node.slot] as [number, number]
  }

  setSlot(id: string, slot: [number, number]): void {
    const node = this.nodes.get(id)
    if (!node) throw new Error(`setSlot: no module "${id}"`)
    node.slot = [...slot] as [number, number]
  }

  connect(from: readonly [string, string], to: readonly [string, string]): Cable {
    const [fromId, fromPort] = from
    const [toId, toPort] = to
    const source = this.nodes.get(fromId)
    const target = this.nodes.get(toId)
    if (!source) throw new Error(`connect: no module "${fromId}"`)
    if (!target) throw new Error(`connect: no module "${toId}"`)

    const active = source.instance !== null && target.instance !== null

    let outNode: AudioNode | undefined
    let inNode: AudioNode | AudioParam | undefined
    if (active) {
      outNode = source.instance!.outputs.get(fromPort)
      if (!outNode) throw new Error(`connect: "${source.type}" has no output port "${fromPort}"`)
      inNode = target.instance!.inputs.get(toPort)
      if (!inNode) throw new Error(`connect: "${target.type}" has no input port "${toPort}"`)
    }

    const edges = this.cableList.map((c) => [c.from[0], c.to[0]] as const)
    const delayed = createsCycle(edges, fromId, toId)

    const cable: Cable = {
      id: `cable-${++this.counter}`,
      from: [from[0], from[1]],
      to: [to[0], to[1]],
      delayed,
      active,
    }

    if (active) {
      if (delayed) {
        const delay = this.ctx.createDelay(1)
        delay.delayTime.value = FEEDBACK_DELAY_SECONDS
        this.delays.set(cable.id, delay)
        outNode!.connect(delay)
        delay.connect(inNode as AudioNode)
      } else {
        // A dedicated unity-gain passthrough per cable -- see the field
        // comment on `passthroughs` -- so this cable's connection can be
        // told apart from any sibling cable sharing the same node pair.
        const pass = this.ctx.createGain()
        pass.gain.value = 1
        this.passthroughs.set(cable.id, pass)
        outNode!.connect(pass)
        pass.connect(inNode as AudioNode)
      }
    }

    this.cableList.push(cable)
    return cable
  }

  disconnect(cableId: string): void {
    const index = this.cableList.findIndex((c) => c.id === cableId)
    if (index === -1) throw new Error(`disconnect: no cable "${cableId}"`)
    const cable = this.cableList[index]!

    if (cable.active) {
      const source = this.nodes.get(cable.from[0])
      const outNode = source?.instance?.outputs.get(cable.from[1])
      const delay = this.delays.get(cableId)
      const pass = this.passthroughs.get(cableId)
      // The delay/passthrough node is exclusive to this one cable, so a
      // bare `.disconnect()` (no argument -- disconnect all of its
      // outputs) is safe and removes the whole path in one step. Only the
      // link from `outNode` needs to name its target explicitly, since
      // `outNode` may be shared with other cables' own delay/passthrough
      // nodes (the `multiple` module's fan-out).
      if (delay) {
        outNode?.disconnect(delay)
        delay.disconnect()
        this.delays.delete(cableId)
      } else if (pass) {
        outNode?.disconnect(pass)
        pass.disconnect()
        this.passthroughs.delete(cableId)
      }
    }

    this.cableList.splice(index, 1)
  }

  removeModule(id: string): void {
    const node = this.nodes.get(id)
    if (!node) throw new Error(`removeModule: no module "${id}"`)

    for (const cable of [...this.cableList]) {
      if (cable.from[0] === id || cable.to[0] === id) this.disconnect(cable.id)
    }
    node.instance?.dispose()
    this.nodes.delete(id)
  }

  /**
   * Tear down every module in this graph. **Callers that construct a
   * `PatchGraph` must call this when they're done with it -- most of all
   * when a live session swaps in a new patch and discards the old graph.**
   * At least one module (the clock, `clock-module.ts`) owns a JS
   * `setInterval` timer that keeps its closure (and the `AudioContext`,
   * `ConstantSourceNode`s and settings it captures) alive independent of
   * whether anything still references the `PatchGraph` object itself --
   * dropping the reference alone does not stop the timer. Only this method
   * reaches every module's own `dispose()`, and the clock's `dispose()` is
   * where that timer actually gets `clearInterval`'d (final review, minor
   * finding alongside Finding 3). Nothing in `src/` calls this today
   * because there is no live UI yet to swap patches (Phase 1B); an offline
   * render never creates a clock timer in the first place (see
   * `clock-module.ts`'s doc comment), so the gap is silent until that UI
   * exists. Whoever builds it: call this on every patch swap, not only on
   * final teardown.
   */
  dispose(): void {
    for (const id of [...this.nodes.keys()]) this.removeModule(id)
  }
}
