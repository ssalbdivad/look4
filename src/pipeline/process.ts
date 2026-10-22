// The cascade for one clip, cheapest stage first: probe → motion → detect → judge → decide.
// `runCascade` is the side-effect-free core (eval dry-runs it); `processClip` wraps it with
// the DB writes, file moves and media the worker needs.

import { existsSync } from "node:fs"
import { appendFile, copyFile, mkdir, readdir, rename, rm, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import sharp from "sharp"
import type { SightingEvent } from "../api-types.ts"
import type { AppContext } from "../context.ts"
import { FULL_FRAME } from "../geometry.ts"
import { logger } from "../log.ts"
import { DETECTOR_ONLY, verdictKeeps } from "../db.ts"
import { isTransientError, usageOf } from "../llm/errors.ts"
import { extractFrame, makePreview, probe, type ProbeResult } from "../media/ffmpeg.ts"
import { clipMediaDir, localDate } from "../paths.ts"
import { mediaUrls } from "../server/dto.ts"
import type { Clip, ClipMedia, Detection, Lookout, MotionResult, Stage, Usage, Verdict } from "../types.ts"
import { isStale } from "./compile.ts"
import { buildCrops, contextImage, feederLook, pickDetections } from "./crops.ts"
import { judgeClip, type SeenBird } from "./judge.ts"
import { runMotionGate } from "./motion.ts"
import type { JudgeCrop } from "./types.ts"

const log = logger("process")

const DAY_MS = 86_400_000
const POSTER_EDGE = 1280

/** The reason the cascade gives a clip that arrived while no lookout was enabled. */
export const NO_LOOKOUTS = "no lookouts enabled"

export type CascadeRun = {
	/** The stage that ended this run early; null when the judge (or detector-only) ruled. */
	droppedAt: Stage | null
	/** Reason for an early drop ("no bird or squirrel detected"); null when the judge ruled. */
	dropReason: string | null
	probe: ProbeResult | null
	motion: MotionResult | null
	/** Every species the judge saw, with the crop that shows each best. */
	birds: SeenBird[]
	/** Detector detections and feeder visits (`via: "feeder"`), never the motion pseudo-detections. */
	detections: Detection[]
	/** Decoded frames keyed by `t`, for the poster. */
	frames: Map<number, Buffer>
	/** Lookouts that had a candidate detection and reached the judge. */
	judged: Lookout[]
	crops: JudgeCrop[]
	/** One per judged lookout. `match` is raw; thresholds are applied by `keepingVerdicts`. */
	verdicts: Verdict[]
	usage: Usage[]
	timings: Partial<Record<Stage, number>>
}

export class AbortedError extends Error {}

const checkAbort = (signal?: AbortSignal) => {
	if (signal?.aborted) throw new AbortedError("aborted")
}

const timed = async <t>(timings: CascadeRun["timings"], stage: Stage, fn: () => Promise<t>): Promise<t> => {
	const start = performance.now()
	try {
		return await fn()
	} finally {
		timings[stage] = Math.round(performance.now() - start)
	}
}

/** Error with the stage it happened in, so the clip's reason can say where it broke. */
export class StageError extends Error {
	readonly stage: Stage
	constructor(stage: Stage, cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause })
		this.stage = stage
	}
}

const atStage = async <t>(stage: Stage, fn: () => Promise<t>): Promise<t> => {
	try {
		return await fn()
	} catch (e) {
		if (e instanceof AbortedError || e instanceof StageError) throw e
		throw new StageError(stage, e)
	}
}

const norm = (s: string) => s.trim().toLowerCase()

