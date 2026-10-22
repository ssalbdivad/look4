// Stage 1: the free motion gate. Decodes a few small grayscale frames per second and asks whether a
// compact thing moved inside the zone, ignoring sensor noise, swaying texture and lighting changes.
//
// Two changes are combined per frame:
// - background difference against the temporal median of the clip, which catches anything that
//   arrives and stays put but also marks a "ghost" wherever a subject that sits through most of the
//   clip is absent (the median then contains the subject);
// - three-frame difference (changed vs both neighbours), which catches pecking/head movement and lands
//   on the subject's CURRENT position rather than where it was.
// Blobs come from connected components of the opened mask. The score is the largest blob's area, not
// the sum of all blobs: noise and leaf flicker fragment into many small components whose total can be
// large, while a bird or squirrel is one compact component.

import type { GrayVideo, ProbeResult } from "../media/ffmpeg.ts"
import type { MotionFrame, MotionResult, NormBox } from "../types.ts"
import type { MotionGate, MotionOptions } from "./types.ts"
import { fromInner, iou } from "../geometry.ts"
import { logger } from "../log.ts"
import { decodeGray } from "../media/ffmpeg.ts"

const log = logger("motion")

/** Long edge of the analysis frames. Small enough to be cheap, big enough that a feeder bird is dozens of pixels. */
const ANALYSIS_EDGE = 320
/** Long clips are sampled more sparsely rather than analyzed longer. */
const MAX_ANALYZED = 240
/** Short clips are sampled more densely so there is something to compare. */
const MIN_ANALYZED = 8
/** Candidate frames closer together than this are near-duplicates for the detector. */
const MIN_GAP_S = 0.5
/** Long clips get at least one detector candidate per this many seconds of footage. */
const SECONDS_PER_CANDIDATE = 10
/** The most candidates a long clip is given, the same ceiling `motion.maxFrames` has. */
const MAX_CANDIDATES = 24
/** Frames that feed the per-pixel median background. */
const BG_SAMPLES = 15
/** A blob whose pixels are mostly background-difference only (no frame-to-frame change) is "static". */
const STATIC_FD_SHARE = 0.15
/** Secondary blobs reported per candidate frame, beyond the largest one. */
const MAX_SECONDARY = 4
/** Below this share of its bbox a blob is scattered flicker (the same cut the reason's "compact blob" uses). */
const COMPACT_FILL = 0.3

export const runMotionGate: MotionGate = async (clipPath, probe, opts, signal) => {
	const started = performance.now()
	const fps = samplingFps(probe, opts.sampleFps)
	const video = await decodeGray(clipPath, probe, {
		fps,
		crop: opts.roi,
		maxEdge: ANALYSIS_EDGE,
		// ffmpeg's fps filter emits one frame at (or past) the very end, which cannot be seeked to later
		maxFrames: probe.durationS > 0 ? Math.min(MAX_ANALYZED, Math.max(1, Math.ceil(probe.durationS * fps - 1e-3))) : MAX_ANALYZED,
		signal
	})
	const decoded = performance.now()
	const result = await sliced(motionSteps(video, opts), signal)
	log.debug(`${clipPath}: ${result.reason}`, {
		frames: video.frames.length,
		size: `${video.width}x${video.height}`,
		decoder: video.decoder,
		decodeMs: Math.round(decoded - started),
		analyzeMs: Math.round(performance.now() - decoded)
	})
	return result
}

const samplingFps = (probe: ProbeResult, sampleFps: number) => {
	const d = probe.durationS
	if (!(d > 0)) return sampleFps
	let fps = Math.min(sampleFps, MAX_ANALYZED / d)
	if (fps * d < MIN_ANALYZED) fps = MIN_ANALYZED / d
	if (probe.fps > 0) fps = Math.min(fps, probe.fps)
	return Math.round(fps * 1e4) / 1e4
}

