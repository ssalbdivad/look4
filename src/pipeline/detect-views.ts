// Pure parts of the detector: which regions of a frame the model looks at, how
// query nouns are phrased for it, and how its raw boxes become full-frame
// detections. No model or ffmpeg here, so all of it is unit-testable.

import { area, clampBox, FULL_FRAME, fromInner, nms } from "../geometry.ts"
import type { Detection, NormBox } from "../types.ts"

/**
 * A region of the full frame the model is run on. A `speculative` view is not anchored on
 * the main motion (a secondary blob's zoom, a second-look tile): every extra close-up is
 * another chance for clutter to look like a squirrel, so its hits must clear a higher bar.
 */
export type View = { box: NormBox; via: Detection["via"]; speculative?: true }

/** A raw model hit, its box relative to the view image (0..1, may spill slightly past the edges). */
export type ViewHit = { label: string; score: number; box: NormBox }

/** Below this share of the ROI, a motion region is small enough that a zoomed second look pays off. */
export const ZOOM_MAX_SHARE = 0.25
/**
 * Smallest zoom side in source pixels. Zooms below the model's input size get upsampled,
 * and that helps: OWL-ViT B/32 sees the world in 32 px patches, so a 60 px squirrel scored
 * 0.27 in a 400 px crop but < 0.05 in a 720 px one. Much smaller and context is lost.
 */
export const ZOOM_MIN_SIDE_PX = 384
/** Context kept around the motion box on every side, as a fraction of its size. */
const ZOOM_CONTEXT = 0.75

export type ModelFamily = "owl" | "grounding-dino"

export const modelFamily = (modelId: string): ModelFamily =>
	/grounding[-_]?dino/i.test(modelId) ? "grounding-dino" : "owl"

/**
 * The text the model is queried with for a bare noun. OWL-ViT/OWLv2 were trained on
 * CLIP-style captions ("a photo of a bird"); Grounding DINO wants a lowercase phrase
 * ending in a period.
 */
export const queryPrompt = (noun: string, family: ModelFamily) => {
	const n = noun.trim().toLowerCase().replace(/\.+$/, "")
	if (family === "grounding-dino") return `${n}.`
	return /^(a|an|the)\s/.test(n) ? `a photo of ${n}` : `a photo of ${/^[aeiou]/.test(n) ? "an" : "a"} ${n}`
}

export type QueryBatch = { nouns: string[]; prompts: string[] }

/**
 * How the nouns are split into model calls. OWL scores every query in one pass.
 * Grounding DINO's transformers.js post-processing labels every box with the whole
 * text span ("bird squirrel."), so it cannot tell which noun matched: one call per noun.
 */
export const queryBatches = (nouns: string[], family: ModelFamily): QueryBatch[] =>
	family === "owl"
		? [{ nouns, prompts: nouns.map(n => queryPrompt(n, family)) }]
		: nouns.map(n => ({ nouns: [n], prompts: [queryPrompt(n, family)] }))

/** Maps a label the model returned back to the bare query noun, or null if it is not one of the batch's. */
export const labelToNoun = (label: string, batch: QueryBatch): string | null =>
	batch.nouns.length === 1 ? batch.nouns[0]! : (batch.nouns[batch.prompts.indexOf(label)] ?? null)

/**
 * The square region (in full-frame coords) to re-run detection on around a small
 * motion box, or null when the motion is big enough that the ROI view already sees
 * it well. Square in pixels and shifted (not clipped) to stay inside the frame.
 */
export const zoomView = (
	motionBox: NormBox | null,
	roi: NormBox | null,
	frame: { width: number; height: number }
): NormBox | null => {
	if (!motionBox || area(motionBox) <= 0) return null
	const outer = roi ?? FULL_FRAME
	if (area(motionBox) >= ZOOM_MAX_SHARE * area(outer)) return null
	const { width: W, height: H } = frame
	const boxSidePx = Math.max(motionBox.w * W, motionBox.h * H) * (1 + 2 * ZOOM_CONTEXT)
	const side = Math.min(Math.max(boxSidePx, ZOOM_MIN_SIDE_PX), W, H)
	// zooming in on most of the frame's short side gains nothing over the ROI view
	if (side >= 0.9 * Math.min(outer.w * W, outer.h * H)) return null
	const cx = (motionBox.x + motionBox.w / 2) * W
	const cy = (motionBox.y + motionBox.h / 2) * H
	const left = Math.min(Math.max(0, cx - side / 2), W - side)
	const top = Math.min(Math.max(0, cy - side / 2), H - side)
	return { x: left / W, y: top / H, w: side / W, h: side / H }
}