/** "bird", "bird or squirrel", "bird, cat or squirrel" */
export const orList = (xs: string[]) =>
	xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`

const queriesOf = (l: Lookout) => (l.compiled?.queries ?? []).map(norm)

const noneDetected = (queries: string[]) => `no ${orList(queries)} detected`

/**
 * Lookouts whose compiled form is missing or stale get compiled now. Hand-edited
 * detector nouns (`compiler: "manual"`) are only replaced when the prompt itself
 * changed, which `updateLookout` already handles.
 */
export const ensureCompiled = async (ctx: AppContext, lookouts: Lookout[], persist: boolean): Promise<Lookout[]> => {
	const out: Lookout[] = []
	const upgraded = upgradeTried.get(ctx) ?? new Set<string>()
	upgradeTried.set(ctx, upgraded)
	for (const l of lookouts) {
		// a keyword-table compile (made while no judge was reachable) gets one LLM retry per process,
		// so a judge that later works also gets the better nouns and rubric, but a broken one is not asked per clip
		const upgrade = !!ctx.llm && l.compiled?.compiler === "fallback" && !upgraded.has(l.id)
		if (upgrade) upgraded.add(l.id)
		const needs = !l.compiled || upgrade || (l.compiled.compiler !== "manual" && isStale(l))
		if (!needs) {
			out.push(l)
			continue
		}
		const compiled = await ctx.compile(l.prompt)
		if (!persist) {
			out.push({ ...l, compiled })
			continue
		}
		// deleted while it was compiling: nothing left to judge for, or to save the compile to
		if (!ctx.store.getLookout(l.id)) continue
		out.push(ctx.store.updateLookout(l.id, { compiled }))
	}
	return out
}

const upgradeTried = new WeakMap<AppContext, Set<string>>()

/** Verdicts that keep a clip: a match at or above its lookout's threshold (see `verdictKeeps`). */
export const keepingVerdicts = (verdicts: Verdict[], lookouts: Map<string, Lookout>) =>
	verdicts
		.filter(v => {
			const l = lookouts.get(v.lookoutId)
			return !!l && verdictKeeps(v, l)
		})
		.sort((a, b) => b.confidence - a.confidence)

/**
 * Runs the cascade without touching the DB or moving files. `lookouts` must
 * already be compiled. Throws `StageError` on failure and `AbortedError` when
 * `signal` fires.
 */
export const runCascade = async (
	ctx: AppContext,
	clip: Clip,
	lookouts: Lookout[],
	signal?: AbortSignal
): Promise<CascadeRun> => {
	const cfg = ctx.config.pipeline
	const run: CascadeRun = {
		droppedAt: null,
		dropReason: null,
		probe: null,
		motion: null,
		detections: [],
		frames: new Map(),
		judged: [],
		birds: [],
		crops: [],
		verdicts: [],
		usage: [],
		timings: {}
	}
	const drop = (stage: Stage, reason: string) => {
		run.droppedAt = stage
		run.dropReason = reason
		return run
	}
	const path = clip.path
	if (!path || !existsSync(path)) throw new StageError("probe", new Error("the clip file is missing (deleted by retention?)"))

	checkAbort(signal)
	const probed = await atStage("probe", () => timed(run.timings, "probe", () => probe(path)))
	run.probe = probed

	checkAbort(signal)
	// A clip a stream's motion gate made already had something move in it. Over a whole-frame zone no
	// area floor here tells a small bird from wind (0.0002 passed 22/23 birds and 13/15 wind clips,
	// docs/decisions.md §12), so the stage doesn't get to drop it: it runs at the watch's own floor
	// only to pick the detector's frames and zoom boxes, and passes, so the detector's tiled second
	// look runs too when the zooms find nothing. With the detector off there is no second look, and
	// forcing the pass would only send every flagged clip to the paid judge: the stage decides then.
	const detectorOn = cfg.detector.enabled && ctx.detector.status().enabled
	const gate = ctx.store.getKv<string>(gateKey(clip.id))
	const motionOpts = { ...cfg.motion, roi: cfg.roi, ...(gate ? { minArea: Math.min(cfg.motion.minArea, GATED_MIN_AREA) } : {}) }
	let motion = await atStage("motion", () => timed(run.timings, "motion", () => runMotionGate(path, probed, motionOpts, signal)))
	if (gate && !motion.passed && detectorOn) motion = { ...motion, passed: true, reason: gatedReason(gate, motion.score) }
	run.motion = motion
	if (!motion.passed) return drop("motion", /^no motion/i.test(motion.reason) ? motion.reason : `no motion (${motion.reason})`)

	if (!lookouts.length) return drop("detect", NO_LOOKOUTS)

	checkAbort(signal)
	const queries = [...new Set(lookouts.flatMap(queriesOf))]
	const judgeOn = ctx.llm && cfg.judge.provider !== "none"
	let candidates: Lookout[]
	let evidence: Detection[]
	let sheets: JudgeCrop[] = []
	let visits: Detection[] = []
	if (detectorOn) {
		const out = await atStage("detect", () =>
			timed(run.timings, "detect", () =>
				ctx.detector.detectClip({ clipId: clip.id, clipPath: path, probe: probed, motion, queries, roi: cfg.roi, feeders: cfg.feeders, signal })
			)
		)
		run.detections = out.detections
		run.frames = out.frames
		const found = new Set(out.detections.map(d => norm(d.label)))
		candidates = lookouts.filter(l => queriesOf(l).some(q => found.has(q)))
		const wanted = new Set(candidates.flatMap(queriesOf))
		evidence = out.detections.filter(d => wanted.has(norm(d.label)))
		// A bird clinging to a feeder barely moves and is too small for the detector: a White-breasted
		// Nuthatch scored 0.04 on OWL-ViT even zoomed on the feeder (0.15 needed), and Grounding DINO
		// scored the empty feeder as "squirrel" as high as the bird. So every moving clip goes to the
		// judge with a sheet of each feeder and a close-up of whatever turned up on one (`feederLook`),
		// whatever else the detector found: looked at only when it found nothing, the feeders went
		// unseen behind the doves it found on the ground all day. One judge call per clip.
		if (cfg.feeders.length && judgeOn) {
			const start = performance.now()
			const look = await atStage("detect", () => feederLook(clip.id, path, probed, cfg.feeders, signal))
			// part of looking for a subject, so it counts toward the detect stage's time
			run.timings.detect = (run.timings.detect ?? 0) + Math.round(performance.now() - start)
			sheets = look.sheets
			visits = look.visits
			run.detections = [...run.detections, ...look.visits]
			candidates = lookouts
		}
		if (!candidates.length) return drop("detect", noneDetected(queries))
	} else {
		// Detector off: the motion gate's best frames stand in as "detections", every lookout goes to the judge.
		const top = motion.frames.slice(0, cfg.judge.maxCrops)
		const picks = top.length ? top : [{ t: Math.min(1, (probed.durationS || 0) / 2), score: motion.score, box: null }]
		evidence = await atStage("detect", () =>
			timed(run.timings, "detect", async () => {
				const dets: Detection[] = []
				for (const f of picks) {
					checkAbort(signal)
					run.frames.set(f.t, await extractFrame(path, f.t))
					dets.push({ clipId: clip.id, frameT: f.t, label: "motion", score: f.score, box: f.box ?? cfg.roi ?? FULL_FRAME, via: "full" })
				}
				return dets
			})
		)
		candidates = lookouts
	}
	run.judged = candidates

	checkAbort(signal)
	await atStage("judge", () =>
		timed(run.timings, "judge", async () => {
			// detectors sometimes return a frameT the frames map lacks (zoom views); decode the ones that will be cropped
			for (const d of [...pickDetections(evidence, cfg.judge.maxCrops), ...pickDetections(visits, cfg.judge.maxCrops)])
				if (!run.frames.has(d.frameT)) run.frames.set(d.frameT, await extractFrame(path, d.frameT))
			const fineGrained = candidates.some(l => l.compiled?.fineGrained)
			const opts = { maxCrops: cfg.judge.maxCrops, cropSize: cfg.judge.cropSize, fineGrained }
			// feeder visits get close-ups of their own: sharing the detector's, they lost to the doves it found
			run.crops = [...(await buildCrops(run.frames, evidence, opts)), ...(await buildCrops(run.frames, visits, opts)), ...sheets]
			if (!judgeOn || !ctx.llm) {
				run.verdicts = candidates.map(l => detectorOnlyVerdict(clip.id, l, evidence))
				return
			}
			const best = evidence[0]
			const frame = (best && run.frames.get(best.frameT)) ?? run.frames.values().next().value
			if (!frame) throw new Error("no decoded frame to judge")
			const context = await contextImage(frame, cfg.roi)
			checkAbort(signal)
			const probedClip = { ...clip, durationS: probed.durationS, width: probed.width, height: probed.height }
			const out = await judgeClip({ clip: probedClip, lookouts: candidates, crops: run.crops, context, lifeList: ctx.store.lifeListSpecies(), lifeListWithoutClip: ctx.store.lifeListWithoutClip(), signal }, ctx.llm, cfg.judge)
			run.verdicts = out.verdicts
			run.birds = out.birds
			run.usage = out.usage.map(u => ({ ...u, clipId: clip.id }))
		})
	)
	return run
}

const detectorOnlyVerdict = (clipId: string, l: Lookout, evidence: Detection[]): Verdict => {
	const qs = new Set(queriesOf(l))
	const best = evidence.filter(d => qs.has(norm(d.label)) || d.label === "motion").sort((a, b) => b.score - a.score)[0]
	return {
		clipId,
		lookoutId: l.id,
		match: !!best,
		confidence: best?.score ?? 0,
		label: best?.label ?? null,
		rationale: best ? `The detector found a ${best.label} (score ${best.score.toFixed(2)}); no spotter is set up.` : "Nothing detected.",
		model: DETECTOR_ONLY,
		createdAt: new Date().toISOString()
	}
}

// ---- reasons ----

const LEADING_WORDS = /^(A|An|The|No|Not|Nothing|Only|This|That|It|There|Just|One|Two|Some|Likely|Probably)\b/

const firstSentence = (s: string) => {
	const one = (s.split(/(?<=[.!?])\s/)[0] ?? s).trim().replace(/[.!]$/, "")
	// "A house sparrow…" reads better mid-line as "a house sparrow…"; proper names ("Northern Cardinal…") keep their case
	const lowered = LEADING_WORDS.test(one) ? one[0]!.toLowerCase() + one.slice(1) : one
	return lowered.length > 120 ? `${lowered.slice(0, 117)}…` : lowered
}

const keptReason = (keeping: Verdict[], lookouts: Map<string, Lookout>) =>
	"kept: " +
	keeping
		.map(v => {
			const l = lookouts.get(v.lookoutId)!
			return `${v.species ?? v.label ?? l.compiled?.summary ?? l.name} (${v.confidence.toFixed(2)}) for ${l.name}`
		})
		.join("; ")

const judgeReason = (verdicts: Verdict[], lookouts: Map<string, Lookout>) => {
	const best = [...verdicts].sort((a, b) => b.confidence - a.confidence)[0]
	if (!best) return "judge: no answer"
	// with no judge configured the detector made the call, so the reason must not blame a judge
	const who = best.model === DETECTOR_ONLY ? "detector" : "judge"
	const l = lookouts.get(best.lookoutId)
	if (best.match && l)
		return `${who}: ${best.label ?? "a possible match"} for ${l.name}, below its threshold (${best.confidence.toFixed(2)} < ${l.threshold.toFixed(2)})`
	const what = best.rationale ? firstSentence(best.rationale) : (best.label ?? "no match")
	return `${who}: ${what} (${best.confidence.toFixed(2)})`
}

// ---- files and media ----

const moveFile = async (from: string, to: string) => {
	await mkdir(dirname(to), { recursive: true })
	try {
		await rename(from, to)
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e
		await copyFile(from, to)
		await unlink(from)
	}
}

/**
 * Where a clip's file really is. A crash between moving it (clips/ ⇄ kept/) and saving the
 * new path leaves the row pointing at the old place; the file is then in the other one.
 */
export const locateClipFile = (paths: Pick<AppContext["paths"], "clips" | "kept">, clip: Clip): string | null => {
	if (!clip.path || existsSync(clip.path)) return clip.path
	for (const dir of [paths.kept, paths.clips]) {
		const p = join(dir, localDate(clip.recordedAt), basename(clip.path))
		if (existsSync(p)) return p
	}
	return clip.path
}

/** Puts a clip's file under kept/ or clips/ by status. A no-op when it is already there. */
export const placeClipFile = async (ctx: Pick<AppContext, "paths">, clip: Clip, kept: boolean): Promise<string | null> => {
	if (!clip.path || !existsSync(clip.path)) return clip.path
	const target = join(kept ? ctx.paths.kept : ctx.paths.clips, localDate(clip.recordedAt), basename(clip.path))
	if (target === clip.path) return clip.path
	await moveFile(clip.path, target)
	return target
}

/**
 * The crops, the one showing what the clip was kept for first: the first crop is the sighting's
 * picture, and in detector order it was whatever the detector found first. On 2026-10-22 a correct
 * White-breasted Nuthatch sighting showed a Mourning Dove on the fence rail.
 */
export const leadWithSighting = (run: Pick<CascadeRun, "crops" | "birds">, keeping: Verdict[]): JudgeCrop[] => {
	const species = keeping.flatMap(v => (v.species ? [v.species.toLowerCase()] : []))
	const best = species.flatMap(s => run.birds.filter(b => b.species.toLowerCase() === s && typeof b.crop === "number"))[0]
	if (!best || !run.crops[best.crop!]) return run.crops
	return [run.crops[best.crop!]!, ...run.crops.filter((_, i) => i !== best.crop)]
}

const posterJpeg = (frame: Buffer) =>
	sharp(frame).resize({ width: POSTER_EDGE, height: POSTER_EDGE, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer()

const posterFrameT = (run: CascadeRun): number | null => {
	const best = run.detections[0]
	if (best) return best.frameT
	const m = run.motion?.frames[0]
	if (m) return m.t
	return null
}

const writeMedia = async (ctx: AppContext, clip: Clip, path: string, run: CascadeRun, kept: boolean): Promise<ClipMedia> => {
	const dir = clipMediaDir(ctx.paths, clip.id)
	await mkdir(dir, { recursive: true })
	// stale crops from a previous run must not linger next to the new ones
	for (const f of await readdir(dir)) if (/^crop-\d+\.jpg$/.test(f)) await rm(join(dir, f), { force: true })
	const media: ClipMedia = { poster: null, preview: null, crops: [] }

	try {
		const t = posterFrameT(run)
		let frame = t === null ? undefined : run.frames.get(t)
		if (!frame) {
			const at = t ?? Math.min(1, (run.probe?.durationS ?? 0) / 2)
			frame = await extractFrame(path, at, { maxEdge: POSTER_EDGE })
		}
		await writeFile(join(dir, "poster.jpg"), await posterJpeg(frame))
		media.poster = "poster.jpg"
	} catch (e) {
		log.warn(`${clip.id}: poster failed`, e)
	}

	// media is a nicety once the verdict is decided: a full disk must not turn a sighting into an error
	for (const [i, crop] of run.crops.entries()) {
		const name = `crop-${i}.jpg`
		try {
			await writeFile(join(dir, name), crop.jpeg)
			media.crops.push(name)
		} catch (e) {
			log.warn(`${clip.id}: ${name} failed`, e)
		}
	}

	if (kept) media.preview = await ensurePreview(ctx, clip.id, path)
	else await rm(join(dir, "preview.mp4"), { force: true })
	return media
}

let previewSeq = 0

/**
 * Writes `preview.mp4` unless it exists. Encoded to a temp name and renamed, so a process
 * killed mid-transcode never leaves a truncated preview that would then count as done.
 */
const ensurePreview = async (ctx: Pick<AppContext, "paths">, clipId: string, path: string): Promise<string | null> => {
	const dir = clipMediaDir(ctx.paths, clipId)
	const previewPath = join(dir, "preview.mp4")
	if (existsSync(previewPath)) return "preview.mp4"
	// unique per call: a re-decision's encode and the worker's may overlap on one clip
	const tmp = join(dir, `.preview-${process.pid}-${++previewSeq}.tmp.mp4`)
	try {
		await mkdir(dir, { recursive: true })
		await makePreview(path, tmp)
		await rename(tmp, previewPath)
		return "preview.mp4"
	} catch (e) {
		await rm(tmp, { force: true })
		log.warn(`${clipId}: preview failed`, e)
		return null
	}
}

/**
 * kv key marking a clip that is kept whatever its verdicts say (saved from Live). Set before
 * the worker runs; the clip is still detected and judged, so it gets its labels.
 */
export const pinKey = (clipId: string) => `pin:${clipId}`

export const isPinned = (ctx: Pick<AppContext, "store">, clipId: string) => ctx.store.getKv(pinKey(clipId)) !== null

/** kv key naming the motion gate that made a stream capture's clip (`IngestInput.gate`); such clips are never dropped at motion. */
export const gateKey = (clipId: string) => `gate:${clipId}`

/** The motion stage's area floor for a gated clip: the watch's own smallest blob, 6 px of 320×180 (≈0.0001). */
const GATED_MIN_AREA = 0.0001

const GATE_NAMES: Record<string, string> = { camera: "the camera", look4: "look4's watch", both: "look4's watch and the camera" }

/** A gated clip's motion reason where the stage alone would have dropped it: `look4's watch saw motion; peak 0.04% of the zone moved`. */
const gatedReason = (gate: string, score: number) =>
	`${GATE_NAMES[gate] ?? gate} saw motion; ${score > 0 ? `peak ${(score * 100).toFixed(score < 0.01 ? 2 : 1)}% of the zone moved` : "too little moved here to measure"}`

