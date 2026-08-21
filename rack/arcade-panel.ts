import type { OutputInstance } from '../src/engine/modules/output'
import { rms } from '../src/engine/analysis/features'
import { createGame, stepGame, defaultConfig, type GameState } from '../arcade/game'

/**
 * Pan Paddle -- ROADMAP 3a's first arcade prototype: a paddle steered by
 * the player's own stereo placement, catching blocks that fall from the
 * top of a playfield. This file owns the rAF loop, the Web Audio tap that
 * measures stereo position, and the canvas draw; `arcade/game.ts` owns
 * every rule (collision, scoring, the difficulty ramp) as plain,
 * node-testable functions -- the same split `dev/scope.ts`/
 * `rack/scope-panel.ts` already draws between "what the display looks
 * like" and "what the numbers mean."
 *
 * **What drives the paddle, and why.** Not the Panner's `pan` param read
 * directly -- the *actual measured stereo balance* of whatever the rack's
 * Output module is emitting, taken as the per-buffer RMS ratio between a
 * left- and right-channel `AnalyserNode` (`readBalance` below). That is a
 * few hundred `getFloatTimeDomainData` samples averaged into one number
 * per frame, not an FFT: cheap enough for a 60fps main-thread poll. The
 * payoff is that *any* patch achieving a given stereo position steers the
 * paddle the same way a Panner knob does -- a ping-pong delay, a
 * hard-panned oscillator, an LFO into the Panner's CV jack -- which
 * rewards understanding stereo rather than memorizing which one knob to
 * turn. ROADMAP 3a asks for exactly this design call and flags the
 * complexity budget explicitly ("per-buffer, cheap, not an FFT"); this is
 * that call, made.
 *
 * **The tap runs in parallel, never in series** -- the project's
 * non-negotiable after the 40 ms startup-thump lesson
 * (docs/CONTINUATION.md). `buildTap` calls
 * `instance.outputs.get('out')!.connect(splitter)` -- an *additional*
 * outgoing edge on a node that is already connected to
 * `ctx.destination` via `rack/main.ts`'s `wireOutputs`, not a
 * disconnect-and-reroute. `LiveRecorder` (`src/engine/recorder.ts`,
 * driven from `rack/main.ts`'s `toggleRecord`) already taps this exact
 * same node the exact same way for the Studio layer; this is that same
 * proven pattern, not a new risk.
 *
 * **What the player is doing.** Turning the Panner's knob by hand is the
 * simplest way to play and is left legal -- restricting input to
 * modulation-only would make the very first thing a new player tries
 * (grab the knob) not work, which is the wrong first five seconds for a
 * prototype whose only job is answering "does this feel good at all."
 * But nothing here reads the knob's value -- it reads the *result* -- so
 * patching an LFO into the Panner's CV jack, once a player wants both
 * hands free for the keyboard, works identically and is where the
 * expressive ceiling actually lives (rate and depth become play choices,
 * not just knob position). The in-panel hint text says so.
 *
 * **Difficulty.** One multiplier (`arcade/game.ts`'s `rampPerSecond`)
 * applied to both fall speed and spawn cadence, growing with seconds
 * survived -- ROADMAP 3a: "ramping speed is enough for a prototype."
 *
 * The tap and the rAF loop are both torn down (`stop()`, called by
 * `rack/main.ts` on leaving Arcade mode) rather than left running
 * headless behind a hidden panel -- the same self-terminating contract
 * `rack/scope-panel.ts`'s own `tick` documents, made explicit here instead
 * of implicit in "the canvas left the document" since this loop also owns
 * live `AnalyserNode`s that should stop pulling from the graph the moment
 * nothing is drawing their result.
 */

const CANVAS_WIDTH = 420
const CANVAS_HEIGHT = 520

