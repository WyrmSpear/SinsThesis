import type {
  ModuleDescriptor, ModuleInstance, PortSpec, ParamSpec,
} from '../../src/engine/types'

/** Records connect and disconnect calls so graph tests can assert on wiring. */
export interface StubNode {
  connections: unknown[]
  connect(target: unknown): void
  disconnect(target?: unknown): void
}

export function stubNode(): StubNode {
  const node: StubNode = {
    connections: [],
    connect(target) {
      node.connections.push(target)
    },
    disconnect(target) {
      if (target === undefined) node.connections.length = 0
      else node.connections = node.connections.filter((c) => c !== target)
    },
  }
  return node
}

/** Minimal stand-in for an AudioParam: tracks `.value` and accepts the same
 *  scheduling calls param-smoothing.ts's `scheduleParam` makes (B3), so a
 *  real module's `setParam` -- which now calls `setTargetAtTime` or
 *  `setValueAtTime` instead of assigning `.value` directly -- can run
 *  against the stub without every test needing to know that. Timing is not
 *  modeled: these tests check wiring and immediate values, not ramps. */
function stubParam(initial = 0): { value: number; setTargetAtTime: (v: number) => void; setValueAtTime: (v: number) => void } {
  const param = {
    value: initial,
    setTargetAtTime(v: number) { param.value = v },
    setValueAtTime(v: number) { param.value = v },
  }
  return param
}

/** Minimal stand-in for BaseAudioContext. Only what the graph actually calls. */
export function stubContext(): BaseAudioContext {
  return {
    sampleRate: 48000,
    currentTime: 0,
    // The graph sets delayTime.value on the node it inserts for feedback
    // cables, so the stub has to carry one.
    createDelay: () => Object.assign(stubNode(), { delayTime: stubParam() }) as unknown as DelayNode,
    // A3: every non-delayed cable gets its own pass-through gain node, so
    // it can be disconnected without severing a sibling cable that happens
    // to share the same (outNode, inNode) endpoint pair.
    createGain: () => Object.assign(stubNode(), { gain: stubParam() }) as unknown as GainNode,
  } as unknown as BaseAudioContext
}

export function stubDescriptor(
  type: string,
  opts: { ports?: PortSpec[]; params?: ParamSpec[] } = {},
): ModuleDescriptor {
  const ports: PortSpec[] = opts.ports ?? [
    { id: 'in', dir: 'in', signal: 'audio', label: 'In', pos: [0, 0] },
    { id: 'out', dir: 'out', signal: 'audio', label: 'Out', pos: [0, 1] },
  ]
  const params: ParamSpec[] = opts.params ?? [
    { id: 'level', label: 'Level', min: 0, max: 1, default: 0.5, curve: 'lin', unit: '' },
  ]
  return {
    type,
    name: type.toUpperCase(),
    hp: 8,
    ports,
    params,
    layout: [],
    create(): ModuleInstance {
      const values = new Map<string, number>()
      const inputs = new Map<string, AudioNode | AudioParam>()
      const outputs = new Map<string, AudioNode>()
      for (const p of ports) {
        const node = stubNode() as unknown as AudioNode
        if (p.dir === 'in') inputs.set(p.id, node)
        else outputs.set(p.id, node)
      }
      return {
        inputs,
        outputs,
        setParam: (id, value) => values.set(id, value),
        dispose: () => values.clear(),
        // Exposed for assertions; not part of the interface.
        ...({ __values: values } as object),
      } as ModuleInstance
    },
  }
}
