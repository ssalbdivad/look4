// Drains the pending queue with `pipeline.concurrency` loops. Each loop sleeps
// until `kick()` (a new clip) or a 30 s safety poll, so nothing busy-waits.
//
// Judge failures that are likely to pass (a Claude Code timeout, a rate or subscription
// limit, a 5xx, the network) are retried on a backoff schedule held in memory: no schema
// change, and the clip shows "retry n/3 at hh:mm" in its reason meanwhile. After the quick
// retries it keeps trying every few hours, since a subscription's limit window or an outage
// can last far longer than half an hour, and only gives up (and lets retention have the
// file) once it has been failing for `retention.rejectedDays`. When the failures began is kept
// in the DB (`retrySinceKey`) and the give-up in the clip's reason, so a restart neither reopens
// that window nor retries a clip given up on. The schedule itself is gone after a restart, so
// start() re-queues the clips still inside their window once, from the stored error text.

import type { AppContext } from "../context.ts"
import { logger } from "../log.ts"
import { sweep } from "../retention.ts"
import type { Clip } from "../types.ts"
import { expiry, gaveUpReason, isRetryable, processClip, retrySinceKey } from "./process.ts"

export { isRetryable }

const log = logger("worker")

const SAFETY_POLL_MS = 30_000
const SWEEP_MS = 3_600_000
const DAY_MS = 86_400_000
/** 3 quick retries over ~30 min: long enough to ride out a rate-limit blip or a flaky network. */
export const RETRY_DELAYS_MS = [2 * 60_000, 8 * 60_000, 20 * 60_000]
/** Then every few hours, to outlast a 5-hour subscription window or an outage overnight. */
export const RETRY_TAIL_MS = 3 * 3_600_000
/** A store error (a full disk, a lock held too long) pauses a loop this long instead of killing the app. */
const LOOP_ERROR_PAUSE_MS = 30_000

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5)

