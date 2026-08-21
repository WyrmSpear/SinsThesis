import type { OutputInstance } from '../src/engine/modules/output'
import { rms, spectralCentroid } from '../src/engine/analysis/features'
import { createGame, stepWub, defaultConfig, type WubState } from '../arcade/wub-game'
import { detectRateHz, LOCK_CONFIDENCE, type RateEstimate } from '../arcade/rate-detect'
import type { ArcadeHandle } from './arcade-panel'

/**
 * Wub Disruptor -- ROADMAP 3a's second arcade prototype: destroy targets by
 * matching their required modulation rate, communicated by how fast they
 * pulse. Same skeleton `rack/arcade-panel.ts` established for the pan
 * paddle (a parallel analyser tap, a `requestAnimationFrame` loop, pure
 * game logic kept in `arcade/` and driven from here) -- this file is the
 * proof that skeleton generalises to a second game, not a rewrite of it.
 *
 * **What drives a target's charge, and why.** Not any knob or CV value
 * read directly -- the *actual measured modulation rate of whatever the
 * rack's Output module is emitting*, via `arcade/rate-detect.ts`'s
 * autocorrelation over a rolling window of per-frame feature readings.
 * Two features are tracked in parallel, RMS level and spectral centroid
 * (`readFeatures` below), and whichever locks on with higher confidence
 * wins each frame -- the same "any means" principle `rack/arcade-panel.ts`'s
 * `readBalance` established for the paddle: a filter-cutoff LFO (the
 * technique this game is built to teach, and the preset bank's own
 * "Tempo-Locked Wobble" entry) drives centroid; a tremolo-style amplitude
 * LFO drives level; either is rewarded.
 *
 * **The tap runs in parallel, never in series** -- same non-negotiable,
 * same mechanism as `rack/arcade-panel.ts`'s own tap: an *additional*
 * outgoing edge off the Output module's own internal node, already
 * connected to `ctx.destination` elsewhere. `buildFeatureTap` explicitly
 * sets `channelCount: 1` / `channelCountMode: 'explicit'` /
 * `channelInterpretation: 'speakers'` on the analyser itself so a stereo
 * source is properly down-mixed into the single-channel reading this
 * module measures -- the exact bug class `rack/arcade-panel.ts`'s own
 * `buildTap` had to fix for the splitter it uses, applied here
 * pre-emptively rather than found live a second time.
 *
 * **Why the detector needs a window, and what that does to pacing.**
 * `arcade/rate-detect.ts` needs at least a couple of cycles of history
 * before it can report anything -- a physical fact about measuring a slow
 * wobble, not a limitation of this implementation. `FEATURE_CAPACITY`
 * below (260 frames, ~4.3s at a healthy 60fps) is sized for the slowest
 * target this game spawns (`arcade/wub-game.ts`'s `requiredRatesHz[0]`,
 * 1 Hz, whose own period is a full second) with real margin, and
 * `arcade/wub-game.ts`'s own `targetLifetimeMs` is paced around that same
 * fact rather than fighting it -- see that file's header comment.
 */

const CANVAS_WIDTH = 420
const CANVAS_HEIGHT = 420

/** One time-domain window per frame, big enough to give `spectralCentroid`
 *  reasonable frequency resolution (46.9 Hz bins at 48kHz) without costing
 *  more than the scope module's own per-frame FFT already proves
 *  affordable at 60fps (`rack/scope-panel.ts`). */
const FEATURE_FFT_SIZE = 1024

/** ~4.3s of history at a healthy 60fps rAF rate -- see this file's header
 *  comment for why that has to cover the slowest target's own period with
 *  margin, not just "a couple of frames." */
const FEATURE_CAPACITY = 260

export interface FeatureTap {
  readonly instance: OutputInstance
  readonly analyser: AnalyserNode
  readonly buf: Float32Array<ArrayBuffer>
}

/**
 * A single-channel analyser tap off `instance`'s own output node, matching
 * the "the CV a player is asked to hit is a property of the *whole* mixed
 * signal" design this game relies on (see `arcade/wub-game.ts`'s header
 * comment on why only one target is ever active). `channelCount: 1` /
 * `'explicit'` / `'speakers'` explicitly down-mixes a stereo source into
 * one channel before analysis, rather than trusting the analyser's default
 * `channelCountMode: 'max'` to do something equivalent -- see this file's
 * own header comment for the bug class this avoids repeating.
 */
export function buildFeatureTap(ctx: AudioContext, instance: OutputInstance): FeatureTap | undefined {
  const source = instance.outputs.get('out')
  if (!source) return undefined
  const analyser = ctx.createAnalyser()
  analyser.channelCount = 1
  analyser.channelCountMode = 'explicit'
  analyser.channelInterpretation = 'speakers'
  analyser.fftSize = FEATURE_FFT_SIZE
  source.connect(analyser)
  return { instance, analyser, buf: new Float32Array(FEATURE_FFT_SIZE) }
}

