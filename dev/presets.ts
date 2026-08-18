/** Two patches that demonstrate the engine rather than a blank rack: a
 *  filter-forward bass and a brighter, wavefolder-textured lead. Both stay
 *  inside the six modules the dev harness patches; nothing here reaches
 *  into modules the page doesn't build. */
export interface Preset {
  name: string
  vco: { shape: number; octave: number; tune: number; pulseWidth: number }
  vcf: { cutoff: number; resonance: number; drive: number }
  adsr: { attack: number; decay: number; sustain: number; release: number }
  wavefolder: { enabled: boolean; drive: number }
  lfo: { enabled: boolean; rate: number; depth: number }
  masterLevel: number
}

export const BASS_PRESET: Preset = {
  name: 'Bass',
  vco: { shape: 0, octave: -2, tune: 0, pulseWidth: 0.5 },
  vcf: { cutoff: 320, resonance: 0.35, drive: 1.5 },
  adsr: { attack: 0.004, decay: 0.28, sustain: 0.5, release: 0.18 },
  wavefolder: { enabled: false, drive: 1 },
  lfo: { enabled: false, rate: 4, depth: 0.3 },
  masterLevel: 0.85,
}

export const LEAD_PRESET: Preset = {
  name: 'Lead',
  vco: { shape: 1, octave: 0, tune: 0, pulseWidth: 0.35 },
  vcf: { cutoff: 2400, resonance: 0.55, drive: 2 },
  adsr: { attack: 0.008, decay: 0.15, sustain: 0.72, release: 0.35 },
  wavefolder: { enabled: true, drive: 3.5 },
  lfo: { enabled: true, rate: 5, depth: 0.35 },
  masterLevel: 0.8,
}
