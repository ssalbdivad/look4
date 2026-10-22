import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
	cardH,
	gripPoint,
	layoutFor,
	loadSize,
	maxPicture,
	minPicture,
	nearestZone,
	PIC_MIN,
	planLayout,
	type Room,
	sizeFromPointer,
	snapTargets,
	stepSize,
	widthOf,
	type Zone
} from "../web/src/live/geometry.ts"

// The Live page at 1440×900 in headless Chromium: 1398 px of page, 744 px of picture height under the top bar.
const ROOM: Room = { width: 1398, height: 744, aside: true, dock: "right" }
const LEFT: Room = { ...ROOM, dock: "left" }
const SNAPS = snapTargets(ROOM, null)

const near = (actual: number, expected: number, within = 0.01) => assert.ok(Math.abs(actual - expected) <= within, `${actual} is not ${expected} ± ${within}`)

describe("live layout", () => {
	test("automatic puts the rail beside at its resting width, on the docked side", () => {
		assert.deepEqual(planLayout(ROOM, { snap: "auto" }), { place: "side", picture: 1048, rail: 336, left: 0 })
		assert.deepEqual(planLayout(LEFT, { snap: "auto" }), { place: "side", picture: 1048, rail: 336, left: 350 })
	})

	test("a share clamps into the room without being rewritten", () => {
		const small: Room = { width: 1000, height: 400, aside: true, dock: "right" }
		near(widthOf(small, { share: 0.95 }), maxPicture(small))
		near(maxPicture(small), 711.11)
		assert.equal(widthOf(small, { share: 0.01 }), PIC_MIN)
	})

	test("the toolbar's narrowest width is the picture's smallest, everywhere a size is chosen", () => {
		const r: Room = { ...ROOM, min: 576 }
		assert.equal(minPicture(r), 576)
		assert.equal(widthOf(r, { share: 0.01 }), 576)
		assert.equal(stepSize(r, 600, -1, true, snapTargets(r, null)).width, 576)
		assert.equal(sizeFromPointer(r, "corner", { x: 0, y: 0 }, [], true, 1048).width, 576)
		// never wider than the page, whatever the toolbar asks
		assert.equal(minPicture({ ...r, min: 2000 }), r.width)
	})

	test("docked below, automatic leaves the controls' header in the window; fit stays the largest", () => {
		const below: Room = { ...ROOM, dock: "below" }
		// 744 − 14 − 36 = 694 px of picture height
		near(widthOf(below, { snap: "auto" }), (694 * 16) / 9)
		near(widthOf(below, { snap: "fit" }), maxPicture(below))
		// hidden controls have no header to keep: automatic is the largest
		near(widthOf({ ...below, aside: false }, { snap: "auto" }), maxPicture(below))
	})
})