export function disposeFeatureTap(tap: FeatureTap): void {
  tap.analyser.disconnect()
}

/** One RMS reading and one spectral-centroid reading off the tap's current
 *  time-domain window -- reused as-is from `src/engine/analysis/features.ts`
 *  rather than duplicated; the whole point of that module existing (per its
 *  own history, see docs/CONTINUATION.md) is serving exactly this kind of
 *  third consumer with no changes needed. */
export function readFeatures(tap: FeatureTap, sampleRate: number): { level: number; centroid: number } {
  tap.analyser.getFloatTimeDomainData(tap.buf)
  return { level: rms(tap.buf), centroid: spectralCentroid(tap.buf, sampleRate) }
}

/** A fixed-capacity rolling window of (value, timestamp) pairs -- the
 *  per-frame feature history `arcade/rate-detect.ts` runs autocorrelation
 *  over. Timestamps (not just a sample count) are kept so the effective
 *  frame rate handed to `detectRateHz` reflects rAF's *actual* average
 *  cadence rather than assuming a perfect 60fps that a busy tab won't
 *  always deliver. */
class RollingWindow {
  private values: number[] = []
  private times: number[] = []
  constructor(private readonly capacity: number) {}

  push(value: number, timeSec: number): void {
    this.values.push(value)
    this.times.push(timeSec)
    if (this.values.length > this.capacity) {
      this.values.shift()
      this.times.shift()
    }
  }

  /** `undefined` until there's enough history to say anything about an
   *  average frame rate at all. */
  detect(): RateEstimate | undefined {
    if (this.values.length < 2) return undefined
    const span = this.times[this.times.length - 1]! - this.times[0]!
    if (span <= 0) return undefined
    const sampleRateHz = (this.values.length - 1) / span
    return detectRateHz(Float32Array.from(this.values), sampleRateHz)
  }
}

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function livesGlyphs(lives: number, livesStart: number): string {
  return '●'.repeat(Math.max(0, lives)) + '○'.repeat(Math.max(0, livesStart - lives))
}

/** Picks whichever feature channel's estimate is more confident, so a
 *  player achieving the wobble through either RMS-style tremolo or
 *  filter-cutoff brightness modulation gets credit -- see this file's
 *  header comment. */
function bestEstimate(level: RateEstimate | undefined, centroid: RateEstimate | undefined): RateEstimate | undefined {
  if (!level) return centroid
  if (!centroid) return level
  return centroid.confidence >= level.confidence ? centroid : level
}

function draw(canvas: HTMLCanvasElement, state: WubState, nowSec: number): void {
  const cctx = canvas.getContext('2d')
  if (!cctx) return
  const { width, height } = canvas

  cctx.fillStyle = token('--surface-recess')
  cctx.fillRect(0, 0, width, height)

  const target = state.target
  if (target) {
    // Pulses at the target's own required rate -- the *only* way its rate
    // is communicated, on purpose (ROADMAP 3a's brief: "needs no text").
    // Phase is anchored to the target's own age so a fresh target always
    // starts at a clear, full-bright pulse rather than a phase inherited
    // from `nowSec`, which would make two targets at the same rate look
    // out of sync with each other for no reason.
    const phase = (target.ageMs / 1000) * target.requiredHz * 2 * Math.PI
    const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(phase))
    const r = state.config.targetRadius

    cctx.globalAlpha = pulse
    cctx.fillStyle = token('--cable-audio')
    cctx.beginPath()
    cctx.arc(target.x, target.y, r, 0, Math.PI * 2)
    cctx.fill()
    cctx.globalAlpha = 1

    // Charge ring: how close this target is to being destroyed.
    const chargeFrac = target.chargeMs / state.config.chargeMsToDestroy
    if (chargeFrac > 0) {
      cctx.strokeStyle = token('--text-accent')
      cctx.lineWidth = 5
      cctx.beginPath()
      cctx.arc(target.x, target.y, r + 8, -Math.PI / 2, -Math.PI / 2 + chargeFrac * Math.PI * 2)
      cctx.stroke()
    }

    // Lifetime ring: how much time is left before it escapes.
    const lifeFrac = 1 - target.ageMs / target.lifetimeMs
    cctx.strokeStyle = token('--panel-border-strong')
    cctx.lineWidth = 2
    cctx.beginPath()
    cctx.arc(target.x, target.y, r + 16, -Math.PI / 2, -Math.PI / 2 + Math.max(0, lifeFrac) * Math.PI * 2)
    cctx.stroke()
  }

  if (state.status === 'gameover') {
    cctx.fillStyle = token('--shadow-ambient')
    cctx.fillRect(0, 0, width, height)
    cctx.fillStyle = token('--text-primary')
    cctx.font = '20px var(--font-mono, monospace)'
    cctx.textAlign = 'center'
    cctx.fillText('GAME OVER', width / 2, height / 2 - 10)
    cctx.font = '13px var(--font-mono, monospace)'
    cctx.fillStyle = token('--text-dim')
    cctx.fillText(`score ${state.score} -- press Restart`, width / 2, height / 2 + 14)
    cctx.textAlign = 'left'
  }
  void nowSec // reserved for a future "no signal" pulsing hint; unused today
}

