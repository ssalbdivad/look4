// Turns detections into the few zoomed images the judge sees. The judge only ever
// looks at these plus one context frame, so their choice decides both accuracy
// (is the bird big enough to identify?) and cost (tokens ≈ width × height / 750).

import sharp from "sharp"
import { expandBox, fromInner, iou, squareAround, toPixels } from "../geometry.ts"
import { keyframeRegions, type ProbeResult } from "../media/ffmpeg.ts"
import type { Detection, NormBox } from "../types.ts"
import { type FrameOccupancy, OCCUPANCY_SIDE, OCCUPIED, scoreFeederFrames } from "./occupancy.ts"
import type { JudgeCrop } from "./types.ts"

/** Context around the box on every side, as a fraction of the box. */
const PADDING = 0.35
/**
 * Smallest crop side, in pixels and as a fraction of the frame's short edge, so a tiny bird keeps its
 * perch in view. Small: at 12% a 47 px nuthatch on a 4K frame filled a fifth of a 259 px crop, and
 * Sonnet named it in 2 of 6 calls (a Downy Woodpecker, a House Finch otherwise); cropped at 5% it named
 * it in 5 of 5, at 60-80% (2026-10-22). The context image still shows where the bird is.
 */
const MIN_SIDE_PX = 96
const MIN_SIDE_FRACTION = 0.05
/** Long edge for coarse calls ("any squirrel"), where more pixels buy nothing. */
const COARSE_EDGE = 384
/** Two boxes on the same frame overlapping this much show the same thing. */
const DUPLICATE_IOU = 0.5

/** The region (full-frame normalized) a crop around `box` covers: padded, squared, at least the minimum side. */
export const cropRegion = (box: NormBox, width: number, height: number): NormBox => {
	const minSidePx = Math.max(MIN_SIDE_PX, MIN_SIDE_FRACTION * Math.min(width, height))
	return squareAround(expandBox(box, PADDING), width / height, Math.min(1, minSidePx / height))
}

/** Same label and boxes overlapping this much, in any frame, is the same subject: feeder visitors move little between sampled frames. */
const SAME_SUBJECT_IOU = 0.3

/**
 * Picks up to `maxCrops` detections so every candidate SUBJECT gets a close-up before
 * any gets a second one: detections are grouped into subjects (same label, overlapping
 * boxes across frames), subjects are taken round-robin across labels, best first, and
 * a subject's extra crops come from frames it was not already cropped on (several
 * moments beat several looks at one moment). With a cardinal and a woodpecker on one
 * feeder, the judge sees both, even when the cardinal outscores the woodpecker everywhere.
 */
export const pickDetections = (detections: Detection[], maxCrops: number): Detection[] => {
	const sorted = [...detections].sort((a, b) => b.score - a.score)
	const subjects: Detection[][] = []
	for (const d of sorted) {
		const s = subjects.find(g => g[0]!.label === d.label && g.some(x => iou(x.box, d.box) >= SAME_SUBJECT_IOU))
		if (!s) subjects.push([d])
		// the same box twice on one frame adds nothing
		else if (!s.some(x => x.frameT === d.frameT && iou(x.box, d.box) >= DUPLICATE_IOU)) s.push(d)
	}
	// within a subject: new frames first, each group best first
	const ordered = subjects.map(g => {
		const seen = new Set<number>()
		const fresh: Detection[] = []
		const repeat: Detection[] = []
		for (const d of g) {
			if (seen.has(d.frameT)) repeat.push(d)
			else {
				fresh.push(d)
				seen.add(d.frameT)
			}
		}
		return [...fresh, ...repeat]
	})
	// interleave labels: a strong "bird" must not crowd out the only "squirrel"
	const byLabel = new Map<string, Detection[][]>()
	for (const g of ordered) byLabel.set(g[0]!.label, [...(byLabel.get(g[0]!.label) ?? []), g])
	const queue: Detection[][] = []
	for (let i = 0; queue.length < ordered.length; i++) for (const gs of byLabel.values()) if (gs[i]) queue.push(gs[i]!)

	const chosen: Detection[] = []
	for (let round = 0; chosen.length < maxCrops; round++) {
		let any = false
		for (const g of queue) {
			const d = g[round]
			if (!d) continue
			any = true
			chosen.push(d)
			if (chosen.length >= maxCrops) break
		}
		if (!any) break
	}
	return chosen
}

/** The frame decoded at `t`, or the nearest one (detectors may round timestamps differently). */
const frameAt = (frames: Map<number, Buffer>, t: number): Buffer | null => {
	const exact = frames.get(t)
	if (exact) return exact
	let best: Buffer | null = null
	let bestDist = Infinity
	for (const [ft, buf] of frames) {
		const dist = Math.abs(ft - t)
		if (dist < bestDist) {
			best = buf
			bestDist = dist
		}
	}
	return bestDist <= 0.5 ? best : null
}