type Blob = {
	/** Fraction of the analysis frame. */
	area: number
	/** Share of its bbox it covers: a bird is solid, leaf flicker is sparse. */
	fill: number
	/** Inclusive pixel bbox in analysis coords. */
	x0: number
	y0: number
	x1: number
	y1: number
	/** Few of its pixels changed frame-to-frame: it is present (or absent) without moving. */
	static: boolean
	/** Its outline is an edge in the background rather than in this frame: it marks where the subject is at other times. */
	ghost: boolean
}

type FrameInfo = { i: number; t: number; global: boolean; blob: Blob | null; others: Blob[] }

type Candidate = { i: number; rank: number; score: number; box: NormBox | null }

/** The analysis, synchronously. `runMotionGate` runs the same steps in slices. */
export const analyzeMotion = (video: GrayVideo, opts: MotionOptions): MotionResult => {
	const steps = motionSteps(video, opts)
	for (;;) {
		const r = steps.next()
		if (r.done) return r.value
	}
}

/**
 * Main-thread time the analysis may hold before it gives the event loop a turn. A 240-frame
 * clip is 0.3-1.3 s of pixel loops at load 40-60, and the server shares this thread.
 */
const SLICE_MS = 20

const sliced = async (steps: Generator<void, MotionResult>, signal?: AbortSignal): Promise<MotionResult> => {
	let since = performance.now()
	for (;;) {
		const r = steps.next()
		if (r.done) return r.value
		if (performance.now() - since < SLICE_MS) continue
		await new Promise(resolve => setImmediate(resolve))
		signal?.throwIfAborted()
		since = performance.now()
	}
}

