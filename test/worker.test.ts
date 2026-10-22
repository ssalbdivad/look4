import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { after, before, describe, test } from "node:test"
import { createContext } from "../src/app.ts"
import { parseConfig } from "../src/config.ts"
import type { AppContext } from "../src/context.ts"
import { isTransientError, LlmError } from "../src/llm/errors.ts"
import type { LlmRequest, VisionLLM } from "../src/llm/types.ts"
import { extractFrame } from "../src/media/ffmpeg.ts"
import { promptHash } from "../src/pipeline/compile.ts"
import type { Detector } from "../src/pipeline/types.ts"
import { createWorker } from "../src/pipeline/worker.ts"
import type { Clip } from "../src/types.ts"

const root = join(import.meta.dirname, ".tmp", "worker", "retry")

const birdDetector: Detector = {
	status: () => ({ enabled: true, model: "stub", ready: true, detail: "stub" }),
	warmup: async () => {},
	detectClip: async input => {
		const f = input.motion.frames[0]!
		return {
			detections: [{ clipId: input.clipId, frameT: f.t, label: "bird", score: 0.5, box: f.box!, via: "full" }],
			frames: new Map([[f.t, await extractFrame(input.clipPath, f.t)]])
		}
	}
}

/** Throws each of `failures` in turn, then says "cardinal, 0.9". */
const flakyLlm = (failures: Error[]) => {
	const calls = { n: 0 }
	const llm: VisionLLM = {
		backend: "mock",
		model: "stub",
		check: async () => ({ ok: true, detail: "stub" }),
		complete: async (req: LlmRequest) => {
			const failure = failures[calls.n++]
			if (failure) throw failure
			const ids = [...req.text.matchAll(/^lookout id=(\S+)/gm)].map(m => m[1]!)
			const json = { verdicts: ids.map(lookoutId => ({ lookoutId, match: true, confidence: 0.9, label: "Northern Cardinal", rationale: "Red." })) }
			return {
				json,
				raw: JSON.stringify(json),
				usage: { ts: new Date().toISOString(), clipId: req.clipId, purpose: req.purpose, backend: "mock", model: "stub", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costUsd: 0 }
			}
		}
	}
	return { llm, calls }
}

const until = async (what: string, fn: () => boolean, ms = 20_000) => {
	const end = Date.now() + ms
	while (!fn()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
		await new Promise(r => setTimeout(r, 25))
	}
}