export const buildCrops = async (
	frames: Map<number, Buffer>,
	detections: Detection[],
	opts: { maxCrops: number; cropSize: number; fineGrained: boolean }
): Promise<JudgeCrop[]> => {
	const edge = opts.fineGrained ? opts.cropSize : Math.min(opts.cropSize, COARSE_EDGE)
	const sizes = new Map<Buffer, { width: number; height: number }>()
	const crops: JudgeCrop[] = []
	for (const d of pickDetections(detections, opts.maxCrops)) {
		const frame = frameAt(frames, d.frameT)
		if (!frame) continue
		let size = sizes.get(frame)
		if (!size) {
			const meta = await sharp(frame).metadata()
			if (!meta.width || !meta.height) continue
			size = { width: meta.width, height: meta.height }
			sizes.set(frame, size)
		}
		const rect = toPixels(cropRegion(d.box, size.width, size.height), size.width, size.height)
		// enlarging small crops is deliberate: vision models read sub-200px images poorly
		const jpeg = await sharp(frame)
			.extract(rect)
			.resize(edge, edge, { fit: "inside" })
			.jpeg({ quality: 85 })
			.toBuffer()
		crops.push({ jpeg, frameT: d.frameT, label: d.label, score: d.score, box: d.box })
	}
	return crops
}

/** Tile side in a feeder sheet: a chickadee, ~70 px of a 4K feeder region, stays ~50 px. */
const SHEET_TILE = 256
/** Most keyframes a sheet shows. */
const SHEET_MAX_TILES = 12
/** The label of a feeder visit found by `scoreFeederFrames`, as a detection. */
export const FEEDER_VISITOR = "feeder visitor"

/**
 * A feeder's visits: runs of occupied frames (`OCCUPIED` or more), one unoccupied frame allowed inside
 * a run since a bird ducking behind the feeder for a keyframe is still the same visit. Each run's
 * frames are best first; runs are ordered by their best frame.
 */
export const visitRuns = (scores: number[]): number[][] => {
	const runs: number[][] = []
	let open: number[] | null = null
	let last = -Infinity
	scores.forEach((s, i) => {
		if (s < OCCUPIED) return
		if (open && i - last <= 2) open.push(i)
		else runs.push((open = [i]))
		last = i
	})
	return runs.map(r => r.sort((a, b) => scores[b]! - scores[a]!)).sort((a, b) => scores[b[0]!]! - scores[a[0]!]!)
}

/**
 * The frames to close up on: within each visit, the best frame at each place on the feeder (boxes
 * overlapping by SAME_SUBJECT_IOU are one place). Two birds can make one visit: on 2026-10-22 a
 * sparrow on the tray and then a nuthatch head-down on the tube kept the feeder occupied for 22 s,
 * and one close-up per visit went to the sparrow.
 */
export const visitorFrames = (occupancy: FrameOccupancy[]): number[] =>
	visitRuns(occupancy.map(o => o.score)).flatMap(run => {
		const places: number[] = []
		for (const i of run) if (places.every(p => iou(occupancy[p]!.box!, occupancy[i]!.box!) < SAME_SUBJECT_IOU)) places.push(i)
		return places
	})

/**
 * Up to `max` of a feeder's frames for its sheet, in time order: occupied frames first, taken a visit
 * at a time (each visit's best, then each one's second best, ...) so a nuthatch dropping in for one
 * keyframe still makes it beside a sparrow that sat through twenty; then the rest spread evenly.
 * Spread alone missed most visits: a 2-minute clip has ~60 keyframes and a chickadee or woodpecker
 * stays for 1-5 of them, so 12 evenly spaced tiles (one per ~10 s) showed the feeder empty while
 * birds came and went. The even fill covers what scoring cannot see: a bird that clings through the
 * whole clip.
 */
export const sheetFrames = (scores: number[], max: number): number[] => {
	const n = scores.length
	if (n <= max) return scores.map((_, i) => i)
	const runs = visitRuns(scores)
	const chosen = new Set<number>()
	for (let round = 0; chosen.size < max && runs.some(r => r[round] !== undefined); round++)
		for (const r of runs) if (r[round] !== undefined && chosen.size < max) chosen.add(r[round]!)
	const rest = scores.map((_, i) => i).filter(i => !chosen.has(i))
	const fill = max - chosen.size
	for (let j = 0; j < fill; j++) chosen.add(rest[Math.round(fill === 1 ? (rest.length - 1) / 2 : (j * (rest.length - 1)) / (fill - 1))]!)
	return [...chosen].sort((a, b) => a - b)
}