/** The analysis as a generator that yields after each unit of work (a frame, a background). */
function* motionSteps(video: GrayVideo, opts: MotionOptions): Generator<void, MotionResult> {
	const { width: W, height: H, frames } = video
	const n = frames.length
	const N = W * H
	const thr = opts.pixelThreshold
	const tOf = (i: number) => Math.round((i / video.fps) * 1000) / 1000
	const toBox = (b: Blob): NormBox =>
		fromInner({ x: b.x0 / W, y: b.y0 / H, w: (b.x1 - b.x0 + 1) / W, h: (b.y1 - b.y0 + 1) / H }, video.region)

	// A second mover worth a zoom: a bird across the feeder from the leaves that dominate the frame.
	// Scattered flicker and the hole a sitting subject left are not.
	const worthAZoom = (b: Blob) => b.area >= opts.minArea && !b.ghost && b.fill >= COMPACT_FILL

	if (n < 2) {
		const reason = n ? "too short to compare frames" : "no frames decoded"
		return { score: 0, passed: false, reason, frames: n ? [{ t: 0, score: 0, box: null }] : [], sampledFrames: n }
	}

	// 1. Split at whole-frame changes (IR day/night switch, camera bump) so each part gets its own background.
	const starts = [0]
	for (let i = 1; i < n; i++) {
		const lut = lightingLut(frames[i]!, frames[i - 1]!, thr)
		if (changedFraction(frames[i]!, lut, frames[i - 1]!, thr) > opts.maxArea) starts.push(i)
		yield
	}
	starts.push(n)

	const infos: FrameInfo[] = []
	const bgOf: Array<Uint8Array | null> = []
	const norm: Uint8Array[] = []
	const lo: number[] = []
	const hi: number[] = []
	let cuts = 0
	for (let s = 0; s + 1 < starts.length; s++) {
		const from = starts[s]!
		const to = starts[s + 1]!
		if (s > 0) cuts++
		// 2. Compensate global lighting: map every frame onto the segment's middle frame. A frame's mapped
		// range [lo, hi] is what it can express: where it clipped at black or white, the true value lies
		// beyond, so comparisons clamp both sides to the range they share.
		const ref = frames[(from + to) >> 1]!
		let bgLo = 0
		let bgHi = 255
		for (let i = from; i < to; i++) {
			const lut = lightingLut(frames[i]!, ref, thr)
			norm[i] = applyLut(frames[i]!, lut)
			lo[i] = lut[0]!
			hi[i] = lut[255]!
			bgLo = Math.max(bgLo, lut[0]!)
			bgHi = Math.min(bgHi, lut[255]!)
			yield
		}
		const bg = to - from >= 3 ? medianFrame(norm.slice(from, to), N) : null
		yield
		for (let i = from; i < to; i++) bgOf[i] = bg

		// 3. Per-frame change mask → opened → components.
		for (let i = from; i < to; i++) {
			if (i > from) yield
			const cur = norm[i]!
			// A two-sided difference marks only where the subject is now; a one-sided one also marks where it
			// was. So at a segment's ends, leave it to the background difference when there is one.
			const hasPrev = i > from
			const hasNext = i + 1 < to
			const j0 = bg ? (hasPrev && hasNext ? i - 1 : -1) : hasPrev ? i - 1 : hasNext ? i + 1 : -1
			const j1 = bg ? (j0 < 0 ? -1 : i + 1) : hasNext ? i + 1 : j0
			const p0 = j0 < 0 ? null : norm[j0]!
			const p1 = j1 < 0 ? null : norm[j1]!
			const [lo0, hi0] = j0 < 0 ? [0, 255] : [Math.max(lo[i]!, lo[j0]!), Math.min(hi[i]!, hi[j0]!)]
			const [lo1, hi1] = j1 < 0 ? [0, 255] : [Math.max(lo[i]!, lo[j1]!), Math.min(hi[i]!, hi[j1]!)]
			const loB = Math.max(lo[i]!, bgLo)
			const hiB = Math.min(hi[i]!, bgHi)
			const fdMask = new Uint8Array(N)
			const mask = new Uint8Array(N)
			let changed = 0
			for (let p = 0; p < N; p++) {
				const c = cur[p]!
				const f =
					p0 !== null &&
					Math.abs(clamp(c, lo0, hi0) - clamp(p0[p]!, lo0, hi0)) > thr &&
					Math.abs(clamp(c, lo1, hi1) - clamp(p1![p]!, lo1, hi1)) > thr
						? 1
						: 0
				const m = f | (bg !== null && Math.abs(clamp(c, loB, hiB) - clamp(bg[p]!, loB, hiB)) > thr ? 1 : 0)
				fdMask[p] = f
				mask[p] = m
				changed += m
			}
			if (changed / N > opts.maxArea) {
				infos.push({ i, t: tOf(i), global: true, blob: null, others: [] })
				continue
			}
			if (changed === 0) {
				infos.push({ i, t: tOf(i), global: false, blob: null, others: [] })
				continue
			}
			const opened = morph(morph(mask, W, H, "min"), W, H, "max")
			// Components are found on a dilated copy so a bird split by a perch or a stripe stays one blob,
			// but area counts only the opened pixels, so the dilation does not inflate the score.
			const [blob = null, ...rest] = findBlobs(opened, morph(opened, W, H, "max"), fdMask, W, H)
			// Without the two-sided difference there is no telling still from moving, but the outline
			// test still tells a subject from the hole it left.
			for (const b of blob ? [blob, ...rest] : []) {
				if (b !== blob && b.area < opts.minArea) break
				if (bg && (b.static || !p0)) b.ghost = isGhost(opened, b, cur, bg, W, H)
				if (!p0) b.static = false
			}
			const others = rest.filter(worthAZoom)
			infos.push({ i, t: tOf(i), global: false, blob, others })
		}
	}

	const live = infos.filter(f => !f.global)
	const peak = live.reduce<FrameInfo | null>((best, f) => (f.blob && (!best?.blob || f.blob.area > best.blob.area) ? f : best), null)
	const score = peak?.blob?.area ?? 0
	const passed = score >= opts.minArea

	// 4. Candidate frames. A static blob means the subject sits still for a while: either the blob frames
	// show it (it arrived and stayed for under half the clip) or they show its absence (a ghost, because
	// it stayed for most of the clip). Frames where that spot matches the background are the other half of
	// the story, so they are candidates too; the ghost test only decides which half ranks first.
	const own = byPlace(
		live
			.filter(f => f.blob && f.blob.area >= opts.minArea)
			.map(f => ({ i: f.i, rank: f.blob!.area * (f.blob!.ghost ? 0.25 : 1), score: f.blob!.area, box: toBox(f.blob!) }))
			.sort((a, b) => b.rank - a.rank)
	)
	const anchor = live
		.map(f => f.blob)
		.filter((b): b is Blob => !!b?.static)
		.reduce<Blob | null>((best, b) => (!best || b.area > best.area ? b : best), null)
	const complements: Candidate[] = []
	if (anchor && anchor.area >= opts.minArea) {
		const pixels = anchor.area * N
		const box = toBox(anchor)
		// A ghost's complement frames are the ones showing the subject, so they lead; otherwise they trail.
		const rank = anchor.ghost ? 2 : -0.5
		for (const f of live) {
			const bg = bgOf[f.i]
			if (bg && rectChanged(norm[f.i]!, bg, anchor, W, thr) <= pixels * 0.25) complements.push({ i: f.i, rank, score: anchor.area, box })
		}
	}

	const picked: Candidate[] = []
	const farEnough = (i: number) => picked.every(p => Math.abs(tOf(p.i) - tOf(i)) > MIN_GAP_S + 1e-6)
	const take = (list: Candidate[], upTo: number) => {
		for (const c of list) if (picked.length < upTo && !picked.some(p => p.i === c.i) && farEnough(c.i)) picked.push(c)
	}
	// The likelier reading of a static blob gets two thirds of the slots and the other at least a third,
	// so a wrong ghost call cannot crowd out every frame that shows the subject.
	const budget = frameBudget(opts.maxFrames, n / video.fps)
	const minority = complements.length ? Math.ceil(budget / 3) : 0
	const [first, second] = anchor?.ghost ? [spread(complements), own] : [own, spread(complements)]
	take(first, budget - minority)
	take(second, picked.length + minority)
	take(first, budget)
	take(second, budget)
	// Pad with evenly spaced frames so the detector always gets a spread of the clip to look at.
	const pool = live.length ? live : infos
	const even = spread(pool.map(f => ({ i: f.i, rank: -1, score: f.blob?.area ?? 0, box: f.blob ? toBox(f.blob) : null })))
	take(even, budget)
	picked.sort((a, b) => b.rank - a.rank)
	const infoAt = new Map(infos.map(f => [f.i, f]))
	const motionFrames: MotionFrame[] = picked.map(c => {
		const frame: MotionFrame = { t: tOf(c.i), score: round(c.score), box: c.box && roundBox(c.box) }
		const f = infoAt.get(c.i)!
		// A complement frame's `box` is the anchor's, so the frame's own primary blob can be a second mover there.
		const own = f.blob && worthAZoom(f.blob) ? [f.blob, ...f.others] : f.others
		const boxes = own
			.map(toBox)
			.filter(b => !c.box || iou(b, c.box) < 0.5)
			.slice(0, MAX_SECONDARY)
		if (boxes.length) frame.boxes = boxes.map(roundBox)
		return frame
	})

	return {
		score: round(score),
		passed,
		reason: explain({ score, passed, peak: peak?.blob ?? null, minArea: opts.minArea, globals: infos.length - live.length, cuts, n }),
		frames: motionFrames,
		sampledFrames: n
	}
}

