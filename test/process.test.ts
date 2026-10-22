import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { after, before, describe, test } from "node:test"
import { createContext } from "../src/app.ts"
import { parseConfig } from "../src/config.ts"
import type { AppContext } from "../src/context.ts"
import { LlmError } from "../src/llm/errors.ts"
import type { LlmRequest, VisionLLM } from "../src/llm/types.ts"
import { extractFrame } from "../src/media/ffmpeg.ts"
import { localDate } from "../src/paths.ts"
import { promptHash } from "../src/pipeline/compile.ts"
import { ensureCompiled, processClip } from "../src/pipeline/process.ts"
import { redecided, updateLookout } from "../src/lookouts.ts"
import { createMockLlm } from "../src/llm/mock.ts"
import type { Detector } from "../src/pipeline/types.ts"
import type { Clip, Lookout } from "../src/types.ts"

const root = join(import.meta.dirname, ".tmp", "worker", "process")
const DAY = 86_400_000

/**
 * Synthetic clips: a white square crossing a green field, the same field with nothing moving, and a
 * 5 px speck crossing it (a sparrow across a wide yard); the last two also with different bytes.
 */
const makeVideos = () => {
	mkdirSync(root, { recursive: true })
	const ff = (...args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args])
	const mover = join(root, "mover.mp4")
	const still = join(root, "still.mp4")
	ff("-f", "lavfi", "-i", "color=c=0x305030:s=320x240:d=3:r=10", "-f", "lavfi", "-i", "color=c=white:s=24x24:d=3:r=10",
		"-filter_complex", "[0][1]overlay=x='40+t*60':y=100,format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast", mover)
	ff("-f", "lavfi", "-i", "color=c=0x305030:s=320x240:d=3:r=10", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", still)
	const speck = join(root, "speck.mp4")
	const speck2 = join(root, "speck2.mp4")
	ff("-f", "lavfi", "-i", "color=c=0x305030:s=320x240:d=3:r=10", "-f", "lavfi", "-i", "color=c=white:s=5x5:d=3:r=10",
		"-filter_complex", "[0][1]overlay=x='40+t*60':y=100,format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", speck)
	ff("-i", speck, "-c", "copy", "-metadata", "title=again", speck2)
	const still2 = join(root, "still2.mp4")
	ff("-i", still, "-c", "copy", "-metadata", "title=again", still2)
	return { mover, still, still2, speck, speck2 }
}

/** Finds `labels` on the gate's best motion frame, at the motion box, with real decoded frames. */
const stubDetector = (labels: () => string[]): Detector => ({
	status: () => ({ enabled: true, model: "stub", ready: true, detail: "stub" }),
	warmup: async () => {},
	detectClip: async input => {
		const f = input.motion.frames[0]!
		const frames = new Map([[f.t, await extractFrame(input.clipPath, f.t)]])
		const detections = labels()
			.filter(l => input.queries.includes(l))
			.map(label => ({ clipId: input.clipId, frameT: f.t, label, score: 0.42, box: f.box!, via: "full" as const }))
		return { detections, frames }
	}
})

type Answer = { match: boolean; confidence: number; label: string | null; rationale: string }

/** What the judge does besides answering: throw, or run something while it "thinks". */
type JudgeHooks = { fail: Error | null; during: (() => void) | null; malformed: boolean }

/** Answers each lookout named in the judge request from `answers` (by lookout name). */
const stubLlm = (answers: Map<string, Answer>, nameOf: (id: string) => string, hooks: JudgeHooks): VisionLLM => ({
	backend: "mock",
	model: "stub",
	check: async () => ({ ok: true, detail: "stub" }),
	complete: async (req: LlmRequest) => {
		const ids = [...req.text.matchAll(/^lookout id=(\S+)/gm)].map(m => m[1]!)
		const json = hooks.malformed ? { verdicts: "yes" } : { verdicts: ids.map(id => ({ lookoutId: id, ...answers.get(nameOf(id))! })) }
		hooks.during?.()
		if (hooks.fail) throw hooks.fail
		return {
			json,
			raw: JSON.stringify(json),
			usage: { ts: new Date().toISOString(), clipId: req.clipId, purpose: req.purpose, backend: "mock", model: "stub", inputTokens: 900, outputTokens: 60, cacheReadTokens: 0, costUsd: 0.0003 }
		}
	}
})

