import { test } from "node:test"
import assert from "node:assert/strict"
import sharp from "sharp"
import { judgeClip } from "../src/pipeline/judge.ts"
import { buildCrops, cropRegion, pickDetections } from "../src/pipeline/crops.ts"
import { createMockLlm } from "../src/llm/mock.ts"
import type { LlmRequest, VisionLLM } from "../src/llm/types.ts"
import type { Config } from "../src/config.ts"
import type { JudgeCrop } from "../src/pipeline/types.ts"
import type { Clip, Detection, Lookout, NormBox } from "../src/types.ts"

const clip: Clip = {
	id: "20261014-153012-a1b2c3",
	source: "scan",
	sourceRef: null,
	originalName: "feeder.mp4",
	path: "/tmp/feeder.mp4",
	sizeBytes: 1,
	sha256: "a1b2c3",
	recordedAt: "2026-10-14T15:30:12.000Z",
	ingestedAt: "2026-10-14T15:31:00.000Z",
	durationS: 12,
	width: 1280,
	height: 720,
	status: "processing",
	droppedAt: null,
	reason: null,
	motion: null,
	timings: {},
	error: null,
	processedAt: null,
	expiresAt: null,
	pendingLookouts: null,
	media: { poster: null, preview: null, crops: [] }
}

const lookout = (id: string, queries: string[]): Lookout => ({
	id,
	name: id,
	prompt: `a ${id}`,
	enabled: true,
	threshold: 0.6,
	compiled: { queries, rubric: `a visible ${id}`, summary: id, fineGrained: false, promptHash: "h", compiler: "manual" },
	createdAt: "",
	updatedAt: ""
})

const crop = (label: string): JudgeCrop => ({ jpeg: Buffer.from("jpeg"), frameT: 1.5, label, score: 0.42, box: { x: 0.4, y: 0.4, w: 0.1, h: 0.1 } })

const cfg = (over: Partial<Config["pipeline"]["judge"]> = {}): Config["pipeline"]["judge"] => ({
	provider: "mock",
	model: "claude-haiku-5-5",
	escalateModel: null,
	escalateBelow: 0.6,
	maxCrops: 4,
	cropSize: 512,
	...over
})

/** A VisionLLM that answers from a function and records what it was asked. */
const scripted = (respond: (req: LlmRequest) => unknown) => {
	const calls: LlmRequest[] = []
	const llm: VisionLLM = {
		backend: "anthropic",
		model: "claude-haiku-5-5",
		check: async () => ({ ok: true, detail: "" }),
		complete: async req => {
			calls.push(req)
			const json = respond(req)
			const model = req.model ?? "claude-haiku-5-5"
			return {
				json,
				raw: typeof json === "string" ? json : JSON.stringify(json),
				usage: { ts: "", clipId: req.clipId, purpose: "judge", backend: "anthropic", model, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, costUsd: 0.00015 }
			}
		}
	}
	return { llm, calls }
}

const input = (lookouts: Lookout[], crops = [crop("bird")]) => ({ clip, lookouts, crops, context: Buffer.from("ctx") })