/**
 * Candidate frames for a clip `durationS` long: `maxFrames`, or one per `SECONDS_PER_CANDIDATE` when that is
 * more. A fixed 6 gives a busy 2-minute clip one detector frame per ~20 s, so a nuthatch's 5 s at the
 * feeder was a coin flip, lost to the doves and squirrel that move more pixels.
 */
export const frameBudget = (maxFrames: number, durationS: number) =>
	Math.max(maxFrames, Math.min(MAX_CANDIDATES, Math.ceil(durationS / SECONDS_PER_CANDIDATE - 1e-6)))

/** Reorders a time-ordered list so any prefix of it is spread evenly across the clip. */
/** Boxes overlapping at least this much are the same place in the scene. */
const SAME_PLACE_IOU = 0.2

/**
 * Round-robins a best-first list over the places its boxes sit, best place first. A feeder swinging
 * all clip long moves more pixels than a bird on the ground, so ranking by area alone gives every
 * detector slot to the feeder and none to the bird.
 */
const byPlace = (list: Candidate[]): Candidate[] => {
	const places: { box: NormBox; items: Candidate[] }[] = []
	for (const c of list) {
		const place = c.box && places.find(p => iou(p.box, c.box!) >= SAME_PLACE_IOU)
		if (place) place.items.push(c)
		else places.push({ box: c.box ?? { x: 0, y: 0, w: 1, h: 1 }, items: [c] })
	}
	const out: Candidate[] = []
	for (let k = 0; out.length < list.length; k++) for (const p of places) if (p.items[k]) out.push(p.items[k]!)
	return out
}

