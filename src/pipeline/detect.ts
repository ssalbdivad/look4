// Stage 2: a local open-vocabulary detector (transformers.js on onnxruntime-node, CPU, in the
// child process detect-host.ts).
// It answers "is there a bird/squirrel/… anywhere near the motion?" for free, so the
// paid judge only sees clips with a plausible subject.

import { fork } from "node:child_process"
import { existsSync } from "node:fs"
import { availableParallelism } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"
import type { Config } from "../config.ts"
import { logger } from "../log.ts"
import { clampBox, fromInner, toPixels } from "../geometry.ts"
import type { Detection, NormBox } from "../types.ts"
import type { HostReply, HostRequest, RawHit } from "./detect-host.ts"
import { frameSource } from "./detect-frames.ts"
import {
	evenTimes,
	labelToNoun,
	mergeFrameHits,
	modelFamily,
	queryBatches,
	saturated,
	tileViews,
	viewsFor,
	type QueryBatch,
	type View,
	type ViewHit
} from "./detect-views.ts"
import type { DetectInput, DetectOutput, Detector, DetectorStatus } from "./types.ts"

const log = logger("detect")

type DetectorConfig = Config["pipeline"]["detector"]

/** dtype used when the model id carries no `:dtype` suffix. q8 measured ~2x faster than fp32 with the same hits. */
export const DEFAULT_DTYPE = "q8"
const DTYPES = ["fp32", "fp16", "q8", "int8", "uint8", "q4", "bnb4", "q4f16"] as const
type Dtype = (typeof DTYPES)[number]

/** File transformers.js downloads for each dtype (its DEFAULT_DTYPE_SUFFIX_MAPPING). */
const onnxFile = (dtype: Dtype) => (dtype === "fp32" ? "model.onnx" : dtype === "q8" ? "model_quantized.onnx" : `model_${dtype}.onnx`)

/** Download sizes (MB, ONNX + tokenizer) for the models we benchmarked, for first-run messages. */
const KNOWN_SIZES_MB: Record<string, Partial<Record<Dtype, number>>> = {
	"Xenova/owlvit-base-patch32": { q8: 158, fp32: 615 },
	"Xenova/owlv2-base-patch16-ensemble": { q8: 158, fp32: 617 },
	"onnx-community/grounding-dino-tiny-ONNX": { q8: 207, fp32: 722 }
}

/** Frames sampled when the motion gate handed over none (it was skipped or found nothing to rank). */
const EVEN_FRAMES = 4
/** A hit this strong is unambiguous; once every query has that on `SATURATE_FRAMES` frames, stop running frames (and, in seek mode, decoding them). */
const confidentScore = (threshold: number) => Math.max(0.3, threshold * 2)
const SATURATE_FRAMES = 2
/** Long edge each view is downscaled to before inference. Every candidate model's input is ≤ 1024 on a side. */
const VIEW_MAX_EDGE = 1024
/**
 * Frames (the motion gate's best) that get the tiled second look when a clip that moved
 * yielded no detection at all. Two, because a half-hidden subject's score swings a lot
 * from frame to frame (the squirrel fixture: 0.36-0.57, but one frame of five at 0.15).
 */
const SECOND_LOOK_FRAMES = 2
/**
 * Zooms on secondary motion blobs per clip, spent on the best frames first. A windy scene
 * has a dozen blobs per frame, nearly all leaves, so a per-frame cap alone would double
 * the cost of every clip that moved.
 */
const EXTRA_ZOOMS_PER_CLIP = 4

/** `Xenova/owlvit-base-patch32:fp32` → id + dtype. Hub ids never contain ":", so the suffix is unambiguous. */
export const parseModelSpec = (spec: string): { id: string; dtype: Dtype } => {
	const i = spec.lastIndexOf(":")
	if (i > 0) {
		const d = spec.slice(i + 1) as Dtype
		if (DTYPES.includes(d)) return { id: spec.slice(0, i), dtype: d }
	}
	return { id: spec, dtype: DEFAULT_DTYPE }
}

/** Whether the model's weights are already in `modelsDir` (no download needed). */
export const isModelCached = (spec: string, modelsDir: string) => {
	const { id, dtype } = parseModelSpec(spec)
	return existsSync(join(modelsDir, id, "onnx", onnxFile(dtype))) && existsSync(join(modelsDir, id, "config.json"))
}

/** ORT intra-op threads: half the cores, so ffmpeg decodes and the web server stay responsive. */
const inferenceThreads = () => Math.max(2, Math.min(8, Math.floor(availableParallelism() / 2)))