export const PINNED_REASON = "Saved from Live"

const pinnedReason = (keeping: Verdict[], lookouts: Map<string, Lookout>) =>
	keeping.length ? `${PINNED_REASON} · ${keptReason(keeping, lookouts)}` : PINNED_REASON

/** The `sighting` event: everything a notification shows, so the browser needs no second request. */
const sightingEvent = (ctx: Pick<AppContext, "paths">, clip: Clip, v: Verdict, lookout: Lookout | undefined): SightingEvent => {
	const media = mediaUrls(ctx.paths, clip)
	return {
		clipId: clip.id,
		lookoutId: v.lookoutId,
		lookoutName: lookout?.name ?? v.lookoutId,
		// the species when named, so a notification says what the sighting card does
		label: v.species ?? v.label,
		confidence: v.confidence,
		source: clip.source,
		recordedAt: clip.recordedAt,
		image: media.closeUps[0] ?? media.crops[0] ?? media.poster
	}
}

/** When an unkept clip's file goes; never for a labeled clip (ground truth for eval). */
export const expiry = (ctx: Pick<AppContext, "store">, clipId: string, days: number) =>
	ctx.store.getLabels({ clipId }).length ? null : new Date(Date.now() + days * DAY_MS).toISOString()

/**
 * The worker's last word on a clip whose judge kept failing; `isRetryable` is false from then on.
 * A pending retry's "(retry 2/3 at 14:05)" is dropped, since no retry is coming.
 */