/** 256 samples at any real `AudioContext` sample rate is 5-6 ms of audio --
 *  fine time resolution for a value read once per animation frame (~16 ms
 *  apart), and small enough that `getFloatTimeDomainData` plus one RMS
 *  pass costs nothing worth measuring on the main thread. */
const BALANCE_FFT_SIZE = 256

// `buildTap`/`readBalance`/`disposeTap`/`Tap` are exported (only, and
// specifically, for `tests/browser/modules/arcade-tap.test.ts`) so the
// mono-up-mix fix below can be exercised directly against a deliberately
// raw, single-channel source node -- bypassing `src/engine/modules/
// output.ts`'s own up-mix, which already protects the normal integration
// path today and would otherwise mask a regression in this file's own fix
// (see that test file's header comment for the full reasoning). Nothing
// else in this codebase imports these; the panel itself only calls
// `startArcade` below.
export interface Tap {
  readonly instance: OutputInstance
  readonly upmix: GainNode
  readonly splitter: ChannelSplitterNode
  readonly analyserL: AnalyserNode
  readonly analyserR: AnalyserNode
  readonly bufL: Float32Array<ArrayBuffer>
  readonly bufR: Float32Array<ArrayBuffer>
}

/**
 * `ChannelSplitterNode` is spec'd `channelInterpretation: 'discrete'`, so a
 * *mono* source connected straight into it lands entirely in channel 0 --
 * channel 1 reads silence, `readBalance` computes (0-l)/(0+l) = -1, and the
 * paddle pins hard left no matter what the patch is doing (reported by the
 * owner, see `docs/CONTINUATION.md`).
 *
 * `instance.outputs.get('out')` -- the source this tap connects to -- is
 * `src/engine/modules/output.ts`'s own internal gain node, which already
 * sets `channelCount: 2` / `channelCountMode: 'explicit'` /
 * `channelInterpretation: 'speakers'` on itself, so in today's normal
 * integration path (a patch wired all the way to a real Output module) that
 * node's *own* up-mix already protects this tap transitively -- verified
 * directly: reverting this function's `upmix` stage and rerunning
 * `tests/browser/rack-arcade.test.ts`'s "mono patch" regression test still
 * passes. What it does NOT protect against, and what actually motivates
 * keeping this stage here rather than treating Output's fix as sufficient:
 * `buildTap` takes any `OutputInstance`-shaped `instance`, not specifically
 * *the* live Output module's internal node -- a future refactor of
 * output.ts, a different `OutputInstance` shape, or this tap ever pointing
 * upstream of that up-mix would silently reintroduce exactly this failure
 * with zero test coverage, since the normal path currently masks it. Fixed
 * locally and unconditionally instead of relying on an upstream module's
 * implementation detail: a unity gain stage with the same three properties,
 * inserted between the source and the splitter, up-mixes a mono signal to
 * both channels *before* the splitter ever sees it -- so a mono source
 * reads balance 0 (centred) regardless of whether it arrived already
 * up-mixed, and a genuinely stereo source reaches the splitter unchanged (2
 * in / 2 computed is already an identity). `tests/browser/modules/
 * arcade-tap.test.ts` exercises this function directly against a
 * deliberately raw, single-channel source (bypassing Output entirely) to
 * prove the stage itself is load-bearing, not just redundant with
 * output.ts's own fix.
 */
export function buildTap(ctx: AudioContext, instance: OutputInstance): Tap | undefined {
  const source = instance.outputs.get('out')
  if (!source) return undefined
  const upmix = ctx.createGain()
  upmix.channelCount = 2
  upmix.channelCountMode = 'explicit'
  upmix.channelInterpretation = 'speakers'
  const splitter = ctx.createChannelSplitter(2)
  const analyserL = ctx.createAnalyser()
  const analyserR = ctx.createAnalyser()
  analyserL.fftSize = BALANCE_FFT_SIZE
  analyserR.fftSize = BALANCE_FFT_SIZE
  // Parallel tap: an additional connection out of a node the graph already
  // routes to ctx.destination elsewhere. Never inserted between the source
  // and its existing destination, so it cannot add latency or alter the
  // signal a listener hears -- see this file's header comment.
  source.connect(upmix)
  upmix.connect(splitter)
  splitter.connect(analyserL, 0)
  splitter.connect(analyserR, 1)
  return {
    instance,
    upmix,
    splitter,
    analyserL,
    analyserR,
    bufL: new Float32Array(BALANCE_FFT_SIZE),
    bufR: new Float32Array(BALANCE_FFT_SIZE),
  }
}

