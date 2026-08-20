import { registerModule } from '../registry'
import { vcoDescriptor } from './vco'
import { noiseDescriptor } from './noise'
import { vcfDescriptor } from './vcf'
import { svfDescriptor } from './svf'
import { vcaDescriptor } from './vca'
import { wavefolderDescriptor } from './wavefolder'
import { driveDescriptor } from './drive'
import { adsrDescriptor } from './adsr'
import { lfoDescriptor } from './lfo'
import { shDescriptor } from './sh'
import { mixerDescriptor } from './mixer'
import { multipleDescriptor } from './multiple'
import { delayDescriptor } from './delay'
import { clockDescriptor } from './clock-module'
import { sequencerDescriptor } from './sequencer'
import { keyboardMidiDescriptor } from './keyboard-midi'
import { outputDescriptor } from './output'
import { scopeDescriptor } from './scope'

/** The Phase 1 module set, plus Phase 2's scope, the state-variable filter
 *  (the roadmap's "biggest gap" -- see docs/ROADMAP.md section 1 and
 *  svf.ts's own doc comment for why a second filter *topology*, not a mode
 *  switch on the ladder), and Drive (a plain saturation stage -- distinct
 *  from the ladder's internal tanh and the wavefolder's fold, see
 *  drive.ts's own doc comment). The UI's palette reads this and may filter
 *  it, which is how a Phase 4 level grants four modules and withholds the
 *  rest. */
export const ALL_DESCRIPTORS = [
  vcoDescriptor, noiseDescriptor,
  vcfDescriptor, svfDescriptor, vcaDescriptor, wavefolderDescriptor, driveDescriptor,
  adsrDescriptor, lfoDescriptor, shDescriptor,
  mixerDescriptor, multipleDescriptor, delayDescriptor,
  clockDescriptor, sequencerDescriptor, keyboardMidiDescriptor, outputDescriptor,
  scopeDescriptor,
]

export function registerAllModules(): void {
  for (const d of ALL_DESCRIPTORS) registerModule(d)
}
