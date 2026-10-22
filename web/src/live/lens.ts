// The wheel's zoom shared between the camera's lens and the picture's magnification, as plain arithmetic so
// node's test runner can check it (test/live-lens.test.ts). Two ways, a choice in the Live page's More menu:
// "picture" magnifies at the pointer at once and, once the wheel rests, has the lens frame the same part of
// the scene (the `box` op), the magnification it couldn't take staying digital; "camera" (the default) aims
// the lens at a box anchored at the pointer and zooms it first, a chain of steps as the wheel turns, and
// magnifies only what the lens can't take, once the picture has caught up.
//
// Coordinates are normalized full-frame, top-left origin, as everywhere on the stage. A view is
// `{ z, cx, cy }`: the magnification and the frame point at the stage's centre.

export type View = { z: number; cx: number; cy: number }
export type Box = { x: number; y: number; w: number; h: number }

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/**
 * What the lens frames to take over `f` of view `v`'s magnification: a box of the frame's own shape around
 * the view's centre, slid onto the frame where the centre is nearer an edge than half the box.
 */
export const lensBox = (v: View, f: number): Box => {
	const s = 1 / f
	return { x: clamp(v.cx - s / 2, 0, 1 - s), y: clamp(v.cy - s / 2, 0, 1 - s), w: s, h: s }
}

/**
 * What the lens frames to zoom `f` times about frame point `a` (the pointer): the scene point at `a` stays at
 * `a` in the new picture, as a point under the pointer stays put when the picture magnifies there. Always
 * inside the frame; a point off the picture (the pointer over the letterbox) counts as the nearest edge.
 */
export const anchoredBox = (a: { x: number; y: number }, f: number): Box => {
	const s = 1 / f
	return { x: clamp(a.x, 0, 1) * (1 - s), y: clamp(a.y, 0, 1) * (1 - s), w: s, h: s }
}

/**
 * Camera first's next lens step for the zoom asked and not sent yet, `want` (a natural log): the factor the
 * lens makes (`snap` rounds to its whole positions; it has `room` left), the zoom past its limit for the
 * picture to magnify later (`rest`, a log), and what stays asked (`want`: under one lens step, it waits for
 * more). `lens` 1: no step to send.
 */
export const lensStep = (want: number, room: number, snap: (factor: number) => number): { lens: number; rest: number; want: number } => {
	const asked = Math.exp(want)
	if (asked >= room) {
		const lens = snap(room)
		return { lens: lens > 1.001 ? lens : 1, rest: want - Math.log(Math.max(1, room)), want: 0 }
	}
	const lens = snap(asked)
	// rounded up to a whole position, the step can be a hair more than asked
	return lens > 1.001 ? { lens, rest: 0, want: Math.max(0, want - Math.log(lens)) } : { lens: 1, rest: 0, want }
}

/** Box `inner`, given in the coordinates of the view that framing `outer` gives, as a box of `outer`'s own picture. */
export const within = (outer: Box, inner: Box): Box => ({
	x: outer.x + inner.x * outer.w,
	y: outer.y + inner.y * outer.h,
	w: inner.w * outer.w,
	h: inner.h * outer.h
})

/** View `v` of the picture before the lens framed `box`, as a view of the picture after: the scene stays put on screen. */
export const afterLens = (v: View, box: Box): View => {
	const f = 1 / box.w
	return { z: v.z / f, cx: 0.5 + (v.cx - (box.x + box.w / 2)) * f, cy: 0.5 + (v.cy - (box.y + box.h / 2)) * f }
}

// While the lens moves, the stage holds the last picture from before the move until the moving picture
// settles: the live stream shows the move a second or so after the camera makes it, and the magnified view
// of a picture that is itself zooming would swing far past the target. Changes (see `change`) of a 64×36
// grey copy of the picture, sampled every 100 ms: 0 on eight still clips from this camera across a day
// (wind and birds included); on the demo's fixture clip, which drifts, at most 7 from its first frame over
// 10 s and 2 between samples; on a simulated 2.5× lens move, 9 at its first sample, 8–16 between samples
// and 16–25 from the start. Camera first shows the moving picture as it is (its lens move is the zoom) and
// reads the same thresholds only to know when the move reaches the picture and when it has settled (`nextBurst`).

/** More change than this since the handoff began: the move has reached the picture. */
export const MOVED = 8
/** Less change than this between samples, STILL_SAMPLES in a row: it has settled. */
export const STILL = 4
export const STILL_SAMPLES = 3
/** A move that never shows (too small to see, or a stalled stream) stops being waited for this long after it was sent... */
export const UNSEEN_MS = 4000
/** ...and nothing holds the picture longer than this. */
export const HOLD_MAX_MS = 8000