export const gaveUpReason = (reason: string | null, why: string) =>
	`${(reason ?? "failed").replace(/ \(retry \d+(?:\/\d+)? at \d\d:\d\d\)$/, "")} (gave up ${why})`

/**
 * A judge failure that may pass (a timeout, a rate or subscription limit, a 5xx), recorded on
 * `clip`, that the worker has not given up on. The give-up is in the reason, so it outlives a restart.
 */
export const isRetryable = (clip: Pick<Clip, "status" | "reason" | "error">) =>
	(clip.status === "error" || clip.status === "kept") &&
	!!clip.error &&
	/(?:^|re-check |^Saved from Live · )failed at judge/.test(clip.reason ?? "") &&
	!/ \(gave up [^)]*\)$/.test(clip.reason ?? "") &&
	isTransientError(clip.error)

/**
 * kv key for when a clip's run of transient judge failures began (epoch ms). In the DB, not in
 * the worker's memory, so the `retention.rejectedDays` cap on retrying is not reopened by every restart.
 */
export const retrySinceKey = (clipId: string) => `retry-since:${clipId}`

const lookoutsInPlay = (ctx: AppContext, clip: Clip): Lookout[] =>
	clip.pendingLookouts
		? clip.pendingLookouts.map(id => ctx.store.getLookout(id)).filter((l): l is Lookout => !!l)
		: ctx.store.listLookouts().filter(l => l.enabled)

