import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { after, before, describe, test } from "node:test"
import sharp from "sharp"
import type { CameraControls, CameraState, PtzBody } from "../src/api-types.ts"
import type { LoadedConfig } from "../src/config.ts"
import { createBus } from "../src/events.ts"
import { cameraBlocker, type CloseUpCaps, createCloseUps, frameBox, sharpest, skipReason, STEER_QUIET_MS } from "../src/live/closeup.ts"
import type { CameraControl } from "../src/live/control.ts"

const tmp = join(import.meta.dirname, ".tmp", "closeup")

before(() => mkdirSync(tmp, { recursive: true }))
after(() => rmSync(tmp, { recursive: true, force: true }))

const round = (b: { x: number; y: number; w: number; h: number } | null) =>
	b && { x: +b.x.toFixed(4), y: +b.y.toFixed(4), w: +b.w.toFixed(4), h: +b.h.toFixed(4) }

describe("framing the bird", () => {
	test("a small bird gets the tightest frame the lens has, centred on it", () => {
		assert.deepEqual(round(frameBox({ x: 0.5, y: 0.5, w: 0.02, h: 0.03 })), { x: 0.41, y: 0.415, w: 0.2, h: 0.2 })
	})

	test("a bigger bird gets its larger side again on every side", () => {
		// 0.1 (in frame heights) is the larger side: the frame is 0.3 of the picture tall, and 0.3 of it wide
		assert.deepEqual(round(frameBox({ x: 0.3, y: 0.3, w: 0.05, h: 0.1 })), { x: 0.175, y: 0.2, w: 0.3, h: 0.3 })
	})

	test("a bird at the edge is framed off-centre rather than past the picture", () => {
		assert.deepEqual(round(frameBox({ x: 0.97, y: 0, w: 0.03, h: 0.04 })), { x: 0.8, y: 0, w: 0.2, h: 0.2 })
	})

	test("a bird already filling much of the picture isn't worth moving the camera for", () => {
		assert.equal(frameBox({ x: 0.3, y: 0.3, w: 0.2, h: 0.1 }), null)
	})
})

describe("whether to look", () => {
	const clock = { now: 1_000_000, busy: false, nextAt: 0, steeredAt: -Infinity }

	test("motion starts a check only when nothing is running, the cadence or cooldown is over, and nobody is steering", () => {
		assert.deepEqual(
			[
				clock,
				{ ...clock, busy: true },
				{ ...clock, nextAt: clock.now + 1 },
				{ ...clock, steeredAt: clock.now - STEER_QUIET_MS + 1 },
				{ ...clock, steeredAt: clock.now - STEER_QUIET_MS }
			].map(skipReason),
			[null, "a check is already running", "too soon after the last one", "someone is steering the camera", null]
		)
	})

	test("the camera must be able to frame a box, have a Home, not track or move, and not be pointed elsewhere", () => {
		const caps: CloseUpCaps = { box: true, zoom: true, home: true, tracking: false }
		const state: CameraState = { moving: false, atHome: true, zoom: 0, focus: 100 }
		assert.deepEqual(
			[
				cameraBlocker(caps, state),
				// look4 hasn't learned where Home is yet: going there teaches it
				cameraBlocker(caps, { ...state, atHome: null }),
				cameraBlocker({ ...caps, box: false }, state),
				cameraBlocker({ ...caps, home: false }, state),
				cameraBlocker({ ...caps, tracking: true }, state),
				cameraBlocker(caps, { ...state, moving: true }),
				cameraBlocker(caps, { ...state, atHome: false })
			],
			[
				null,
				null,
				"this camera can't zoom in on a part of the picture",
				"the camera has no Home view to come back to",
				"the camera's own auto-tracking is on",
				"the camera is moving",
				"the camera isn't at its Home view"
			]
		)
	})
})

test("the sharpest still is the in-focus one, wherever it falls among the soft ones", async () => {
	// a checkerboard of 8 px squares: strong edges everywhere
	const W = 640
	const H = 360
	const raw = Buffer.alloc(W * H)
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) raw[y * W + x] = ((x >> 3) + (y >> 3)) % 2 ? 255 : 0
	const sharpJpeg = await sharp(raw, { raw: { width: W, height: H, channels: 1 } }).jpeg().toBuffer()
	const soft = await sharp(sharpJpeg).blur(4).jpeg().toBuffer()
	const softer = await sharp(sharpJpeg).blur(8).jpeg().toBuffer()
	assert.equal(await sharpest([soft, sharpJpeg, softer]), 1)
	assert.equal(await sharpest([softer, soft, sharpJpeg]), 2)
})

