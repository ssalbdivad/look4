import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { after, afterEach, before, beforeEach, describe, test } from "node:test"
import { Hono } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import sharp from "sharp"
import type { CameraControls } from "../src/api-types.ts"
import { ReolinkSource, type ReolinkSourceConfig } from "../src/config.ts"
import { type CameraControl, ControlError } from "../src/live/control.ts"
import type { Live } from "../src/live/manager.ts"
import { createReolinkControl, type ReolinkControlOptions } from "../src/live/reolink-control.ts"
import { HttpError } from "../src/server/http.ts"
import { liveRoutes } from "../src/server/live.ts"
import { type MockPosition, type MockReolink, RLC823S1, startMockReolink } from "./fixtures/mock-reolink.ts"

const tmp = join(import.meta.dirname, ".tmp", "live-control")
const ENV = "LOOK4_TEST_CONTROL_PW"

let mock: MockReolink
let fixed: MockReolink
let n = 0
const opened: CameraControl[] = []

const cfg = (m: MockReolink = mock): ReolinkSourceConfig =>
	ReolinkSource.assert({ type: "reolink", name: "cam", host: m.host, protocol: "http", passwordEnv: ENV })

/** A fresh driver (no cached zoom, presets or abilities) with its own data dir. */
const open = (o: ReolinkControlOptions & { m?: MockReolink; env?: NodeJS.ProcessEnv } = {}) => {
	const dataDir = join(tmp, String(++n))
	const control = createReolinkControl(cfg(o.m), o.env ?? { [ENV]: "hunter2" }, { autoStopMs: 60_000, settlePollMs: 20, dataDir, ...o })
	opened.push(control)
	return { control, dataDir }
}

