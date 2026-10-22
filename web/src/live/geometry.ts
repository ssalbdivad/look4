// The Live page's layout as plain arithmetic: how wide the picture is, where the controls go, where each
// resize grip sits for a given width, which width a pointer asks for, and the sizes it snaps to. No React and
// no DOM, so node's test runner can check it (test/live-geometry.test.ts) and the page and the tests can't
// disagree about a pixel.
//
// Coordinates are page coordinates: the origin is the top-left of `.lv-shell`'s box in the page, x to the
// right, y down. One picture width drives everything; every way of resizing produces one and stores it as a
// `SizeChoice`.

/** The rail's width when it sits beside the picture: never narrower than RAIL_MIN, at rest RAIL_AUTO. */
export const RAIL_MIN = 272
export const RAIL_AUTO = 336
export const RAIL_MAX = 420
/** The splitter between them. */
export const SPLIT = 14
/** Smaller than this the picture stops being worth watching. */
export const PIC_MIN = 320
/** At the automatic size the picture is at least this wide beside the rail; less, and the rail moves under it. */
export const PIC_BESIDE_MIN = 560
/** The toolbar's height under the picture. */
export const BAR_H = 56
/** How close (px, between grip points) a size has to come to a snap before it jumps there. */
export const MAGNET = 12
/** Two snaps closer than this are one: the second would only make the first hard to leave. */
export const DEDUPE = 24
/** Pull this far past the largest size and letting go enters theater. */
export const ARM = 48
/** The invisible edge strips' thickness. */
export const EDGE_HIT = 10
/** The gap between the picture's card and the rail below it. */
export const BELOW_GAP = 14
/** The controls' header (drag it to move them): docked below, the automatic size keeps it on screen. */
export const HEAD_H = 36

export type Dock = "right" | "left" | "below"
export type SnapId = "auto" | "fit" | "beside" | "native"
export type SizeChoice = { snap: "auto" | "fit" | "beside" } | { share: number }
/**
 * The room the page has. `aside`: the rail (or the camera's problems) is shown at all. `min`: the narrowest
 * the picture's card may be, the toolbar under it at its narrowest (PIC_MIN when unknown).
 */
export type Room = { width: number; height: number; aside: boolean; dock: Dock; min?: number }
export type Place = "side" | "below" | "none"
/** `left`: the picture card's x. */
export type Plan = { place: Place; picture: number; rail: number; left: number }
export type Grip = "corner" | "edge-x" | "edge-y"
export type Snap = { id: SnapId; width: number; label: string }
export type Point = { x: number; y: number }
export type Rect = { x: number; y: number; w: number; h: number }

export const AUTO: SizeChoice = { snap: "auto" }

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

/** The smallest picture: PIC_MIN, or wider where the toolbar needs it (never wider than the page). */
export const minPicture = (r: Room) => Math.max(PIC_MIN, Math.min(r.min ?? 0, r.width))

/** The largest picture: the page's width, or as wide as the window's height allows at 16:9. */
export const maxPicture = (r: Room) => Math.max(minPicture(r), Math.min(r.width, (r.height * 16) / 9))

/** The rail may go beside the picture (it still needs RAIL_MIN of room there). */
export const canSide = (r: Room) => r.aside && r.dock !== "below"

/** The picture card's height: the 16:9 picture and the toolbar under it. */
export const cardH = (p: number) => (p * 9) / 16 + BAR_H

/**
 * The picture width a stored choice means in this room. Named sizes follow the window; a share keeps its share.
 * Automatic with the controls docked below leaves their header on screen, so they don't vanish under the fold.
 */
export const widthOf = (r: Room, size: SizeChoice): number => {
	const max = maxPicture(r)
	const min = minPicture(r)
	if ("share" in size) return clamp(size.share * r.width, min, max)
	if (size.snap === "fit") return max
	if (size.snap === "beside") return canSide(r) ? clamp(r.width - RAIL_MIN - SPLIT, min, max) : max
	if (r.aside && r.dock === "below") return clamp(((r.height - BELOW_GAP - HEAD_H) * 16) / 9, min, max)
	const a = r.width - RAIL_AUTO - SPLIT
	return canSide(r) && a >= Math.max(PIC_BESIDE_MIN, min) ? Math.min(a, max) : max
}

