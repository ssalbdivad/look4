import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { describe, test } from "node:test"
import { Config } from "../src/config.ts"
import { iou } from "../src/geometry.ts"
import { probe } from "../src/media/ffmpeg.ts"
import { createDetector, isModelCached } from "../src/pipeline/detect.ts"
import {
	hitToFrame,
	labelToNoun,
	MAX_TILES,
	MAX_ZOOMS,
	mergeFrameHits,
	queryBatches,
	queryPrompt,
	saturated,
	tileViews,
	viewsFor,
	zoomView,
	type View
} from "../src/pipeline/detect-views.ts"
import { runMotionGate } from "../src/pipeline/motion.ts"
import { planFrames, splitJpegs } from "../src/pipeline/detect-frames.ts"
import type { NormBox } from "../src/types.ts"

const round = (b: NormBox) => ({
	x: Number(b.x.toFixed(6)),
	y: Number(b.y.toFixed(6)),
	w: Number(b.w.toFixed(6)),
	h: Number(b.h.toFixed(6))
})

const uhd = { width: 3840, height: 2160 }

describe("zoom views", () => {
	test("a small motion box gets a pixel-square zoom of at least the minimum side, centered on it", () => {
		// 96x108 px bird near the middle of a 4K frame: 2.5x its long side is under the 384 px minimum
		const motion = { x: 0.5, y: 0.5, w: 0.025, h: 0.05 }
		const z = zoomView(motion, null, uhd)!
		assert.deepEqual(round(z), round({ x: (1968 - 192) / 3840, y: (1134 - 192) / 2160, w: 384 / 3840, h: 384 / 2160 }))
		assert.equal(Math.round(z.w * uhd.width), Math.round(z.h * uhd.height))
	})

	test("a zoom at the frame edge is shifted inside, not clipped smaller", () => {
		const z = zoomView({ x: 0.97, y: 0, w: 0.02, h: 0.03 }, null, uhd)!
		assert.deepEqual(round(z), round({ x: 1 - 384 / 3840, y: 0, w: 384 / 3840, h: 384 / 2160 }))
	})

	test("motion covering a quarter of the ROI or more needs no zoom", () => {
		const roi = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }
		const motion = { x: 0.45, y: 0.45, w: 0.1, h: 0.1 }
		assert.equal(zoomView(motion, roi, uhd), null)
		// the same box is small relative to the whole frame, so without an ROI it zooms
		assert.notEqual(zoomView(motion, null, uhd), null)
	})

	test("a large motion box zooms to 2.5x its long side; no zoom once that nears the frame's short side", () => {
		const z = zoomView({ x: 0.4, y: 0.4, w: 0.1, h: 0.1 }, null, uhd)!
		assert.equal(Math.round(z.w * uhd.width), 960)
		assert.equal(zoomView({ x: 0.5, y: 0.5, w: 0.05, h: 0.05 }, null, { width: 640, height: 360 }), null)
	})

	test("views: ROI first, zoom only when enabled and motion is known", () => {
		const roi = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }
		const motion = { x: 0.4, y: 0.4, w: 0.02, h: 0.02 }
		assert.deepEqual(viewsFor(motion, roi, uhd, true).map(v => v.via), ["full", "zoom"])
		assert.deepEqual(viewsFor(motion, roi, uhd, false), [{ box: roi, via: "full" }])
		assert.deepEqual(viewsFor(null, null, uhd, true), [{ box: { x: 0, y: 0, w: 1, h: 1 }, via: "full" }])
	})

	test("feeders always get a zoom, outside the motion zooms' cap", () => {
		const feeder = { x: 0.14, y: 0.085, w: 0.045, h: 0.095 }
		// no motion at all: the feeder is still looked at closely
		assert.deepEqual(viewsFor(null, null, uhd, true, [], [feeder]).map(v => [v.via, v.speculative ?? false]), [["full", false], ["zoom", false]])
		// a blob on the feeder still gets its own tighter zoom, and the feeder does not count against MAX_ZOOMS
		const onFeeder = { x: 0.15, y: 0.1, w: 0.01, h: 0.01 }
		const elsewhere = [{ x: 0.5, y: 0.5, w: 0.02, h: 0.02 }, { x: 0.8, y: 0.2, w: 0.02, h: 0.02 }]
		assert.equal(viewsFor(onFeeder, null, uhd, true, elsewhere, [feeder]).length, 2 + MAX_ZOOMS)
		assert.deepEqual(viewsFor(null, null, uhd, false, [], [feeder]).length, 1)
	})

	test("secondary blobs get speculative zooms, unless an earlier zoom already holds them, up to MAX_ZOOMS", () => {
		const main = { x: 0.1, y: 0.1, w: 0.02, h: 0.02 }
		// inside the main blob's 384 px zoom: seen there already
		const near = { x: 0.13, y: 0.12, w: 0.01, h: 0.01 }
		const others = [near, { x: 0.5, y: 0.5, w: 0.02, h: 0.02 }, { x: 0.8, y: 0.2, w: 0.02, h: 0.02 }, { x: 0.8, y: 0.8, w: 0.02, h: 0.02 }]
		const views = viewsFor(main, null, uhd, true, others)
		assert.equal(views.length, 1 + MAX_ZOOMS)
		assert.deepEqual(views.map(v => [v.via, v.speculative ?? false]), [["full", false], ["zoom", false], ["zoom", true], ["zoom", true]])
		assert.deepEqual(views.slice(2).map(v => round(v.box)), [zoomView(others[1]!, null, uhd), zoomView(others[2]!, null, uhd)].map(b => round(b!)))
	})
})