function updateHud(hud: HTMLElement, state: WubState, hasSignal: boolean): void {
  const signalNote = hasSignal ? '' : ' -- patch an Output and modulate something to disrupt targets'
  hud.textContent = `Score ${state.score} · Lives ${livesGlyphs(state.lives, state.config.livesStart)}${signalNote}`
  hud.dataset['score'] = String(state.score)
  hud.dataset['lives'] = String(state.lives)
  hud.dataset['status'] = state.status
}

/**
 * Mounts the wub disruptor into `container` and starts its
 * `requestAnimationFrame` loop -- same contract as `rack/arcade-panel.ts`'s
 * `startArcade` (down to the exported `ArcadeHandle` shape), so
 * `rack/arcade-panel.ts`'s own shell can mount either game interchangeably.
 */
export function startWub(
  container: HTMLElement,
  ctx: AudioContext,
  getOutputInstance: () => OutputInstance | undefined,
): ArcadeHandle {
  container.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.className = 'arcade-panel-content'

  const hud = document.createElement('div')
  hud.className = 'arcade-hud'
  hud.dataset['testid'] = 'wub-hud'

  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_WIDTH
  canvas.height = CANVAS_HEIGHT
  canvas.className = 'arcade-display'
  canvas.dataset['testid'] = 'wub-display'

  const restartBtn = document.createElement('button')
  restartBtn.textContent = 'Restart'
  restartBtn.className = 'arcade-restart-btn toolbar-btn'
  restartBtn.type = 'button'
  restartBtn.dataset['testid'] = 'wub-restart'

  const hint = document.createElement('p')
  hint.className = 'arcade-hint dim'
  hint.textContent =
    'Each target pulses at the modulation rate it needs. Patch an LFO into a filter’s ' +
    'cutoff CV (or anything else that makes the sound wobble) and tune its rate to match the ' +
    'pulse -- hold it steady to disrupt the target.'

  wrap.append(hud, canvas, restartBtn, hint)
  container.append(wrap)

  const config = defaultConfig(CANVAS_WIDTH, CANVAS_HEIGHT)
  let state = createGame(config)
  let tap: FeatureTap | undefined
  let lastTime: number | undefined
  let raf = 0
  const levelWindow = new RollingWindow(FEATURE_CAPACITY)
  const centroidWindow = new RollingWindow(FEATURE_CAPACITY)

  restartBtn.addEventListener('click', () => {
    state = createGame(config)
  })

  function ensureTap(): void {
    const instance = getOutputInstance()
    if (!instance) {
      if (tap) { disposeFeatureTap(tap); tap = undefined }
      return
    }
    if (tap && tap.instance === instance) return
    if (tap) disposeFeatureTap(tap)
    tap = buildFeatureTap(ctx, instance)
  }

  function tick(time: number): void {
    // Self-terminating, same contract as rack/arcade-panel.ts's own tick.
    if (!canvas.isConnected) {
      if (tap) disposeFeatureTap(tap)
      return
    }

    const dt = lastTime === undefined ? 16 : Math.min(64, time - lastTime)
    lastTime = time

    ensureTap()
    let measuredHz: number | undefined
    let confidence = 0
    if (tap) {
      const { level, centroid } = readFeatures(tap, ctx.sampleRate)
      // Timestamped with `time` -- rAF's own clock -- not `ctx.currentTime`.
      // "One reading per animation frame" is the contract `RollingWindow`'s
      // effective-sample-rate estimate depends on, and rAF is what actually
      // governs how often a reading gets pushed; the audio clock is a
      // different clock that is only *usually* in lockstep with it. Mixing
      // the two would make the estimate wrong exactly when it matters most
      // (a stalled or free-running audio context), independent of the
      // feature values being read correctly.
      const nowSec = time / 1000
      levelWindow.push(level, nowSec)
      centroidWindow.push(centroid, nowSec)
      const est = bestEstimate(levelWindow.detect(), centroidWindow.detect())
      if (est) {
        measuredHz = est.hz
        confidence = est.confidence
      }
    }

    state = stepWub(state, dt, measuredHz, confidence, LOCK_CONFIDENCE)
    draw(canvas, state, time / 1000)
    updateHud(hud, state, tap !== undefined)
    // Test hooks, same rationale as rack/arcade-panel.ts's own dataset
    // fields: proves a real target was actually destroyed/escaped by a
    // real measured rate, not just that stepWub was called with a number.
    canvas.dataset['targetHz'] = state.target ? String(state.target.requiredHz) : ''
    canvas.dataset['measuredHz'] = measuredHz !== undefined ? measuredHz.toFixed(3) : ''

    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  return {
    stop(): void {
      cancelAnimationFrame(raf)
      if (tap) disposeFeatureTap(tap)
    },
  }
}
