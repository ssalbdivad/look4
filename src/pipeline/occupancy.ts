// Finds the keyframes in which something sits on a feeder, without the detector. A small bird
// clinging to a feeder is too small and too still for it (a White-breasted Nuthatch scored 0.04 on
// OWL-ViT zoomed on the feeder, 0.15 needed), so these frames become the judge's close-ups.

import type { NormBox } from "../types.ts"

/** Side, in pixels, a feeder tile is scored at: a chickadee or nuthatch stays ~12-18 px. */
export const OCCUPANCY_SIDE = 96
/** Frames each frame is compared with: the closest-looking ones, so the feeder swung to about the same place. */
const NEIGHBOURS = 5
/** Frames on each side of a frame that are never its neighbours, so a bird's visit is not compared with itself. */
const GAP = 2
/** A pixel may match the neighbour anywhere this close (px at OCCUPANCY_SIDE), for the swing a pose match leaves over. */
const SHIFT = 2
/** Mean per-channel difference (0-255) over a 3×3 patch above which a pixel is "something new". */
const PIXEL_DIFF = 25
/**
 * Blob area, in px of a 128 px tile, from which a frame counts as occupied. On a labelled clip (two
 * feeders, 116 s, 58 keyframes each: a Downy Woodpecker, chickadees and a nuthatch-sized bird coming
 * and going) birds scored 36-297 and no empty frame above 36, with the feeder swinging up to ~1/10
 * of the tile.
 */
export const OCCUPIED = 40

export type FrameOccupancy = {
	/** Area of the largest new blob, in px of a 128 px tile; 0 when nothing new. */
	score: number
	/** That blob's bounds, relative to the tile; null when nothing new. */
	box: NormBox | null
}

const median = (xs: Float32Array) => {
	const s = xs.slice().sort()
	return s[s.length >> 1]!
}

/**
 * Per pixel, the 3×3-patch mean of |f - g| (summed over channels / 3), each pixel taking its best
 * match within SHIFT px in `g`, folded into `out` by min.
 */
const patchDiffMin = (f: Uint8Array, g: Uint8Array, side: number, out: Float32Array, raw: Float32Array, integral: Float64Array) => {
	const w = side + 1
	for (let sy = -SHIFT; sy <= SHIFT; sy++)
		for (let sx = -SHIFT; sx <= SHIFT; sx++) {
			for (let y = 0; y < side; y++) {
				const gy = Math.min(side - 1, Math.max(0, y + sy))
				for (let x = 0; x < side; x++) {
					const gx = Math.min(side - 1, Math.max(0, x + sx))
					const p = (y * side + x) * 3
					const q = (gy * side + gx) * 3
					raw[y * side + x] = Math.abs(f[p]! - g[q]!) + Math.abs(f[p + 1]! - g[q + 1]!) + Math.abs(f[p + 2]! - g[q + 2]!)
				}
			}
			for (let y = 0; y < side; y++) {
				let row = 0
				for (let x = 0; x < side; x++) {
					row += raw[y * side + x]!
					integral[(y + 1) * w + x + 1] = integral[y * w + x + 1]! + row
				}
			}
			for (let y = 1; y < side - 1; y++)
				for (let x = 1; x < side - 1; x++) {
					const s = (integral[(y + 2) * w + x + 2]! - integral[(y - 1) * w + x + 2]! - integral[(y + 2) * w + x - 1]! + integral[(y - 1) * w + x - 1]!) / 27
					const p = y * side + x
					if (s < out[p]!) out[p] = s
				}
		}
}