/**
 * Zoom views per frame, the largest motion blob's first. More blobs than this in one
 * frame is almost always foliage, and each zoom costs a full model run.
 */
export const MAX_ZOOMS = 3

const overlapShare = (inner: NormBox, outer: NormBox) => {
	const a = area(inner)
	if (a <= 0) return 1
	const w = Math.min(inner.x + inner.w, outer.x + outer.w) - Math.max(inner.x, outer.x)
	const h = Math.min(inner.y + inner.h, outer.y + outer.h) - Math.max(inner.y, outer.y)
	return w > 0 && h > 0 ? (w * h) / a : 0
}

/**
 * The views to run for one frame: the ROI (or whole frame), a zoom on each feeder, plus a
 * zoom around each small motion blob (the largest first, then `others`), up to `MAX_ZOOMS`.
 * A blob that already sits inside an earlier zoom is seen there and gets no view of its own.
 * Feeder zooms are not speculative: a bird at the feeder is the expected subject, not clutter.
 */
export const viewsFor = (
	motionBox: NormBox | null,
	roi: NormBox | null,
	frame: { width: number; height: number },
	zoom: boolean,
	others: NormBox[] = [],
	feeders: NormBox[] = []
): View[] => {
	const views: View[] = [{ box: roi ? clampBox(roi) : FULL_FRAME, via: "full" }]
	if (!zoom) return views
	const zooms: View[] = []
	for (const f of feeders) {
		const z = zoomView(f, roi, frame)
		if (z) zooms.push({ box: z, via: "zoom" })
	}
	const motionZoomsFrom = zooms.length
	const blobs = [...(motionBox ? [{ b: motionBox, main: true }] : []), ...others.map(b => ({ b, main: false }))]
	for (const { b, main } of blobs) {
		if (zooms.length - motionZoomsFrom >= MAX_ZOOMS) break
		// only motion zooms hold a blob: a feeder zoom is wider, and a tighter crop scores small birds higher
		if (zooms.slice(motionZoomsFrom).some(z => overlapShare(b, z.box) >= 0.8)) continue
		const z = zoomView(b, roi, frame)
		if (z) zooms.push(main ? { box: z, via: "zoom" } : { box: z, via: "zoom", speculative: true })
	}
	return [...views, ...zooms]
}

/**
 * Side of a second-look tile as a share of the ROI's short edge. OWL-ViT squashes every
 * view to 768x768, so a subject needs to fill a few of its 32 px patches: on the
 * squirrel fixture (an 80x290 px squirrel in 720p) 0.6 scored 0.36-0.57 on 4 of 5
 * frames, 0.5 split it across rows (< 0.07 on 3 of 5) and 0.75 diluted it (< 0.05 on 3 of 5).
 */
export const TILE_SHARE = 0.6
/** Neighbouring tiles overlap by at least this share of a side, so a subject on a seam is whole in one. */
const TILE_OVERLAP = 0.25
/** Most tiles per frame; a very elongated ROI gets bigger tiles rather than more. */
export const MAX_TILES = 8

/** Evenly spaced starts of `n` windows of `side` covering [0, len], overlapping by at least `TILE_OVERLAP`. */
const tileStarts = (len: number, side: number) => {
	const n = side >= len ? 1 : Math.ceil((len - side) / (side * (1 - TILE_OVERLAP)) - 1e-9) + 1
	return Array.from({ length: n }, (_, i) => (n === 1 ? 0 : (i * (len - side)) / (n - 1)))
}