export function disposeTap(tap: Tap): void {
  tap.upmix.disconnect()
  tap.splitter.disconnect()
  tap.analyserL.disconnect()
  tap.analyserR.disconnect()
}

/** -1 (hard left) .. +1 (hard right), from the two channels' per-buffer
 *  RMS. Silence (nothing patched, or the patch is resting between notes)
 *  reads as 0 -- centered -- rather than chasing whatever the noise floor
 *  happens to lean toward. */
export function readBalance(tap: Tap): number {
  tap.analyserL.getFloatTimeDomainData(tap.bufL)
  tap.analyserR.getFloatTimeDomainData(tap.bufR)
  const l = rms(tap.bufL)
  const r = rms(tap.bufR)
  const sum = l + r
  if (sum < 1e-6) return 0
  return Math.min(1, Math.max(-1, (r - l) / sum))
}

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function draw(canvas: HTMLCanvasElement, state: GameState, balance: number): void {
  const cctx = canvas.getContext('2d')
  if (!cctx) return
  const { width, height } = canvas
  const cfg = state.config

  cctx.fillStyle = token('--surface-recess')
  cctx.fillRect(0, 0, width, height)

  cctx.strokeStyle = token('--panel-border')
  cctx.beginPath()
  cctx.moveTo(0, cfg.paddleY)
  cctx.lineTo(width, cfg.paddleY)
  cctx.stroke()

  // Blocks.
  cctx.fillStyle = token('--text-warn')
  for (const b of state.blocks) {
    cctx.fillRect(b.x - b.width / 2, b.y, b.width, b.height)
  }

  // A faint marker for the raw (unsmoothed) commanded position, so a
  // player can see whether the paddle is genuinely lagging their pan or
  // just riding the intentional follow-smoothing -- diagnostic during
  // development, and honest feedback during play.
  const targetX = ((Math.min(1, Math.max(-1, balance)) + 1) / 2) * cfg.width
  cctx.strokeStyle = token('--cable-cv')
  cctx.globalAlpha = 0.5
  cctx.beginPath()
  cctx.moveTo(targetX, cfg.paddleY - 10)
  cctx.lineTo(targetX, cfg.paddleY + cfg.paddleHeight + 10)
  cctx.stroke()
  cctx.globalAlpha = 1

  // Paddle.
  cctx.fillStyle = token('--text-accent')
  cctx.fillRect(state.paddleX - cfg.paddleWidth / 2, cfg.paddleY, cfg.paddleWidth, cfg.paddleHeight)

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
}

function livesGlyphs(lives: number, livesStart: number): string {
  return '●'.repeat(Math.max(0, lives)) + '○'.repeat(Math.max(0, livesStart - lives))
}

function updateHud(hud: HTMLElement, state: GameState, hasSignal: boolean): void {
  const speedMul = 1 + (state.elapsedMs / 1000) * state.config.rampPerSecond
  const signalNote = hasSignal ? '' : ' -- patch an Output and play something to steer'
  hud.textContent =
    `Score ${state.score} · Lives ${livesGlyphs(state.lives, state.config.livesStart)} · ` +
    `${speedMul.toFixed(1)}x${signalNote}`
  // Plain numeric read hooks, alongside the prose above -- what
  // tests/browser/rack-arcade.test.ts polls to prove a real collision
  // registers, without parsing the HUD's own sentence.
  hud.dataset['score'] = String(state.score)
  hud.dataset['lives'] = String(state.lives)
  hud.dataset['status'] = state.status
}