export const createWorker = (
	ctx: AppContext,
	opts: { retryDelaysMs?: number[]; retryTailMs?: number; retryForMs?: number; errorPauseMs?: number } = {}
) => {
	const delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS
	const tailMs = opts.retryTailMs ?? RETRY_TAIL_MS
	const retryForMs = () => opts.retryForMs ?? ctx.config.retention.rejectedDays * DAY_MS
	const errorPauseMs = opts.errorPauseMs ?? LOOP_ERROR_PAUSE_MS
	let controller: AbortController | null = null
	let loops: Promise<void>[] = []
	let sweepTimer: NodeJS.Timeout | null = null
	let waiters: Array<() => void> = []
	/** clip id → retries already scheduled by this process */
	const attempts = new Map<string, number>()
	/** When the clip's transient failures began; processClip records it with the first one. */
	const failingSince = (id: string) => {
		const at = ctx.store.getKv<number>(retrySinceKey(id))
		if (at !== null) return at
		// failed before this was recorded: its window starts now
		const now = Date.now()
		ctx.store.setKv(retrySinceKey(id), now)
		return now
	}
	const retryTimers = new Map<string, NodeJS.Timeout>()

	const requeue = (id: string) => {
		const clip = ctx.store.getClip(id)
		// a user may have reprocessed or deleted it meanwhile
		if (!clip) ctx.store.deleteKv(retrySinceKey(id))
		if (!clip || !isRetryable(clip)) return false
		ctx.store.updateClip(id, { status: "pending" })
		ctx.bus.emit("clip", { clipId: id, status: "pending" })
		return true
	}

	/** For good: the reason now says so, which `isRetryable` reads, so no later start re-queues it. */
	const giveUp = (clip: Clip, why: string) => {
		attempts.delete(clip.id)
		ctx.store.deleteKv(retrySinceKey(clip.id))
		ctx.store.updateClip(clip.id, {
			reason: gaveUpReason(clip.reason, why),
			// held back while retrying; now retention may have an unkept clip
			expiresAt: clip.status === "kept" ? null : expiry(ctx, clip.id, ctx.config.retention.rejectedDays),
			// a sighting keeps its status; the lookouts its re-check never reached are not owed a run now
			...(clip.status === "kept" ? { pendingLookouts: null } : {})
		})
		log.warn(`${clip.id}: judge still failing; gave up ${why}`)
	}

	const scheduleRetry = (clip: Clip) => {
		if (!isRetryable(clip)) {
			attempts.delete(clip.id)
			return
		}
		const n = (attempts.get(clip.id) ?? 0) + 1
		const quick = delays[n - 1]
		if (quick === undefined && Date.now() + tailMs - failingSince(clip.id) > retryForMs()) return giveUp(clip, `after ${n - 1} retries`)
		const delay = quick ?? tailMs
		attempts.set(clip.id, n)
		const at = clock(Date.now() + delay)
		ctx.store.updateClip(clip.id, { reason: `${clip.reason} (${quick === undefined ? `retry ${n} at ${at}` : `retry ${n}/${delays.length} at ${at}`})` })
		log.info(`${clip.id}: transient judge failure, retry ${n} in ${Math.round(delay / 1000)}s`)
		const timer = setTimeout(() => {
			retryTimers.delete(clip.id)
			try {
				if (requeue(clip.id)) wakeAll()
			} catch (e) {
				log.error(`${clip.id}: could not queue the retry`, e)
			}
		}, delay)
		timer.unref()
		retryTimers.set(clip.id, timer)
	}

	const wakeAll = () => {
		const w = waiters
		waiters = []
		for (const fn of w) fn()
	}

	const sleep = (signal: AbortSignal) =>
		new Promise<void>(resolve => {
			const timer = setTimeout(done, SAFETY_POLL_MS)
			function done() {
				clearTimeout(timer)
				signal.removeEventListener("abort", done)
				waiters = waiters.filter(w => w !== done)
				resolve()
			}
			waiters.push(done)
			signal.addEventListener("abort", done, { once: true })
		})

	const emitQueue = () => ctx.bus.emit("queue", ctx.store.queueDepth())

	/** A pause a kick does not cut short, so a failing store is not hammered by every new clip. */
	const pause = (signal: AbortSignal, ms: number) =>
		new Promise<void>(resolve => {
			const timer = setTimeout(done, ms)
			function done() {
				clearTimeout(timer)
				signal.removeEventListener("abort", done)
				resolve()
			}
			signal.addEventListener("abort", done, { once: true })
		})

	const loop = async (signal: AbortSignal) => {
		while (!signal.aborted) {
			try {
				const clip = ctx.store.claimNextPending()
				if (!clip) {
					await sleep(signal)
					continue
				}
				emitQueue()
				try {
					const out = await processClip(ctx, clip, signal)
					if (!signal.aborted) scheduleRetry(out)
				} catch (e) {
					// processClip records its own failures; this is a bug or a DB error, so park the clip rather than spin on it
					log.error(`${clip.id}: unexpected failure`, e)
					try {
						ctx.store.updateClip(clip.id, { status: "error", error: e instanceof Error ? e.message : String(e) })
					} catch {}
				}
				emitQueue()
			} catch (e) {
				// the store itself failed (SQLITE_FULL, a lock held past busy_timeout): an unhandled
				// rejection here would take the UI and every source down with it
				log.error(`worker loop: ${e instanceof Error ? e.message : String(e)}; pausing ${Math.round(errorPauseMs / 1000)}s`)
				await pause(signal, errorPauseMs)
			}
		}
	}

	const runSweep = () => {
		try {
			sweep(ctx)
		} catch (e) {
			log.error("retention sweep failed", e)
		}
	}

	return {
		start() {
			if (controller) return
			controller = new AbortController()
			const reset = ctx.store.resetProcessing()
			if (reset) log.info(`requeued ${reset} clip${reset === 1 ? "" : "s"} interrupted mid-run`)
			const retry = ctx.store.listClips({ status: ["error", "kept"], limit: 100_000 }).filter(isRetryable)
			let requeued = 0
			for (const c of retry) {
				const failing = Date.now() - failingSince(c.id)
				// its window ran out while look4 was not running to give up on it
				if (failing > retryForMs()) giveUp(c, `after ${Math.round(failing / DAY_MS)} days of failures`)
				else if (requeue(c.id)) requeued++
			}
			if (requeued) log.info(`requeued ${requeued} clip${requeued === 1 ? "" : "s"} whose judge call failed transiently`)
			const n = ctx.config.pipeline.concurrency
			loops = Array.from({ length: n }, () => loop(controller!.signal))
			runSweep()
			sweepTimer = setInterval(runSweep, SWEEP_MS)
			sweepTimer.unref()
			emitQueue()
		},
		async stop() {
			if (!controller) return
			controller.abort()
			wakeAll()
			if (sweepTimer) clearInterval(sweepTimer)
			sweepTimer = null
			for (const t of retryTimers.values()) clearTimeout(t)
			retryTimers.clear()
			attempts.clear()
			await Promise.allSettled(loops)
			loops = []
			controller = null
		},
		kick() {
			wakeAll()
		}
	}
}