const waitFor = async (what: string, ok: () => boolean | Promise<boolean>, ms = 3000) => {
	const end = Date.now() + ms
	while (!(await ok())) {
		if (Date.now() > end) assert.fail(`timed out waiting for ${what}`)
		await new Promise(r => setTimeout(r, 20))
	}
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const rejectsWith = (p: Promise<unknown>, status: number, message: RegExp) =>
	assert.rejects(p, (e: unknown) => e instanceof ControlError && e.status === status && message.test(e.message))

const IMAGE = /^\/api\/live\/cam\/presets\/(\d+)\/image\?v=[0-9a-f]{10}$/

before(async () => {
	mkdirSync(tmp, { recursive: true })
	mock = await startMockReolink({ files: [], abilities: "ptz", settleMs: 50 })
	fixed = await startMockReolink({ files: [] })
})
afterEach(async () => {
	await Promise.all(opened.splice(0).map(c => c.close()))
})
after(async () => {
	await Promise.all([mock.close(), fixed.close()])
	rmSync(tmp, { recursive: true, force: true })
})

describe("reading the camera", () => {
	test("the real RLC-823S1's answers become CameraControls", async () => {
		const { control } = open()
		const c = await control.controls()
		const images = c.ptz!.presets.map(p => p.image)
		assert.ok(images.every(i => i && IMAGE.test(i)), String(images))
		assert.deepEqual(
			{ ...c, ptz: { ...c.ptz!, presets: c.ptz!.presets.map(p => ({ ...p, image: p.image && "<url>" })) } },
			{
				ptz: {
					pan: true,
					tilt: true,
					zoom: true,
					focus: true,
					zoomRange: { min: 0, max: 28, pos: 8 },
					focusRange: { min: 0, max: 205, pos: 143 },
					autofocus: true,
					box: true,
					speed: true,
					presets: [
						{ id: 0, name: "Tree and Left Feeder", image: "<url>", digital: null },
						{ id: 1, name: "Feeders", image: "<url>", digital: null }
					],
					maxPresets: 64,
					// no guard point saved on the real camera yet; timeout limits from the action:1 range
					guard: { set: false, autoReturn: false, timeoutS: 60, minS: 10, maxS: 300, digital: null },
					// aiTrack 1 is the tracking method; bSmartTrack 0 is the switch, and it's off
					tracking: { on: false }
				},
				lights: [
					{ id: "ir", label: "Night vision", on: true, detail: "The infrared lights come on by themselves when it gets dark." },
					{ id: "spotlight", label: "Spotlight", on: false, detail: "The white light is off.", brightness: 85 }
				],
				dayNight: "auto",
				siren: true,
				microphone: false,
				snapshot: true,
				model: "RLC-823S1"
			} satisfies CameraControls
		)
	})

	test("abilities are read once; after that, every setting comes back in one round trip", async () => {
		const { control } = open()
		const from = mock.requests.length
		await control.controls()
		const posts = () => new Set(mock.requests.slice(from).map(r => r.http)).size
		// Login, GetAbility + GetDevInfo, then the reads
		assert.equal(posts(), 3)
		const mark = mock.requests.length
		await control.controls()
		assert.equal(posts(), 4)
		assert.deepEqual(
			mock.requests.slice(mark).map(r => `${r.cmd}:${r.action ?? 0}`),
			["GetPtzPreset:1", "GetZoomFocus:1", "GetAutoFocus:0", "GetPtzGuard:1", "GetAiCfg:0", "GetIrLights:0", "GetWhiteLed:1", "GetIsp:0", "GetEnc:0"]
		)
	})

	test("a fixed camera offers only what it has", async () => {
		const { control } = open({ m: fixed })
		const c = await control.controls()
		assert.deepEqual([c.ptz, c.dayNight, c.siren, c.microphone, c.lights.map(l => l.id)], [null, null, false, null, ["ir"]])
		assert.deepEqual(await control.state(), { moving: false, atHome: null, zoom: null, focus: null })
		await rejectsWith(control.ptz({ op: "home" }), 400, /can't move/)
	})

	test("a batch whose token died signs in again once and answers", async () => {
		const { control } = open()
		await control.state()
		mock.expireTokens()
		const logins = mock.requests.filter(r => r.cmd === "Login").length
		assert.equal((await control.state()).zoom, mock.state.pos.zoom)
		assert.equal(mock.requests.filter(r => r.cmd === "Login").length, logins + 1)
	})
})

describe("moving", () => {
	const lastPtz = () => mock.state.ptz.at(-1)

	test("speed follows the zoom (slower zoomed in), and Shift halves it", async () => {
		const { control } = open()
		mock.state.pos = { ...mock.state.pos, zoom: 28 }
		await control.ptz({ op: "move", direction: "left" })
		assert.deepEqual(lastPtz(), { channel: 0, op: "Left", speed: 6 })
		// the state poll keeps the zoom current
		mock.state.pos = { ...mock.state.pos, zoom: 0 }
		await control.state()
		await control.ptz({ op: "move", direction: "downRight", slow: true })
		assert.deepEqual(lastPtz(), { channel: 0, op: "RightDown", speed: 16 })
		await control.ptz({ op: "stop" })
		assert.deepEqual(lastPtz(), { channel: 0, op: "Stop" })
	})

	test("focus near is FocusInc, and a held op stops by itself", async () => {
		const { control } = open({ autoStopMs: 40 })
		mock.state.ptz.length = 0
		await control.ptz({ op: "focus", direction: "near", speed: 10 })
		await waitFor("auto-stop", () => mock.state.ptz.length === 2)
		assert.deepEqual(mock.state.ptz, [
			{ channel: 0, op: "FocusInc", speed: 10 },
			{ channel: 0, op: "Stop" }
		])
	})

	test("a held move resent by the page re-arms the auto-stop without the camera hearing it again; a new speed goes through", async () => {
		const { control } = open({ autoStopMs: 300 })
		mock.state.ptz.length = 0
		await control.ptz({ op: "move", direction: "left", speed: 10 })
		for (let i = 0; i < 4; i++) {
			await sleep(100)
			await control.ptz({ op: "move", direction: "left", speed: 10 })
		}
		// 400 ms in, past the 300 ms auto-stop: still the one PtzCtrl, no Stop
		assert.deepEqual(mock.state.ptz, [{ channel: 0, op: "Left", speed: 10 }])
		await control.ptz({ op: "move", direction: "left", speed: 5 })
		await waitFor("auto-stop", () => mock.state.ptz.length === 3)
		assert.deepEqual(mock.state.ptz, [
			{ channel: 0, op: "Left", speed: 10 },
			{ channel: 0, op: "Left", speed: 5 },
			{ channel: 0, op: "Stop" }
		])
	})

	test("an op refused mid-move, or a Stop the camera didn't take, leaves the auto-stop armed", async () => {
		let busy = false
		const m = await startMockReolink({ files: [], abilities: "ptz", failCommand: (cmd, p) => busy && cmd === "PtzCtrl" && p?.op === "Stop" })
		try {
			const { control } = open({ m, autoStopMs: 200 })
			const ptz = () => m.requests.filter(r => r.cmd === "PtzCtrl").map(r => [r.param, r.rspCode])
			await control.ptz({ op: "move", direction: "left", speed: 10 })
			// no Home saved: refused before the camera hears of it, while the pan runs on
			await rejectsWith(control.ptz({ op: "home" }), 409, /^No Home view is saved yet\./)
			await waitFor("auto-stop after the refused op", () => ptz().length === 2)
			await control.ptz({ op: "move", direction: "right", speed: 10 })
			busy = true
			await rejectsWith(control.ptz({ op: "stop" }), 502, /device busy/)
			busy = false
			await waitFor("auto-stop after the failed Stop", () => ptz().length === 5)
			assert.deepEqual(ptz(), [
				[{ channel: 0, op: "Left", speed: 10 }, null],
				[{ channel: 0, op: "Stop" }, null],
				[{ channel: 0, op: "Right", speed: 10 }, null],
				[{ channel: 0, op: "Stop" }, -17],
				[{ channel: 0, op: "Stop" }, null]
			])
		} finally {
			await m.close()
		}
	})

	test("a password refused while waiting for a move to finish ends the wait at once, and is what the next request hears", async () => {
		const env: NodeJS.ProcessEnv = { [ENV]: "hunter2" }
		const { control } = open({ env })
		const refusedLogins = () => mock.requests.filter(r => r.cmd === "Login" && r.rspCode !== null).length
		const before = refusedLogins()
		await control.ptz({ op: "preset", id: 1 })
		// changed in the Reolink app: the session dies and the saved password is wrong
		env[ENV] = "the-old-password"
		mock.expireTokens()
		await waitFor("the refused sign-in", () => refusedLogins() === before + 1)
		// ten more poll periods: the wait asks no more
		await sleep(200)
		await rejectsWith(
			control.state(),
			409,
			/^The camera turned down the saved password, so look4 won't try it again \(the camera allows 9 more wrong tries before it locks\)\./
		)
		assert.equal(refusedLogins(), before + 1)
	})

	test("zoomTo and focusTo are StartZoomFocus, kept inside the camera's range", async () => {
		const { control } = open()
		await control.ptz({ op: "zoomTo", pos: 40 })
		await control.ptz({ op: "focusTo", pos: 100.4 })
		assert.deepEqual(mock.sent("StartZoomFocus").slice(-2), [
			{ ZoomFocus: { channel: 0, op: "ZoomPos", pos: 28 } },
			{ ZoomFocus: { channel: 0, op: "FocusPos", pos: 100 } }
		])
	})

	test("once the zoom range is known, zoomTo is one round trip: no GetZoomFocus", async () => {
		const { control } = open()
		await control.ptz({ op: "zoomTo", pos: 10 })
		const from = mock.requests.length
		await control.ptz({ op: "zoomTo", pos: 12 })
		assert.deepEqual(mock.requests.slice(from).map(r => r.cmd), ["StartZoomFocus"])
	})

	/** The commands of the last HTTP request that carried `cmd`, with their params. */
	const lastPost = (cmd: string) => {
		const n = mock.requests.findLast(r => r.cmd === cmd)!.http
		return mock.requests.filter(r => r.http === n).map(r => [r.cmd, r.param])
	}

	test("zoomTo with an aim centres the point first, then zooms, in one request", async () => {
		const { control } = open()
		mock.state.pos = { ...mock.state.pos, zoom: 0 }
		await control.ptz({ op: "zoomTo", pos: 14, aim: { x: 0.3, y: 0.6 } })
		assert.deepEqual(lastPost("StartZoomFocus"), [
			["Set3DPos", { "3DPos": { channel: 0, posX: 1152, posY: 1296, posWidth: 0, posHeight: 0, speed: 32, width: 3840, height: 2160 } }],
			["StartZoomFocus", { ZoomFocus: { channel: 0, op: "ZoomPos", pos: 14 } }]
		])
	})

	test("a box is a point at its centre, then the lens to the position whose measured magnification fills the view with it", async () => {
		const { control } = open()
		const before = mock.sent("Get3DPos").length
		// 1.15× at position 4; a box half the picture wide wants 2.3×, which the lens has at 24
		mock.state.pos = { ...mock.state.pos, zoom: 4 }
		await control.ptz({ op: "box", x: 0.9, y: 0.25, w: 0.5, h: 0.25 })
		assert.deepEqual(lastPost("StartZoomFocus"), [
			// slid onto the frame first: centre (0.75, 0.375)
			["Set3DPos", { "3DPos": { channel: 0, posX: 2880, posY: 810, posWidth: 0, posHeight: 0, speed: 28, width: 3840, height: 2160 } }],
			["StartZoomFocus", { ZoomFocus: { channel: 0, op: "ZoomPos", pos: 24 } }]
		])
		// past the lens's 2.53×: as far as it goes
		await control.ptz({ op: "box", x: 0.4, y: 0.4, w: 0.1, h: 0.1 })
		assert.deepEqual(mock.sent("StartZoomFocus").at(-1), { ZoomFocus: { channel: 0, op: "ZoomPos", pos: 28 } })
		// a point only centres
		const zooms = mock.sent("StartZoomFocus").length
		await control.ptz({ op: "box", x: 0.5, y: 0.5, w: 0, h: 0, speed: 20 })
		assert.deepEqual(lastPost("Set3DPos"), [
			["Set3DPos", { "3DPos": { channel: 0, posX: 1920, posY: 1080, posWidth: 0, posHeight: 0, speed: 20, width: 3840, height: 2160 } }]
		])
		assert.equal(mock.sent("StartZoomFocus").length, zooms)
		// the frame size is asked once
		assert.equal(mock.sent("Get3DPos").length - before, 1)
	})

	test("settle answers once the camera's position holds still, not when the camera took the command", async () => {
		const m = await startMockReolink({ files: [], abilities: "ptz", settleMs: 1000 })
		try {
			const { control } = open({ m, arrivePollMs: 50 })
			await control.ptz({ op: "zoomTo", pos: 20 })
			await sleep(300)
			// the camera says it is on its way (GetPtzStat would say 0 here, as the real one does)
			const on = (await control.state()).zoom!
			assert.ok(on > 8 && on < 20, `zoom ${on}`)
			await control.ptz({ op: "zoomTo", pos: 0, settle: true })
			assert.equal((await control.state()).zoom, 0)
		} finally {
			await m.close()
		}
	})

	test("settle gives up at its deadline however slowly the camera answers reads", async () => {
		// a move that doesn't end in time, on a camera whose every answer takes 250 ms
		const m = await startMockReolink({ files: [], abilities: "ptz", settleMs: 60_000, latencyMs: 250 })
		try {
			const { control } = open({ m, arrivePollMs: 50, arriveMaxMs: 400 })
			await control.ptz({ op: "zoomTo", pos: 0 })
			const t = Date.now()
			await control.ptz({ op: "zoomTo", pos: 28, settle: true })
			// the command's own 250 ms and the 400 ms wait, the read out at the deadline cut off: twenty reads
			// at 300 ms each would be over 2 s
			const took = Date.now() - t
			assert.ok(took < 1100, `answered after ${took} ms`)
		} finally {
			await m.close()
		}
	})

	test("an aimed zoomTo that a newer move overtook while it learned the picture size is never sent", async () => {
		const { control } = open()
		await control.ptz({ op: "zoomTo", pos: 8 })
		const zooms = mock.sent("StartZoomFocus").length
		const points = mock.sent("Set3DPos").length
		// a wheel step, then a wheel out while the step still waits for Get3DPos
		await Promise.all([control.ptz({ op: "zoomTo", pos: 16, aim: { x: 0.8, y: 0.5 }, settle: true }), control.ptz({ op: "zoomTo", pos: 4 })])
		assert.deepEqual(mock.sent("StartZoomFocus").slice(zooms), [{ ZoomFocus: { channel: 0, op: "ZoomPos", pos: 4 } }])
		assert.equal(mock.sent("Set3DPos").length, points)
	})

	test("reading the controls learns the picture size, so the first aimed step is one request", async () => {
		const { control } = open()
		await control.controls()
		const from = mock.requests.length
		await control.ptz({ op: "zoomTo", pos: 12, aim: { x: 0.5, y: 0.5 } })
		assert.deepEqual(mock.requests.slice(from).map(r => r.cmd), ["Set3DPos", "StartZoomFocus"])
	})
})

describe("Home", () => {
	// an earlier test's last move may still be under way on the shared mock, and saving Home reads where the
	// camera is: setting the position (to itself) lands it
	beforeEach(() => {
		mock.state.pos = { ...mock.state.pos }
	})
	afterEach(() => {
		mock.state.guard = { ...mock.state.guard, benable: 0, bexistPos: 0, timeout: 60, pos: null }
	})

	test("with nothing saved, Back home and auto-return refuse in a sentence", async () => {
		const { control } = open()
		await rejectsWith(control.ptz({ op: "home" }), 409, /^No Home view is saved yet\./)
		await rejectsWith(control.setting({ setting: "home", autoReturn: true }), 409, /Save a Home view first/)
	})

	test("Make this view Home saves the guard point; moving away and back shows in atHome", async () => {
		const { control, dataDir } = open()
		const c = await control.setting({ setting: "home", saveHere: true })
		assert.deepEqual(mock.sent("SetPtzGuard").at(-1), { PtzGuard: { channel: 0, cmdStr: "setPos", bSaveCurrentPos: 1, bexistPos: 1, benable: 0, timeout: 60 } })
		assert.equal(c.ptz!.guard!.set, true)
		const { Ppos, Tpos, Zpos } = mock.state.pos
		const { savedAt: _, ...saved } = JSON.parse(readFileSync(join(dataDir, "live", "cam", "home.json"), "utf8"))
		assert.deepEqual(saved, { pan: Ppos, tilt: Tpos, zoom: Zpos })
		assert.equal((await control.state()).atHome, true)

		await control.ptz({ op: "move", direction: "right", speed: 64 })
		await control.ptz({ op: "stop" })
		assert.equal((await control.state()).atHome, false)

		await control.ptz({ op: "home" })
		assert.deepEqual(mock.sent("SetPtzGuard").at(-1), { PtzGuard: { channel: 0, cmdStr: "toPos" } })
		await waitFor("back home", async () => (await control.state()).atHome === true)
	})

	test("a Home saved elsewhere is unknown until the camera has been sent there", async () => {
		// set in the Reolink app: the camera has a guard point, look4 doesn't know where
		mock.state.guard = { ...mock.state.guard, bexistPos: 1, pos: { ...mock.state.pos, Ppos: mock.state.pos.Ppos + 300 } }
		const { control } = open()
		assert.equal((await control.state()).atHome, null)
		await control.ptz({ op: "home" })
		await waitFor("Home learned", async () => (await control.state()).atHome === true)
	})

	test("auto-return and its delay change without moving Home, within the camera's 10–300 s", async () => {
		const { control } = open()
		await control.setting({ setting: "home", saveHere: true })
		const c = await control.setting({ setting: "home", autoReturn: true, timeoutS: 600 })
		assert.deepEqual(mock.sent("SetPtzGuard").at(-1), { PtzGuard: { channel: 0, cmdStr: "setPos", bSaveCurrentPos: 0, benable: 1, timeout: 300 } })
		assert.deepEqual(c.ptz!.guard, { set: true, autoReturn: true, timeoutS: 300, minS: 10, maxS: 300, digital: null })
	})

	test("Home keeps the magnification it was saved with; changing the return keeps it too", async () => {
		const { control, dataDir } = open()
		const digital = { z: 2.5, cx: 0.4, cy: 0.6 }
		await control.setting({ setting: "home", saveHere: true, digital })
		const c = await control.setting({ setting: "home", autoReturn: true })
		assert.deepEqual(c.ptz!.guard!.digital, digital)
		// a fresh driver reads it back from disk
		const again = createReolinkControl(cfg(), { [ENV]: "hunter2" }, { autoStopMs: 60_000, settlePollMs: 20, dataDir })
		opened.push(again)
		assert.deepEqual((await again.controls()).ptz!.guard!.digital, digital)
		// saved again at 1×: nothing to restore
		assert.equal((await control.setting({ setting: "home", saveHere: true, digital: { z: 1, cx: 0.5, cy: 0.5 } })).ptz!.guard!.digital, null)
	})
})

describe("saved views", () => {
	const presetPos = new Map<number, MockPosition>()
	before(() => {
		for (const [id, p] of mock.state.presetPos) presetPos.set(id, p)
	})
	afterEach(() => {
		mock.state.presets = structuredClone(RLC823S1.GetPtzPreset!.value.PtzPreset)
		mock.state.presetPos = new Map(presetPos)
	})

	test("the camera's own thumbnail is fetched once (ExportImg) and then served from disk", async () => {
		const { control, dataDir } = open()
		const before = mock.sent("ExportImg").length
		const a = await control.presetImage(0)
		const b = await control.presetImage(0)
		assert.deepEqual(a, mock.state.images.get("preset_00"))
		assert.deepEqual(b, a)
		assert.deepEqual(mock.sent("ExportImg").slice(before), [{ ExportImg: { channel: 0, FileName: "preset_00" } }])
		assert.ok(existsSync(join(dataDir, "live", "cam")))
	})

	test("an old camera picture is fetched again; one re-saved in the Reolink app gets a new URL", async () => {
		const original = mock.state.images.get("preset_00")!
		try {
			const { control } = open({ viewPictureMaxAgeMs: 0 })
			const url = async () => (await control.controls()).ptz!.presets.find(p => p.id === 0)!.image
			const first = await url()
			assert.deepEqual(await control.presetImage(0), original)
			const resaved = await sharp({ create: { width: 169, height: 95, channels: 3, background: "#123456" } }).jpeg().toBuffer()
			mock.state.images.set("preset_00", resaved)
			assert.deepEqual(await control.presetImage(0), resaved)
			const second = await url()
			assert.notEqual(second, first)
			// fetched again, unchanged: the URL stays, so browsers keep their copy
			assert.deepEqual(await control.presetImage(0), resaved)
			assert.equal(await url(), second)
		} finally {
			mock.state.images.set("preset_00", original)
		}
	})

	test("save takes the lowest free slot, uploads a 169×95 thumbnail, then stores the view", async () => {
		const { control } = open()
		const c = await control.preset({ op: "save", name: "  Right feeder " })
		// field `ptz-image`, file name `<uuid>&preset_02&<bytes>&0`, as the camera's web UI uploads it
		const { uuid, bytes, ...upload } = mock.sent("ImportImg").at(-1)
		assert.match(uuid, /^[0-9a-f-]{36}$/)
		assert.deepEqual(upload, { field: "ptz-image", imgName: "preset_02", size: bytes, channel: 0, type: "image/jpeg" })
		const uploaded = mock.state.images.get("preset_02")!
		assert.ok(uploaded.length <= 14 * 1024)
		assert.deepEqual(await sharp(uploaded).metadata().then(m => [m.width, m.height]), [169, 95])
		// upload first, then the view itself (enable 1 stores where the camera points)
		const last = mock.requests.filter(r => r.cmd === "ImportImg" || r.cmd === "SetPtzPreset").slice(-2).map(r => r.cmd)
		assert.deepEqual(last, ["ImportImg", "SetPtzPreset"])
		assert.deepEqual(mock.sent("SetPtzPreset").at(-1), { PtzPreset: { channel: 0, enable: 1, id: 2, name: "Right feeder", imgName: "preset_02" } })
		const saved = c.ptz!.presets.find(p => p.id === 2)!
		assert.match(saved.image!, IMAGE)
		// look4 already has the picture: no ExportImg needed
		const exports = mock.sent("ExportImg").length
		assert.deepEqual(await control.presetImage(2), uploaded)
		assert.equal(mock.sent("ExportImg").length, exports)
	})

	test("rename leaves out enable; delete removes the picture first, then disables the slot", async () => {
		const { control } = open()
		await control.preset({ op: "rename", id: 1, name: "Both feeders" })
		assert.deepEqual(mock.sent("SetPtzPreset").at(-1), { PtzPreset: { channel: 0, id: 1, name: "Both feeders", imgName: "preset_01" } })
		const c = await control.preset({ op: "delete", id: 1 })
		const order = mock.requests.filter(r => r.cmd === "DeleteImg" || r.cmd === "SetPtzPreset").slice(-2)
		assert.deepEqual(
			order.map(r => r.param),
			[{ DeleteImg: { channel: 0, FileName: "preset_01" } }, { PtzPreset: { channel: 0, enable: 0, id: 1, name: "Both feeders", imgName: "preset_01" } }]
		)
		assert.deepEqual(c.ptz!.presets.map(p => p.id), [0])
		await rejectsWith(control.preset({ op: "rename", id: 1, name: "x" }), 404, /no saved view 1/)
		await rejectsWith(control.preset({ op: "save", name: "   " }), 400, /1 to 31 characters/)
	})

	test("a view keeps the magnification it was saved with until it is updated or deleted", async () => {
		const { control } = open()
		const digital = { z: 3, cx: 0.25, cy: 0.7 }
		const at = (c: CameraControls, id: number) => c.ptz!.presets.find(p => p.id === id)?.digital
		assert.deepEqual(at(await control.preset({ op: "save", name: "Close up", digital }), 2), digital)
		assert.deepEqual(at(await control.preset({ op: "rename", id: 2, name: "Closer" }), 2), digital)
		assert.equal(at(await control.preset({ op: "save", id: 2, name: "Closer" }), 2), null)
		await control.preset({ op: "save", id: 2, name: "Closer", digital })
		await control.preset({ op: "delete", id: 2 })
		// the slot comes back empty: the deleted view's magnification went with it
		assert.equal(at(await control.preset({ op: "save", name: "New" }), 2), null)
	})

	test("when the camera won't take the upload, the view is saved anyway with look4's own picture", async () => {
		const m = await startMockReolink({ files: [], abilities: "ptz", failImport: true })
		try {
			const { control } = open({ m })
			const c = await control.preset({ op: "save", name: "Ground" })
			assert.deepEqual(m.sent("SetPtzPreset").at(-1), { PtzPreset: { channel: 0, enable: 1, id: 2, name: "Ground" } })
			assert.match(c.ptz!.presets.find(p => p.id === 2)!.image!, IMAGE)
			assert.equal((await control.presetImage(2)).subarray(0, 2).toString("hex"), "ffd8")
			assert.equal(m.sent("ExportImg").length, 0)
		} finally {
			await m.close()
		}
	})

	test("a view without any picture gets one from look4 once the camera has reached it", async () => {
		const { control } = open()
		mock.state.images.delete("preset_01")
		await rejectsWith(control.presetImage(1), 404, /no picture yet/)
		assert.equal((await control.controls()).ptz!.presets.find(p => p.id === 1)!.image, null)
		const snaps = mock.requests.filter(r => r.cmd === "Snap").length
		await control.ptz({ op: "preset", id: 1 })
		assert.deepEqual(mock.state.ptz.at(-1), { channel: 0, op: "ToPos", id: 1, speed: 32 })
		await waitFor("thumbnail", async () => (await control.controls()).ptz!.presets.find(p => p.id === 1)!.image !== null)
		assert.equal(mock.requests.filter(r => r.cmd === "Snap").length, snaps + 1)
		mock.state.images.set("preset_01", await sharp({ create: { width: 169, height: 95, channels: 3, background: "#000" } }).jpeg().toBuffer())
	})
})

describe("lights, picture, siren", () => {
	test("a spotlight switched on from look4 switches itself off, and says so", async () => {
		const { control } = open({ spotlightOffMs: 400 })
		const c = await control.setLight({ id: "spotlight", on: true, brightness: 40 })
		assert.deepEqual(mock.sent("SetWhiteLed").at(-1), { WhiteLed: { channel: 0, state: 1, bright: 40 } })
		assert.deepEqual(c.lights.find(l => l.id === "spotlight"), {
			id: "spotlight",
			label: "Spotlight",
			on: true,
			detail: "The white light is on. look4 switches it off by itself in 1 min.",
			brightness: 40
		})
		await waitFor("auto-off", () => mock.state.whiteLed === 0)
		assert.deepEqual(mock.sent("SetWhiteLed").at(-1), { WhiteLed: { channel: 0, state: 0 } })
		await rejectsWith(control.setLight({ id: "ir", brightness: 10 }), 400, /no brightness/)
	})

	test("night picture and microphone send back the whole Isp / Enc; tracking is bSmartTrack; autofocus is disable", async () => {
		const { control } = open()
		await control.setting({ setting: "dayNight", mode: "bw" })
		assert.deepEqual(mock.sent("SetIsp").at(-1), { Isp: { ...RLC823S1.GetIsp!.value.Isp, dayNight: "Black&White" } })
		await control.setting({ setting: "microphone", on: true })
		assert.deepEqual(mock.sent("SetEnc").at(-1), { Enc: { ...RLC823S1.GetEnc!.value.Enc, audio: 1 } })
		await control.setting({ setting: "tracking", on: true })
		assert.deepEqual(mock.sent("SetAiCfg").at(-1), { channel: 0, bSmartTrack: 1 })
		const c = await control.setting({ setting: "autofocus", on: false })
		assert.deepEqual(mock.sent("SetAutoFocus").at(-1), { AutoFocus: { channel: 0, disable: 1 } })
		assert.deepEqual([c.dayNight, c.microphone, c.ptz!.tracking, c.ptz!.autofocus], ["bw", true, { on: true }, false])
		// put the shared mock back
		await control.setting({ setting: "dayNight", mode: "auto" })
		await control.setting({ setting: "microphone", on: false })
		await control.setting({ setting: "tracking", on: false })
		await control.setting({ setting: "autofocus", on: true })
	})

	test("the siren plays once", async () => {
		const { control } = open()
		await control.siren()
		assert.deepEqual(mock.sent("AudioAlarmPlay").at(-1), { channel: 0, alarm_mode: "times", times: 1 })
		await rejectsWith(open({ m: fixed }).control.siren(), 400, /no siren/)
	})
})

describe("control routes", () => {
	const serve = (control: CameraControl | null) => {
		const app = new Hono()
		app.onError((e, c) => c.json({ error: e.message }, (e instanceof HttpError ? e.status : 500) as ContentfulStatusCode))
		app.route("/", liveRoutes({ controlFor: () => control } as unknown as Live))
		return app
	}
	const post = (app: Hono, path: string, body: unknown) =>
		app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })

	test("a view's picture is a JPEG a browser may keep for a day", async () => {
		const res = await serve(open().control).request("/live/cam/presets/0/image?v=x")
		assert.equal(res.status, 200)
		assert.deepEqual([res.headers.get("content-type"), res.headers.get("cache-control")], ["image/jpeg", "private, max-age=86400"])
	})

	test("a box outside the picture is refused before the camera hears of it; camera refusals are one sentence", async () => {
		const app = serve(open().control)
		const bad = await post(app, "/live/cam/ptz", { op: "box", x: 1.2, y: 0, w: 0.1, h: 0.1 })
		assert.equal(bad.status, 400)
		const home = await post(app, "/live/cam/ptz", { op: "home" })
		assert.equal(home.status, 409)
		assert.deepEqual(await home.json(), { error: "No Home view is saved yet. Point the camera at the feeder and use “Make this view Home”." })
	})

	test("a camera without a driver has no controls and can't be steered", async () => {
		const app = serve(null)
		assert.deepEqual(await (await app.request("/live/cam/state")).json(), { moving: false, atHome: null, zoom: null, focus: null })
		const res = await post(app, "/live/cam/siren", {})
		assert.deepEqual([res.status, await res.json()], [400, { error: "This camera has no siren." }])
	})
})