export interface ArcadeHandle {
  stop(): void
}

/**
 * Mounts the game into `container` (expected to be `#arcade-panel`,
 * cleared and rebuilt fresh on every entry to Arcade mode -- the same
 * "rebuild the whole thing declaratively" convention every other rack
 * panel already follows, e.g. `rack/main.ts`'s own `renderRack`) and
 * starts its `requestAnimationFrame` loop. `getOutputInstance` is a
 * getter, not a snapshot, so it keeps working across a patch load that
 * swaps the graph out from under it (mirrors `enableReorder`'s own
 * `() => graph` getter in `rack/main.ts`).
 */
export function startArcade(
  container: HTMLElement,
  ctx: AudioContext,
  getOutputInstance: () => OutputInstance | undefined,
): ArcadeHandle {
  container.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.className = 'arcade-panel-content'

  const hud = document.createElement('div')
  hud.className = 'arcade-hud'
  hud.dataset['testid'] = 'arcade-hud'

  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_WIDTH
  canvas.height = CANVAS_HEIGHT
  canvas.className = 'arcade-display'
  canvas.dataset['testid'] = 'arcade-display'

  const restartBtn = document.createElement('button')
  restartBtn.textContent = 'Restart'
  restartBtn.className = 'arcade-restart-btn toolbar-btn'
  restartBtn.type = 'button'
  restartBtn.dataset['testid'] = 'arcade-restart'

  const hint = document.createElement('p')
  hint.className = 'arcade-hint dim'
  hint.textContent =
    'Pan the sound to steer the paddle -- turn the Panner’s knob, or patch an LFO into ' +
    'its CV jack and let modulation drive it. Any patch that moves the stereo image works: ' +
    'a ping-pong delay or a hard-panned oscillator steer it just as well.'

  wrap.append(hud, canvas, restartBtn, hint)
  container.append(wrap)

  const config = defaultConfig(CANVAS_WIDTH, CANVAS_HEIGHT)
  let state = createGame(config)
  let tap: Tap | undefined
  let lastBalance = 0
  let lastTime: number | undefined
  let raf = 0

  restartBtn.addEventListener('click', () => {
    state = createGame(config)
  })

  function ensureTap(): void {
    const instance = getOutputInstance()
    if (!instance) {
      if (tap) { disposeTap(tap); tap = undefined }
      return
    }
    if (tap && tap.instance === instance) return
    if (tap) disposeTap(tap)
    tap = buildTap(ctx, instance)
  }

  function tick(time: number): void {
    // Self-terminating, same contract as rack/scope-panel.ts's tick: once
    // this panel's canvas leaves the document (mode switched away, or the
    // page tore the panel down) there is nothing left to draw into, and
    // nothing schedules another frame or keeps pulling from the tap.
    if (!canvas.isConnected) {
      if (tap) disposeTap(tap)
      return
    }

    // Clamp dt so a backgrounded-tab gap (rAF pauses, then delivers one
    // huge delta on refocus) can't let a block tunnel through the paddle
    // band in a single step, or make the ramp jump discontinuously.
    const dt = lastTime === undefined ? 16 : Math.min(64, time - lastTime)
    lastTime = time

    ensureTap()
    if (tap) lastBalance = readBalance(tap)

    state = stepGame(state, dt, lastBalance)
    draw(canvas, state, lastBalance)
    updateHud(hud, state, tap !== undefined)
    // Same test hook rationale as the HUD's dataset fields above: proves
    // the paddle itself moved in response to a real measured stereo
    // position, not just that the balance reader returned a number.
    canvas.dataset['paddleX'] = String(Math.round(state.paddleX))

    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  return {
    stop(): void {
      cancelAnimationFrame(raf)
      if (tap) disposeTap(tap)
    },
  }
}