const spread = <t>(list: t[]): t[] => {
	const out: t[] = []
	const used = new Set<number>()
	for (let parts = 1; out.length < list.length; parts *= 2)
		for (let k = 0; k < parts; k++) {
			const j = Math.min(list.length - 1, Math.floor(((k + 0.5) * list.length) / parts))
			if (!used.has(j)) {
				used.add(j)
				out.push(list[j]!)
			}
		}
	return out
}

const pct = (f: number) => `${(f * 100).toFixed(f < 0.01 ? 2 : 1)}%`

const explain = (r: { score: number; passed: boolean; peak: Blob | null; minArea: number; globals: number; cuts: number; n: number }) => {
	if (r.passed && r.peak) {
		const kind = r.peak.static ? "something still" : r.peak.fill >= 0.3 ? "compact blob" : "scattered"
		return `peak ${pct(r.score)} of the zone moved (${kind})`
	}
	if (r.globals + r.cuts > 0 && r.score < r.minArea) return "whole-frame light change only"
	if (r.score === 0) return "no motion"
	return `only ${pct(r.score)} of the zone moved (needs ${pct(r.minArea)})`
}

const round = (n: number) => Math.round(n * 1e5) / 1e5
const roundBox = (b: NormBox): NormBox => ({ x: round(b.x), y: round(b.y), w: round(b.w), h: round(b.h) })

// ---------------------------------------------------------------------------------------------------
// Image primitives on 8-bit planes. Kept local: they exist for this stage's speed, not for reuse.

/**
 * Lookup table mapping `cur`'s luma onto `ref`'s under a robust gain + offset model. Cloud cover and
 * auto-exposure scale the whole scene; a linear fit absorbs that, and unlike histogram matching or a
 * free-form tone curve it cannot "explain away" a bird whose luma happens to be rare in the scene.
 */
