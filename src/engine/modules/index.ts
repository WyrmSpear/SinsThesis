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
import { pannerDescriptor } from './panner'
import { pingpongDescriptor } from './pingpong'
import { widthDescriptor } from './width'
import { samplerDescriptor } from './sampler'

/** The Phase 1 module set, plus Phase 2's scope, the state-variable filter
 *  (the roadmap's "biggest gap" -- see docs/ROADMAP.md section 1 and
 *  svf.ts's own doc comment for why a second filter *topology*, not a mode
 *  switch on the ladder), Drive (a plain saturation stage -- distinct
 *  from the ladder's internal tanh and the wavefolder's fold, see
 *  drive.ts's own doc comment), the three stereo modules ROADMAP
 *  section 1a calls for -- Panner, Ping-Pong Delay and Width -- and the
 *  Sampler (the missing primitive the researched history track needed to
 *  reach the sampling era at all -- Mellotron, Fairlight, hip-hop and
 *  jungle -- see sampler.ts's own doc comment). The other twenty modules
 *  stay mono end to end, deliberately (see ROADMAP section 1a's "do not
 *  make everything stereo" ruling); stereo appears only at Panner/
 *  Ping-Pong/Width plus output.ts's now channel-count-aware `in` jack. The
 *  UI's palette reads this and may filter it, which is how a Phase 4 level
 *  grants four modules and withholds the rest. */
export const ALL_DESCRIPTORS = [
  vcoDescriptor, noiseDescriptor, samplerDescriptor,
  vcfDescriptor, svfDescriptor, vcaDescriptor, wavefolderDescriptor, driveDescriptor,
  adsrDescriptor, lfoDescriptor, shDescriptor,
  mixerDescriptor, multipleDescriptor, delayDescriptor, pingpongDescriptor,
  clockDescriptor, sequencerDescriptor, keyboardMidiDescriptor, outputDescriptor,
  scopeDescriptor, pannerDescriptor, widthDescriptor,
]

export function registerAllModules(): void {
  for (const d of ALL_DESCRIPTORS) registerModule(d)
}