/**
 * Runs the cascade on one clip and records the outcome. A backfill
 * (`clip.pendingLookouts`) replaces only those lookouts' verdicts; the clip's
 * status is then recomputed from all of them. Aborting leaves the clip pending.
 */
export const processClip = async (ctx: AppContext, clip: Clip, signal?: AbortSignal): Promise<Clip> => {
	const { store, bus } = ctx
	const retention = ctx.config.retention
	const started = Date.now()
	const backfill = clip.pendingLookouts !== null
	const before = store.getVerdicts(clip.id)
	const allLookouts = () => new Map(store.listLookouts().map(l => [l.id, l]))
	const keptBefore = new Set(keepingVerdicts(before, allLookouts()).map(v => v.lookoutId))

	const finish = (patch: Partial<Clip>) => {
		const out = store.updateClip(clip.id, patch)
		bus.emit("clip", { clipId: out.id, status: out.status })
		return out
	}

	const found = locateClipFile(ctx.paths, clip)
	if (found !== clip.path) {
		store.updateClip(clip.id, { path: found })
		clip = { ...clip, path: found }
	}

	try {
		const lookouts = await ensureCompiled(ctx, lookoutsInPlay(ctx, clip), true)
		const run = await runCascade(ctx, clip, lookouts, signal)
		checkAbort(signal)
		// first and on its own: those calls were paid for, whatever fails next
		for (const u of run.usage) store.addUsage(u)

		if (run.dropReason === NO_LOOKOUTS && !backfill && store.listLookouts().some(l => l.enabled)) {
			// the first lookout was switched on while this clip was in flight (the setup wizard's camera
			// backlog), too late for its re-queue of unwatched clips to see it: look again now, not drop it
			log.debug(`${clip.id}: a lookout appeared mid-run, back to pending`)
			const out = finish({ status: "pending" })
			ctx.kick()
			return out
		}

		const verdicts = store.transaction(() => {
			// a lookout deleted while the clip was being judged has no row left to hang a verdict on
			const live = allLookouts()
			const verdicts = run.verdicts.filter(v => live.has(v.lookoutId))
			if (run.timings.detect !== undefined || !backfill) {
				// a backfill only searched for its own nouns, so keep what earlier runs found for the others
				const searched = new Set(lookouts.flatMap(queriesOf))
				// feeder visits are looked for on every run, so a backfill's replace them too
				const kept = backfill ? store.getDetections(clip.id).filter(d => d.via !== "feeder" && !searched.has(norm(d.label))) : []
				store.replaceDetections(clip.id, [...kept, ...run.detections].sort((a, b) => b.score - a.score))
			}
			store.deleteVerdicts(clip.id, backfill ? lookouts.map(l => l.id) : undefined)
			for (const v of verdicts) store.upsertVerdict(v)
			return verdicts
		})

		const byId = allLookouts()
		const all = store.getVerdicts(clip.id)
		const keeping = keepingVerdicts(all, byId)
		const pinned = isPinned(ctx, clip.id)
		const isKept = keeping.length > 0 || pinned
		const fresh = keeping.filter(v => verdicts.some(r => r.lookoutId === v.lookoutId))
		const path = await placeClipFile(ctx, clip, isKept)
		// saved at once, so a crash during the media below never leaves the row pointing at the old place
		if (path !== clip.path) store.updateClip(clip.id, { path })
		// a backfill that adds no match leaves a sighting's close-ups and poster as they were
		const keepMedia = backfill && isKept && keptBefore.size > 0 && !fresh.length
		const media = path && !keepMedia ? await writeMedia(ctx, clip, path, { ...run, crops: leadWithSighting(run, keeping) }, isKept) : clip.media

		let droppedAt: Stage | null = null
		let reason: string
		if (pinned) reason = pinnedReason(keeping, byId)
		else if (isKept) reason = keptReason(keeping, byId)
		else if (run.droppedAt && !all.length) {
			droppedAt = run.droppedAt
			reason = run.dropReason ?? "rejected"
			// a backfill only searched for its own lookout's nouns; the reason speaks for every lookout,
			// so it reads as if all of them had been run together
			if (backfill && run.droppedAt === "detect") {
				const ids = new Set(lookouts.map(l => l.id))
				const every = [...byId.values()].filter(l => l.enabled || ids.has(l.id))
				reason = noneDetected([...new Set(every.flatMap(queriesOf))])
			}
		} else {
			droppedAt = "judge"
			reason = judgeReason(all, byId)
		}

		let out = finish({
			status: isKept ? "kept" : "rejected",
			droppedAt,
			reason,
			path,
			durationS: run.probe?.durationS ?? clip.durationS,
			width: run.probe?.width ?? clip.width,
			height: run.probe?.height ?? clip.height,
			motion: run.motion,
			timings: run.timings,
			error: null,
			processedAt: new Date().toISOString(),
			expiresAt: isKept ? null : expiry(ctx, clip.id, droppedAt === "motion" ? retention.motionlessDays : retention.rejectedDays),
			pendingLookouts: null,
			media
		})

		// A threshold that moved while the file and media were written was applied to the clips
		// already decided, and this one, still processing, was skipped: re-decide it now from the
		// verdicts just stored, or it keeps the decision the old threshold made (kept below the bar,
		// with no expiry). The re-decision moves the file, sets the expiry and indexes a new keep.
		let keepingNow = keeping
		const latest = allLookouts()
		if (all.some(v => latest.get(v.lookoutId)?.threshold !== byId.get(v.lookoutId)?.threshold)) {
			log.debug(`${clip.id}: a threshold moved while it was processed, re-deciding`)
			const r = await redecideClips(ctx, [clip.id])
			await r.previews()
			out = store.getClip(clip.id) ?? out
			keepingNow = out.status === "kept" ? keepingVerdicts(all, latest) : []
		}

		// a backfill over a week of footage would otherwise raise one desktop notification per old match
		for (const v of fresh)
			if (keepingNow.includes(v)) bus.emit("sighting", { ...sightingEvent(ctx, out, v, latest.get(v.lookoutId)), ...(backfill ? { recheck: true as const } : {}) })
		if (isKept && out.status === "kept" && keepingNow.some(v => !keptBefore.has(v.lookoutId)))
			await appendIndex(ctx, out, keepingNow, latest)
		store.deleteKv(retrySinceKey(clip.id))
		log.info(`${clip.id} ${out.status}${out.droppedAt ? ` at ${out.droppedAt}` : ""} in ${Date.now() - started} ms: ${out.reason}`)
		return out
	} catch (e) {
		if (e instanceof AbortedError || signal?.aborted) {
			log.debug(`${clip.id}: aborted, back to pending`)
			return finish({ status: "pending" })
		}
		const spent = usageOf(e)
		if (spent) store.addUsage({ ...spent, clipId: clip.id })
		const stage = e instanceof StageError ? e.stage : null
		const message = e instanceof Error ? e.message : String(e)
		log.error(`${clip.id} failed${stage ? ` at ${stage}` : ""}: ${message}`)
		const failed = `failed${stage ? ` at ${stage}` : ""}: ${message.split("\n")[0]!.slice(0, 160)}`
		// the worker will try again: keep it a backfill, and keep the file until it gives up
		const retry = stage === "judge" && isTransientError(message)
		if (!retry) store.deleteKv(retrySinceKey(clip.id))
		else if (store.getKv(retrySinceKey(clip.id)) === null) store.setKv(retrySinceKey(clip.id), Date.now())
		const pendingLookouts = retry ? clip.pendingLookouts : null
		const processedAt = new Date().toISOString()
		const byId = allLookouts()
		const keeping = keepingVerdicts(store.getVerdicts(clip.id), byId)
		// a re-check (backfill, reprocess) of a sighting failed: what it was kept for still stands
		if (keeping.length)
			return finish({ status: "kept", droppedAt: null, reason: `${(isPinned(ctx, clip.id) ? pinnedReason : keptReason)(keeping, byId)} · re-check ${failed}`, error: message, processedAt, expiresAt: null, pendingLookouts })
		// saved from Live: kept even when its analysis fails (the worker still retries a judge failure)
		if (isPinned(ctx, clip.id))
			return finish({ status: "kept", droppedAt: null, reason: `${PINNED_REASON} · ${failed}`, error: message, processedAt, expiresAt: null, pendingLookouts })
		return finish({
			status: "error",
			droppedAt: stage === "probe" ? "probe" : null,
			reason: failed,
			error: message,
			processedAt,
			expiresAt: retry ? null : expiry(ctx, clip.id, retention.rejectedDays),
			pendingLookouts
		})
	}
}

