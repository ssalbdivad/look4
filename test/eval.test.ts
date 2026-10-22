import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { after, before, describe, test } from "node:test"
import { createContext } from "../src/app.ts"
import { parseConfig } from "../src/config.ts"
import type { AppContext } from "../src/context.ts"
import { metrics, runEval } from "../src/eval.ts"
import type { VisionLLM } from "../src/llm/types.ts"
import { extractFrame } from "../src/media/ffmpeg.ts"
import { promptHash } from "../src/pipeline/compile.ts"
import type { Detector } from "../src/pipeline/types.ts"
import type { Stage } from "../src/types.ts"

const root = join(import.meta.dirname, ".tmp", "worker", "eval")

const noDetector: Detector = {
	status: () => ({ enabled: true, model: "stub", ready: true, detail: "stub" }),
	warmup: async () => {},
	detectClip: async () => ({ detections: [], frames: new Map() })
}

const fresh = async (name: string, opts: { llm?: VisionLLM | null; detector?: Detector } = {}) => {
	const config = parseConfig({ dataDir: "data", pipeline: { judge: { provider: "mock" } } }, null, join(root, name))
	return createContext(config, { llm: opts.llm ?? null, detector: opts.detector ?? noDetector })
}

const lookout = (ctx: AppContext, name: string, threshold: number) => {
	const prompt = `a ${name}`
	return ctx.store.insertLookout({
		id: `lk-${name}`,
		name,
		prompt,
		enabled: true,
		threshold,
		compiled: { queries: ["bird"], rubric: prompt, summary: name, fineGrained: false, promptHash: promptHash(prompt), compiler: "test" }
	})
}

let seq = 0
/** A processed clip (no file needed for stored-verdict eval) with an optional verdict and a label. */
const labeled = (
	ctx: AppContext,
	lookoutId: string,
	truth: boolean,
	opts: { verdict?: [match: boolean, confidence: number]; droppedAt?: Stage; path?: string } = {}
) => {
	const id = `20261014-1200${String(++seq).padStart(2, "0")}-${"abcdef"}`
	ctx.store.insertClip({ id, source: "scan", sourceRef: null, originalName: "x.mp4", path: opts.path ?? null, sizeBytes: 1, sha256: id, recordedAt: "2026-10-14T12:00:00.000Z" })
	ctx.store.updateClip(id, { status: opts.droppedAt ? "rejected" : "kept", droppedAt: opts.droppedAt ?? null, reason: opts.droppedAt ? `dropped at ${opts.droppedAt}` : null })
	if (opts.verdict) {
		const [match, confidence] = opts.verdict
		ctx.store.upsertVerdict({ clipId: id, lookoutId, match, confidence, label: null, rationale: "r", model: "m", createdAt: "2026-10-14T12:00:00.000Z" })
	}
	ctx.store.setLabel({ clipId: id, lookoutId, truth })
	return id
}

before(() => rmSync(root, { recursive: true, force: true }))
after(() => rmSync(root, { recursive: true, force: true }))

describe("runEval from stored verdicts", () => {
	test("counts against each lookout's own threshold and reports the stage that dropped each miss", async () => {
		const ctx = await fresh("stored")
		const a = lookout(ctx, "cardinal", 0.6)
		labeled(ctx, a.id, true, { verdict: [true, 0.9] }) // tp
		const missed = labeled(ctx, a.id, true, { droppedAt: "detect" }) // fn, never reached the judge
		labeled(ctx, a.id, false, { verdict: [true, 0.7] }) // fp
		labeled(ctx, a.id, false, { verdict: [true, 0.55], droppedAt: "judge" }) // tn: a match, but under 0.6

		const report = await runEval(ctx, { rerun: false })
		const r = report.lookouts[0]!
		assert.deepEqual(
			{ tp: r.tp, fp: r.fp, fn: r.fn, tn: r.tn, precision: r.precision, recall: r.recall, f1: r.f1 },
			{ tp: 1, fp: 1, fn: 1, tn: 1, precision: 0.5, recall: 0.5, f1: 0.5 }
		)
		assert.deepEqual(r.falseNegatives, [{ clipId: missed, droppedAt: "detect", reason: "dropped at detect" }])
	})

	test("undefined ratios are null, not 0 or NaN", async () => {
		const ctx = await fresh("nulls")
		const onlyNegatives = lookout(ctx, "jay", 0.6)
		lookout(ctx, "hawk", 0.6)
		labeled(ctx, onlyNegatives.id, false, { verdict: [false, 0.2] })

		const [jay, hawk] = (await runEval(ctx, { rerun: false })).lookouts
		assert.deepEqual([jay!.labeled, jay!.tn, jay!.precision, jay!.recall, jay!.f1], [1, 1, null, null, null])
		assert.deepEqual([hawk!.labeled, hawk!.precision, hawk!.recall, hawk!.f1], [0, null, null, null])
	})

	test("all-wrong predictions score 0, which is defined", () => {
		assert.deepEqual(metrics({ tp: 0, fp: 2, fn: 3 }), { precision: 0, recall: 0, f1: 0 })
	})
})

describe("runEval with rerun", () => {
	test("re-judges labeled clips with the current setup without writing verdicts or moving files", async () => {
		mkdirSync(root, { recursive: true })
		const video = join(root, "mover.mp4")
		execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x305030:s=320x240:d=3:r=10", "-f", "lavfi",
			"-i", "color=c=white:s=24x24:d=3:r=10", "-filter_complex", "[0][1]overlay=x='40+t*60':y=100,format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast", video])
		const birdDetector: Detector = {
			...noDetector,
			detectClip: async input => {
				const f = input.motion.frames[0]!
				return {
					detections: [{ clipId: input.clipId, frameT: f.t, label: "bird", score: 0.5, box: f.box!, via: "full" }],
					frames: new Map([[f.t, await extractFrame(input.clipPath, f.t)]])
				}
			}
		}
		const yes: VisionLLM = {
			backend: "mock",
			model: "stub",
			check: async () => ({ ok: true, detail: "" }),
			complete: async req => {
				const ids = [...req.text.matchAll(/^lookout id=(\S+)/gm)].map(m => m[1]!)
				const json = { verdicts: ids.map(lookoutId => ({ lookoutId, match: true, confidence: 0.8, label: "Northern Cardinal", rationale: "red" })) }
				return { json, raw: "", usage: { ts: "", clipId: req.clipId, purpose: "judge", backend: "mock", model: "stub", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costUsd: 0.002 } }
			}
		}
		const ctx = await fresh("rerun", { llm: yes, detector: birdDetector })
		const a = lookout(ctx, "cardinal", 0.6)
		const { clip } = await ctx.ingest({ file: video, source: "scan", mode: "copy" })
		// stored outcome says "missed at detect"; the current setup finds it
		ctx.store.updateClip(clip.id, { status: "rejected", droppedAt: "detect" })
		ctx.store.setLabel({ clipId: clip.id, lookoutId: a.id, truth: true })

		const r = (await runEval(ctx, { rerun: true })).lookouts[0]!
		assert.deepEqual([r.tp, r.fn, r.recall, r.costUsd], [1, 0, 1, 0.002])
		assert.deepEqual(ctx.store.getVerdicts(clip.id), [])
		assert.deepEqual(ctx.store.getUsage(clip.id), [])
		assert.equal(ctx.store.getClip(clip.id)!.path, clip.path)
	})
})