/**
 * Every feeder's keyframes, for every clip that reaches the judge, whatever the detector found: a
 * small bird clinging to a feeder is too small and too still for it, and on 2026-10-22 the doves the
 * detector found on the ground kept the feeders out of the judge's sight (they were looked at only
 * when it found nothing at all) while chickadees, a woodpecker and nuthatches came and went.
 *
 * Returns one sheet per feeder, its keyframes tiled in time order (picked by `sheetFrames`), each
 * tile labeled with its time; and each visit `scoreFeederFrames` finds (`visitRuns`), as a detection
 * labeled FEEDER_VISITOR on its best frame, boxed on the visitor, so the judge also gets a close-up of
 * it (a bird is ~34 px in a sheet tile). Picking frames by the motion gate alone does not work at a
 * feeder: a chickadee sat still on one for the first 3 s of 24 and the feeder then swung for 20, so
 * every frame motion picked showed it empty. Keyframes decode on their own: one pass over a 24 s 4K
 * clip's 12 takes ~3.2 s.
 */
export const feederLook = async (
	clipId: string,
	path: string,
	size: Pick<ProbeResult, "width" | "height"> & Partial<Pick<ProbeResult, "codec" | "rotation">>,
	feeders: NormBox[],
	signal?: AbortSignal
): Promise<{ sheets: JudgeCrop[]; visits: Detection[] }> => {
	const regions = feeders.map(box => cropRegion(box, size.width, size.height))
	const rects = regions.map(r => toPixels(r, size.width, size.height))
	const frames = await keyframeRegions(path, rects, SHEET_TILE, signal, size.codec ? { ...size, codec: size.codec } : undefined)
	if (!frames.length) return { sheets: [], visits: [] }
	const visits: Detection[] = []
	const sheets = await Promise.all(
		feeders.map(async (box, f) => {
			const small = await Promise.all(
				frames.map(k => sharp(k.tiles[f]!, { raw: { width: SHEET_TILE, height: SHEET_TILE, channels: 3 } }).resize(OCCUPANCY_SIDE, OCCUPANCY_SIDE).raw().toBuffer())
			)
			signal?.throwIfAborted()
			const occupancy = scoreFeederFrames(small, OCCUPANCY_SIDE)
			for (const i of visitorFrames(occupancy)) {
				const o = occupancy[i]!
				visits.push({ clipId, frameT: frames[i]!.t, label: FEEDER_VISITOR, score: Math.min(1, o.score / 300), box: fromInner(o.box!, regions[f]!), via: "feeder" })
			}
			const picked = sheetFrames(
				occupancy.map(o => o.score),
				SHEET_MAX_TILES
			).map(i => frames[i]!)
			// about 4:3, the shape vision models read best: 12 tiles are 4×3
			const cols = Math.ceil(Math.sqrt((picked.length * 4) / 3) - 1e-9)
			const rows = Math.ceil(picked.length / cols)
			const tiles = picked.map((k, i) => ({
				input: k.tiles[f]!,
				raw: { width: SHEET_TILE, height: SHEET_TILE, channels: 3 as const },
				left: (i % cols) * SHEET_TILE,
				top: Math.floor(i / cols) * SHEET_TILE
			}))
			const labels = picked.map((k, i) => ({
				input: Buffer.from(
					`<svg width="64" height="22"><rect width="64" height="22" fill="black" fill-opacity="0.6"/><text x="4" y="16" font-family="sans-serif" font-size="15" fill="white">${k.t.toFixed(1)}s</text></svg>`
				),
				left: (i % cols) * SHEET_TILE,
				top: Math.floor(i / cols) * SHEET_TILE
			}))
			const jpeg = await sharp({ create: { width: cols * SHEET_TILE, height: rows * SHEET_TILE, channels: 3, background: "#000" } })
				.composite([...tiles, ...labels])
				.jpeg({ quality: 85 })
				.toBuffer()
			return { jpeg, frameT: picked[0]!.t, label: "feeder timeline", score: 0, box, sheet: picked.map(k => k.t) }
		})
	)
	return { sheets, visits: visits.sort((a, b) => b.score - a.score) }
}

/** The whole scene (or the detection zone) for the judge's context, long edge at most `maxEdge`. */
export const contextImage = async (frame: Buffer, roi: NormBox | null, maxEdge = 768): Promise<Buffer> => {
	let img = sharp(frame)
	if (roi) {
		const meta = await sharp(frame).metadata()
		if (meta.width && meta.height) img = img.extract(toPixels(roi, meta.width, meta.height))
	}
	return img.resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()
}