describe("second-look tiles", () => {
	const px = (v: View, frame: { width: number; height: number }) =>
		[v.box.x * frame.width, v.box.y * frame.height, v.box.w * frame.width, v.box.h * frame.height].map(Math.round)

	test("720p: eight overlapping 432 px squares (0.6 of the short edge) covering the frame", () => {
		const hd = { width: 1280, height: 720 }
		const tiles = tileViews(null, hd)
		assert.deepEqual(tiles.map(t => px(t, hd)), [
			[0, 0, 432, 432], [283, 0, 432, 432], [565, 0, 432, 432], [848, 0, 432, 432],
			[0, 288, 432, 432], [283, 288, 432, 432], [565, 288, 432, 432], [848, 288, 432, 432]
		])
		assert.ok(tiles.every(t => t.via === "zoom" && t.speculative))
	})

	test("tiles stay inside the ROI and cover it", () => {
		const roi = { x: 0.5, y: 0, w: 0.5, h: 1 }
		const tiles = tileViews(roi, uhd)
		// 1920x2160 px zone: 1152 px squares, 2 across and 3 down
		assert.deepEqual(tiles.map(t => px(t, uhd)), [
			[1920, 0, 1152, 1152], [2688, 0, 1152, 1152],
			[1920, 504, 1152, 1152], [2688, 504, 1152, 1152],
			[1920, 1008, 1152, 1152], [2688, 1008, 1152, 1152]
		])
	})

	test("a zone already magnified by the ROI view gets no tiles; a sliver of one gets at most MAX_TILES", () => {
		assert.deepEqual(tileViews({ x: 0.4, y: 0.4, w: 0.1, h: 0.1 }, uhd), [])
		const sliver = { x: 0, y: 0.45, w: 1, h: 0.1 }
		const tiles = tileViews(sliver, uhd)
		assert.equal(tiles.length, MAX_TILES)
		const right = tiles.at(-1)!.box
		assert.deepEqual(round({ x: tiles[0]!.box.x, y: tiles[0]!.box.y, w: right.x + right.w, h: tiles[0]!.box.h }), round(sliver))
	})
})

