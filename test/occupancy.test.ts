import assert from "node:assert/strict"
import { test } from "node:test"
import { sheetFrames } from "../src/pipeline/crops.ts"
import { OCCUPIED, scoreFeederFrames } from "../src/pipeline/occupancy.ts"

const SIDE = 96

/**
 * A synthetic feeder tile: vertical fence boards, a dark feeder body that swings `dx` px sideways
 * (as far as a real one, ~1/10 of the tile), and optionally a pale 12×9 bird clinging to its left side.
 */
const tile = (dx: number, bird: boolean) => {
	const rgb = new Uint8Array(SIDE * SIDE * 3)
	for (let y = 0; y < SIDE; y++)
		for (let x = 0; x < SIDE; x++) {
			const board = Math.floor(x / 12) % 2 ? 150 : 175
			const feeder = x >= 35 + dx && x < 60 + dx && y >= 20 && y < 75
			const onBird = bird && x >= 23 + dx && x < 35 + dx && y >= 40 && y < 49
			const v = onBird ? 225 : feeder ? 45 : board
			rgb.set([v, onBird ? 225 : feeder ? 45 : v - 30, onBird ? 220 : feeder ? 50 : v - 60], (y * SIDE + x) * 3)
		}
	return rgb
}

const swing = (i: number) => Math.round(9 * Math.sin(i * 0.9))

test("a swinging feeder with nothing on it scores nothing", () => {
	const frames = Array.from({ length: 30 }, (_, i) => tile(swing(i), false))
	assert.deepEqual(
		scoreFeederFrames(frames, SIDE).map(o => o.score),
		frames.map(() => 0)
	)
})

test("a bird on a swinging feeder for two keyframes is found in both, boxed on the bird", () => {
	const frames = Array.from({ length: 30 }, (_, i) => tile(swing(i), i === 11 || i === 12))
	const scores = scoreFeederFrames(frames, SIDE)
	assert.deepEqual(
		scores.flatMap((o, i) => (o.score >= OCCUPIED ? [i] : [])),
		[11, 12]
	)
	const { box } = scores[11]!
	const birdX = (23 + swing(11)) / SIDE
	// the box holds the bird (12×9 of 96) give or take the erosion's pixel
	assert.ok(box && Math.abs(box.x - birdX) <= 2 / SIDE && Math.abs(box.y - 40 / SIDE) <= 2 / SIDE, JSON.stringify(box))
	assert.ok(box.w <= 14.01 / SIDE && box.h <= 11.01 / SIDE, JSON.stringify(box))
})

test("too few keyframes to compare are scored as empty rather than guessed", () => {
	const frames = Array.from({ length: 4 }, (_, i) => tile(0, i === 1))
	assert.deepEqual(
		scoreFeederFrames(frames, SIDE).map(o => o.score),
		[0, 0, 0, 0]
	)
})

test("sheetFrames: occupied frames first, a visit at a time, then the rest spread evenly, all in time order", () => {
	const scores = Array.from({ length: 60 }, (_, i) => (i === 7 ? 90 : i === 40 ? 300 : i === 41 ? 50 : 0))
	assert.deepEqual(sheetFrames(scores, 5), [0, 7, 40, 41, 59])
	// more occupied frames than tiles: each visit's best before any visit's second
	assert.deepEqual(sheetFrames(scores, 2), [7, 40])
	// a sparrow on the feeder for 20 keyframes leaves a tile for the nuthatch that came for one
	const busy = Array.from({ length: 60 }, (_, i) => (i >= 10 && i < 30 ? 200 + i : i === 50 ? 45 : 0))
	assert.deepEqual(sheetFrames(busy, 3), [28, 29, 50])
	// a short clip shows every frame
	assert.deepEqual(sheetFrames([0, 99, 0], 12), [0, 1, 2])
})
