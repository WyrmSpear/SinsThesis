/**
 * Global module registry, validated at registration time rather than at use
 * time. Fifteen modules each define their descriptor once at startup; a typo
 * in a port id or a default outside its own range should fail loudly right
 * there, not silently corrupt a patch loaded three screens later.
 */
import type { ModuleDescriptor } from './types'

const descriptors = new Map<string, ModuleDescriptor>()

function validate(d: ModuleDescriptor): void {
  if (descriptors.has(d.type)) {
    throw new Error(`registerModule: type "${d.type}" is already registered`)
  }

  const portIds = new Set<string>()
  for (const p of d.ports) {
    if (portIds.has(p.id)) {
      throw new Error(`registerModule: "${d.type}" has a duplicate port id "${p.id}"`)
    }
    portIds.add(p.id)
  }

  const paramIds = new Set<string>()
  for (const p of d.params) {
    if (paramIds.has(p.id)) {
      throw new Error(`registerModule: "${d.type}" has a duplicate param id "${p.id}"`)
    }
    paramIds.add(p.id)
    if (p.default < p.min || p.default > p.max) {
      throw new Error(
        `registerModule: "${d.type}" param "${p.id}" default ${p.default} ` +
          `falls outside [${p.min}, ${p.max}]`,
      )
    }
  }

  for (const item of d.layout) {
    if (!portIds.has(item.ref) && !paramIds.has(item.ref)) {
      throw new Error(
        `registerModule: "${d.type}" layout has an unknown reference "${item.ref}"`,
      )
    }
  }
}

export function registerModule(d: ModuleDescriptor): void {
  validate(d)
  descriptors.set(d.type, d)
}

export function getModule(type: string): ModuleDescriptor | undefined {
  return descriptors.get(type)
}

export function listModules(): ModuleDescriptor[] {
  return [...descriptors.values()]
}

/** Test-only. Production code registers once at startup. */
export function clearRegistry(): void {
  descriptors.clear()
}