type Image = { data: Uint8Array; width: number; height: number }

type Loaded = {
	state: "loading" | "ready" | "error"
	detail: string
	promise: Promise<void>
	run: (image: Image, labels: string[], threshold: number) => Promise<RawHit[]>
	views: number
	inferMs: number
}

// One loaded model per (model, dtype, cache dir) for the whole process: weights are
// hundreds of MB and the ORT session is thread-hungry, so detectors created by tests,
// the worker and `look4 doctor` all share it.
const loaded = new Map<string, Loaded>()

const HOST = fileURLToPath(new URL("./detect-host.ts", import.meta.url))

const load = (spec: string, modelsDir: string): Loaded => {
	const key = `${spec}|${modelsDir}`
	const existing = loaded.get(key)
	if (existing && existing.state !== "error") return existing
	const { id, dtype } = parseModelSpec(spec)
	const sizeMb = KNOWN_SIZES_MB[id]?.[dtype]
	const firstRun = !isModelCached(spec, modelsDir)
	const entry: Loaded = {
		state: "loading",
		detail: firstRun ? `downloading model (first run${sizeMb ? `, ~${sizeMb} MB` : ""})` : "loading model",
		promise: Promise.resolve(),
		run: () => Promise.reject(new Error("detector model is not loaded")),
		views: 0,
		inferMs: 0
	}
	const started = performance.now()
	// The model runs in a child process (see detect-host.ts for why). Requests go one at a time:
	// ORT already spreads a single run across threads, and two concurrent runs would just
	// fight over the same cores.
	const host = fork(HOST, [], {
		serialization: "advanced",
		// not the parent's flags: under `node --test` those would make the host a test runner
		execArgv: ["--disable-warning=ExperimentalWarning"],
		stdio: ["ignore", "inherit", "inherit", "ipc"]
	})
	const pending = new Map<number, { resolve: (hits: RawHit[]) => void; reject: (e: Error) => void }>()
	let seq = 0
	let onLoad: { resolve: () => void; reject: (e: Error) => void } | null = null
	// An idle host must not keep a CLI command or a test alive; a busy one must, or the
	// process could exit under an await.
	let busy = 0
	const hold = () => {
		if (busy++ === 0) {
			host.ref()
			host.channel?.ref()
		}
	}
	const release = () => {
		if (--busy === 0) {
			host.unref()
			host.channel?.unref()
		}
	}
	const fail = (e: Error) => {
		if (onLoad) onLoad.reject(e)
		onLoad = null
		for (const p of pending.values()) p.reject(e)
		pending.clear()
	}
	let lastPct = -1
	host.on("message", (m: HostReply) => {
		if (m.type === "progress") {
			// progress events also fire while reading a cached model from disk; only a real download is news
			if (!firstRun) return
			const pct = Math.floor(m.progress)
			entry.detail = `downloading model (first run, ${pct}% of ${Math.round(m.total / 1e6)} MB)`
			if (pct >= lastPct + 25 || (pct === 100 && lastPct < 100)) {
				lastPct = pct
				log.info(`${id}: ${entry.detail}`)
			}
		} else if (m.type === "ready") {
			onLoad?.resolve()
			onLoad = null
		} else if (m.type === "result") {
			entry.views++
			entry.inferMs += m.ms
			pending.get(m.seq)?.resolve(m.hits)
			pending.delete(m.seq)
		} else if (m.seq === null) {
			onLoad?.reject(new Error(m.message))
			onLoad = null
		} else {
			pending.get(m.seq)?.reject(new Error(m.message))
			pending.delete(m.seq)
		}
	})
	host.on("error", e => fail(e))
	host.on("exit", (code, signal) => {
		const e = new Error(`the detector process exited (${signal ?? `code ${code}`})`)
		fail(e)
		// a crash (out of memory, say) costs the clip in flight; the next one starts a fresh host
		if (entry.state === "ready") {
			entry.state = "error"
			entry.detail = e.message
			log.error(`${id}: ${e.message}`)
		}
	})
	const request = (m: HostRequest) =>
		host.send(m, e => {
			if (e) fail(e)
		})
	entry.promise = (async () => {
		hold()
		try {
			await new Promise<void>((resolve, reject) => {
				onLoad = { resolve, reject }
				request({ type: "load", id, dtype, modelsDir, threads: inferenceThreads() })
			})
		} finally {
			release()
		}
		let chain: Promise<unknown> = Promise.resolve()
		entry.run = (image, labels, threshold) => {
			const next = chain.then(
				() =>
					new Promise<RawHit[]>((resolve, reject) => {
						const n = ++seq
						hold()
						pending.set(n, {
							resolve: hits => {
								release()
								resolve(hits)
							},
							reject: e => {
								release()
								reject(e)
							}
						})
						request({ type: "run", seq: n, labels, threshold, ...image })
					})
			)
			chain = next.catch(() => {})
			return next
		}
		entry.state = "ready"
		entry.detail = `ready (${dtype}, CPU, loaded in ${((performance.now() - started) / 1000).toFixed(1)}s)`
		log.info(`${id}: ${entry.detail}`)
	})().catch((e: unknown) => {
		entry.state = "error"
		const msg = e instanceof Error ? e.message : String(e)
		entry.detail = `failed to load ${id} (${dtype}): ${msg}`
		log.error(entry.detail)
		host.kill()
		throw e
	})
	// a rejected warmup must not become an unhandled rejection; callers await `promise` themselves
	entry.promise.catch(() => {})
	loaded.set(key, entry)
	return entry
}