/**
 * Where everything goes for a picture `p` wide. Beside: the picture, splitter and rail centred as a group,
 * the rail taking what's left up to RAIL_MAX. Below: the picture hugs the dock's side, so a grip being dragged
 * across the side/below threshold doesn't jump.
 */
export const layoutFor = (r: Room, p: number): Plan => {
	const W = r.width
	if (!r.aside) return { place: "none", picture: p, rail: 0, left: (W - p) / 2 }
	if (canSide(r) && W - p - SPLIT >= RAIL_MIN) {
		const rail = Math.min(RAIL_MAX, W - p - SPLIT)
		const off = (W - (p + SPLIT + rail)) / 2
		return { place: "side", picture: p, rail, left: r.dock === "right" ? off : off + rail + SPLIT }
	}
	return { place: "below", picture: p, rail: 0, left: r.dock === "left" ? W - p : 0 }
}

export const planLayout = (r: Room, size: SizeChoice) => layoutFor(r, widthOf(r, size))

/** The corner grip (and the edge strips) sit on the controls' side: left only when they're docked left. */
export const gripOnLeft = (r: Room, place: Place) => place !== "none" && r.dock === "left"

/** Where a grip is when the picture is `p` wide. An edge counts along one axis only (the other is 0). */
export const gripPoint = (r: Room, p: number, grip: Grip): Point => {
	const L = layoutFor(r, p)
	const onLeft = gripOnLeft(r, L.place)
	if (grip === "corner") return { x: onLeft ? L.left : L.left + p, y: cardH(p) }
	if (grip === "edge-y") return { x: 0, y: cardH(p) + EDGE_HIT / 2 }
	if (L.place === "side") return { x: r.dock === "right" ? L.left + p + SPLIT / 2 : L.left - SPLIT / 2, y: 0 }
	return { x: onLeft ? L.left - EDGE_HIT / 2 : L.left + p + EDGE_HIT / 2, y: 0 }
}

/** The distance between two grip points as the grip sees it: both axes for the corner, one for an edge. */
const gripDistance = (grip: Grip, a: Point, b: Point) =>
	grip === "corner" ? Math.hypot(a.x - b.x, a.y - b.y) : grip === "edge-x" ? Math.abs(a.x - b.x) : Math.abs(a.y - b.y)

export const SNAP_LABELS: Record<SnapId, string> = {
	auto: "Automatic",
	fit: "Fit window",
	beside: "Largest beside the controls",
	native: "Actual pixels"
}

/**
 * The sizes a drag is pulled to, in priority order. `nativeWidth`: the playing stream's width in CSS pixels
 * (null when nothing plays). Sizes out of range, or within DEDUPE of an earlier one, are dropped.
 */
export const snapTargets = (r: Room, nativeWidth: number | null): Snap[] => {
	const max = maxPicture(r)
	const min = minPicture(r)
	const all: Array<[SnapId, number | null]> = [
		["auto", widthOf(r, AUTO)],
		["fit", max],
		["beside", canSide(r) ? r.width - RAIL_MIN - SPLIT : null],
		["native", nativeWidth]
	]
	const out: Snap[] = []
	for (const [id, width] of all) {
		if (width === null || !Number.isFinite(width) || width < min - 0.5 || width > max + 0.5) continue
		if (out.some(s => Math.abs(s.width - width) < DEDUPE)) continue
		out.push({ id, width, label: SNAP_LABELS[id] })
	}
	return out
}

/** The snap a width sits on (within half a pixel), if any. */
export const snapAt = (snaps: Snap[], width: number) => snaps.find(s => Math.abs(s.width - width) <= 0.5) ?? null

export type PointerSize = { width: number; snap: Snap | null; beyond: number }

/**
 * The width whose grip lands nearest `target` (the pointer, less where on the grip it was grabbed), so the
 * grip stays under the pointer whatever the centring does: with the group centred the picture grows 2 px per
 * pointer px, as a centred dialog does. Then, unless `free`, a snap within MAGNET wins. `beyond`: at the
 * largest size, how far the pointer has gone past it along the grip's path (else 0).
 *
 * The corner, given `from` (the width when the drag started), follows the axis the pointer moved further
 * along, as an aspect-locked window corner does: the width whose grip x is the pointer's and the one whose
 * grip y is, whichever is further from `from`. The nearest point on the 16:9 path would let a sideways or
 * straight-up pull count for a fraction of its length and leave the grip far behind the pointer.
 */