describe("mapping hits back to the full frame", () => {
	test("a box found in a zoom crop lands at the right full-frame position", () => {
		const view = { x: 0.5, y: 0.25, w: 0.25, h: 0.5 }
		const box = hitToFrame({ label: "bird", score: 0.5, box: { x: 0.2, y: 0.4, w: 0.4, h: 0.2 } }, view)
		assert.deepEqual(round(box), { x: 0.55, y: 0.45, w: 0.1, h: 0.1 })
	})

	test("boxes spilling past the view's edge are clamped to the view first", () => {
		const view = { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }
		const box = hitToFrame({ label: "bird", score: 0.5, box: { x: -0.1, y: 0.8, w: 0.3, h: 0.4 } }, view)
		assert.deepEqual(round(box), { x: 0.5, y: 0.9, w: 0.1, h: 0.1 })
	})
})

describe("merging views", () => {
	const full: View = { box: { x: 0, y: 0, w: 1, h: 1 }, via: "full" }
	const zoom: View = { box: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, via: "zoom" }

	test("the same bird seen in both views is reported once, from the stronger view", () => {
		const out = mergeFrameHits("c1", 1.5, [
			{ view: full, hits: [{ label: "bird", score: 0.2, box: { x: 0.55, y: 0.55, w: 0.1, h: 0.1 } }] },
			// zoom-relative box covering the same region: 0.5 + 0.25*0.2 = 0.55
			{ view: zoom, hits: [{ label: "bird", score: 0.6, box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }] }
		], 0.1)
		assert.equal(out.length, 1)
		assert.deepEqual({ ...out[0]!, box: round(out[0]!.box) }, {
			clipId: "c1",
			frameT: 1.5,
			label: "bird",
			score: 0.6,
			box: { x: 0.55, y: 0.55, w: 0.1, h: 0.1 },
			via: "zoom"
		})
	})

	test("drops sub-threshold hits, keeps overlapping hits with different labels, sorts by score", () => {
		const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }
		const out = mergeFrameHits("c1", 0, [
			{
				view: full,
				hits: [
					{ label: "bird", score: 0.09, box: { x: 0.6, y: 0.6, w: 0.1, h: 0.1 } },
					{ label: "bird", score: 0.3, box },
					{ label: "squirrel", score: 0.4, box }
				]
			}
		], 0.1)
		assert.deepEqual(out.map(d => [d.label, d.score]), [["squirrel", 0.4], ["bird", 0.3]])
	})

	test("a speculative view's hit must clear the higher bar; the same score from the ROI view counts", () => {
		const tile: View = { box: { x: 0, y: 0, w: 0.5, h: 0.5 }, via: "zoom", speculative: true }
		const hit = { label: "squirrel", score: 0.22, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }
		assert.deepEqual(mergeFrameHits("c1", 0, [{ view: tile, hits: [hit] }], 0.15, 0.5, 0.3), [])
		assert.deepEqual(mergeFrameHits("c1", 0, [{ view: full, hits: [hit] }], 0.15, 0.5, 0.3).map(d => d.score), [0.22])
	})

	test("no hits → no detections", () => {
		assert.deepEqual(mergeFrameHits("c1", 0, [{ view: full, hits: [] }], 0.1), [])
	})
})

describe("prompting", () => {
	test("OWL gets a caption with the right article; Grounding DINO a period-terminated phrase", () => {
		assert.equal(queryPrompt("Bird", "owl"), "a photo of a bird")
		assert.equal(queryPrompt("owl", "owl"), "a photo of an owl")
		assert.equal(queryPrompt("blue jay", "grounding-dino"), "blue jay.")
	})

	test("labels map back to the bare noun; Grounding DINO gets one call per noun", () => {
		const [owl] = queryBatches(["bird", "squirrel"], "owl")
		assert.deepEqual(owl, { nouns: ["bird", "squirrel"], prompts: ["a photo of a bird", "a photo of a squirrel"] })
		assert.equal(labelToNoun("a photo of a squirrel", owl!), "squirrel")
		assert.equal(labelToNoun("a photo of a cat", owl!), null)
		// its post-processing labels every box with the whole span, so the noun comes from the batch
		const dino = queryBatches(["bird", "squirrel"], "grounding-dino")
		assert.deepEqual(dino.map(b => b.prompts), [["bird."], ["squirrel."]])
		assert.equal(labelToNoun("bird squirrel.", dino[1]!), "squirrel")
	})
})

