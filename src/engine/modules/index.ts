import { registerModule } from '../registry'
import { vcoDescriptor } from './vco'
import { noiseDescriptor } from './noise'
import { vcfDescriptor } from './vcf'
import { vcaDescriptor } from './vca'
import { wavefolderDescriptor } from './wavefolder'
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

/** The Phase 1 module set. The UI's palette reads this and may filter it,
 *  which is how a Phase 4 level grants four modules and withholds the rest. */
export const ALL_DESCRIPTORS = [
  vcoDescriptor, noiseDescriptor,
  vcfDescriptor, vcaDescriptor, wavefolderDescriptor,
  adsrDescriptor, lfoDescriptor, shDescriptor,
  mixerDescriptor, multipleDescriptor, delayDescriptor,
  clockDescriptor, sequencerDescriptor, keyboardMidiDescriptor, outputDescriptor,
]

export function registerAllModules(): void {
  for (const d of ALL_DESCRIPTORS) registerModule(d)
}
