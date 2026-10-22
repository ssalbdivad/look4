// Turns detections into the few zoomed images the judge sees. The judge only ever
// looks at these plus one context frame, so their choice decides both accuracy
// (is the bird big enough to identify?) and cost (tokens ≈ width × height / 750).

import sharp from "sharp"
import { expandBox, iou, squareAround, toPixels } from "../geometry.ts"
import { keyframeRegions } from "../media/ffmpeg.ts"
import type { Detection, NormBox } from "../types.ts"
import type { JudgeCrop } from "./types.ts"

/** Context around the box on every side, as a fraction of the box. */
const PADDING = 0.35
/** Smallest crop side, in pixels and as a fraction of the frame's short edge, so a tiny bird keeps its perch in view. */
const MIN_SIDE_PX = 96
const MIN_SIDE_FRACTION = 0.12
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
/** Most keyframes a sheet shows; a longer clip's are spread evenly over it. */
const SHEET_MAX_TILES = 12

/**
 * For a clip the detector found nothing in: one image per feeder, every keyframe of the clip at that
 * feeder tiled in time order, so the judge sees the whole clip at each feeder. Picking frames does
 * not work there: a chickadee sat still on a feeder for the first 3 s of 24 and the feeder then
 * swung for 20, so every frame the motion gate picked showed it empty, and so did the frames a
 * difference score ranked first (the swing outscored the bird, 2026-10-22). Each tile is labeled
 * with its time; the crop's `frameT` is the first tile's.
 */
export const feederSheets = async (
	path: string,
	size: { width: number; height: number },
	feeders: NormBox[],
	signal?: AbortSignal
): Promise<JudgeCrop[]> => {
	const regions = feeders.map(box => cropRegion(box, size.width, size.height))
	const frames = await keyframeRegions(path, regions.map(r => toPixels(r, size.width, size.height)), SHEET_TILE, signal)
	if (!frames.length) return []
	const picked = frames.length <= SHEET_MAX_TILES ? frames : Array.from({ length: SHEET_MAX_TILES }, (_, i) => frames[Math.round((i * (frames.length - 1)) / (SHEET_MAX_TILES - 1))]!)
	// about 4:3, the shape vision models read best: 12 tiles are 4×3
	const cols = Math.ceil(Math.sqrt((picked.length * 4) / 3) - 1e-9)
	const rows = Math.ceil(picked.length / cols)
	return Promise.all(
		feeders.map(async (box, f) => {
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