export type RedecideCtx = Pick<AppContext, "store" | "bus" | "paths" | "config">

/**
 * Re-decides clips from their stored verdicts, with no detector or judge call: after a
 * lookout's threshold moves, a clip whose verdict now clears the bar is kept (moved to
 * kept/, indexed) and one that no longer does is rejected with the usual expiry, exactly
 * as the cascade would have decided. Clips in the queue, never judged, waiting on a judge
 * retry, or whose file retention already deleted are left alone. A clip that fails (say it
 * was deleted mid-move) is logged and skipped, so it never costs the rest of the batch.
 * `previews()` encodes the newly kept clips' previews: ffmpeg work the caller may run later.
 */
export const redecideClips = async (
	ctx: RedecideCtx,
	clipIds: string[]
): Promise<{ kept: number; rejected: number; previews: () => Promise<void> }> => {
	const { store, bus } = ctx
	const newlyKept: string[] = []
	let rejected = 0
	for (const id of clipIds) {
		try {
			const out = await redecide(ctx, id)
			if (out === "kept") newlyKept.push(id)
			else if (out === "rejected") rejected++
		} catch (e) {
			log.warn(`${id}: could not re-decide`, e)
		}
	}
	const previews = async () => {
		for (const id of newlyKept) {
			const c = store.getClip(id)
			// re-decided again (or deleted, or queued) since: its own run owns its media now
			if (!c || c.status !== "kept" || !c.path) continue
			const preview = await ensurePreview(ctx, id, c.path)
			const now = store.getClip(id)
			// deleted while encoding: the delete already removed the media dir this re-created
			if (!now) await rm(clipMediaDir(ctx.paths, id), { recursive: true, force: true })
			else if (!preview) continue
			else if (now.status === "rejected" || now.status === "error") await rm(join(clipMediaDir(ctx.paths, id), preview), { force: true })
			else if (now.status === "kept") {
				store.updateClip(id, { media: { ...now.media, preview } })
				bus.emit("clip", { clipId: id, status: "kept" })
			}
		}
	}
	return { kept: newlyKept.length, rejected, previews }
}

