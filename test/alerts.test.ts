import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { after, before, describe, test } from "node:test"
import type { SettingsDto, SightingEvent } from "../src/api-types.ts"
import { createContext } from "../src/app.ts"
import { parseConfig } from "../src/config.ts"
import type { AppContext } from "../src/context.ts"
import { extractFrame } from "../src/media/ffmpeg.ts"
import { promptHash } from "../src/pipeline/compile.ts"
import { pinKey, processClip, redecideClips } from "../src/pipeline/process.ts"
import type { Detector } from "../src/pipeline/types.ts"
import type { LlmRequest, VisionLLM } from "../src/llm/types.ts"
import { createServer } from "../src/server/index.ts"

const root = join(import.meta.dirname, ".tmp", "alerts")

type Answer = { match: boolean; confidence: number; label: string | null; rationale: string }

/** Finds `labels` on the motion gate's best frame. */
const stubDetector = (labels: string[]): Detector => ({
	status: () => ({ enabled: true, model: "stub", ready: true, detail: "stub" }),
	warmup: async () => {},
	detectClip: async input => {
		const f = input.motion.frames[0]!
		const frames = new Map([[f.t, await extractFrame(input.clipPath, f.t)]])
		const detections = labels
			.filter(l => input.queries.includes(l))
			.map(label => ({ clipId: input.clipId, frameT: f.t, label, score: 0.42, box: f.box!, via: "full" as const }))
		return { detections, frames }
	}
})

/** Gives every judged lookout the same answer. */
const stubLlm = (answer: Answer): VisionLLM => ({
	backend: "mock",
	model: "stub",
	check: async () => ({ ok: true, detail: "stub" }),
	complete: async (req: LlmRequest) => {
		const ids = [...req.text.matchAll(/^lookout id=(\S+)/gm)].map(m => m[1]!)
		const json = { verdicts: ids.map(id => ({ lookoutId: id, ...answer })) }
		return {
			json,
			raw: JSON.stringify(json),
			usage: { ts: new Date().toISOString(), clipId: req.clipId, purpose: req.purpose, backend: "mock", model: "stub", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costUsd: 0 }
		}
	}
})

let mover = ""
let n = 0

/** A data dir with one "cardinal" lookout (threshold 0.6) whose judge always gives `answer`. */
const setup = async (answer: Answer) => {
	const dir = join(root, `run-${++n}`)
	const config = parseConfig({ dataDir: "data", pipeline: { judge: { provider: "mock" } } }, null, dir)
	const ctx: AppContext = await createContext(config, { llm: stubLlm(answer), detector: stubDetector(["bird"]) })
	const prompt = "a cardinal"
	ctx.store.insertLookout({
		id: "lk-cardinal",
		name: "cardinal",
		prompt,
		enabled: true,
		threshold: 0.6,
		compiled: { queries: ["bird"], rubric: prompt, summary: "cardinal", fineGrained: true, promptHash: promptHash(prompt), compiler: "test" }
	})
	const sightings: SightingEvent[] = []
	ctx.bus.on("sighting", e => sightings.push(e))
	const clip = (await ctx.ingest({ file: mover, source: "feeder", mode: "copy" })).clip
	return { ctx, clip, sightings, dir }
}

before(() => {
	rmSync(root, { recursive: true, force: true })
	mkdirSync(root, { recursive: true })
	mover = join(root, "mover.mp4")
	execFileSync("ffmpeg", [
		"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "color=c=0x305030:s=320x240:d=3:r=10", "-f", "lavfi", "-i", "color=c=white:s=24x24:d=3:r=10",
		"-filter_complex", "[0][1]overlay=x='40+t*60':y=100,format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast", mover
	])
})
after(() => rmSync(root, { recursive: true, force: true }))

describe("alerts", () => {
	test("a sighting carries what a notification shows: lookout name, camera, time and the crop's URL", async () => {
		const { ctx, clip, sightings } = await setup({ match: true, confidence: 0.92, label: "Northern Cardinal", rationale: "Red crest." })
		const out = await processClip(ctx, clip)
		const v = Date.parse(out.processedAt!)
		assert.deepEqual(sightings, [
			{
				clipId: out.id,
				lookoutId: "lk-cardinal",
				lookoutName: "cardinal",
				label: "Northern Cardinal",
				confidence: 0.92,
				source: "feeder",
				recordedAt: out.recordedAt,
				image: `/media/${out.id}/crop-0.jpg?v=${v}`
			}
		])
	})

	test("a clip saved from Live is kept with no match, and a threshold move does not reject it", async () => {
		const { ctx, clip, sightings } = await setup({ match: false, confidence: 0.1, label: "House Sparrow", rationale: "Brown." })
		ctx.store.setKv(pinKey(clip.id), "live")
		const out = await processClip(ctx, clip)
		assert.deepEqual(
			{ status: out.status, droppedAt: out.droppedAt, expiresAt: out.expiresAt, reason: out.reason },
			{ status: "kept", droppedAt: null, expiresAt: null, reason: "Saved from Live" }
		)
		assert.deepEqual(out.media, { poster: "poster.jpg", preview: "preview.mp4", crops: ["crop-0.jpg"] })
		assert.ok(out.path!.startsWith(ctx.paths.kept) && existsSync(out.path!))
		// still analysed: it gets its labels
		assert.equal(ctx.store.getVerdicts(out.id)[0]?.label, "House Sparrow")
		assert.equal(ctx.store.getDetections(out.id).length, 1)
		assert.deepEqual(sightings, [])

		ctx.store.updateLookout("lk-cardinal", { threshold: 0.9 })
		await redecideClips(ctx, [out.id])
		assert.equal(ctx.store.getClip(out.id)?.status, "kept")
	})

	test("a pinned clip that also matched names the match after the pin", async () => {
		const { ctx, clip } = await setup({ match: true, confidence: 0.92, label: "Northern Cardinal", rationale: "Red crest." })
		ctx.store.setKv(pinKey(clip.id), "live")
		const out = await processClip(ctx, clip)
		assert.equal(out.reason, "Saved from Live · kept: Northern Cardinal (0.92) for cardinal")
	})

	test("PATCH settings persists alerts.desktop to the config file", async () => {
		const { ctx, dir } = await setup({ match: false, confidence: 0, label: null, rationale: "" })
		const { app } = createServer(ctx, { webDist: join(dir, "no-dist") })
		const res = await app.request("/api/settings", {
			method: "PATCH",
			body: JSON.stringify({ alerts: { desktop: false } }),
			headers: { "Content-Type": "application/json" }
		})
		assert.equal(res.status, 200)
		assert.deepEqual(((await res.json()) as SettingsDto).alerts, { desktop: false })
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "look4.config.json"), "utf8")).alerts, { desktop: false })
	})
})