type RawFrame = { data: Buffer; width: number; height: number; channels: 1 | 2 | 3 | 4 }

/** Crops `box` out of a decoded frame and downscales it to the RGB image the model gets. */
const viewImage = async (frame: RawFrame, box: NormBox): Promise<{ image: Image; box: NormBox }> => {
	const px = toPixels(box, frame.width, frame.height)
	const { data, info } = await sharp(frame.data, { raw: { width: frame.width, height: frame.height, channels: frame.channels } })
		.extract(px)
		.resize({ width: VIEW_MAX_EDGE, height: VIEW_MAX_EDGE, fit: "inside", withoutEnlargement: true })
		.removeAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true })
	return {
		image: { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height },
		// the integer pixel rect is what the model actually saw; map boxes back through it, not the requested box
		box: { x: px.left / frame.width, y: px.top / frame.height, w: px.width / frame.width, h: px.height / frame.height }
	}
}

const toViewHits = (raw: RawHit[], image: Image, batch: QueryBatch): ViewHit[] =>
	raw.flatMap(r => {
		const label = labelToNoun(r.label, batch)
		if (!label) return []
		const { xmin, ymin, xmax, ymax } = r.box
		return [{
			label,
			score: r.score,
			box: { x: xmin / image.width, y: ymin / image.height, w: (xmax - xmin) / image.width, h: (ymax - ymin) / image.height }
		}]
	})

/** A hit on a still, its box in the still's full-frame coordinates. */
export type StillHit = { label: string; score: number; box: NormBox }

/**
 * One view of one still: `box` of the JPEG, cut out and scaled like a clip's views, run for
 * `nouns` at the configured threshold; hits come back best first. It shares the clips' model and
 * their one-at-a-time queue, so it waits at most for the view in flight. Close-ups use it to ask
 * "is that movement a bird?" before turning the camera (src/live/closeup.ts).
 */
export const detectStill = async (cfg: DetectorConfig, modelsDir: string, input: { jpeg: Buffer; box: NormBox; nouns: string[] }): Promise<StillHit[]> => {
	const model = load(cfg.model, modelsDir)
	await model.promise
	const { width, height } = await sharp(input.jpeg).metadata()
	if (!width || !height) throw new Error("the still has no size")
	// only the view is decoded at full size: a whole 4K frame is ~0.1 s of sharp's time
	const px = toPixels(input.box, width, height)
	const { data, info } = await sharp(input.jpeg)
		.extract(px)
		.resize({ width: VIEW_MAX_EDGE, height: VIEW_MAX_EDGE, fit: "inside", withoutEnlargement: true })
		.removeAlpha()
		.toColourspace("srgb")
		.raw()
		.toBuffer({ resolveWithObject: true })
	const image = { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height }
	const view = { x: px.left / width, y: px.top / height, w: px.width / width, h: px.height / height }
	const hits: StillHit[] = []
	for (const batch of queryBatches(input.nouns, modelFamily(parseModelSpec(cfg.model).id)))
		for (const h of toViewHits(await model.run(image, batch.prompts, cfg.threshold), image, batch)) hits.push({ ...h, box: clampBox(fromInner(h.box, view)) })
	return hits.sort((a, b) => b.score - a.score)
}