test("judge: output that does not match the schema throws, quoting the raw answer", async () => {
	const { llm } = scripted(() => "Sure! It's a cardinal.")
	await assert.rejects(judgeClip(input([lookout("cardinal", ["bird"])]), llm, cfg()), /judge returned malformed output.*Sure! It's a cardinal\./)
})

test("judge: a lookout the model skipped gets an explicit no-answer verdict", async () => {
	const { llm } = scripted(() => ({
		verdicts: [{ lookoutId: "cardinal", rationale: "Red, crested, black mask.", label: "Northern Cardinal (male)", match: true, confidence: 0.94 }]
	}))
	const out = await judgeClip(input([lookout("cardinal", ["bird"]), lookout("squirrel", ["squirrel"])]), llm, cfg())
	assert.deepEqual(
		out.verdicts.map(v => [v.lookoutId, v.match, v.confidence, v.label, v.rationale, v.model]),
		[
			["cardinal", true, 0.94, "Northern Cardinal (male)", "Red, crested, black mask.", "anthropic:claude-haiku-5-5"],
			["squirrel", false, 0, null, "judge gave no answer", "anthropic:claude-haiku-5-5"]
		]
	)
})

test("judge: an uncertain verdict is re-asked of the escalation model, which wins; both usages are kept", async () => {
	const { llm, calls } = scripted(req =>
		req.model === "claude-sonnet-5-5"
			? { verdicts: [{ lookoutId: "cardinal", rationale: "Crest and mask visible.", label: "Northern Cardinal (female)", match: true, confidence: 0.86 }] }
			: {
					verdicts: [
						{ lookoutId: "cardinal", rationale: "Brownish bird, bill unclear.", label: "finch-like bird", match: true, confidence: 0.45 },
						{ lookoutId: "squirrel", rationale: "No mammal visible.", label: null, match: false, confidence: 0.97 }
					]
				}
	)
	const out = await judgeClip(input([lookout("cardinal", ["bird"]), lookout("squirrel", ["squirrel"])]), llm, cfg({ escalateModel: "claude-sonnet-5-5" }))
	assert.deepEqual(
		out.verdicts.map(v => [v.lookoutId, v.match, v.confidence, v.model]),
		[
			["cardinal", true, 0.86, "anthropic:claude-sonnet-5-5"],
			["squirrel", false, 0.97, "anthropic:claude-haiku-5-5"]
		]
	)
	assert.deepEqual(out.usage.map(u => u.model), ["claude-haiku-5-5", "claude-sonnet-5-5"])
	// only the uncertain lookout goes to the expensive model
	assert.match(calls[1]!.text, /lookout id=cardinal /)
	assert.doesNotMatch(calls[1]!.text, /lookout id=squirrel /)
})

test("judge: the life list rides in the clip's text, and each verdict's species comes back trimmed, its confidence clamped (both null when the answer names none or is under 50% sure)", async () => {
	const { llm, calls } = scripted(() => ({
		verdicts: [
			{ lookoutId: "new", rationale: "Grey dove shape.", label: "Mourning Dove (likely)", species: " Mourning Dove ", speciesConfidence: 1.4, match: true, confidence: 0.8 },
			{ lookoutId: "squirrel", rationale: "No mammal.", label: null, speciesConfidence: 0.7, match: false, confidence: 0.9 },
			{ lookoutId: "guess", rationale: "Small streaky bird.", label: "small brown bird", species: "House Wren", speciesConfidence: 0.3, match: false, confidence: 0.7 }
		]
	}))
	const out = await judgeClip({ ...input([lookout("new", ["bird"]), lookout("squirrel", ["squirrel"]), lookout("guess", ["bird"])]), lifeList: ["Blue Jay", "House Finch"], lifeListWithoutClip: ["House Finch"] }, llm, cfg())
	assert.deepEqual(
		out.verdicts.map(v => [v.species, v.speciesConfidence]),
		[
			["Mourning Dove", 1],
			[null, null],
			// under 50% is a guess, not a species to offer for the life list
			[null, null]
		]
	)
	assert.match(calls[0]!.text, /^Life list, this camera's regulars \(2 species\): Blue Jay; House Finch\.$/m)
	// which species lack a clip is look4's business, not a hint to the judge
	assert.doesNotMatch(calls[0]!.text, /without a clip/i)
})

test("judge: a life-list lookout keeps only a species new for its mode named at 75% or more, whatever the judge answered, and its prompt is withheld", async () => {
	const lifeLookout = (id: string, lifeList: "new" | "newOrClipless"): Lookout => {
		const l = lookout(id, ["bird"])
		return { ...l, prompt: "a species not on my life list, 50%+ is fine", compiled: { ...l.compiled!, lifeList } }
	}
	const said = (species: string, speciesConfidence: number) => ({ rationale: "Seen.", label: species, species, speciesConfidence, match: true, confidence: 0.8 })
	const run = async (species: string, speciesConfidence: number, mode: "new" | "newOrClipless") => {
		const { llm, calls } = scripted(() => ({ verdicts: [{ lookoutId: "lifer", ...said(species, speciesConfidence) }] }))
		const out = await judgeClip({ ...input([lifeLookout("lifer", mode)]), lifeList: ["Mourning Dove", "House Finch"], lifeListWithoutClip: ["House Finch"] }, llm, cfg())
		const v = out.verdicts[0]!
		return { verdict: [v.match, v.confidence, v.rationale.split(".")[0]], text: calls[0]!.text }
	}
	const lifer = await run("Dark-eyed Junco", 0.9, "new")
	assert.deepEqual(lifer.verdict, [true, 0.8, "Seen"])
	assert.doesNotMatch(lifer.text, /50%\+/)
	// the morning of 2026-10-22: a Mourning Dove read as a Junco at 55%
	assert.deepEqual((await run("Dark-eyed Junco", 0.55, "new")).verdict, [false, 0.55, "Dark-eyed Junco at 55% is under the 75% a new species needs"])
	assert.deepEqual((await run("Mourning Dove", 0.95, "newOrClipless")).verdict, [false, 0.95, "Mourning Dove is already on the life list with a clip"])
	// a regular added by hand without a clip only counts when the lookout asks for those
	assert.deepEqual((await run("House Finch", 0.9, "newOrClipless")).verdict, [true, 0.8, "Seen"])
	assert.deepEqual((await run("House Finch", 0.9, "new")).verdict, [false, 0.9, "House Finch is already on the life list"])
	// a listed regular still owed a clip is no lifer claim, so a plain majority call is enough
	assert.deepEqual((await run("House Finch", 0.6, "newOrClipless")).verdict, [true, 0.6, "Seen"])
})

test("judge: a life-list lookout keeps a clip for any bird in it, not only the one its verdict names", async () => {
	const l = lookout("lifer", ["bird"])
	const lifer: Lookout = { ...l, compiled: { ...l.compiled!, lifeList: "newOrClipless" } }
	const run = async (birds: { species: string; confidence: number }[]) => {
		const { llm, calls } = scripted(() => ({
			identification: "A chickadee on the port; a nuthatch head-down on the post.",
			birds,
			verdicts: [{ lookoutId: "lifer", rationale: "Birds at the feeder.", label: "Black-capped Chickadee", species: "Black-capped Chickadee", speciesConfidence: 0.9, match: true, confidence: 0.9 }]
		}))
		const out = await judgeClip(
			{ ...input([lifer]), lifeList: ["Black-capped Chickadee", "White-breasted Nuthatch", "Mourning Dove"], lifeListWithoutClip: ["White-breasted Nuthatch"] },
			llm,
			cfg()
		)
		const v = out.verdicts[0]!
		return { verdict: [v.match, v.species, v.speciesConfidence, v.rationale.split(".")[0]], schema: calls[0]!.schema }
	}
	// 2026-10-22: chickadees and nuthatches at the left feeder, every clip rejected as "chickadee already has a clip"
	const mixed = await run([
		{ species: "Black-capped Chickadee", confidence: 0.9 },
		{ species: " White-breasted Nuthatch ", confidence: 0.65 }
	])
	assert.deepEqual(mixed.verdict, [true, "White-breasted Nuthatch", 0.65, "Birds at the feeder"])
	assert.deepEqual((mixed.schema as { required: string[] }).required, ["identification", "birds", "verdicts"])
	// under 50% the second bird is a guess and does not count
	assert.deepEqual((await run([{ species: "White-breasted Nuthatch", confidence: 0.4 }])).verdict, [false, "Black-capped Chickadee", 0.9, "Black-capped Chickadee is already on the life list with a clip"])
	// an unlisted species still needs the lifer bar, wherever in the clip it was seen
	assert.deepEqual((await run([{ species: "Red-breasted Nuthatch", confidence: 0.6 }])).verdict, [false, "Black-capped Chickadee", 0.9, "Black-capped Chickadee is already on the life list with a clip"])
	assert.deepEqual((await run([{ species: "Red-breasted Nuthatch", confidence: 0.85 }])).verdict, [true, "Red-breasted Nuthatch", 0.85, "Birds at the feeder"])
})

test("judge: confidence below the escalation band is a confident no, not escalated", async () => {
	const { llm, calls } = scripted(() => ({
		verdicts: [{ lookoutId: "cardinal", rationale: "A leaf.", label: null, match: false, confidence: 0.29 }]
	}))
	await judgeClip(input([lookout("cardinal", ["bird"])]), llm, cfg({ escalateModel: "claude-sonnet-5-5" }))
	assert.equal(calls.length, 1)
})

test("judge with the mock backend: matches exactly the lookouts whose detector nouns a crop carries", async () => {
	const out = await judgeClip(
		input([lookout("cardinal", ["bird"]), lookout("squirrel", ["squirrel"])], [crop("bird"), crop("leaf")]),
		createMockLlm(),
		cfg()
	)
	assert.deepEqual(out.verdicts.map(v => [v.lookoutId, v.match, v.confidence]), [["cardinal", true, 0.9], ["squirrel", false, 0.9]])
})

const contains = (outer: NormBox, inner: NormBox) =>
	outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.w >= inner.x + inner.w && outer.y + outer.h >= inner.y + inner.h

test("cropRegion: pads and squares around the box; a tiny box gets the minimum side; an edge box stays in frame", () => {
	const box = { x: 0.4, y: 0.3, w: 0.2, h: 0.25 }
	const r = cropRegion(box, 1280, 720)
	assert.ok(contains(r, box) && r.x < box.x && r.y < box.y)
	assert.equal(Math.round(r.w * 1280), Math.round(r.h * 720), "square in pixels")
	// a 6×6 px bird mid-frame: the crop is the 96 px minimum, not 8 px of blur
	const tiny = { x: 0.5, y: 0.5, w: 6 / 1280, h: 6 / 720 }
	const t = cropRegion(tiny, 1280, 720)
	assert.ok(contains(t, tiny))
	assert.deepEqual([Math.round(t.w * 1280), Math.round(t.h * 720)], [96, 96])
	// a 47 px nuthatch on a 4K frame fills its crop rather than a fifth of it
	const nuthatch = { x: 0.16, y: 0.2, w: 47 / 3840, h: 72 / 2160 }
	const n = cropRegion(nuthatch, 3840, 2160)
	assert.deepEqual([Math.round(n.w * 3840), Math.round(n.h * 2160)], [122, 122])
	const corner = { x: 0.99, y: 0, w: 0.01, h: 0.02 }
	const c = cropRegion(corner, 1280, 720)
	assert.ok(contains(c, corner) && c.x + c.w <= 1 && c.y >= 0)
})

const det = (frameT: number, score: number, box: NormBox): Detection => ({ clipId: clip.id, frameT, label: "bird", score, box, via: "full" })

test("pickDetections: every subject gets a crop before any gets a second, from a new frame, without same-frame duplicates", () => {
	const a = det(1, 0.9, { x: 0.1, y: 0.1, w: 0.2, h: 0.2 })
	const aDup = det(1, 0.8, { x: 0.11, y: 0.1, w: 0.2, h: 0.2 })
	const other = det(1, 0.7, { x: 0.6, y: 0.6, w: 0.2, h: 0.2 })
	const aLater = det(2, 0.5, { x: 0.12, y: 0.11, w: 0.2, h: 0.2 })
	assert.deepEqual(pickDetections([aDup, aLater, other, a], 2), [a, other])
	assert.deepEqual(pickDetections([aDup, aLater, other, a], 4), [a, other, aLater])
})

test("pickDetections: a cardinal that outscores the woodpecker on every frame still leaves the woodpecker its close-ups", () => {
	const left = { x: 0.1, y: 0.3, w: 0.15, h: 0.2 }
	const right = { x: 0.6, y: 0.4, w: 0.1, h: 0.25 }
	const cardinal = [1, 2, 3, 4].map(t => det(t, 0.9 - t / 100, left))
	const woodpecker = [1, 3].map(t => det(t, 0.3 - t / 100, right))
	const squirrel = { ...det(2, 0.2, { x: 0.4, y: 0.7, w: 0.2, h: 0.2 }), label: "squirrel" }
	assert.deepEqual(pickDetections([...cardinal, ...woodpecker], 4), [cardinal[0], woodpecker[0], cardinal[1], woodpecker[1]])
	// labels interleave too: the lone weak squirrel is not pushed out by a second bird
	assert.deepEqual(pickDetections([...cardinal, ...woodpecker, squirrel], 3), [cardinal[0], squirrel, woodpecker[0]])
})

test("buildCrops: the crop shows the whole detected object and has the requested long edge", async () => {
	const W = 1280
	const H = 720
	// grey frame, one red 40×30 "bird" at (600, 300)
	const red = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer()
	const frame = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 128, g: 128, b: 128 } } })
		.composite([{ input: red, left: 600, top: 300 }])
		.jpeg({ quality: 95 })
		.toBuffer()
	const box = { x: 600 / W, y: 300 / H, w: 40 / W, h: 30 / H }
	const frames = new Map([[2.5, frame]])
	const [fine] = await buildCrops(frames, [det(2.5, 0.4, box)], { maxCrops: 4, cropSize: 512, fineGrained: true })
	const [coarse] = await buildCrops(frames, [det(2.5, 0.4, box)], { maxCrops: 4, cropSize: 512, fineGrained: false })
	assert.ok(fine && coarse)
	const fm = await sharp(fine.jpeg).metadata()
	const cm = await sharp(coarse.jpeg).metadata()
	assert.equal(Math.max(fm.width!, fm.height!), 512)
	assert.equal(Math.max(cm.width!, cm.height!), 384)
	assert.deepEqual([fine.frameT, fine.label, fine.box], [2.5, "bird", box])
	// every red pixel of the object made it in: red-dominant area ≈ object area scaled into the crop
	const { data, info } = await sharp(fine.jpeg).raw().toBuffer({ resolveWithObject: true })
	let redPx = 0
	let redOnBorder = false
	for (let y = 0; y < info.height; y++)
		for (let x = 0; x < info.width; x++) {
			const i = (y * info.width + x) * info.channels
			if (data[i]! > 200 && data[i + 1]! < 80 && data[i + 2]! < 80) {
				redPx++
				if (x === 0 || y === 0 || x === info.width - 1 || y === info.height - 1) redOnBorder = true
			}
		}
	const region = cropRegion(box, W, H)
	const scale = info.width / (region.w * W)
	const expected = 40 * 30 * scale * scale
	assert.equal(redOnBorder, false)
	assert.ok(redPx > expected * 0.85 && redPx < expected * 1.15, `red ${redPx} vs expected ~${Math.round(expected)}`)
})