describe("dragging a grip", () => {
	test("the splitter stays under the pointer while the narrowing group re-centres", () => {
		// from automatic the splitter is at 1055; 200 px left of it the rail is at its widest and the group centred
		const r = sizeFromPointer(ROOM, "edge-x", { x: 855, y: 0 }, SNAPS, false)
		assert.equal(r.width, 732)
		assert.deepEqual(layoutFor(ROOM, r.width), { place: "side", picture: 732, rail: 420, left: 116 })
	})

	test("the corner snaps to the largest size beside the controls within the magnet, and not with Ctrl", () => {
		const target = gripPoint(ROOM, 1108, "corner")
		const snapped = sizeFromPointer(ROOM, "corner", target, SNAPS, false)
		assert.equal(snapped.width, 1112)
		assert.equal(snapped.snap?.id, "beside")
		const free = sizeFromPointer(ROOM, "corner", target, SNAPS, true)
		assert.equal(free.width, 1108)
		assert.equal(free.snap, null)
	})

	test("docked left, the corner doesn't jump when the rail drops below", () => {
		const beside = gripPoint(LEFT, 1112, "corner")
		const below = gripPoint(LEFT, 1113, "corner")
		assert.equal(layoutFor(LEFT, 1112).place, "side")
		assert.equal(layoutFor(LEFT, 1113).place, "below")
		assert.ok(Math.abs(beside.x - below.x) <= 1.5, `${beside.x} → ${below.x}`)
	})

	test("the corner follows a sideways or straight-up pull, not only one along the diagonal", () => {
		const from = 1048
		const g = gripPoint(ROOM, from, "corner")
		// 200 px to the right at the same height: the grip ends under the pointer's x
		const wide = sizeFromPointer(ROOM, "corner", { x: g.x + 200, y: g.y }, [], true, from)
		near(gripPoint(ROOM, wide.width, "corner").x, g.x + 200, 1)
		// 280 px straight up: the grip ends at the pointer's y
		const up = sizeFromPointer(ROOM, "corner", { x: g.x, y: g.y - 280 }, [], true, from)
		near(gripPoint(ROOM, up.width, "corner").y, g.y - 280, 1)
	})

	test("pulling past the largest size measures how far, and short of it nothing", () => {
		const max = maxPicture(ROOM)
		const far = sizeFromPointer(ROOM, "corner", { x: 1500, y: cardH(max) + 60 }, SNAPS, true)
		near(far.width, max)
		assert.ok(far.beyond >= 48, `beyond ${far.beyond}`)
		const short = sizeFromPointer(ROOM, "corner", gripPoint(ROOM, max - 50, "corner"), SNAPS, true)
		near(short.width, max - 50, 1)
		assert.equal(short.beyond, 0)
	})
})

describe("snaps", () => {
	test("Shift+← stops at each snap it passes", () => {
		const a = stepSize(ROOM, 1152, -1, true, SNAPS)
		assert.equal(a.width, 1112)
		assert.equal(a.snap?.id, "beside")
		const b = stepSize(ROOM, a.width, -1, true, SNAPS)
		assert.equal(b.width, 1048)
		assert.equal(b.snap?.id, "auto")
	})

	test("the stream's own size is dropped when it's within reach of an earlier snap", () => {
		assert.deepEqual(
			snapTargets(ROOM, 1060).map(s => s.id),
			["auto", "fit", "beside"]
		)
		assert.deepEqual(
			snapTargets(ROOM, 1280).map(s => s.id),
			["auto", "fit", "beside", "native"]
		)
	})
})

describe("remembered size", () => {
	test("the splitter's old width migrates once; a bad new value falls back to automatic", () => {
		assert.deepEqual(loadSize(null, "0.6"), { size: { share: 0.6 }, migrated: true })
		for (const old of ["null", "1.5", "abc", ""]) assert.deepEqual(loadSize(null, old), { size: { snap: "auto" }, migrated: true }, old)
		assert.deepEqual(loadSize(null, null), { size: { snap: "auto" }, migrated: false })
		// the new key wins, and an unreadable one is not "migrated" over from the old
		assert.deepEqual(loadSize('{"snap":"beside"}', "0.6"), { size: { snap: "beside" }, migrated: false })
		assert.deepEqual(loadSize("{oops", "0.6"), { size: { snap: "auto" }, migrated: false })
		assert.deepEqual(loadSize('{"share":2}', null), { size: { snap: "auto" }, migrated: false })
	})
})

describe("moving the controls", () => {
	test("the nearest zone wins, inside beats near, and a tie goes right, left, below", () => {
		const zones: Zone[] = [
			{ dock: "right", rect: { x: 200, y: 0, w: 100, h: 100 } },
			{ dock: "left", rect: { x: 0, y: 0, w: 100, h: 100 } },
			{ dock: "below", rect: { x: 0, y: 200, w: 300, h: 50 } }
		]
		assert.equal(nearestZone(zones, { x: 50, y: 50 })?.dock, "left")
		assert.equal(nearestZone(zones, { x: 150, y: 50 })?.dock, "right")
		assert.equal(nearestZone(zones, { x: 50, y: 150 })?.dock, "left")
		assert.equal(nearestZone(zones, { x: 250, y: 225 })?.dock, "below")
	})
})
