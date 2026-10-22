import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createMotionWatch, DEFAULT_OSD, osdBoxes, WATCH_FPS, type WatchVerdict } from "../src/sources/stream-motion.ts"

// 320x180 grey frames at 4 fps, as the watch gets them from ffmpeg: a smooth deterministic texture
// with per-pixel sensor noise of ±3 every frame, so the per-pixel noise model and the lighting fit
// face something closer to a real yard than a flat colour.
const W = 320
const H = 180
const FPS = WATCH_FPS
/** 15 s warm-up plus a little: frames a fresh watch needs before it may report. */
const WARM = 16 * FPS

/** Deterministic noise (mulberry32), so a failure reproduces. */
const random = (seed: number) => () => {
	seed = (seed + 0x6d2b79f5) | 0
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** The yard, wide enough to pan across: computed once, since a test feeds it thousands of times. */
const PAN_MAX = 64
const TW = W + PAN_MAX
const yard = new Float32Array(TW * H)
for (let y = 0; y < H; y++) for (let x = 0; x < TW; x++) yard[y * TW + x] = 120 + 50 * Math.sin(x / 7) * Math.cos(y / 5) + 20 * Math.sin((x + y) / 23)
/** Sensor noise, ±3: each frame reads it from a random offset, so no two frames share it. */
const NOISE = (() => {
	const rnd = random(99)
	return Float32Array.from({ length: 2 * W * H }, () => rnd() * 6 - 3)
})()

type Box = { x: number; y: number; w: number; h: number }

/** A scene that can be shifted (pan), re-exposed (gain) and have dark boxes drawn on it. */
const scene = (seed = 1) => {
	const rnd = random(seed)
	return (o: { shift?: number; gain?: number; boxes?: Box[]; flip?: Box[] } = {}) => {
		const f = new Uint8Array(W * H)
		const gain = o.gain ?? 1
		const shift = o.shift ?? 0
		const n0 = Math.floor(rnd() * W * H)
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const v = (yard[y * TW + x + shift]! + NOISE[n0 + y * W + x]!) * gain
				f[y * W + x] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
			}
		for (const b of [...(o.boxes ?? []), ...(o.flip ?? [])])
			for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) f[y * W + x] = 20
		return f
	}
}

/** Feeds `n` frames made by `make(i)` and returns the verdicts. */
const feed = (watch: ReturnType<typeof createMotionWatch>, n: number, make: (i: number) => Uint8Array) =>
	Array.from({ length: n }, (_, i) => watch.push(make(i)))

const motionAt = (vs: WatchVerdict[]) => vs.flatMap((v, i) => (v.motion ? [i] : []))

/** A fresh watch that has learned the still scene. */
const warmed = (frame = scene()) => {
	const watch = createMotionWatch({ width: W, height: H, exclude: DEFAULT_OSD })
	const vs = feed(watch, WARM, () => frame())
	assert.deepEqual([vs[0]!.warming, vs.at(-1)!.warming, motionAt(vs)], [true, false, []])
	return { watch, frame }
}