/**
 * The "second look": pixel-square, overlapping tiles covering the ROI, for when the
 * normal views found nothing. Each tile is seen at roughly 2-3x the scale of the ROI
 * view, which is what a small or partly hidden subject needs when the motion boxes
 * landed on something else (wind in the leaves).
 */
export const tileViews = (roi: NormBox | null, frame: { width: number; height: number }): View[] => {
	const outer = roi ? clampBox(roi) : FULL_FRAME
	const W = outer.w * frame.width
	const H = outer.h * frame.height
	if (!(W > 0 && H > 0)) return []
	const short = Math.min(W, H)
	const long = Math.max(W, H)
	// the model input is 768 px: a ROI this small is already magnified in the ROI view
	if (long <= ZOOM_MIN_SIDE_PX) return []
	const count = (side: number) => tileStarts(W, side).length * tileStarts(H, side).length
	// below the zoom floor a tile is mostly upsampling noise, and the ROI view already gets upsampled
	let side = Math.min(short, Math.max(short * TILE_SHARE, ZOOM_MIN_SIDE_PX))
	while (count(side) > MAX_TILES && side < short) side = Math.min(short, side * 1.1)
	// a very elongated ROI still has too many: stretch the tiles along its long axis instead
	const stretched = count(side) > MAX_TILES ? long / (MAX_TILES - (MAX_TILES - 1) * TILE_OVERLAP) : side
	const tw = W >= H ? stretched : side
	const th = W >= H ? side : stretched
	const xs = tileStarts(W, tw)
	const ys = tileStarts(H, th)
	// one tile that is the whole ROI is the view that already found nothing
	if (xs.length * ys.length === 1 && tw >= W && th >= H) return []
	return ys.flatMap(y =>
		xs.map(x => ({
			box: { x: outer.x + x / frame.width, y: outer.y + y / frame.height, w: tw / frame.width, h: th / frame.height },
			via: "zoom" as const,
			speculative: true as const
		}))
	)
}

/** A hit's box from view-relative to full-frame normalized coords, clamped to the frame. */
export const hitToFrame = (hit: ViewHit, view: NormBox): NormBox => clampBox(fromInner(clampBox(hit.box), view))

/**
 * Turns one frame's hits from every view into detections: map to full-frame coords,
 * drop sub-threshold and degenerate boxes (speculative views use `speculativeThreshold`),
 * then NMS per label so the same bird seen in the ROI view and the zoom view is reported
 * once (the higher-scoring one survives, keeping its `via`).
 */
export const mergeFrameHits = (
	clipId: string,
	frameT: number,
	perView: Array<{ view: View; hits: ViewHit[] }>,
	threshold: number,
	iouThreshold = 0.5,
	speculativeThreshold = threshold
): Detection[] => {
	const all: Detection[] = []
	for (const { view, hits } of perView)
		for (const hit of hits) {
			if (hit.score < (view.speculative ? Math.max(threshold, speculativeThreshold) : threshold)) continue
			const box = hitToFrame(hit, view.box)
			if (box.w <= 0 || box.h <= 0) continue
			all.push({ clipId, frameT, label: hit.label, score: hit.score, box, via: view.via })
		}
	const labels = [...new Set(all.map(d => d.label))]
	return labels.flatMap(l => nms(all.filter(d => d.label === l), iouThreshold)).sort((a, b) => b.score - a.score)
}

/** Evenly spaced sample times (frame centers of n equal slices) for clips the motion gate gave no frames for. */
export const evenTimes = (durationS: number, n: number): number[] => {
	if (!(durationS > 0)) return [0]
	return Array.from({ length: n }, (_, i) => Number((((i + 0.5) / n) * durationS).toFixed(3)))
}

/**
 * True once every query has been seen with at least `confident` score on at least
 * `frames` distinct frames — more frames will not change which lookouts are candidates.
 */
export const saturated = (detections: Detection[], queries: string[], confident: number, frames: number) =>
	queries.length > 0 &&
	queries.every(q => new Set(detections.filter(d => d.label === q && d.score >= confident).map(d => d.frameT)).size >= frames)