export const sizeFromPointer = (r: Room, grip: Grip, target: Point, snaps: Snap[], free: boolean, from?: number): PointerSize => {
	const max = maxPicture(r)
	const min = minPicture(r)
	// a 1 px scan: a few thousand layouts per move is nothing, and no shortcut has to agree with layoutFor
	const nearest = (dist: (at: Point) => number) => {
		let best = min
		let bestD = dist(gripPoint(r, min, grip))
		for (let p = Math.floor(min) + 1; p <= max + 1; p++) {
			const w = Math.min(p, max)
			const d = dist(gripPoint(r, w, grip))
			if (d < bestD) {
				best = w
				bestD = d
			}
		}
		return best
	}
	let best: number
	if (grip === "corner" && from !== undefined) {
		const byX = nearest(at => Math.abs(at.x - target.x))
		const byY = nearest(at => Math.abs(at.y - target.y))
		best = Math.abs(byX - from) >= Math.abs(byY - from) ? byX : byY
	} else best = nearest(at => gripDistance(grip, at, target))
	let snap: Snap | null = null
	if (!free) {
		const at = gripPoint(r, best, grip)
		let snapD = MAGNET
		for (const s of snaps) {
			const d = gripDistance(grip, gripPoint(r, s.width, grip), at)
			if (d <= snapD && (!snap || d < snapD)) {
				snap = s
				snapD = d
			}
		}
	}
	let beyond = 0
	if (best >= max - 0.5) {
		const end = gripPoint(r, max, grip)
		const before = gripPoint(r, max - 1, grip)
		const dx = grip === "edge-y" ? 0 : end.x - before.x
		const dy = grip === "edge-x" ? 0 : end.y - before.y
		const len = Math.hypot(dx, dy)
		if (len > 0) beyond = Math.max(0, ((target.x - end.x) * dx + (target.y - end.y) * dy) / len)
	}
	return { width: snap ? snap.width : best, snap, beyond }
}

/** What to remember for a width: a named snap by name, the largest size as "fit", anything else as a share. */
export const choiceFor = (r: Room, width: number, snap: SnapId | null): SizeChoice => {
	if (snap === "auto" || snap === "fit" || snap === "beside") return { snap }
	if (width >= maxPicture(r) - 0.5) return { snap: "fit" }
	return { share: width / Math.max(1, r.width) }
}

/** The named snap a stored choice is, if it's one. */
export const choiceSnap = (size: SizeChoice): SnapId | null => ("snap" in size ? size.snap : null)

/** An arrow key on the corner grip: 40 px (160 with Shift), stopping at the first snap it would pass. */
export const stepSize = (r: Room, p: number, dir: 1 | -1, big: boolean, snaps: Snap[]) => {
	let next = p + dir * (big ? 160 : 40)
	const passed = snaps.filter(s => Math.abs(s.width - p) > 0.5 && (dir > 0 ? s.width > p && s.width <= next : s.width < p && s.width >= next))
	if (passed.length) next = dir > 0 ? Math.min(...passed.map(s => s.width)) : Math.max(...passed.map(s => s.width))
	const width = clamp(next, minPicture(r), maxPicture(r))
	return { width, snap: snapAt(snaps, width) }
}

/** PageUp / PageDown: the next snap up or down, else the end of the range. */
export const nextSnap = (r: Room, p: number, dir: 1 | -1, snaps: Snap[]) => {
	const ahead = snaps.filter(s => (dir > 0 ? s.width > p + 0.5 : s.width < p - 0.5))
	const width = ahead.length ? (dir > 0 ? Math.min(...ahead.map(s => s.width)) : Math.max(...ahead.map(s => s.width))) : dir > 0 ? maxPicture(r) : minPicture(r)
	return { width, snap: snapAt(snaps, width) }
}

// ---------- remembered choices ----------