/**
 * `live`: the picture still shows the scene from before the move, so the stage keeps a copy of each frame;
 * `held`: the move has reached the picture, which the stage covers with that copy; `done`: show it live again.
 */
export type Hold = { phase: "live" | "held" | "done"; start: number; still: number }

export const startHold = (t: number): Hold => ({ phase: "live", start: t, still: 0 })

export type HoldSample = {
	t: number
	/** When the camera took the command; null while it's being sent, false if it refused. */
	sent: number | null | false
	/** Change since the first sample and since the previous one; null without a picture to sample. */
	fromStart: number | null
	fromLast: number | null
}

export const nextHold = (h: Hold, s: HoldSample): Hold => {
	if (h.phase === "done") return h
	if (s.sent === false || s.t - h.start > HOLD_MAX_MS) return { ...h, phase: "done" }
	if (h.phase === "live") {
		if (s.fromStart !== null && s.fromStart > MOVED) return { ...h, phase: "held", still: 0 }
		return s.sent !== null && s.t - s.sent > UNSEEN_MS ? { ...h, phase: "done" } : h
	}
	if (s.fromLast === null) return h
	const still = s.fromLast < STILL ? h.still + 1 : 0
	return { ...h, still, phase: still >= STILL_SAMPLES ? "done" : "held" }
}

/**
 * How much the picture changed between two grey copies of one size: the median pixel's change, less the
 * picture's overall brightening or darkening (exposure, a cloud). A lens move changes nearly every pixel; a
 * bird, however close, only some.
 */
export const change = (a: Uint8Array, b: Uint8Array) => {
	if (!a.length) return 0
	const d = new Int16Array(a.length)
	for (let i = 0; i < a.length; i++) d[i] = b[i]! - a[i]!
	const offset = d.slice().sort()[d.length >> 1]!
	for (let i = 0; i < d.length; i++) d[i] = Math.abs(d[i]! - offset)
	return d.sort()[d.length >> 1]!
}

/** RGBA pixels to grey. */
export const grey = (rgba: Uint8ClampedArray) => {
	const g = new Uint8Array(rgba.length / 4)
	for (let i = 0; i < g.length; i++) g[i] = (rgba[4 * i]! * 77 + rgba[4 * i + 1]! * 150 + rgba[4 * i + 2]! * 29) >> 8
	return g
}

// Camera first follows the same samples through a chain of camera steps (a "burst"): each step's request
// answers once the camera has arrived (zoomTo's `settle`), and the next goes at once from there. The picture
// shows the camera about 0.8–0.9 s after a command (measured: 0.35–0.45 s of stream path, the rest the
// camera's own move and the player), so the picture is current only once it has held still after the last
// arrival, with nothing more on its way.

/** The picture can't show the camera's arrival sooner than this after it: the stream path alone, measured 0.35–0.45 s. */
export const ARRIVAL_SHOWS_MS = 400
/** A burst whose move never showed (too small to see) is over this long after the camera arrived. */
export const UNSEEN_AFTER_MS = 2000

/** `live`: the picture shows nothing of the move yet; `moved`: it does; `done`: the picture is current again. */
export type Burst = { phase: "live" | "moved" | "done"; start: number; still: number }

export const startBurst = (t: number): Burst => ({ phase: "live", start: t, still: 0 })

export type BurstSample = {
	t: number
	/** A step is on its way to the camera, or about to be sent. */
	busy: boolean
	/** When the latest step went out, and when the camera arrived from it; null before. */
	sent: number | null
	arrived: number | null
	fromStart: number | null
	fromLast: number | null
}

export const nextBurst = (b: Burst, s: BurstSample): Burst => {
	if (b.phase === "done") return b
	// nothing holds out longer than this after the last thing that happened
	if (s.t - Math.max(b.start, s.sent ?? 0, s.arrived ?? 0) > HOLD_MAX_MS) return { ...b, phase: "done" }
	const moved = b.phase === "moved" || (s.fromStart !== null && s.fromStart > MOVED)
	const phase = moved ? "moved" : "live"
	// a still picture between two steps (the camera standing while its arrival is confirmed) isn't the end
	if (s.busy || s.arrived === null) return { ...b, phase, still: 0 }
	const since = s.t - s.arrived
	if (!moved) return since > UNSEEN_AFTER_MS ? { ...b, phase: "done" } : { ...b, phase, still: 0 }
	const still = since >= ARRIVAL_SHOWS_MS && s.fromLast !== null && s.fromLast < STILL ? b.still + 1 : 0
	return { ...b, phase: still >= STILL_SAMPLES ? "done" : "moved", still }
}
