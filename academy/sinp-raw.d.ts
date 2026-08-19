/**
 * `academy/levels.ts` imports each level's solution `.sinp` with Vite's
 * `?raw` suffix (a plain string of the file's contents, parsed with
 * `JSON.parse` rather than relying on bundler JSON-extension sniffing --
 * see that file's comment). `tsc` has no built-in knowledge of Vite's
 * import-suffix conventions the way `vite/client`'s ambient types do for a
 * full Vite app; this project never pulled in `vite/client` globally
 * (`tsconfig.json`'s `types` is `["vitest/globals", "node"]` only), so this
 * one-off declaration covers the single suffix this project actually uses.
 */
declare module '*.sinp?raw' {
  const raw: string
  export default raw
}
