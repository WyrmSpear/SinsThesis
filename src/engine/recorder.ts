/**
 * Captures whatever comes out of the live instrument while the player
 * performs -- keyboard notes, knob turns, the timing and the mistakes --
 * for the studio layer's first slice (docs/superpowers/specs's Phase 3).
 *
 * Three mechanisms were on the table and two were rejected on measurement
 * grounds, not convenience:
 *
 * - `MediaStreamDestination` + `MediaRecorder` re-encodes to whatever codec
 *   the browser supports for that container -- Opus or WebM, both lossy --
 *   on the way to a file. That throws away signal a synth this precisely
 *   measured (docs/CONTINUATION.md's alias-floor and THD table) worked hard
 *   to keep clean, for a format nobody asked for.
 * - A `ScriptProcessorNode` (or any main-thread poll -- `requestAnimationFrame`,
 *   a timed read) runs on the same thread as layout, GC, and every DOM
 *   event the rack's own UI generates. This project already has a
 *   hard-won rule about that: tests/browser/startup-thump.test.ts exists
 *   because a main-thread poll measurably missed a transient a worklet
 *   never did (2/42 vs 30/30 in the investigation that produced peak-tap).
 *   A recording that can silently drop samples under load is worse than no
 *   recording at all.
 *
 * What's used instead: an `AudioWorkletNode` (`recorder.worklet.ts`) wired
 * as a *parallel* tap off the output the operator already hears -- never in
 * series with it. The worklet writes nothing to its own output and the tap
 * is an additional connection, not a replacement one, so arming or
 * disarming this class can never add latency, change gain, or alter a
 * single sample reaching the speakers. It only ever adds a second listener
 * to a signal the operator was already going to hear.
 *
 * `AnalyserNode` (which the output module already builds, for its meter --
 * src/engine/modules/output.ts) was considered and rejected for this job:
 * it hands back a rolling window on demand, sized and refreshed by whoever
 * polls it, which is observation, not capture. Nothing guarantees two
 * consecutive reads don't overlap or leave a gap, and there is no way to
 * ask it for "everything since I started asking." The worklet tap is the
 * only mechanism here that guarantees every sample is seen exactly once.
 */

const DEFAULT_MAX_SECONDS = 300 // see the doc comment on `maxSeconds` below

export interface RecordingResult {
  /** Mono -- the engine's whole signal path is mono end to end (see
   *  render.ts's `renderGraph`/`renderPatch`, both single-channel), so a
   *  stereo capture here would just be the same channel duplicated twice
   *  for no benefit and double the memory. */
  samples: Float32Array
  sampleRate: number
  seconds: number
  /** True if the recording was cut short by `maxSeconds` rather than an
   *  explicit `stop()`. */
  truncated: boolean
}

export interface LiveRecorderOptions {
  /** Hard ceiling on recording length, chosen to make memory use bounded
   *  and *visible* rather than letting an operator who forgets a running
   *  transport grow an unbounded `Float32Array` until the tab dies. Mono
   *  float32 at 48 kHz is ~192 KB/s, so the default (300 s = 5 minutes)
   *  caps a single recording at ~57.6 MB -- generous for "capture a
   *  performance" while still being a number a browser tab shrugs off. */
  maxSeconds?: number
  /** Called once, from inside a worklet-message handler, if `maxSeconds` is
   *  reached before an explicit `stop()` -- the caller's only way to learn
   *  the cap fired without polling `elapsedSeconds` on a timer. */
  onAutoStop?: (result: RecordingResult) => void
}

/** One recording session. Construct fresh per recording (or reuse across
 *  many `start()`/`stop()` cycles -- state resets each `start()`) on a live
 *  `AudioContext`; `ensureWorklets` must have already loaded `'recorder'`
 *  into that context, which every caller in this codebase gets for free
 *  since render.ts's `ensureWorklets` loads the whole `WORKLET_MODULES`
 *  list together. */
export class LiveRecorder {
  private readonly ctx: AudioContext
  private readonly maxFrames: number
  private readonly onAutoStopCb: ((result: RecordingResult) => void) | undefined

  private node: AudioWorkletNode | undefined
  private mute: GainNode | undefined
  private source: AudioNode | undefined
  private chunks: Float32Array[] = []
  private frameCount = 0
  private truncatedFlag = false

  recording = false

  constructor(ctx: AudioContext, opts: LiveRecorderOptions = {}) {
    this.ctx = ctx
    this.maxFrames = Math.ceil((opts.maxSeconds ?? DEFAULT_MAX_SECONDS) * ctx.sampleRate)
    this.onAutoStopCb = opts.onAutoStop
  }

  get maxSeconds(): number {
    return this.maxFrames / this.ctx.sampleRate
  }

  /** Audio-thread-accurate: counts frames the worklet actually reported,
   *  not wall-clock time since `start()` -- the two agree, but this is the
   *  number the recording will actually contain. */
  get elapsedSeconds(): number {
    return this.frameCount / this.ctx.sampleRate
  }

  /** Begins capturing everything `source` outputs from this moment on. A
   *  parallel connection off `source`, never removing or rerouting
   *  whatever `source` already feeds -- see this file's header comment. */
  start(source: AudioNode): void {
    if (this.recording) return
    this.chunks = []
    this.frameCount = 0
    this.truncatedFlag = false

    const node = new AudioWorkletNode(this.ctx, 'recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    // A node must be graph-reachable from `destination` to be processed at
    // all (WebAudio's pull model starts from the destination and walks
    // inputs backward) -- muted so this tap is never itself audible, the
    // same trick peak-tap.worklet.ts's test callers use.
    const mute = this.ctx.createGain()
    mute.gain.value = 0
    node.connect(mute)
    mute.connect(this.ctx.destination)
    node.port.onmessage = (event: MessageEvent<Float32Array>): void => this.onChunk(event.data)
    source.connect(node)

    this.node = node
    this.mute = mute
    this.source = source
    this.recording = true
  }

  private onChunk(samples: Float32Array): void {
    if (!this.recording) return
    let usable = samples
    let hitCap = false
    if (this.frameCount + samples.length >= this.maxFrames) {
      usable = samples.subarray(0, Math.max(0, this.maxFrames - this.frameCount))
      hitCap = true
    }
    if (usable.length > 0) {
      this.chunks.push(usable)
      this.frameCount += usable.length
    }
    if (hitCap) {
      this.truncatedFlag = true
      this.onAutoStopCb?.(this.finish())
    }
  }

  /** Stops capturing and returns everything captured so far. Safe to call
   *  after an auto-stop already fired (returns an empty, non-truncated
   *  result) -- a transport's Stop button doesn't need to know whether the
   *  cap already ended the session. */
  stop(): RecordingResult {
    if (!this.recording) {
      return { samples: new Float32Array(0), sampleRate: this.ctx.sampleRate, seconds: 0, truncated: false }
    }
    return this.finish()
  }

  private finish(): RecordingResult {
    this.recording = false
    try {
      this.source?.disconnect(this.node!)
    } catch {
      /* already disconnected, e.g. the module it taps was removed mid-recording */
    }
    this.node?.disconnect()
    this.mute?.disconnect()
    this.node = undefined
    this.mute = undefined
    this.source = undefined

    const samples = new Float32Array(this.frameCount)
    let at = 0
    for (const chunk of this.chunks) {
      samples.set(chunk, at)
      at += chunk.length
    }
    this.chunks = []

    return {
      samples,
      sampleRate: this.ctx.sampleRate,
      seconds: samples.length / this.ctx.sampleRate,
      truncated: this.truncatedFlag,
    }
  }
}