/** `look4:live-size`'s text back into a choice (null: unreadable). */
export const parseSize = (raw: string): SizeChoice | null => {
	let v: unknown
	try {
		v = JSON.parse(raw)
	} catch {
		return null
	}
	if (!v || typeof v !== "object") return null
	const o = v as { snap?: unknown; share?: unknown }
	if (o.snap === "auto" || o.snap === "fit" || o.snap === "beside") return { snap: o.snap }
	if (typeof o.share === "number" && o.share > 0 && o.share <= 1) return { share: o.share }
	return null
}

export const parseDock = (raw: string): Dock | null => (raw === "right" || raw === "left" || raw === "below" ? raw : null)

/**
 * The size to start with, from `look4:live-size` and the splitter's old `look4:live-width` (a share of the
 * page, or "null" for automatic). `migrated`: the old key was read, so write the new one and drop the old.
 */
export const loadSize = (sizeRaw: string | null, oldRaw: string | null): { size: SizeChoice; migrated: boolean } => {
	if (sizeRaw !== null) return { size: parseSize(sizeRaw) ?? AUTO, migrated: false }
	if (oldRaw === null) return { size: AUTO, migrated: false }
	const n = Number(oldRaw)
	return { size: oldRaw.trim() !== "" && n > 0 && n <= 1 ? { share: n } : AUTO, migrated: true }
}

// ---------- moving the controls ----------

/** The drop zones while the controls' header is dragged, in priority order (ties go to the earlier). */
export type Zone = { dock: Dock; rect: Rect }

/**
 * Where the controls could go, for the page as it is: beside on either side (only where a side layout fits,
 * at the current size or else the automatic one), and always below. `view`: the visible window in page
 * coordinates (less the sticky top bar); every zone is clamped into it, and the below zone becomes a band
 * along the window's bottom when hardly any of it would show.
 */
export const dropZones = (r: Room, size: SizeChoice, view: Rect): Zone[] => {
	const zones: Zone[] = []
	for (const dock of ["right", "left"] as const) {
		const room = { ...r, dock }
		if (!canSide(room)) continue
		let p = widthOf(room, size)
		let L = layoutFor(room, p)
		if (L.place !== "side") {
			p = widthOf(room, AUTO)
			L = layoutFor(room, p)
		}
		if (L.place !== "side") continue
		const x = dock === "right" ? L.left + p + SPLIT : L.left - SPLIT - L.rail
		// scrolled, only the part in view is drawn (at least a 56 px band, at the view's top)
		const y0 = Math.max(0, view.y)
		const y1 = Math.max(y0 + 56, Math.min(cardH(p), view.y + view.h))
		zones.push({ dock, rect: { x, y: y0, w: L.rail, h: y1 - y0 } })
	}
	const below = { ...r, dock: "below" as const }
	const top = cardH(widthOf(below, size)) + BELOW_GAP
	const y0 = Math.max(top, view.y)
	const y1 = Math.min(top + 200, view.y + view.h)
	const x0 = Math.max(0, view.x)
	const x1 = Math.min(r.width, view.x + view.w)
	const rect = y1 - y0 >= 56 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: view.x + 8, y: view.y + view.h - 8 - 56, w: view.w - 16, h: 56 }
	zones.push({ dock: "below", rect })
	return zones
}

/** The floating panel's two places in theater and full screen (the shell is the window there). */
export const overlayZones = (width: number, height: number): Zone[] => {
	const w = Math.min(320, width - 28)
	const rect = (x: number) => ({ x, y: 14, w, h: Math.max(0, height - 14 - 84) })
	return [
		{ dock: "right", rect: rect(width - 14 - w) },
		{ dock: "left", rect: rect(14) }
	]
}

/** The zone nearest the pointer (0 inside it); ties go to the earlier zone, so there is always exactly one. */
export const nearestZone = (zones: Zone[], at: Point): Zone | null => {
	let best: Zone | null = null
	let bestD = Infinity
	for (const z of zones) {
		const dx = Math.max(z.rect.x - at.x, 0, at.x - (z.rect.x + z.rect.w))
		const dy = Math.max(z.rect.y - at.y, 0, at.y - (z.rect.y + z.rect.h))
		const d = Math.hypot(dx, dy)
		if (d < bestD) {
			best = z
			bestD = d
		}
	}
	return best
}