export const createDetector = (cfg: DetectorConfig, modelsDir: string): Detector => {
	const spec = cfg.model
	const { id, dtype } = parseModelSpec(spec)
	const family = modelFamily(id)
	const current = () => loaded.get(`${spec}|${modelsDir}`)

	const status = (): DetectorStatus => {
		if (!cfg.enabled) return { enabled: false, model: spec, ready: false, detail: "off" }
		const m = current()
		if (!m) {
			const sizeMb = KNOWN_SIZES_MB[id]?.[dtype]
			return {
				enabled: true,
				model: spec,
				ready: false,
				detail: isModelCached(spec, modelsDir)
					? "not loaded yet (loads on first clip)"
					: `not downloaded yet (first run downloads${sizeMb ? ` ~${sizeMb} MB` : " the model"})`
			}
		}
		const perView = m.views ? `, ${(m.inferMs / m.views / 1000).toFixed(2)} s/view over ${m.views} views` : ""
		return { enabled: true, model: spec, ready: m.state === "ready", detail: m.detail + (m.state === "ready" ? perView : "") }
	}

	const warmup = async () => {
		await load(spec, modelsDir).promise
	}

	const detectClip = async (input: DetectInput): Promise<DetectOutput> => {
		const model = load(spec, modelsDir)
		await model.promise
		const nouns = [...new Set(input.queries.map(q => q.trim()).filter(Boolean))]
		const frames = new Map<number, Buffer>()
		const detections: Detection[] = []
		if (!nouns.length) return { detections, frames }
		const batches = queryBatches(nouns, family)
		const candidates = input.motion.frames.length
			? input.motion.frames.map(f => ({ t: f.t, box: f.box, boxes: f.boxes ?? [] }))
			: evenTimes(input.probe.durationS, EVEN_FRAMES).map(t => ({ t, box: null, boxes: [] }))
		const confident = confidentScore(cfg.threshold)
		const started = performance.now()
		const source = await frameSource(input.clipPath, [...new Set(candidates.map(c => c.t))], input.probe.fps, input.signal)
		// decoded RGB of the best frames, kept for the second look so it need not decode them again
		const kept = new Map<number, RawFrame>()
		let views = 0
		let extraZooms = EXTRA_ZOOMS_PER_CLIP
		let failed = 0
		let lastError: unknown = null
		const look = async (t: number, frame: RawFrame, frameViews: View[]) => {
			const perView = []
			for (const v of frameViews) {
				input.signal?.throwIfAborted()
				const { image, box } = await viewImage(frame, v.box)
				const hits: ViewHit[] = []
				for (const batch of batches) hits.push(...toViewHits(await model.run(image, batch.prompts, cfg.threshold), image, batch))
				views++
				perView.push({ view: { ...v, box }, hits })
			}
			return mergeFrameHits(input.clipId, t, perView, cfg.threshold, 0.5, confident)
		}
		for (const c of candidates) {
			input.signal?.throwIfAborted()
			if (saturated(detections, nouns, confident, SATURATE_FRAMES)) break
			if (frames.has(c.t)) continue
			let jpeg: Buffer
			try {
				jpeg = await source.get(c.t)
			} catch (e) {
				// one bad seek (past the end, a corrupt GOP) should not sink the clip
				failed++
				lastError = e
				log.debug(`${input.clipId}: no frame at ${c.t}s`, e)
				continue
			}
			frames.set(c.t, jpeg)
			// decoded once per frame, not once per view: a 4K JPEG is ~0.1 s of sharp's time each
			const { data, info } = await sharp(jpeg).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true })
			const frame = { data, width: info.width, height: info.height, channels: info.channels }
			if (kept.size < SECOND_LOOK_FRAMES) kept.set(c.t, frame)
			const frameViews = viewsFor(c.box, input.roi, frame, cfg.zoom, c.boxes, input.feeders).filter(v => !v.speculative || extraZooms-- > 0)
			detections.push(...(await look(c.t, frame, frameViews)))
		}
		if (!frames.size && failed) throw lastError
		// Second look: something moved but nothing was found. The motion boxes may sit on wind in
		// the leaves while a small or half-hidden subject is elsewhere, so tile the ROI of the best
		// frames (already decoded) at a closer scale. Tiles see clutter close up too (a suet cake
		// scored 0.22 as "squirrel"), so, being speculative views, they only count at the confident score.
		const normalViews = views
		if (!detections.length && input.motion.passed && cfg.zoom)
			for (const [t, frame] of kept) {
				const found = await look(t, frame, tileViews(input.roi, frame))
				detections.push(...found)
				if (found.length) break
			}
		detections.sort((a, b) => b.score - a.score)
		log.debug(
			`${input.clipId}: ${frames.size}/${candidates.length} frames (${source.mode}), ${normalViews} views${views > normalViews ? ` + ${views - normalViews} tiles` : ""}, ${detections.length} hits in ${Math.round(performance.now() - started)}ms`
		)
		return { detections, frames }
	}

	return { status, warmup, detectClip }
}