describe("look4's motion watch", () => {
	test("a sparrow-sized 4×3 px blob crossing the yard is motion from its second frame; one there for a single frame never is", () => {
		const { watch, frame } = warmed()
		const crossing = feed(watch, 8, i => frame({ boxes: [{ x: 100 + i, y: 90, w: 4, h: 3 }] }))
		assert.deepEqual(motionAt(crossing), [1, 2, 3, 4, 5, 6, 7])
		assert.deepEqual(crossing[1]!.blobs, [{ x: 101 / W, y: 90 / H, w: 4 / W, h: 3 / H }])

		const { watch: other, frame: still } = warmed()
		const flash = feed(other, 8, i => still(i === 0 ? { boxes: [{ x: 100, y: 90, w: 4, h: 3 }] } : {}))
		assert.deepEqual(motionAt(flash), [])
	})

	test("scattered single-pixel noise far above the threshold is never motion", () => {
		const { watch, frame } = warmed()
		const rnd = random(7)
		const vs = feed(watch, 40, () => {
			const f = frame()
			for (let k = 0; k < 200; k++) f[Math.floor(rnd() * W * H)] = rnd() < 0.5 ? 0 : 255
			return f
		})
		assert.deepEqual(motionAt(vs), [])
	})

	test("the whole picture brightening by 30% at once, or 2% a frame for 5 s, is not motion", () => {
		const { watch, frame } = warmed()
		const step = feed(watch, 20, () => frame({ gain: 1.3 }))
		const ramp = feed(watch, 5 * FPS, i => frame({ gain: 1.3 * 1.02 ** i }))
		assert.deepEqual([motionAt(step), motionAt(ramp)], [[], []])
	})

	test("a pan of 3 px a frame for 3 s is not motion: it reads as whole-frame change, the watch starts over and warms up, then sees a blob again", () => {
		const { watch, frame } = warmed()
		const pan = feed(watch, 3 * FPS, i => frame({ shift: 3 * (i + 1) }))
		assert.deepEqual(motionAt(pan), [])
		assert.ok(pan.slice(0, 3).every(v => v.global), "the pan's first frames are whole-frame changes")
		const after = feed(watch, WARM, () => frame({ shift: 3 * 3 * FPS }))
		assert.deepEqual([after[0]!.warming, after.at(-1)!.warming, motionAt(after)], [true, false, []])
		const blob = feed(watch, 4, i => frame({ shift: 3 * 3 * FPS, boxes: [{ x: 200 + i, y: 60, w: 4, h: 3 }] }))
		assert.deepEqual(motionAt(blob), [1, 2, 3])
	})

	test("a patch flickering in the wind stops counting; once calm, a bird on it counts again after ~45 s, not after 5 s", () => {
		const { watch, frame } = warmed()
		const leaf = { x: 60, y: 120, w: 6, h: 5 }
		// a toggle every frame for 60 s: counts at first, then the flicker mask takes it out
		const windy = feed(watch, 60 * FPS, i => frame(i % 2 ? { flip: [leaf] } : {}))
		const lastMotion = motionAt(windy).at(-1) ?? -1
		assert.ok(lastMotion < 10 * FPS, `still motion ${lastMotion / FPS} s into the wind`)
		const bird = { x: 61, y: 121, w: 4, h: 3 }
		const sits = (seconds: number) => {
			feed(watch, seconds * FPS, () => frame())
			return motionAt(feed(watch, 6, () => frame({ boxes: [bird] })))
		}
		assert.deepEqual(sits(5), [])
		assert.deepEqual(sits(40), [1, 2, 3, 4, 5])
	})

	test("a bird that lands and sits 20 s doesn't mask its own perch: the next one there is motion too", () => {
		const { watch, frame } = warmed()
		const perch = { x: 220, y: 70, w: 4, h: 3 }
		const first = feed(watch, 20 * FPS, () => frame({ boxes: [perch] }))
		assert.deepEqual(motionAt(first).slice(0, 2), [1, 2])
		feed(watch, 20 * FPS, () => frame())
		const second = feed(watch, 4, () => frame({ boxes: [perch] }))
		assert.deepEqual(motionAt(second), [1, 2, 3])
	})

	test("the camera's ticking clock and name, inside the on-screen-text boxes, are never motion", () => {
		const { watch, frame } = warmed()
		// a digit changing every second at the top centre, the name blinking at the lower right
		const vs = feed(watch, 20 * FPS, i =>
			frame({ boxes: [{ x: 150 + (Math.floor(i / FPS) % 3) * 6, y: 2, w: 5, h: 10 }, ...(i % 8 < 4 ? [{ x: 290, y: 168, w: 20, h: 8 }] : [])] })
		)
		assert.deepEqual(motionAt(vs), [])
	})
})

describe("on-screen text from GetOsd", () => {
	test("a clock moved to the upper left and a long name at the bottom centre become boxes there; a disabled one none", () => {
		assert.deepEqual(
			osdBoxes({ Osd: { osdTime: { enable: 1, pos: "Upper Left" }, osdChannel: { enable: 1, name: "Backyard feeders cam", pos: "Bottom Center" } } }),
			[
				{ x: 0, y: 0, w: 0.48, h: 0.085 },
				{ x: 0.3, y: 0.91, w: 0.4, h: 0.09 }
			]
		)
		assert.deepEqual(osdBoxes({ Osd: { osdTime: { enable: 1, pos: "Top Center" }, osdChannel: { enable: 0, name: "x", pos: "Lower Right" } } }), [
			{ x: 0.26, y: 0, w: 0.48, h: 0.085 }
		])
	})

	test("a position it doesn't know (custom placement) or an odd answer gives null, so the defaults stay", () => {
		assert.equal(osdBoxes({ Osd: { osdTime: { enable: 1, pos: "Other" }, osdChannel: { enable: 1, name: "x", pos: "Lower Right" } } }), null)
		assert.equal(osdBoxes({ rspCode: 200 }), null)
	})
})
