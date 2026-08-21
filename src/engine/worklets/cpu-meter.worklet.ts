/**
 * Section 11's other unbuilt failure mode: "the engine counts render-quantum
 * overruns and shows a load meter." Nothing in this codebase measured CPU
 * load at all before this file -- see `docs/CONTINUATION.md`'s recorded
 * gap and `.superpowers/sdd/robustness-report.md`.
 *
 * **The technique.** The Web Audio spec calls every active node's
 * `process()` exactly once per render quantum, synchronously, in
 * topological order, all on the single audio-rendering thread, before that
 * thread sleeps until the next quantum's deadline. That means the
 * wall-clock gap between two consecutive calls to *this* node's own
 * `process()` reflects however long the *whole* graph -- every other
 * active module's DSP, not just this one -- took to render that quantum,
 * regardless of where in the graph's topological order this node sits.
 * This node's own `process()` does nothing but read a timestamp, do a
 * handful of comparisons and additions -- no DSP, no allocation in the
 * steady-state path -- so it adds essentially nothing to the load it is
 * measuring.
 *
 * **Reported as a windowed average, not a single-quantum peak, and why
 * that is the honest choice rather than a simpler one.** An early version
 * of this file reported the single largest one-quantum gap seen in each
 * ~0.2s reporting window. Tested live (not just reasoned about) against
 * the real rack page, that number came back identical -- and implausibly
 * high -- whether the patch was the six-module starter patch or six
 * hundred extra oscillator/filter/wavefolder voices, which is exactly the
 * "measure it honestly" bar this failure mode was specified against, not
 * met. The cause: this file's own time source (see the next paragraph)
 * has coarser resolution than the ~2.7 ms quantum budget at 48 kHz in at
 * least one real browser, so *consecutive* per-quantum deltas alias
 * between "0 ms" (same tick) and "one full clock tick" almost independent
 * of actual DSP cost, and a bare peak-of-single-deltas metric is dominated
 * by that clock-quantization artifact rather than by real load. Averaging
 * elapsed wall time over an entire reporting window (`REPORT_QUANTA`
 * quanta, tracked from `windowStartMs`) against that window's *combined*
 * ideal budget dilutes one coarse tick's worth of quantization noise
 * across dozens of quanta instead of letting it dominate a single-sample
 * peak, and it is this averaged number this file actually reports.
 *
 * **Time source: `Date.now()`, not `performance.now()`, and why that
 * matters more than it sounds.** `performance` is part of the spec'd
 * `WorkletGlobalScope` mixin, but it is not available inside
 * `AudioWorkletGlobalScope` in every browser this shipped to be tested
 * against -- found live, in this very project's own headless-Chromium test
 * run: calling `performance.now()` here threw a `ReferenceError` on the
 * very first `process()` call, and per spec a `process()` that throws gets
 * its processor permanently deactivated -- the node silently stopped being
 * called at all, forever, with no error surfaced anywhere a player would
 * see it. That is a worse failure than the CPU meter simply not existing:
 * a badge-free, silent, permanent stop, the exact failure category this
 * whole task is about. `Date.now()` is plain ECMAScript, not a
 * Window/Worklet-scope API, so it is universally available; this file
 * prefers `performance.now()`'s sub-millisecond precision when it exists
 * and falls back to `Date.now()`'s millisecond-or-coarser precision when
 * it doesn't, rather than assuming either -- and the windowed-average
 * design above is what makes that fallback path still report something
 * meaningful rather than just something less wrong.
 *
 * **Overrun counting, adjusted for the same coarse-clock reality.** A
 * genuine single-quantum stutter is still worth flagging on its own, not
 * only as a dip in the windowed average, so this still counts a per-quantum
 * gap against a threshold -- but at `OVERRUN_MULTIPLE` times the ideal
 * budget (generous headroom above one coarse clock tick), not at 1x, so an
 * ordinary quantization tick on a fully idle patch does not read as an
 * "overrun."
 *
 * **What this does not claim.** It reports overall audio-thread load, not
 * a per-module breakdown -- there is no way to attribute *which* module
 * cost what from outside each node's own `process()`. It is also an
 * approximation, not a certified real-time trace: a browser's own
 * scheduling jitter (GC pauses, other tabs, OS scheduling) shows up
 * indistinguishably from genuine DSP overload. Good enough to warn a
 * player their patch is heavier than their machine, which is the entire
 * point -- not a profiler.
 *
 * **Cost of the measurement itself.** One timestamp read and a few
 * comparisons/additions, once per render quantum (~2.7 ms at 48 kHz) --
 * call it single-digit microseconds of JS on a thread whose own budget for
 * that same quantum is ~2700 microseconds, so this reporter's own share of
 * the load it's warning about is on the order of 0.1-0.3%, in line with
 * the instrument-shouldn't-move-the-needle-it's-reading requirement this
 * failure mode was specified with. `postMessage` -- the one part of this
 * that is not free -- fires at most a few times a second
 * (`REPORTS_PER_SECOND`), not once per quantum, so its cost is amortized
 * across hundreds of quanta rather than paid on every one.
 */

const REPORTS_PER_SECOND = 5
/** A single quantum has to run this many times its own ideal budget before
 *  it counts as a genuine overrun -- see this file's own doc comment on
 *  why 1x is too tight once the time source's resolution is coarser than
 *  the budget itself. */
const OVERRUN_MULTIPLE = 4

/** See this file's own doc comment for why `Date.now()` is the safe
 *  default and `performance.now()` only a preferred upgrade, resolved
 *  once at module-load time rather than branched on every `process()`
 *  call. */
const nowMs: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now()

class CpuMeterProcessor extends AudioWorkletProcessor {
  private lastWallMs: number | undefined
  private windowStartMs: number | undefined
  private readonly budgetMs = (128 / sampleRate) * 1000
  private readonly reportEveryQuanta = Math.max(1, Math.round(sampleRate / 128 / REPORTS_PER_SECOND))
  private quantaSinceReport = 0
  private overrunsSinceReport = 0

  process(): boolean {
    const now = nowMs()
    if (this.lastWallMs !== undefined) {
      const singleQuantumMs = now - this.lastWallMs
      if (singleQuantumMs > this.budgetMs * OVERRUN_MULTIPLE) this.overrunsSinceReport++
    }
    this.lastWallMs = now
    if (this.windowStartMs === undefined) this.windowStartMs = now

    this.quantaSinceReport++
    if (this.quantaSinceReport >= this.reportEveryQuanta) {
      const elapsedWindowMs = now - this.windowStartMs
      const idealWindowMs = this.quantaSinceReport * this.budgetMs
      const load = idealWindowMs > 0 ? elapsedWindowMs / idealWindowMs : 0
      this.port.postMessage({ avgLoad: load, overruns: this.overrunsSinceReport })
      this.quantaSinceReport = 0
      this.overrunsSinceReport = 0
      this.windowStartMs = now
    }
    // No inputs, no outputs written -- silent by construction (see
    // `cpu-meter.ts`'s doc comment for why it's wired to destination
    // through a zero-gain sink rather than left unconnected). Returning
    // `true` keeps this node alive indefinitely, the same convention
    // clock-generator-style worklets with no input already rely on.
    return true
  }
}

registerProcessor('cpu-meter', CpuMeterProcessor)