describe("taking a close-up", () => {
	const BLOB = { x: 0.5, y: 0.5, w: 0.02, h: 0.03 }

	const fixture = async (o: { onState?: (moved: boolean) => void; failStills?: boolean } = {}) => {
		const dir = join(tmp, String(Math.random()).slice(2))
		const still = await sharp({ create: { width: 3840, height: 2160, channels: 3, background: "#808080" } }).jpeg().toBuffer()
		const ops: PtzBody["op"][] = []
		let snaps = 0
		const control = {
			controls: async () => ({ ptz: { box: true, zoom: true, guard: { set: true }, tracking: null } }) as unknown as CameraControls,
			state: async (): Promise<CameraState> => {
				o.onState?.(ops.includes("box"))
				return { moving: false, atHome: !ops.includes("box") || ops.at(-1) === "home", zoom: 0, focus: 100 }
			},
			ptz: async (b: PtzBody) => {
				ops.push(b.op)
			},
			snapshot: async () => {
				if (snaps++ > 0 && o.failStills) throw new Error("the camera dropped the connection")
				return still
			}
		} as unknown as CameraControl
		const bus = createBus()
		const config = { sources: [{ type: "reolink", name: "cam", enabled: true, closeUps: true }] } as unknown as LoadedConfig
		const clipEvents: string[] = []
		bus.on("clip", e => clipEvents.push(e.clipId))
		const closeUps = createCloseUps({
			bus,
			config: () => config,
			live: { controlFor: () => control, find: name => ({ name }) },
			detect: async () => [{ label: "bird", score: 0.6, box: BLOB }],
			dir: join(dir, "closeups"),
			mediaDir: id => join(dir, "media", id),
			clipStatus: () => "pending",
			timing: { settleFirstMs: 0, settlePollMs: 1, shotGapMs: 0, homeRetryMs: 1 }
		})
		return { dir, ops, bus, closeUps, clipEvents, snaps: () => snaps }
	}

	const until = async (what: string, ok: () => boolean) => {
		const end = Date.now() + 5000
		while (!ok()) {
			if (Date.now() > end) assert.fail(`timed out waiting for ${what}`)
			await new Promise(r => setTimeout(r, 5))
		}
	}

	test("a bird is framed, shot, and the camera goes Home; the still joins the clip that covers it", async () => {
		const f = await fixture()
		f.bus.emit("motion", { source: "cam", at: Date.now(), blobs: [BLOB] })
		await until("a close-up waiting for its clip", () => existsSync(join(f.dir, "closeups")) && readdirSync(join(f.dir, "closeups")).length === 1)
		assert.deepEqual(f.ops, ["box", "home"])
		// a confirming still, then three once the lens settled
		assert.equal(f.snaps(), 4)
		// a clip from long before doesn't claim it; the one covering it does
		f.bus.emit("captured", { source: "cam", clipId: "old", start: Date.now() - 600_000, end: Date.now() - 500_000 })
		f.bus.emit("captured", { source: "cam", clipId: "now", start: Date.now() - 20_000, end: Date.now() })
		await until("the close-up filed", () => f.clipEvents.length > 0)
		assert.ok(existsSync(join(f.dir, "media", "now", "closeup-0.jpg")))
		assert.deepEqual([readdirSync(join(f.dir, "closeups")), existsSync(join(f.dir, "media", "old")), f.clipEvents], [[], false, ["now"]])
		// a second motion right away is inside the cooldown
		f.bus.emit("motion", { source: "cam", at: Date.now(), blobs: [BLOB] })
		await new Promise(r => setTimeout(r, 50))
		assert.deepEqual(f.ops, ["box", "home"])
		await f.closeUps.close()
	})

	test("the camera goes Home even when the close-up stills fail", async () => {
		const f = await fixture({ failStills: true })
		f.bus.emit("motion", { source: "cam", at: Date.now(), blobs: [BLOB] })
		await until("the camera sent Home", () => f.ops.includes("home"))
		assert.deepEqual(f.ops, ["box", "home"])
		await f.closeUps.close()
		assert.equal(existsSync(join(f.dir, "closeups")), false)
	})

	test("someone steering mid-close-up gets the camera: no stills, and it isn't yanked Home", async () => {
		let f: Awaited<ReturnType<typeof fixture>> | null = null
		let steered = false
		f = await fixture({
			onState: moved => {
				if (!moved || steered) return
				steered = true
				f!.closeUps.steered("cam")
			}
		})
		f.bus.emit("motion", { source: "cam", at: Date.now(), blobs: [BLOB] })
		await until("someone steering while the lens moves", () => steered)
		await new Promise(r => setTimeout(r, 50))
		await f.closeUps.close()
		assert.deepEqual([f.ops, f.snaps()], [["box"], 1])
	})
})