describe("worker retries", () => {
	let video: string
	let n = 0
	before(() => {
		rmSync(root, { recursive: true, force: true })
		mkdirSync(root, { recursive: true })
		video = join(root, "mover.mp4")
		execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x305030:s=320x240:d=3:r=10",
			"-f", "lavfi", "-i", "color=c=white:s=24x24:d=3:r=10", "-filter_complex", "[0][1]overlay=x='40+t*60':y=100,format=yuv420p",
			"-c:v", "libx264", "-preset", "ultrafast", video])
	})
	after(() => rmSync(root, { recursive: true, force: true }))

	const setup = async (llm: VisionLLM): Promise<AppContext> => {
		const config = parseConfig({ dataDir: "data", pipeline: { judge: { provider: "mock" } } }, null, join(root, `run-${++n}`))
		const ctx = await createContext(config, { llm, detector: birdDetector })
		ctx.store.insertLookout({
			id: "lk-cardinal",
			name: "cardinal",
			prompt: "a cardinal",
			enabled: true,
			threshold: 0.6,
			compiled: { queries: ["bird"], rubric: "a cardinal", summary: "cardinal", fineGrained: false, promptHash: promptHash("a cardinal"), compiler: "test" }
		})
		return ctx
	}

	test("transient judge failures are retried on the backoff schedule until the clip is judged", async () => {
		const { llm, calls } = flakyLlm([new LlmError("Claude Code timed out after 120s"), new LlmError("Anthropic API error 529: Overloaded")])
		const ctx = await setup(llm)
		const { clip } = await ctx.ingest({ file: video, source: "scan", mode: "copy" })
		const reasons: string[] = []
		const expiries: Array<string | null> = []
		ctx.bus.on("clip", e => e.status === "pending" && reasons.push(ctx.store.getClip(e.clipId)!.reason ?? ""))
		ctx.bus.on("clip", e => e.status === "error" && expiries.push(ctx.store.getClip(e.clipId)!.expiresAt))
		const worker = createWorker(ctx, { retryDelaysMs: [50, 50, 50] })
		worker.start()
		try {
			await until("kept", () => ctx.store.getClip(clip.id)!.status === "kept")
		} finally {
			await worker.stop()
		}
		assert.equal(calls.n, 3)
		assert.match(reasons[0]!, /^failed at judge: Claude Code timed out after 120s \(retry 1\/3 at \d\d:\d\d\)$/)
		assert.match(reasons[1]!, /^failed at judge: Anthropic API error 529: Overloaded \(retry 2\/3 at \d\d:\d\d\)$/)
		assert.equal(ctx.store.getClip(clip.id)!.error, null)
		// retention must not take the file while a retry is due
		assert.deepEqual(expiries, [null, null])
		ctx.store.close()
	})

	test("after the quick retries it keeps trying on the long schedule, outlasting a subscription limit", async () => {
		const limit = () => new LlmError("Claude Code error (success): You've hit your session limit · resets 5pm")
		const { llm, calls } = flakyLlm([limit(), limit(), limit()])
		const ctx = await setup(llm)
		const { clip } = await ctx.ingest({ file: video, source: "scan", mode: "copy" })
		const reasons: string[] = []
		ctx.bus.on("clip", e => e.status === "pending" && reasons.push(ctx.store.getClip(e.clipId)!.reason ?? ""))
		const worker = createWorker(ctx, { retryDelaysMs: [20], retryTailMs: 20, retryForMs: 60_000 })
		worker.start()
		try {
			await until("kept", () => ctx.store.getClip(clip.id)!.status === "kept")
		} finally {
			await worker.stop()
		}
		assert.equal(calls.n, 4)
		assert.match(reasons[2]!, /\(retry 3 at \d\d:\d\d\)$/)
		ctx.store.close()
	})

	test("a store failure in the loop pauses the worker instead of killing the process", async () => {
		const { llm } = flakyLlm([])
		const ctx = await setup(llm)
		const { clip } = await ctx.ingest({ file: video, source: "scan", mode: "copy" })
		const claim = ctx.store.claimNextPending
		let thrown = 0
		ctx.store.claimNextPending = () => {
			if (!thrown++) throw new Error("database or disk is full")
			return claim()
		}
		const worker = createWorker(ctx, { errorPauseMs: 20 })
		worker.start()
		try {
			await until("kept", () => ctx.store.getClip(clip.id)!.status === "kept")
		} finally {
			await worker.stop()
		}
		assert.equal(thrown > 1, true)
		ctx.store.close()
	})

	test("a permanent judge failure stays an error and the judge is not asked again", async () => {
		const { llm, calls } = flakyLlm([new LlmError("Claude Code is not logged in: run `claude` once and sign in (or set ANTHROPIC_API_KEY)")])
		const ctx = await setup(llm)
		const { clip } = await ctx.ingest({ file: video, source: "scan", mode: "copy" })
		const worker = createWorker(ctx, { retryDelaysMs: [20, 20, 20] })
		worker.start()
		let out: Clip
		try {
			await until("error", () => ctx.store.getClip(clip.id)!.status === "error")
			await new Promise(r => setTimeout(r, 300))
			out = ctx.store.getClip(clip.id)!
		} finally {
			await worker.stop()
		}
		assert.equal(calls.n, 1)
		assert.equal(out.status, "error")
		assert.equal(out.reason, "failed at judge: Claude Code is not logged in: run `claude` once and sign in (or set ANTHROPIC_API_KEY)")
		ctx.store.close()
	})

	test("once the retries run out the clip is left an error for retention, and a restart does not try it again", async () => {
		const timeout = () => new LlmError("Claude Code timed out after 120s")
		const { llm, calls } = flakyLlm([timeout(), timeout(), timeout()])
		const ctx = await setup(llm)
		const { clip } = await ctx.ingest({ file: video, source: "scan", mode: "copy" })
		const first = createWorker(ctx, { retryDelaysMs: [20, 20], retryForMs: 0 })
		first.start()
		try {
			await until("give up", () => /gave up/.test(ctx.store.getClip(clip.id)!.reason ?? ""))
		} finally {
			await first.stop()
		}
		assert.equal(calls.n, 3)
		const gaveUp = ctx.store.getClip(clip.id)!
		assert.equal(gaveUp.reason, "failed at judge: Claude Code timed out after 120s (gave up after 2 retries)")
		// only now does retention get the file
		assert.equal(Math.round((Date.parse(gaveUp.expiresAt!) - Date.now()) / 86_400_000), ctx.config.retention.rejectedDays)

		// a restart, with a judge that would now answer: the give-up stands, and so does the expiry
		const second = createWorker(ctx, { retryDelaysMs: [20, 20], retryForMs: 0 })
		second.start()
		await new Promise(r => setTimeout(r, 300))
		await second.stop()
		assert.equal(calls.n, 3)
		assert.deepEqual(ctx.store.getClip(clip.id), gaveUp)
		ctx.store.close()
	})

	test("the retry window is counted from the first failure, not from the last start", async () => {
		const timeout = () => new LlmError("Claude Code timed out after 120s")
		const { llm, calls } = flakyLlm([timeout(), timeout()])
		const ctx = await setup(llm)
		const { clip } = await ctx.ingest({ file: video, source: "scan", mode: "copy" })
		// stopped while its first retry is still a long way off
		const first = createWorker(ctx, { retryDelaysMs: [60_000], retryForMs: 400 })
		first.start()
		try {
			await until("a retry is scheduled", () => /\(retry 1\/1 at /.test(ctx.store.getClip(clip.id)!.reason ?? ""))
		} finally {
			await first.stop()
		}
		assert.equal(calls.n, 1)

		await new Promise(r => setTimeout(r, 500))
		// back up after the window closed: it gives up instead of opening a new window
		const second = createWorker(ctx, { retryDelaysMs: [20], retryForMs: 400 })
		second.start()
		await new Promise(r => setTimeout(r, 300))
		await second.stop()
		const out = ctx.store.getClip(clip.id)!
		assert.equal(calls.n, 1)
		assert.equal(out.status, "error")
		assert.equal(out.reason, "failed at judge: Claude Code timed out after 120s (gave up after 0 days of failures)")
		assert.ok(out.expiresAt)
		ctx.store.close()
	})

	test("the classifier separates what the backends throw for passing trouble from lasting faults", () => {
		const transient = [
			"Claude Code timed out after 120s",
			"Claude Code exited 1 without a result: API Error: 503",
			"Anthropic API rate limit hit (after retries); try again shortly",
			"could not reach the Anthropic API: Connection error.",
			"Claude Code error (error_during_execution): API Error: 529 {\"type\":\"overloaded_error\"}",
			"Claude Code error (success): You've hit your session limit · resets 5pm",
			"Claude Code error (success): You've hit your weekly limit · resets Oct 20, 9am",
			"Claude Code error (success): You've hit your limit · resets 5pm"
		]
		const permanent = [
			"Claude Code is not logged in: run `claude` once and sign in (or set ANTHROPIC_API_KEY)",
			"Anthropic API rejected the request: 400 image exceeds 5 MB maximum",
			"the model declined to answer (refusal)",
			"judge returned malformed output (verdicts must be an array): {}",
			"Input buffer contains unsupported image format"
		]
		assert.deepEqual(transient.filter(m => !isTransientError(m)), [])
		assert.deepEqual(permanent.filter(isTransientError), [])
	})
})
