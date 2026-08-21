/**
 * The toolbar's MIDI status readout -- lives next to the CPU meter for the
 * same reason that one does (`rack/cpu-meter-panel.ts`'s own doc comment):
 * the toolbar is the one piece of chrome visible in every mode, and this
 * exists specifically so a plugged-in controller's state is never a
 * silent unknown. `requestMidiAccess` returning `null` (no API, or the
 * player refused the permission prompt) is not an error -- see
 * `src/engine/midi.ts`'s own doc comment -- so this reads "MIDI
 * unavailable," not a scary failure banner, and the computer keyboard
 * keeps working either way.
 *
 * Three things this shows, all named in the task brief: which device (if
 * any) is connected, a device picker when more than one input exists, and
 * a lightweight blink so "messages are arriving" is never a silent
 * unknown -- a connection that may or may not be working is exactly the
 * failure mode to avoid.
 */

export type MidiStatusState =
  | { kind: 'unavailable' }
  | { kind: 'no-device' }
  | { kind: 'connected'; devices: readonly { id: string; name: string }[]; selectedId: string }

export interface MidiStatusHandlers {
  onSelectDevice(id: string): void
}

function readoutFor(state: MidiStatusState): string {
  if (state.kind === 'unavailable') return 'MIDI: unavailable'
  if (state.kind === 'no-device') return 'MIDI: no device'
  const name = state.devices.find((d) => d.id === state.selectedId)?.name ?? 'device'
  return `MIDI: ${name}`
}

/** Renders into `root` (index.html's `#midi-status`, inside the toolbar).
 *  Rebuilt on every state change (the same "declaratively rebuild the
 *  small thing" convention every other toolbar-adjacent panel in this rack
 *  already uses -- `renderStudioPanel`, `renderAcademyPanel`), since a
 *  device list changes rarely enough that a full rebuild costs nothing. */
export function renderMidiStatus(root: HTMLElement, state: MidiStatusState, handlers: MidiStatusHandlers): void {
  root.innerHTML = ''
  root.className = `midi-status midi-status-${state.kind}`
  root.dataset['testid'] = 'midi-status'

  const dot = document.createElement('span')
  dot.className = 'midi-status-dot'
  dot.dataset['testid'] = 'midi-status-dot'

  const readout = document.createElement('span')
  readout.className = 'midi-status-readout'
  readout.dataset['testid'] = 'midi-status-readout'
  readout.textContent = readoutFor(state)

  root.append(dot, readout)

  if (state.kind === 'connected' && state.devices.length > 1) {
    const select = document.createElement('select')
    select.className = 'midi-status-select'
    select.dataset['testid'] = 'midi-status-select'
    select.setAttribute('aria-label', 'MIDI input device')
    for (const d of state.devices) {
      const opt = document.createElement('option')
      opt.value = d.id
      opt.textContent = d.name
      opt.selected = d.id === state.selectedId
      select.append(opt)
    }
    select.addEventListener('change', () => handlers.onSelectDevice(select.value))
    root.append(select)
  }

  if (state.kind === 'unavailable') {
    root.title = 'No Web MIDI access -- the browser does not support it, or the permission prompt was refused. The computer keyboard still works.'
  } else if (state.kind === 'no-device') {
    root.title = 'MIDI is available, but no input device is plugged in yet. Connecting one is picked up automatically.'
  } else {
    root.title = `Listening to "${state.devices.find((d) => d.id === state.selectedId)?.name ?? ''}." Play a note or turn a bound knob to see activity.`
  }
}

/** Flashes the activity dot briefly -- called once per incoming MIDI
 *  message. A CSS class toggled on and back off after a short, fixed
 *  delay, not a persistent "last message" timestamp polled on a redraw
 *  loop, because a message can arrive many times a second (a hardware
 *  knob wiggled for MIDI learn) and a fixed-duration flash reads as
 *  "alive" without needing to re-render on every single one. */
export function flashMidiActivity(root: HTMLElement): void {
  const dot = root.querySelector<HTMLElement>('.midi-status-dot')
  if (!dot) return
  dot.classList.remove('midi-status-dot-flash')
  // Force a reflow so re-adding the class restarts the CSS animation even
  // when messages arrive faster than the animation's own duration.
  void dot.offsetWidth
  dot.classList.add('midi-status-dot-flash')
}