test("early stop: saturated only once every query is confident on enough distinct frames", () => {
	const d = (label: string, frameT: number, score: number) => ({
		clipId: "c",
		frameT,
		label,
		score,
		box: { x: 0, y: 0, w: 0.1, h: 0.1 },
		via: "full" as const
	})
	const birds = [d("bird", 0, 0.5), d("bird", 0, 0.6), d("bird", 1, 0.5)]
	assert.equal(saturated(birds, ["bird"], 0.3, 2), true)
	// two boxes on one frame count once
	assert.equal(saturated(birds.slice(0, 2), ["bird"], 0.3, 2), false)
	// a second query never seen keeps it scanning
	assert.equal(saturated(birds, ["bird", "squirrel"], 0.3, 2), false)
	assert.equal(saturated([d("bird", 0, 0.2), d("bird", 1, 0.2)], ["bird"], 0.3, 2), false)
})

describe("frame decoding plan", () => {
	const times = [0.8, 2.5, 4.2, 5.8, 7.5, 9.2]

	test("one keyframe per 10 s clip: a single pass from it, selecting each frame by index", () => {
		assert.deepEqual(planFrames(times, [0, 10], 25), { mode: "batch", start: 0, indices: [20, 63, 105, 145, 188, 230] })
	})

	test("2 s GOP over a 30 s clip: seeking decodes far less than one long pass", () => {
		const kfs = Array.from({ length: 15 }, (_, i) => i * 2)
		assert.deepEqual(planFrames([1, 9, 17, 29.5], kfs, 25), { mode: "seek" })
	})

	test("a pass starts at the keyframe before the earliest frame, and frames sharing an index decode once", () => {
		assert.deepEqual(planFrames([20.5, 20.51, 24], [0, 20], 25), { mode: "batch", start: 20, indices: [13, 100] })
	})

	test("a single frame or unknown fps always seeks", () => {
		assert.deepEqual(planFrames([3], [0], 25), { mode: "seek" })
		assert.deepEqual(planFrames(times, [0], 0), { mode: "seek" })
	})

	test("splits an MJPEG pipe into whole JPEGs, dropping a truncated tail", () => {
		const jpeg = (body: number[]) => [0xff, 0xd8, ...body, 0xff, 0xd9]
		const out = splitJpegs(Buffer.from([...jpeg([1, 2]), ...jpeg([0xff, 0x00, 3]), 0xff, 0xd8, 4]))
		assert.deepEqual(out.map(b => [...b]), [jpeg([1, 2]), jpeg([0xff, 0x00, 3])])
	})
})