/** One clip of `redecideClips`; the new status when it changed. */
const redecide = async (ctx: RedecideCtx, id: string): Promise<"kept" | "rejected" | null> => {
	const { store, bus } = ctx
	const clip = store.getClip(id)
	// a judge retry is due: that run decides it with the thresholds of the moment
	if (!clip || (clip.status !== "kept" && clip.status !== "rejected") || isRetryable(clip)) return null
	const from = locateClipFile(ctx.paths, clip)
	if (!from || !existsSync(from)) return null
	const all = store.getVerdicts(id)
	if (!all.length) return null
	const byId = new Map(store.listLookouts().map(l => [l.id, l]))
	const keeping = keepingVerdicts(all, byId)
	const pinned = isPinned(ctx, id)
	const isKept = keeping.length > 0 || pinned
	const reason = pinned ? pinnedReason(keeping, byId) : isKept ? keptReason(keeping, byId) : judgeReason(all, byId)
	if (isKept === (clip.status === "kept")) {
		if (reason !== clip.reason && !clip.error) store.updateClip(id, { reason })
		return null
	}
	// Saved before the file moves, with nothing awaited since the read above: a backfill, reprocess
	// or delete that lands while the file moves comes after this decision and is never overwritten
	// by it. Until the move is recorded the row points at the old place, which locateClipFile and
	// the worker already handle (it is the same state a crash mid-move leaves).
	const out = store.updateClip(id, {
		status: isKept ? "kept" : "rejected",
		droppedAt: isKept ? null : "judge",
		reason,
		error: null,
		// set only on a clip whose judge retry gave up: nothing will run those lookouts now
		pendingLookouts: null,
		expiresAt: isKept ? null : expiry(ctx, id, ctx.config.retention.rejectedDays),
		media: { ...clip.media, preview: isKept ? clip.media.preview : null }
	})
	bus.emit("clip", { clipId: id, status: out.status })
	if (!isKept) await rm(join(clipMediaDir(ctx.paths, id), "preview.mp4"), { force: true })
	const to = await placeClipFile(ctx, { ...clip, path: from }, isKept)
	const placed = store.transaction(() => {
		const now = store.getClip(id)
		// someone else (the worker, a later re-decision) has already recorded where the file is
		if (!now || now.path !== clip.path || to === clip.path) return now
		return store.updateClip(id, { path: to })
	})
	if (!placed) {
		// deleted after its file moved: the delete removed the old path, so nothing else frees this one
		if (to) await rm(to, { force: true })
		return null
	}
	if (isKept) await appendIndex(ctx, placed, keeping, byId)
	return isKept ? "kept" : "rejected"
}

/** One line per kept clip in kept/index.jsonl. A failure only logs: the clip is kept either way. */
const appendIndex = async (ctx: Pick<AppContext, "paths">, clip: Clip, keeping: Verdict[], lookouts: Map<string, Lookout>) => {
	const rel = (p: string) => relative(ctx.paths.root, p)
	const line = {
		clipId: clip.id,
		recordedAt: clip.recordedAt,
		file: clip.path ? rel(clip.path) : null,
		source: clip.source,
		matches: keeping.map(v => ({
			lookout: lookouts.get(v.lookoutId)?.name ?? v.lookoutId,
			label: v.label,
			confidence: v.confidence,
			rationale: v.rationale
		})),
		crops: clip.media.crops.map(c => rel(join(clipMediaDir(ctx.paths, clip.id), c)))
	}
	try {
		await appendFile(ctx.paths.keptIndex, JSON.stringify(line) + "\n")
	} catch (e) {
		log.warn(`${clip.id}: could not append to ${ctx.paths.keptIndex}`, e)
	}
}
