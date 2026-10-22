import type { NormBox } from "./types.ts"

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

export const FULL_FRAME: NormBox = { x: 0, y: 0, w: 1, h: 1 }

/** Clips a box to the unit square. */
export const clampBox = (b: NormBox): NormBox => {
	const x = clamp01(b.x)
	const y = clamp01(b.y)
	return { x, y, w: clamp01(b.x + b.w) - x, h: clamp01(b.y + b.h) - y }
}

/** Grows a box by `factor` of its own size on every side, then clamps. */
export const expandBox = (b: NormBox, factor: number): NormBox =>
	clampBox({ x: b.x - b.w * factor, y: b.y - b.h * factor, w: b.w * (1 + 2 * factor), h: b.h * (1 + 2 * factor) })

/** Smallest box containing both. */
export const unionBox = (a: NormBox, b: NormBox): NormBox => {
	const x = Math.min(a.x, b.x)
	const y = Math.min(a.y, b.y)
	return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

export const area = (b: NormBox) => Math.max(0, b.w) * Math.max(0, b.h)

export const iou = (a: NormBox, b: NormBox) => {
	const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
	const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
	const inter = ix * iy
	const u = area(a) + area(b) - inter
	return u <= 0 ? 0 : inter / u
}

/** Greedy non-max suppression, highest score first. */
export const nms = <t extends { box: NormBox; score: number }>(items: t[], threshold = 0.5): t[] => {
	const sorted = [...items].sort((a, b) => b.score - a.score)
	const kept: t[] = []
	for (const item of sorted) if (kept.every(k => iou(k.box, item.box) < threshold)) kept.push(item)
	return kept
}

/** Maps a box expressed relative to `outer` (itself in full-frame coords) back to full-frame coords. */
export const fromInner = (inner: NormBox, outer: NormBox): NormBox => ({
	x: outer.x + inner.x * outer.w,
	y: outer.y + inner.y * outer.h,
	w: inner.w * outer.w,
	h: inner.h * outer.h
})

/** Maps a full-frame box into coordinates relative to `outer`. */
export const toInner = (box: NormBox, outer: NormBox): NormBox => ({
	x: (box.x - outer.x) / outer.w,
	y: (box.y - outer.y) / outer.h,
	w: box.w / outer.w,
	h: box.h / outer.h
})

/** Integer pixel rectangle for sharp's `extract`, at least 1px, inside the image. */
export const toPixels = (b: NormBox, width: number, height: number) => {
	const c = clampBox(b)
	const left = Math.min(width - 1, Math.floor(c.x * width))
	const top = Math.min(height - 1, Math.floor(c.y * height))
	return {
		left,
		top,
		width: Math.max(1, Math.min(width - left, Math.round(c.w * width))),
		height: Math.max(1, Math.min(height - top, Math.round(c.h * height)))
	}
}

/** Makes a box square-ish around its center (crops for a vision model read better that way). */
export const squareAround = (b: NormBox, frameAspect: number, minSide = 0): NormBox => {
	const cx = b.x + b.w / 2
	const cy = b.y + b.h / 2
	// side lengths in pixel-proportional units: w is in frame-width units, h in frame-height units
	const sidePx = Math.max(b.w * frameAspect, b.h, minSide)
	const w = sidePx / frameAspect
	const h = sidePx
	return clampBox({ x: cx - w / 2, y: cy - h / 2, w, h })
}