describe("real model", () => {
	// The default model is ~158 MB; never download it from a test. `look4 doctor` or a first
	// clip fills the cache, after which this runs.
	const cfg = Config.assert({}).pipeline.detector
	const root = join(import.meta.dirname, "..")
	const modelsDir = process.env.LOOK4_MODELS_DIR ?? join(root, "data/models")
	const videos = join(root, "test/fixtures/videos")
	const skip = !isModelCached(cfg.model, modelsDir)
		? `${cfg.model} is not in ${modelsDir}`
		: !existsSync(join(videos, "blue-jay.mp4"))
			? "fixtures not fetched (pnpm fixtures)"
			: false
	const detector = createDetector(cfg, modelsDir)
	const run = async (file: string) => {
		const path = join(videos, file)
		const p = await probe(path)
		// no motion frames: the detector falls back to evenly spaced ones
		const motion = { score: 1, passed: true, reason: "", frames: [], sampledFrames: 0 }
		return detector.detectClip({ clipId: file, clipPath: path, probe: p, motion, queries: ["bird", "squirrel"], roi: null, feeders: [] })
	}

	test("a blue jay on a feeder yields a plausible bird box on a frame it returns", { skip }, async () => {
		const { detections, frames } = await run("blue-jay.mp4")
		const best = detections[0]
		assert.ok(best, "no detections")
		assert.equal(best.label, "bird")
		assert.ok(best.score >= 0.3, `best bird score ${best.score}`)
		// a close-up jay fills a good part of the frame, but not all of it
		const a = best.box.w * best.box.h
		assert.ok(a > 0.02 && a < 0.6, `box area ${a}`)
		assert.ok(best.box.x + best.box.w <= 1 && best.box.y + best.box.h <= 1)
		assert.ok(frames.get(best.frameT)?.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), "frame for the best detection is a JPEG")
		assert.equal(detector.status().ready, true)
	})

	test("an empty, static feeder yields nothing, even from the second look", { skip }, async () => {
		const { detections, frames } = await run("static.mp4")
		assert.deepEqual(detections, [])
		assert.equal(frames.size, 4)
	})

	const viewsRun = () => Number(/over (\d+) views/.exec(detector.status().detail)?.[1] ?? 0)
	const withMotion = async (file: string, queries: string[]) => {
		const path = join(videos, file)
		const p = await probe(path)
		const motion = await runMotionGate(path, p, { ...Config.assert({}).pipeline.motion, roi: null })
		return { motion, input: { clipId: file, clipPath: path, probe: p, motion, queries, roi: null, feeders: [] } }
	}

	test("the second look finds the squirrel the motion boxes missed, but only in a clip that moved", { skip }, async () => {
		// hand-labelled from the frame at 7.5 s: the squirrel hangs under the feeder for the whole clip
		const squirrel = { x: 0.324, y: 0.34, w: 0.066, h: 0.396 }
		const { motion, input } = await withMotion("squirrel.mp4", ["bird", "squirrel"])
		const { detections } = await detector.detectClip(input)
		assert.equal(detections[0]?.label, "squirrel", JSON.stringify(detections))
		assert.ok(detections[0]!.score >= 0.3, `score ${detections[0]!.score}`)
		assert.ok(iou(detections[0]!.box, squirrel) > 0.4, JSON.stringify(detections[0]!.box))
		const still = await detector.detectClip({ ...input, motion: { ...motion, passed: false } })
		assert.deepEqual(still.detections, [])
	})

	test("falling snow on an empty feeder passes motion but the second look finds nothing", { skip }, async () => {
		// its tiles see the suet cake close up, which OWL-ViT scores ~0.2 as "squirrel": over the
		// threshold, under the bar for speculative views
		const { motion, input } = await withMotion("empty-feeder-snow.mp4", ["bird", "squirrel"])
		assert.equal(motion.passed, true)
		const { detections } = await detector.detectClip(input)
		assert.deepEqual(detections, [])
	})

	test("a clip with a detection gets no second look", { skip }, async () => {
		const { input } = await withMotion("blue-jay.mp4", ["bird"])
		const before = viewsRun()
		const { detections, frames } = await detector.detectClip(input)
		assert.equal(detections[0]?.label, "bird")
		// every view run was a frame's ROI view or a motion zoom; one frame of tiles alone is more
		assert.ok(viewsRun() - before <= frames.size * (1 + MAX_ZOOMS), `${viewsRun() - before} views on ${frames.size} frames`)
	})

	test("a model process that dies between clips is replaced by the next clip, with the same detections", { skip }, async () => {
		const before = await run("blue-jay.mp4")
		// the model runs in this process's one child that runs detect-host.ts
		const pid = Number(execFileSync("pgrep", ["-P", String(process.pid), "-f", "detect-host.ts"]).toString().trim())
		process.kill(pid, "SIGKILL")
		for (const end = Date.now() + 5000; detector.status().ready && Date.now() < end; ) await new Promise(r => setTimeout(r, 20))
		assert.equal(detector.status().detail, "the detector process exited (SIGKILL)")
		assert.deepEqual((await run("blue-jay.mp4")).detections, before.detections)
		assert.equal(detector.status().ready, true)
	})
})

test("a disabled detector reports off without loading anything", () => {
	const d = createDetector({ enabled: false, model: "Xenova/owlvit-base-patch32", threshold: 0.1, zoom: true }, "/nonexistent")
	assert.deepEqual(d.status(), { enabled: false, model: "Xenova/owlvit-base-patch32", ready: false, detail: "off" })
})