const lightingLut = (cur: Uint8Array, ref: Uint8Array, thr: number): Uint8Array => {
	// Per 16-level bin of `cur`: the median `ref` value of those pixels. A moving subject is a minority
	// in almost every bin, so the medians trace the background's transfer curve.
	const BINS = 16
	const joint = new Uint32Array(BINS * 256)
	const curSum = new Float64Array(BINS)
	const counts = new Uint32Array(BINS)
	let samples = 0
	for (let p = 0; p < cur.length; p += 2) {
		const b = cur[p]! >> 4
		joint[b * 256 + ref[p]!]!++
		curSum[b]! += cur[p]!
		counts[b]!++
		samples++
	}
	const pts: Array<{ x: number; y: number; w: number }> = []
	for (let b = 0; b < BINS; b++) {
		const c = counts[b]!
		if (c < samples * 0.005 || c < 8) continue
		let acc = 0
		let y = 0
		for (; y < 256; y++) {
			acc += joint[b * 256 + y]!
			if (acc * 2 >= c) break
		}
		pts.push({ x: curSum[b]! / c, y, w: c })
	}
	let gain = 1
	let offset = 0
	const fit = (use: typeof pts) => {
		let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0
		for (const q of use) {
			sw += q.w
			sx += q.w * q.x
			sy += q.w * q.y
			sxx += q.w * q.x * q.x
			sxy += q.w * q.x * q.y
		}
		const den = sw * sxx - sx * sx
		// A flat scene (one populated bin) only supports an offset.
		if (use.length < 2 || den <= sw * sw * 4) {
			gain = 1
			offset = (sy - sx) / sw
		} else {
			gain = Math.min(4, Math.max(0.25, (sw * sxy - sx * sy) / den))
			offset = (sy - gain * sx) / sw
		}
	}
	if (pts.length) {
		fit(pts)
		const inliers = pts.filter(q => Math.abs(gain * q.x + offset - q.y) <= thr)
		if (inliers.length && inliers.length < pts.length) fit(inliers)
	}
	const lut = new Uint8Array(256)
	for (let v = 0; v < 256; v++) lut[v] = Math.min(255, Math.max(0, Math.round(gain * v + offset)))
	return lut
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

const applyLut = (src: Uint8Array, lut: Uint8Array) => {
	const out = new Uint8Array(src.length)
	for (let p = 0; p < src.length; p++) out[p] = lut[src[p]!]!
	return out
}

/** Fraction of (sub-sampled) pixels that differ by more than `thr` once `cur` is mapped through `lut`. */
const changedFraction = (cur: Uint8Array, lut: Uint8Array, ref: Uint8Array, thr: number) => {
	let changed = 0
	let total = 0
	const lo = lut[0]!
	const hi = lut[255]!
	for (let p = 0; p < cur.length; p += 3) {
		if (Math.abs(lut[cur[p]!]! - clamp(ref[p]!, lo, hi)) > thr) changed++
		total++
	}
	return total ? changed / total : 0
}

/** Per-pixel temporal median over up to BG_SAMPLES evenly spaced frames. */
const medianFrame = (frames: Uint8Array[], N: number) => {
	const k = Math.min(BG_SAMPLES, frames.length)
	const picks = Array.from({ length: k }, (_, j) => frames[Math.floor(((j + 0.5) * frames.length) / k)]!)
	const out = new Uint8Array(N)
	const vals = new Uint8Array(k)
	const mid = k >> 1
	for (let p = 0; p < N; p++) {
		for (let j = 0; j < k; j++) {
			// insertion sort: k is small and the values are nearly sorted already for static pixels
			const v = picks[j]![p]!
			let m = j
			while (m > 0 && vals[m - 1]! > v) {
				vals[m] = vals[m - 1]!
				m--
			}
			vals[m] = v
		}
		out[p] = vals[mid]!
	}
	return out
}

/** 3×3 erosion (`min`) or dilation (`max`) of a 0/1 mask, separably. Pixels outside the frame are ignored. */
const morph = (src: Uint8Array, W: number, H: number, op: "min" | "max") => {
	const tmp = new Uint8Array(src.length)
	const out = new Uint8Array(src.length)
	// Two hand-specialised copies: this runs several times per frame and is the hottest loop in the stage.
	if (op === "min") {
		for (let row = 0; row < src.length; row += W) {
			tmp[row] = src[row]! & src[row + 1]!
			for (let p = row + 1, end = row + W - 1; p < end; p++) tmp[p] = src[p - 1]! & src[p]! & src[p + 1]!
			tmp[row + W - 1] = src[row + W - 2]! & src[row + W - 1]!
		}
		for (let p = 0; p < W; p++) out[p] = tmp[p]! & tmp[p + W]!
		for (let p = W, end = src.length - W; p < end; p++) out[p] = tmp[p - W]! & tmp[p]! & tmp[p + W]!
		for (let p = src.length - W; p < src.length; p++) out[p] = tmp[p - W]! & tmp[p]!
	} else {
		for (let row = 0; row < src.length; row += W) {
			tmp[row] = src[row]! | src[row + 1]!
			for (let p = row + 1, end = row + W - 1; p < end; p++) tmp[p] = src[p - 1]! | src[p]! | src[p + 1]!
			tmp[row + W - 1] = src[row + W - 2]! | src[row + W - 1]!
		}
		for (let p = 0; p < W; p++) out[p] = tmp[p]! | tmp[p + W]!
		for (let p = W, end = src.length - W; p < end; p++) out[p] = tmp[p - W]! | tmp[p]! | tmp[p + W]!
		for (let p = src.length - W; p < src.length; p++) out[p] = tmp[p - W]! | tmp[p]!
	}
	return out
}

/** Every connected component of `linked` (8-connectivity) that holds `area` pixels, largest first. */
const findBlobs = (area: Uint8Array, linked: Uint8Array, fd: Uint8Array, W: number, H: number): Blob[] => {
	const N = W * H
	const seen = new Uint8Array(N)
	const stack = new Int32Array(N)
	const out: Blob[] = []
	for (let start = 0; start < N; start++) {
		if (!linked[start] || seen[start]) continue
		let top = 0
		stack[top++] = start
		seen[start] = 1
		let count = 0
		let fdCount = 0
		let x0 = W, y0 = H, x1 = -1, y1 = -1
		while (top) {
			const p = stack[--top]!
			const x = p % W
			const y = (p - x) / W
			if (area[p]) {
				count++
				fdCount += fd[p]!
				if (x < x0) x0 = x
				if (x > x1) x1 = x
				if (y < y0) y0 = y
				if (y > y1) y1 = y
			}
			for (let dy = -1; dy <= 1; dy++) {
				const yy = y + dy
				if (yy < 0 || yy >= H) continue
				for (let dx = -1; dx <= 1; dx++) {
					const xx = x + dx
					if (xx < 0 || xx >= W) continue
					const q = yy * W + xx
					if (linked[q] && !seen[q]) {
						seen[q] = 1
						stack[top++] = q
					}
				}
			}
		}
		if (count)
			out.push({ area: count / N, fill: count / ((x1 - x0 + 1) * (y1 - y0 + 1)), x0, y0, x1, y1, static: fdCount < count * STATIC_FD_SHARE, ghost: false })
	}
	// stable: equal areas keep scan order, so the primary blob is the same one the old single-pass search picked
	return out.sort((a, b) => b.area - a.area)
}

/**
 * Ghost test for a static blob: along its outline, does the current frame or the background carry the
 * stronger edge? A real subject's silhouette is an edge in the frame; a ghost's is an edge in the
 * background (where the subject is "baked in") and the frame there is plain background texture.
 */
const isGhost = (mask: Uint8Array, b: Blob, cur: Uint8Array, bg: Uint8Array, W: number, H: number) => {
	const grad = (img: Uint8Array, x: number, y: number) => {
		const p = y * W + x
		const l = img[x > 0 ? p - 1 : p]!
		const r = img[x + 1 < W ? p + 1 : p]!
		const u = img[y > 0 ? p - W : p]!
		const d = img[y + 1 < H ? p + W : p]!
		return Math.abs(r - l) + Math.abs(d - u)
	}
	let inFrame = 0
	let inBg = 0
	for (let y = b.y0; y <= b.y1; y++)
		for (let x = b.x0; x <= b.x1; x++) {
			const p = y * W + x
			if (!mask[p]) continue
			const edge = (x > 0 && !mask[p - 1]) || (x + 1 < W && !mask[p + 1]) || (y > 0 && !mask[p - W]) || (y + 1 < H && !mask[p + W])
			if (!edge) continue
			inFrame += grad(cur, x, y)
			inBg += grad(bg, x, y)
		}
	return inBg > inFrame
}

/** Pixels inside the blob's bbox that differ from the background. */
const rectChanged = (cur: Uint8Array, bg: Uint8Array, b: Blob, W: number, thr: number) => {
	let changed = 0
	for (let y = b.y0; y <= b.y1; y++)
		for (let x = b.x0; x <= b.x1; x++) if (Math.abs(cur[y * W + x]! - bg[y * W + x]!) > thr) changed++
	return changed
}
