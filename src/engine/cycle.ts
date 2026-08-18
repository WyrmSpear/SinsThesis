/**
 * Feedback detection for the patch graph.
 *
 * WebAudio permits a graph cycle only through a DelayNode. Rather than hiding
 * that, the engine detects the loop on connect, inserts the required delay,
 * and marks the cable so the operator can see which cable costs them 2.7 ms.
 */

/**
 * Would adding `from -> to` close a loop?
 *
 * True when `to` already reaches `from`, or when the edge is a self-connection.
 */
export function createsCycle(
  edges: ReadonlyArray<readonly [string, string]>,
  from: string,
  to: string,
): boolean {
  if (from === to) return true

  const adjacency = new Map<string, string[]>()
  for (const [src, dst] of edges) {
    const list = adjacency.get(src)
    if (list) list.push(dst)
    else adjacency.set(src, [dst])
  }

  // Depth-first search from `to`, looking for `from`.
  const seen = new Set<string>()
  const stack = [to]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node === from) return true
    if (seen.has(node)) continue
    seen.add(node)
    const next = adjacency.get(node)
    if (next) stack.push(...next)
  }
  return false
}
