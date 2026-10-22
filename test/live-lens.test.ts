import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { lensFactor, lensPosition } from "../src/live/zoom-curve.ts"
import {
	afterLens,
	anchoredBox,
	ARRIVAL_SHOWS_MS,
	type Burst,
	type BurstSample,
	change,
	type Hold,
	type HoldSample,
	HOLD_MAX_MS,
	lensBox,
	lensStep,
	MOVED,
	nextBurst,
	nextHold,
	startBurst,
	startHold,
	STILL,
	UNSEEN_AFTER_MS,
	UNSEEN_MS,
	within
} from "../web/src/live/lens.ts"

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`)

/** Feeds samples 100 ms apart; returns the phase after each. */
const run = (samples: Omit<HoldSample, "t">[], from: Hold = startHold(0)) => {
	let h = from
	return samples.map((s, i) => (h = nextHold(h, { ...s, t: (i + 1) * 100 })).phase)
}

describe("handing magnification to the lens", () => {
	test("the lens frames the magnified view, slid onto the frame near an edge", () => {
		assert.deepEqual(lensBox({ z: 2, cx: 0.5, cy: 0.5 }, 2), { x: 0.25, y: 0.25, w: 0.5, h: 0.5 })
		// a bird at the left edge: the box can't be centred on it
		assert.deepEqual(lensBox({ z: 4, cx: 0.1, cy: 0.9 }, 2), { x: 0, y: 0.5, w: 0.5, h: 0.5 })
	})

	test("what the lens couldn't take stays magnified, and the scene doesn't move on screen", () => {
		const before = { z: 4, cx: 0.1, cy: 0.9 }
		const box = lensBox(before, 2)
		const after = afterLens(before, box)
		assert.deepEqual(after, { z: 2, cx: 0.2, cy: 0.8 })
		// a point of the scene: where it was on screen before (old picture), and after (the lens's picture)
		const p = { x: 0.13, y: 0.84 }
		const moved = { x: 0.5 + (p.x - (box.x + box.w / 2)) * 2, y: 0.5 + (p.y - (box.y + box.h / 2)) * 2 }
		near((moved.x - after.cx) * after.z, (p.x - before.cx) * before.z)
		near((moved.y - after.cy) * after.z, (p.y - before.cy) * before.z)
	})
})

describe("camera first: the lens zooms at the pointer", () => {
	/** Where frame point `p` is in the lens's picture once it has framed `box`. */
	const after = (box: { x: number; y: number; w: number; h: number }, p: { x: number; y: number }) => ({ x: (p.x - box.x) / box.w, y: (p.y - box.y) / box.h })

	test("the scene under the pointer stays under it, and the box stays on the frame near an edge", () => {
		const a = { x: 0.95, y: 0.02 }
		const box = anchoredBox(a, 4)
		near(box.x, 0.7125)
		near(box.y, 0.015)
		assert.equal(box.w, 0.25)
		const moved = after(box, a)
		near(moved.x, 0.95)
		near(moved.y, 0.02)
		assert.ok(box.x + box.w <= 1 && box.y >= 0)
	})

	test("the pointer over the letterbox anchors at the picture's edge", () => {
		assert.deepEqual(anchoredBox({ x: -0.2, y: 1.3 }, 2), { x: 0, y: 0.5, w: 0.5, h: 0.5 })
	})

	/** The RLC-823S1's 0–28 lens from position `at`, as useCamera snaps a factor to whole positions. */
	const lens = (at: number) => {
		const r = { min: 0, max: 28 }
		return {
			room: lensFactor(28, r) / lensFactor(at, r),
			snap: (f: number) => lensFactor(Math.round(lensPosition(Math.min(2.53, lensFactor(at, r) * f), r)), r) / lensFactor(at, r)
		}
	}

	test("a step is whole lens positions: what rounding leaves stays asked, and less than a position waits", () => {
		const { room, snap } = lens(8)
		// 1.2× from 1.38× wants 1.656×: position 12.78, so 13 (1.6675×)
		const step = lensStep(Math.log(1.2), room, snap)
		near(step.lens, 1.6675 / 1.38)
		assert.equal(step.rest, 0)
		// rounded up a hair past what was asked: nothing stays
		assert.equal(step.want, 0)
		assert.deepEqual(lensStep(Math.log(1.01), room, snap), { lens: 1, rest: 0, want: Math.log(1.01) })
	})

	test("past the lens's limit, the step goes all the way in and the rest is left to magnify", () => {
		const { room, snap } = lens(24)
		const step = lensStep(Math.log(2), room, snap)
		near(step.lens, 2.53 / 2.3)
		near(Math.exp(step.rest), (2 * 2.3) / 2.53)
		assert.equal(step.want, 0)
		// all the way in (the camera can report a hair past its range): the picture takes it all
		assert.deepEqual(lensStep(0.4, 0.98, () => 1), { lens: 1, rest: 0.4, want: 0 })
	})

	test("a step asked for during the last, in the view that one goes to, is inside the first box on today's picture", () => {
		const first = anchoredBox({ x: 0.8, y: 0.3 }, 1.25)
		near(within(first, { x: 0, y: 0, w: 1, h: 1 }).w, first.w)
		const both = within(first, anchoredBox({ x: 0.8, y: 0.3 }, 1.25))
		// the same pointer twice: 1.5625× about the same scene point
		const once = anchoredBox({ x: 0.8, y: 0.3 }, 1.5625)
		for (const k of ["x", "y", "w", "h"] as const) near(both[k], once[k])
	})
})

describe("the lens's measured curve", () => {
	test("factors and positions are the measured table, interpolated, on the camera's own range", () => {
		const r = { min: 0, max: 28 }
		assert.deepEqual([0, 8, 28].map(p => lensFactor(p, r)), [1, 1.38, 2.53])
		near(lensFactor(10, r), 1.495)
		near(lensPosition(1.495, r), 10)
		// another range maps by its share: half way is position 14 of 28
		near(lensFactor(50, { min: 0, max: 100 }), lensFactor(14, r))
		// kept on the lens: past either end is that end
		assert.deepEqual([lensPosition(4, r), lensPosition(0.5, r), lensFactor(40, r)], [28, 0, 2.53])
	})
})

describe("holding the picture while the lens moves", () => {
	test("a lens move changes the picture; a brighter sky or a big bird doesn't", () => {
		// a 64×36 picture with texture (grass, leaves): fixed noise
		const W = 64
		let seed = 1
		const scene = Uint8Array.from({ length: W * 36 }, () => {
			seed ^= seed << 13
			seed ^= seed >>> 17
			seed ^= seed << 5
			return 60 + ((seed >>> 0) % 120)
		})
		const brighter = scene.map(x => x + 25)
		const bird = scene.map((x, i) => (i % W < 24 ? 230 - x : x))
		const panned = scene.map((_, i) => scene[i % W < W - 2 ? i + 2 : i]!)
		assert.ok(change(scene, brighter) < STILL, `brighter: ${change(scene, brighter)}`)
		assert.ok(change(scene, bird) < STILL, `bird over a third: ${change(scene, bird)}`)
		assert.ok(change(scene, panned) > MOVED, `panned 2 px: ${change(scene, panned)}`)
	})

	const quiet = { sent: 0, fromStart: 0.3, fromLast: 0.2 }

	test("held from when the move shows until three still samples; a repeated frame mid-move doesn't end it", () => {
		// the changes measured on a simulated 2.5× lens move, which has one repeated frame
		const moving = [16.8, 21.1, 0.0, 22.2, 17.9]
		const phases = run([
			quiet,
			...moving.map(d => ({ sent: 0, fromStart: 30, fromLast: d })),
			{ sent: 0, fromStart: 43, fromLast: 0.2 },
			{ sent: 0, fromStart: 43, fromLast: 0.1 },
			{ sent: 0, fromStart: 43, fromLast: 0.2 }
		])
		assert.deepEqual(phases, ["live", "held", "held", "held", "held", "held", "held", "held", "done"])
	})

	test("a move that never shows stops being waited for, counted from when the camera took it", () => {
		const phases = run(Array.from({ length: 60 }, () => ({ ...quiet, sent: 1000 })))
		assert.equal(phases.indexOf("done") * 100 + 100, 1000 + UNSEEN_MS + 100)
	})

	test("still sending: only the overall limit ends it; refused: it ends at once", () => {
		const sending = run(Array.from({ length: 90 }, () => ({ ...quiet, sent: null })))
		assert.equal(sending.indexOf("done") * 100 + 100, HOLD_MAX_MS + 100)
		assert.deepEqual(run([{ ...quiet, sent: false }]), ["done"])
	})
})

describe("camera first: when the picture is current again", () => {
	/** Samples 100 ms apart, from t = 100; returns the phase after each. */
	const burst = (samples: Omit<BurstSample, "t">[], from: Burst = startBurst(0)) => {
		let b = from
		return samples.map((s, i) => (b = nextBurst(b, { ...s, t: (i + 1) * 100 })).phase)
	}
	const still = { fromStart: 0.3, fromLast: 0.2 }
	const moving = { fromStart: 30, fromLast: 18 }

	test("moved once the picture shows it; current after it holds still past the camera's arrival, not before", () => {
		const phases = burst([
			{ busy: true, sent: 50, arrived: null, ...still },
			{ busy: true, sent: 50, arrived: null, ...moving },
			// arrived at 300: the picture can't show that before 300 + ARRIVAL_SHOWS_MS, so these stills don't count
			...[0, 1, 2, 3].map(() => ({ busy: false, sent: 50, arrived: 300, fromStart: 30, fromLast: 0.1 })),
			{ busy: false, sent: 50, arrived: 300, ...moving },
			...[0, 1, 2].map(() => ({ busy: false, sent: 50, arrived: 300, fromStart: 40, fromLast: 0.1 }))
		])
		assert.equal(ARRIVAL_SHOWS_MS, 400)
		assert.deepEqual(phases, ["live", "moved", "moved", "moved", "moved", "moved", "moved", "moved", "moved", "done"])
	})

	test("the still picture between two steps, while the next is on its way, isn't the end", () => {
		const phases = burst([
			{ busy: false, sent: 0, arrived: 0, ...moving },
			...Array.from({ length: 10 }, () => ({ busy: true, sent: 200, arrived: 0, fromStart: 30, fromLast: 0.1 }))
		])
		assert.deepEqual(new Set(phases), new Set(["moved"]))
	})

	test("a step too small to show is over a while after the camera arrived; a step that never answers, after the limit", () => {
		const unseen = burst(Array.from({ length: 40 }, () => ({ busy: false, sent: 0, arrived: 500, ...still })))
		assert.equal(unseen.indexOf("done") * 100 + 100, 500 + UNSEEN_AFTER_MS + 100)
		const lost = burst(Array.from({ length: 90 }, () => ({ busy: true, sent: 0, arrived: null, ...still })))
		assert.equal(lost.indexOf("done") * 100 + 100, HOLD_MAX_MS + 100)
	})
})