/** Largest 4-connected blob of `mask` after one 3×3 erosion, with its bounds grown back by the erosion. */
const largestBlob = (mask: Uint8Array, side: number): FrameOccupancy => {
	const px = side * side
	const er = new Uint8Array(px)
	for (let y = 1; y < side - 1; y++)
		for (let x = 1; x < side - 1; x++) {
			const p = y * side + x
			er[p] = mask[p - side - 1]! & mask[p - side]! & mask[p - side + 1]! & mask[p - 1]! & mask[p]! & mask[p + 1]! & mask[p + side - 1]! & mask[p + side]! & mask[p + side + 1]!
		}
	const seen = new Uint8Array(px)
	let best = 0
	let bounds = [0, 0, 0, 0]
	for (let i = 0; i < px; i++) {
		if (!er[i] || seen[i]) continue
		let n = 0
		let [x0, y0, x1, y1] = [side, side, 0, 0]
		const stack = [i]
		seen[i] = 1
		while (stack.length) {
			const p = stack.pop()!
			n++
			const x = p % side
			const y = (p - x) / side
			x0 = Math.min(x0, x)
			x1 = Math.max(x1, x)
			y0 = Math.min(y0, y)
			y1 = Math.max(y1, y)
			for (const q of [p - side, p + side, x > 0 ? p - 1 : -1, x < side - 1 ? p + 1 : -1])
				if (q >= 0 && q < px && er[q] && !seen[q]) {
					seen[q] = 1
					stack.push(q)
				}
		}
		if (n > best) {
			best = n
			bounds = [x0, y0, x1, y1]
		}
	}
	if (!best) return { score: 0, box: null }
	const [x0, y0, x1, y1] = bounds as [number, number, number, number]
	const lo = (v: number) => Math.max(0, v - 1) / side
	const hi = (v: number) => Math.min(side, v + 2) / side
	return { score: Math.round((best * 128 * 128) / px), box: { x: lo(x0), y: lo(y0), w: hi(x1) - lo(x0), h: hi(y1) - lo(y0) } }
}

/**
 * Scores every keyframe of one feeder (raw RGB, `side`×`side`, in time order) for something on it
 * that the rest of the clip mostly lacks. The feeder swings, often by more than a small bird's width,
 * so a frame is not compared with the clip's median picture: that flags the swing as strongly as a
 * bird (and a per-pixel variability allowance then hides birds sitting in the tray, where the swing
 * is largest). Each frame is compared instead with the NEIGHBOURS other frames that look most like
 * it overall, which are the ones where the feeder hung in about the same place; the per-pixel median
 * of those differences survives only where this frame has something most of them lack.
 *
 * A bird that sits through most of the clip is in its own neighbours and scores low; the detector
 * and the feeder sheet are the cover for that. The feeder turning on its chain to show another face
 * of its mesh scores high (an empty feeder at 238-373 on 2 of 35 clips): a wasted close-up.
 */
export const scoreFeederFrames = (frames: Uint8Array[], side: number): FrameOccupancy[] => {
	const n = frames.length
	// a short clip (the shortest is ~12 s, 6 keyframes) gets a narrower gap and fewer neighbours
	const gap = n >= NEIGHBOURS + 2 * GAP + 1 ? GAP : 1
	const k = Math.min(NEIGHBOURS, n - 2 * gap - 1)
	if (k < 2) return frames.map(() => ({ score: 0, box: null }))
	const px = side * side
	const dist = Array.from({ length: n }, () => new Float64Array(n))
	for (let i = 0; i < n; i++)
		for (let j = i + 1; j < n; j++) {
			let s = 0
			const a = frames[i]!
			const b = frames[j]!
			for (let k = 0; k < a.length; k++) s += Math.abs(a[k]! - b[k]!)
			dist[i]![j] = dist[j]![i] = s
		}
	const raw = new Float32Array(px)
	const integral = new Float64Array((side + 1) * (side + 1))
	const col = new Float32Array(k)
	const per = Array.from({ length: k }, () => new Float32Array(px))
	const mask = new Uint8Array(px)
	return frames.map((f, i) => {
		const near = Array.from({ length: n }, (_, j) => j)
			.filter(j => Math.abs(i - j) > gap)
			.sort((a, b) => dist[i]![a]! - dist[i]![b]!)
			.slice(0, k)
		near.forEach((j, m) => {
			per[m]!.fill(Infinity)
			patchDiffMin(f, frames[j]!, side, per[m]!, raw, integral)
		})
		for (let p = 0; p < px; p++) {
			for (let m = 0; m < near.length; m++) col[m] = per[m]![p]!
			const m = median(col)
			mask[p] = m !== Infinity && m > PIXEL_DIFF ? 1 : 0
		}
		return largestBlob(mask, side)
	})
}
