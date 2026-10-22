import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { cornerRadius, EXIT_EASE, EXIT_FROM, EXIT_MS, holeMask, readoutAt, springCurve } from "../web/src/live/iris.ts"

const near = (actual: number, expected: number, tol = 1e-3) => assert.ok(Math.abs(actual - expected) < tol, `${actual} is not ${expected}`)

/** A CSS cubic-bezier's progress at time fraction `x`. */
const bezier = (x1: number, y1: number, x2: number, y2: number) => (x: number) => {
	const at = (t: number, a: number, b: number) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3
	let lo = 0
	let hi = 1
	for (let i = 0; i < 50; i++) {
		const t = (lo + hi) / 2
		if (at(t, x1, x2) < x) lo = t
		else hi = t
	}
	return at((lo + hi) / 2, y1, y2)
}

describe("springCurve", () => {
	test("from rest: overshoots by the damping's textbook amount", () => {
		const c = springCurve(0, 0.36, 0.64)
		let peak = 0
		for (let t = 0; t < c.dur / 1000; t += 0.001) peak = Math.max(peak, c.x(t))
		near(peak - 1, Math.exp((-Math.PI * 0.64) / Math.sqrt(1 - 0.64 ** 2)), 2e-3)
		assert.match(c.easing, /^linear\(0, .*, 1\)$/)
	})

	test("it ends only once settled, so the easing's last step to 1 is no visible jump", () => {
		// the class's springs: the first notch's settle, a notch landing mid-move, the retreat
		for (const [v0, period, zeta] of [
			[0, 0.3, 0.86],
			[6, 0.36, 0.64],
			[0, 0.5, 1]
		] as const) {
			const c = springCurve(v0, period, zeta)
			near(c.x(c.dur / 1000 - 1e-4), 1, 2e-3)
			near(Number(c.easing.slice(7, -1).split(", ").at(-2)), 1, 2e-3)
		}
	})

	test("a retarget keeps the momentum it starts with", () => {
		const c = springCurve(6, 0.36, 0.64)
		near(c.x(0), 0)
		near(c.dx(0), 6)
		// and the derivative is the curve's own
		near((c.x(0.051) - c.x(0.049)) / 0.002, c.dx(0.05), 1e-2)
	})

	test("critically damped: no overshoot", () => {
		const c = springCurve(0, 0.5, 1)
		for (let t = 0; t < c.dur / 1000; t += 0.001) assert.ok(c.x(t) <= 1 + 1e-9)
	})
})

test("cornerRadius: square at 1×, capped at 12 px", () => {
	assert.equal(cornerRadius(1), 0)
	assert.ok(0 < cornerRadius(1.1) && cornerRadius(1.1) < cornerRadius(1.5))
	assert.equal(cornerRadius(2.5), 12)
})

test("holeMask: on a box smaller than two radii, the corner pieces shrink to half its side and don't overlap", () => {
	// a 36×20 box (a small Picture-in-Picture stage at a high zoom) with r 12
	assert.deepEqual(holeMask(320, 180, { x: 100, y: 50, w: 36, h: 20 }, 12), {
		maskPosition: "0px 0px, 0px 70px, 0px 0px, 136px 0px, 100px 50px, 126px 50px, 100px 60px, 126px 60px",
		maskSize: "320px 50px, 320px 110px, 100px 180px, 184px 180px, 10px 10px, 10px 10px, 10px 10px, 10px 10px"
	})
})

test("holeMask: bands meet the box's edges, rounded corner pieces sit in its corners, nothing covers the rest", () => {
	assert.deepEqual(holeMask(1280, 720, { x: 100, y: 50, w: 640, h: 360 }, 12), {
		maskPosition: "0px 0px, 0px 410px, 0px 0px, 740px 0px, 100px 50px, 728px 50px, 100px 398px, 728px 398px",
		maskSize: "1280px 50px, 1280px 310px, 100px 720px, 540px 720px, 12px 12px, 12px 12px, 12px 12px, 12px 12px"
	})
})

test("holeMask: the full frame leaves nothing with any area, and a box past the stage's edge no band there", () => {
	assert.equal(holeMask(1280, 720, { x: 0, y: 0, w: 1280, h: 720 }, 0).maskSize, "1280px 0px, 1280px 0px, 0px 720px, 0px 720px, 0px 0px, 0px 0px, 0px 0px, 0px 0px")
	assert.ok(holeMask(1280, 720, { x: -20, y: -10, w: 700, h: 400 }, 0).maskSize.startsWith("1280px 0px, 1280px 330px, 0px 720px"))
})

describe("readoutAt", () => {
	const pill = { w: 40, h: 14 }

	test("under the box's bottom-left corner", () => {
		assert.deepEqual(readoutAt({ x: 100, y: 100, w: 400, h: 225 }, pill, 1280, 720, 6), { x: 100, y: 331, side: "below" })
	})

	test("above the box near the stage's bottom, kept inside the stage near its right edge", () => {
		assert.deepEqual(readoutAt({ x: 1260, y: 500, w: 400, h: 215 }, pill, 1280, 720, 6), { x: 1234, y: 480, side: "above" })
	})

	test("inside the box when it is nearly the stage's height", () => {
		assert.deepEqual(readoutAt({ x: 50, y: 5, w: 1240, h: 705 }, pill, 1280, 720, 6), { x: 56, y: 690, side: "inside" })
	})

	test("a forced side holds while the box is still on its way", () => {
		assert.equal(readoutAt({ x: 100, y: 100, w: 400, h: 225 }, pill, 1280, 720, 6, "above").y, 80)
	})
})

test("the exit's hole tracks the picture's zoom from where it is when the move is seen, to the zoom's end", () => {
	// the brief's zoom: 700 ms, ease-in-out; the exit starts when it is EXIT_MS from its end
	const zoom = bezier(0.45, 0, 0.55, 1)
	const t0 = (700 - EXIT_MS) / 700
	near(EXIT_FROM, zoom(t0), 2e-3)
	const exit = bezier(...(/cubic-bezier\((.*)\)/.exec(EXIT_EASE)![1]!.split(",").map(Number) as [number, number, number, number]))
	for (let u = 0; u <= 1; u += 0.05) near(EXIT_FROM + (1 - EXIT_FROM) * exit(u), zoom(t0 + u * (1 - t0)), 2e-3)
})
