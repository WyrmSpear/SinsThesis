/**
 * Reflective wavefolder.
 *
 * Clipping flattens a peak; folding reflects it back down, so the waveform
 * gains inflection points instead of losing them. That is why a folded sine
 * grows a bright, metallic harmonic series while a clipped sine just gets
 * buzzy. Drive scales the signal into the folding region.
 */
export function foldSample(input: number, drive: number, symmetry = 0): number {
  let v = input * Math.max(drive, 0) + symmetry

  // Each pass reflects one excursion past the rails. Extreme drive needs
  // several; the bound keeps the loop finite in the audio thread.
  for (let i = 0; i < 32; i++) {
    if (v > 1) v = 2 - v
    else if (v < -1) v = -2 - v
    else break
  }
  return Math.min(Math.max(v, -1), 1)
}
