/**
 * Bilinear-prewarped per-pole gain shared by every zero-delay-feedback (TPT)
 * filter in this codebase: `ladder.ts`'s four cascaded one-poles and
 * `svf.ts`'s two-integrator loop both need exactly this number, computed
 * exactly this way, and disagreeing between them would mean the two
 * filters' cutoff knobs quietly meant different things.
 *
 * Prewarping keeps the *digital* cutoff honest against the *analog*
 * topology being modeled: the bilinear transform warps frequency
 * nonlinearly, and without correcting for it a digital one-pole's corner
 * drifts sharp as cutoff climbs toward Nyquist. `g = tan(pi*fc/fs)` is the
 * standard correction (Vadim Zavalishin's TPT derivation) -- both filters'
 * prior, inlined versions of this line were already bit-identical modulo
 * floating-point associativity, which is what made this extraction safe
 * rather than a guess at a shared abstraction.
 */
export function prewarp(cutoffHz: number, sampleRate: number): { g: number; fc: number } {
  const nyquist = sampleRate * 0.5
  // Never below 10 Hz (audio-rate math misbehaves near DC) and never
  // within 1% of Nyquist (tan() diverges as its argument approaches pi/2).
  const fc = Math.min(Math.max(cutoffHz, 10), nyquist * 0.99)
  const g = Math.tan((Math.PI * fc) / sampleRate)
  return { g, fc }
}