describe("processClip", () => {
	let videos: ReturnType<typeof makeVideos>
	let n = 0

	before(() => {
		rmSync(root, { recursive: true, force: true })
		videos = makeVideos()
	})
	after(() => rmSync(root, { recursive: true, force: true }))

	/** A fresh data dir with lookouts `{ name: [queries, threshold] }`. */
	const setup = async (lookouts: Record<string, [string[], number]>, opts: { judge?: boolean; detector?: boolean } = {}) => {
		const dir = join(root, `run-${++n}`)
		const pipeline = { judge: { provider: opts.judge === false ? "none" : "mock" }, ...(opts.detector === false ? { detector: { enabled: false } } : {}) }
		const config = parseConfig({ dataDir: "data", pipeline }, null, dir)
		const answers = new Map<string, Answer>()
		const detected = { labels: [] as string[] }
		const judge: JudgeHooks = { fail: null, during: null, malformed: false }
		let ctx: AppContext
		const nameOf = (id: string) => ctx.store.getLookout(id)!.name
		const llm = opts.judge === false ? null : stubLlm(answers, nameOf, judge)
		ctx = await createContext(config, { llm, detector: stubDetector(() => detected.labels) })
		const byName: Record<string, Lookout> = {}
		for (const [name, [queries, threshold]] of Object.entries(lookouts)) {
			const prompt = `a ${name}`
			byName[name] = ctx.store.insertLookout({
				id: `lk-${name}`,
				name,
				prompt,
				enabled: true,
				threshold,
				compiled: { queries, rubric: prompt, summary: name, fineGrained: true, promptHash: promptHash(prompt), compiler: "test" }
			})
		}
		const sightings: string[] = []
		ctx.bus.on("sighting", e => sightings.push(`${nameOf(e.lookoutId)}:${e.confidence}`))
		const ingest = async (file: string) => (await ctx.ingest({ file, source: "scan", mode: "copy" })).clip
		return { ctx, answers, detected, judge, lookouts: byName, sightings, ingest }
	}

	const expiresInDays = (clip: Clip) => Math.round((Date.parse(clip.expiresAt!) - Date.now()) / DAY)

	test("a motionless clip is rejected at motion and expires after motionlessDays", async () => {
		const { ctx, ingest } = await setup({ cardinal: [["bird"], 0.6] })
		const out = await processClip(ctx, await ingest(videos.still))
		assert.equal(out.status, "rejected")
		assert.equal(out.droppedAt, "motion")
		assert.equal(out.reason, "no motion")
		assert.equal(expiresInDays(out), ctx.config.retention.motionlessDays)
		assert.deepEqual(ctx.store.getVerdicts(out.id), [])
		assert.equal(ctx.store.getUsage(out.id).length, 0)
	})

	test("a clip a stream's motion gate made is never dropped at motion: a speck below minArea gets candidate frames and its box; unmarked, it is dropped", async () => {
		const { ctx, ingest } = await setup({ cardinal: [["bird"], 0.6] })
		const plain = await processClip(ctx, await ingest(videos.speck))
		assert.deepEqual([plain.droppedAt, plain.reason], ["motion", "no motion (only 0.02% of the zone moved (needs 0.08%))"])

		const gated = await processClip(ctx, (await ctx.ingest({ file: videos.speck2, source: "cam", mode: "copy", gate: "look4" })).clip)
		assert.deepEqual([gated.droppedAt, gated.reason, gated.motion?.passed], ["detect", "no bird detected", true])
		const box = gated.motion!.frames[0]!.box!
		assert.ok(box.w < 0.03 && box.h < 0.03 && Math.abs(box.y - 100 / 240) < 0.02, `box ${JSON.stringify(box)} is the speck's`)

		// even with nothing the stage can see, the gate's word stands and the detector gets a look
		const still = await processClip(ctx, (await ctx.ingest({ file: videos.still2, source: "cam", mode: "copy", gate: "camera" })).clip)
		assert.deepEqual([still.droppedAt, still.motion?.reason], ["detect", "the camera saw motion; too little moved here to measure"])
	})

	test("with the detector off, a gated clip the stage sees nothing in is dropped at motion, not sent to the judge", async () => {
		const { ctx } = await setup({ cardinal: [["bird"], 0.6] }, { detector: false })
		const still = await processClip(ctx, (await ctx.ingest({ file: videos.still, source: "cam", mode: "copy", gate: "look4" })).clip)
		assert.deepEqual([still.droppedAt, still.reason, ctx.store.getUsage(still.id).length], ["motion", "no motion", 0])
	})

	test("motion with nothing the lookouts want is rejected at detect without calling the judge", async () => {
		const { ctx, detected, ingest } = await setup({ cardinal: [["bird"], 0.6], squirrel: [["squirrel"], 0.6] })
		detected.labels = ["cat"]
		const out = await processClip(ctx, await ingest(videos.mover))
		assert.equal(out.status, "rejected")
		assert.equal(out.droppedAt, "detect")
		assert.equal(out.reason, "no bird or squirrel detected")
		assert.equal(expiresInDays(out), ctx.config.retention.rejectedDays)
		assert.equal(ctx.store.getUsage(out.id).length, 0)
		assert.equal(out.media.poster, "poster.jpg")
	})

	test("a match at the threshold keeps the clip: moved to kept/, media written, indexed, announced", async () => {
		const { ctx, answers, detected, ingest, sightings } = await setup({ cardinal: [["bird"], 0.94] })
		detected.labels = ["bird"]
		answers.set("cardinal", { match: true, confidence: 0.94, label: "Northern Cardinal", rationale: "Red crest and black mask." })
		const clip = await ingest(videos.mover)
		const out = await processClip(ctx, clip)

		assert.equal(out.status, "kept")
		assert.equal(out.droppedAt, null)
		assert.equal(out.expiresAt, null)
		assert.equal(out.reason, "kept: Northern Cardinal (0.94) for cardinal")
		assert.equal(out.path, join(ctx.paths.kept, localDate(out.recordedAt), `${out.id}.mp4`))
		assert.ok(existsSync(out.path!) && !existsSync(clip.path!))
		assert.deepEqual(out.media, { poster: "poster.jpg", preview: "preview.mp4", crops: ["crop-0.jpg"] })
		for (const f of ["poster.jpg", "preview.mp4", "crop-0.jpg"]) assert.ok(existsSync(join(ctx.paths.media, out.id, f)), f)
		assert.deepEqual(sightings, ["cardinal:0.94"])
		assert.equal(ctx.store.getUsage(out.id)[0]?.costUsd, 0.0003)

		const index = readFileSync(ctx.paths.keptIndex, "utf8").trim().split("\n").map(l => JSON.parse(l))
		assert.deepEqual(index, [
			{
				clipId: out.id,
				recordedAt: out.recordedAt,
				file: `kept/${localDate(out.recordedAt)}/${out.id}.mp4`,
				source: "scan",
				matches: [{ lookout: "cardinal", label: "Northern Cardinal", confidence: 0.94, rationale: "Red crest and black mask." }],
				crops: [`media/${out.id}/crop-0.jpg`]
			}
		])
	})

	test("a match below the threshold is rejected at judge, with the judge's words in the reason", async () => {
		const { ctx, answers, detected, ingest, sightings } = await setup({ cardinal: [["bird"], 0.6] })
		detected.labels = ["bird"]
		answers.set("cardinal", { match: false, confidence: 0.12, label: "House Sparrow", rationale: "A house sparrow, not a cardinal. Brown streaks." })
		const out = await processClip(ctx, await ingest(videos.mover))
		assert.equal(out.status, "rejected")
		assert.equal(out.droppedAt, "judge")
		assert.equal(out.reason, "judge: a house sparrow, not a cardinal (0.12)")
		assert.equal(expiresInDays(out), ctx.config.retention.rejectedDays)
		assert.equal(out.media.preview, null)
		assert.deepEqual(out.media.crops, ["crop-0.jpg"])
		assert.deepEqual(sightings, [])
	})

	test("a backfill of one lookout keeps the other lookout's verdict, the kept status and the file where it is", async () => {
		const { ctx, answers, detected, ingest, lookouts } = await setup({ cardinal: [["bird"], 0.6], jay: [["bird"], 0.6] })
		detected.labels = ["bird"]
		answers.set("cardinal", { match: true, confidence: 0.9, label: "Northern Cardinal", rationale: "Red." })
		answers.set("jay", { match: false, confidence: 0.3, label: "Northern Cardinal", rationale: "Not blue." })
		const first = await processClip(ctx, await ingest(videos.mover))
		assert.equal(first.status, "kept")
		const cardinalBefore = ctx.store.getVerdicts(first.id).find(v => v.lookoutId === lookouts.cardinal!.id)

		// the judge now says no to both, but only jay is being re-asked
		answers.set("cardinal", { match: false, confidence: 0.1, label: null, rationale: "Nothing." })
		answers.set("jay", { match: false, confidence: 0.2, label: "Northern Cardinal", rationale: "Still not blue." })
		const queued = ctx.store.updateClip(first.id, { status: "processing", pendingLookouts: [lookouts.jay!.id] })
		const out = await processClip(ctx, queued)

		assert.equal(out.status, "kept")
		assert.equal(out.path, first.path)
		assert.equal(out.pendingLookouts, null)
		const after = ctx.store.getVerdicts(out.id)
		assert.deepEqual(after.find(v => v.lookoutId === lookouts.cardinal!.id), cardinalBefore)
		assert.equal(after.find(v => v.lookoutId === lookouts.jay!.id)?.confidence, 0.2)
		// no new matching lookout, so no second index line
		assert.equal(readFileSync(ctx.paths.keptIndex, "utf8").trim().split("\n").length, 1)
	})

	test("a backfill that finds nothing keeps a reason that speaks for every lookout, not just the backfilled one", async () => {
		const { ctx, ingest } = await setup({ squirrel: [["squirrel"], 0.6] })
		const first = await processClip(ctx, await ingest(videos.mover))
		assert.equal(first.reason, "no squirrel detected")
		const hawk = ctx.store.insertLookout({
			id: "lk-hawk",
			name: "hawk",
			prompt: "a hawk",
			enabled: true,
			threshold: 0.6,
			compiled: { queries: ["bird"], rubric: "a hawk", summary: "hawk", fineGrained: true, promptHash: promptHash("a hawk"), compiler: "test" }
		})
		const out = await processClip(ctx, ctx.store.updateClip(first.id, { status: "processing", pendingLookouts: [hawk.id] }))
		assert.equal(out.status, "rejected")
		assert.equal(out.droppedAt, "detect")
		assert.equal(out.reason, "no squirrel or bird detected")
	})

	test("a keyword-fallback lookout is recompiled by the LLM once per process, not on every clip", async () => {
		const dir = join(root, `run-${++n}`)
		const ctx = await createContext(parseConfig({ dataDir: "data" }, null, dir), { llm: createMockLlm(), detector: stubDetector(() => []) })
		const fallback = { queries: ["a jay"], rubric: "a jay", summary: "a jay", fineGrained: false, promptHash: promptHash("a blue jay"), compiler: "fallback" }
		const l = ctx.store.insertLookout({ id: "lk-jay", name: "jay", prompt: "a blue jay", enabled: true, threshold: 0.6, compiled: fallback })
		const [first] = await ensureCompiled(ctx, [l], true)
		assert.equal(first!.compiled?.compiler, "mock:mock")
		assert.deepEqual(ctx.store.getLookout("jay")!.compiled?.queries, ["bird"])
		// a second fallback (say the judge failed again) is left alone for the rest of the process
		const again = ctx.store.updateLookout(l.id, { compiled: fallback })
		const [second] = await ensureCompiled(ctx, [again], true)
		assert.equal(second!.compiled?.compiler, "fallback")
		ctx.store.close()
	})

	test("an aborted run leaves the clip pending", async () => {
		const { ctx, ingest } = await setup({ cardinal: [["bird"], 0.6] })
		const out = await processClip(ctx, await ingest(videos.mover), AbortSignal.abort())
		assert.equal(out.status, "pending")
		assert.equal(out.processedAt, null)
	})

	const hawk = (ctx: AppContext, queries: string[]) =>
		ctx.store.insertLookout({
			id: "lk-hawk",
			name: "hawk",
			prompt: "a hawk",
			enabled: true,
			threshold: 0.6,
			compiled: { queries, rubric: "a hawk", summary: "hawk", fineGrained: true, promptHash: promptHash("a hawk"), compiler: "test" }
		})

	test("a sighting whose backfill fails stays kept, in the feed and on disk, with the failure in its reason", async () => {
		const { ctx, answers, detected, judge, ingest } = await setup({ cardinal: [["bird"], 0.6] })
		detected.labels = ["bird"]
		answers.set("cardinal", { match: true, confidence: 0.9, label: "Northern Cardinal", rationale: "Red." })
		const first = await processClip(ctx, await ingest(videos.mover))
		const h = hawk(ctx, ["bird"])

		judge.fail = new LlmError("Claude Code did not return JSON: oops")
		const out = await processClip(ctx, ctx.store.updateClip(first.id, { status: "processing", pendingLookouts: [h.id] }))
		assert.equal(out.status, "kept")
		assert.equal(out.expiresAt, null)
		assert.equal(out.path, first.path)
		assert.equal(out.reason, "kept: Northern Cardinal (0.90) for cardinal · re-check failed at judge: Claude Code did not return JSON: oops")
		assert.deepEqual(ctx.store.listSightings().map(s => s.clip.id), [first.id])
		// a permanent failure is not retried, so the backfill is not left hanging on the clip
		assert.equal(out.pendingLookouts, null)
	})

	test("a lookout deleted while its clip is being judged does not cost the other lookout its sighting", async () => {
		const { ctx, answers, detected, judge, ingest, lookouts } = await setup({ cardinal: [["bird"], 0.6], jay: [["bird"], 0.6] })
		detected.labels = ["bird"]
		answers.set("cardinal", { match: true, confidence: 0.9, label: "Northern Cardinal", rationale: "Red." })
		answers.set("jay", { match: false, confidence: 0.8, label: "Northern Cardinal", rationale: "Not blue." })
		judge.during = () => ctx.store.deleteLookout(lookouts.jay!.id)
		const out = await processClip(ctx, await ingest(videos.mover))
		assert.equal(out.status, "kept")
		assert.deepEqual(ctx.store.getVerdicts(out.id).map(v => v.lookoutId), [lookouts.cardinal!.id])
		assert.equal(ctx.store.getUsage(out.id).length, 1)
	})

	test("a backfill that adds no match leaves the sighting's close-ups and poster alone", async () => {
		const { ctx, answers, detected, ingest } = await setup({ cardinal: [["bird"], 0.6] })
		detected.labels = ["bird"]
		answers.set("cardinal", { match: true, confidence: 0.9, label: "Northern Cardinal", rationale: "Red." })
		const first = await processClip(ctx, await ingest(videos.mover))
		assert.deepEqual(first.media.crops, ["crop-0.jpg"])
		// the hawk lookout wants a noun the detector does not find, so its run has no crops at all
		const h = hawk(ctx, ["hawk"])
		const out = await processClip(ctx, ctx.store.updateClip(first.id, { status: "processing", pendingLookouts: [h.id] }))
		assert.equal(out.status, "kept")
		assert.deepEqual(out.media, first.media)
		assert.ok(existsSync(join(ctx.paths.media, out.id, "crop-0.jpg")))
	})

	test("a judge answer that fails validation is still counted in usage", async () => {
		const { ctx, detected, judge, ingest } = await setup({ cardinal: [["bird"], 0.6] })
		detected.labels = ["bird"]
		judge.malformed = true
		const out = await processClip(ctx, await ingest(videos.mover))
		assert.equal(out.status, "error")
		assert.match(out.reason!, /^failed at judge: judge returned malformed output/)
		assert.deepEqual(ctx.store.getUsage(out.id).map(u => [u.inputTokens, u.costUsd]), [[900, 0.0003]])
	})

	test("with no judge, a detection of the lookout's noun keeps the clip whatever its score", async () => {
		const { ctx, detected, ingest } = await setup({ cardinal: [["bird"], 0.6] }, { judge: false })
		detected.labels = ["bird"]
		// the stub detector scores 0.42: past the detector's own bar, below the lookout's 0.6
		const out = await processClip(ctx, await ingest(videos.mover))
		assert.equal(out.status, "kept")
		assert.equal(out.reason, "kept: bird (0.42) for cardinal")
		assert.deepEqual(ctx.store.listSightings().map(s => s.verdicts.map(v => v.model)), [["detector-only"]])
	})

	test("a clip in flight when the first lookout is switched on goes back in the queue instead of being dropped", async () => {
		const { ctx, ingest } = await setup({})
		const clip = await ingest(videos.mover)
		const running = processClip(ctx, ctx.store.updateClip(clip.id, { status: "processing" }))
		hawk(ctx, ["bird"])
		const out = await running
		assert.equal(out.status, "pending")
		assert.equal(out.reason, null)
	})

	test("a media failure after the clip is moved to kept/ leaves it kept at its new path", async () => {
		const { ctx, answers, detected, ingest } = await setup({ cardinal: [["bird"], 0.6] })
		detected.labels = ["bird"]
		answers.set("cardinal", { match: true, confidence: 0.9, label: "Northern Cardinal", rationale: "Red." })
		const clip = await ingest(videos.mover)
		// a file where the media directory should be: writing the poster and crops fails
		writeFileSync(join(ctx.paths.media, clip.id), "")
		const out = await processClip(ctx, clip)
		assert.equal(out.status, "kept")
		assert.equal(out.expiresAt, null)
		assert.equal(out.path, join(ctx.paths.kept, localDate(out.recordedAt), `${out.id}.mp4`))
		assert.ok(existsSync(out.path!))
	})

	test("a threshold raised while a kept clip's media is written applies to that clip too", async () => {
		const { ctx, answers, detected, sightings, ingest, lookouts } = await setup({ cardinal: [["bird"], 0.6] })
		detected.labels = ["bird"]
		answers.set("cardinal", { match: true, confidence: 0.9, label: "Northern Cardinal", rationale: "Red." })
		const clip = await ingest(videos.mover)
		// the slider moves once the clip is decided and its file is in kept/, as the preview encodes
		const update = ctx.store.updateClip
		let moved: Promise<unknown> | null = null
		ctx.store.updateClip = (id, patch) => {
			const out = update(id, patch)
			if (!moved && patch.path?.startsWith(ctx.paths.kept)) moved = updateLookout(ctx, lookouts.cardinal!.id, { threshold: 0.95 })
			return out
		}
		const out = await processClip(ctx, ctx.store.claimClip(clip.id, null)!)
		await moved
		await redecided(ctx)
		assert.deepEqual([out.status, out.droppedAt, out.path], ["rejected", "judge", join(ctx.paths.clips, localDate(out.recordedAt), `${out.id}.mp4`)])
		assert.equal(out.reason, "judge: Northern Cardinal for cardinal, below its threshold (0.90 < 0.95)")
		assert.equal(expiresInDays(out), ctx.config.retention.rejectedDays)
		assert.equal(existsSync(join(ctx.paths.media, out.id, "preview.mp4")), false)
		assert.deepEqual(sightings, [])
	})

	test("a clip whose file was moved but whose row was not (a crash in between) is found in the other folder", async () => {
		const { ctx, answers, detected, ingest } = await setup({ cardinal: [["bird"], 0.6] })
		detected.labels = ["bird"]
		answers.set("cardinal", { match: true, confidence: 0.9, label: "Northern Cardinal", rationale: "Red." })
		const clip = await ingest(videos.mover)
		const moved = join(ctx.paths.kept, localDate(clip.recordedAt), basename(clip.path!))
		mkdirSync(dirname(moved), { recursive: true })
		renameSync(clip.path!, moved)
		const out = await processClip(ctx, clip)
		assert.equal(out.status, "kept")
		assert.equal(out.path, moved)
	})
})
