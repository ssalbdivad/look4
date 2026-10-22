import assert from "node:assert/strict"
import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { after, before, describe, test } from "node:test"
import { type ReolinkSourceConfig, parseConfig, ReolinkSource } from "../src/config.ts"
import { ControlError } from "../src/live/control.ts"
import { streamOf, streamVariant } from "../src/live/inputs.ts"
import { ffmpegFrames, mp4Args } from "../src/live/feeds.ts"
import { createLive as createLiveIn, type LiveDeps, MAX_MP4_SESSIONS } from "../src/live/manager.ts"
import { createMjpegParser, mjpegPart } from "../src/live/mjpeg.ts"
import { codecsOf, initSegmentEnd } from "../src/live/mp4.ts"
import { createReolinkControl, reolinkCapabilities } from "../src/live/reolink-control.ts"
import { run } from "../src/media/ffmpeg.ts"
import { createReolinkClient, ReolinkError } from "../src/sources/reolink-api.ts"
import { type MockReolink, startMockReolink } from "./fixtures/mock-reolink.ts"
import { type MockRtsp, startMockRtsp } from "./fixtures/mock-rtsp.ts"
import { Hono } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { HttpError } from "../src/server/http.ts"
import { liveMediaRoutes } from "../src/server/live-media.ts"

const tmp = join(import.meta.dirname, ".tmp", "live-test")
const ABILITY_823S1 = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "reolink-ability-rlc823s1.json"), "utf8"))

/** A camera's 16 kHz mono beep, as `-f lavfi` input args. */
const BEEP = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:beep_factor=4"]

/** The first bytes ffmpeg writes for a live fragmented-MP4 stream of `encoder` (plus `audio` encoder args, if any). */
const initOf = async (encoder: string, audio: string[] = []) => {
	const out = join(tmp, `${encoder}${audio.join("")}.mp4`)
	await run("ffmpeg", [
		"-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10:duration=1",
		...(audio.length ? [...BEEP, "-t", "1", ...audio, "-ac", "1"] : []),
		"-c:v", encoder, "-pix_fmt", "yuv420p", "-f", "mp4", "-movflags", "empty_moov+default_base_moof+frag_every_frame", out
	])
	return readFileSync(out)
}

/** A looping camera clip with a short keyframe interval (a viewer gets a picture at once) and the given sound. */
const cameraClip = async (name: string, video: string[], audio: string[] = ["-an"]) => {
	const out = join(tmp, name)
	await run("ffmpeg", [
		"-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10:duration=4",
		...(audio[0] === "-an" ? [] : [...BEEP, "-t", "4", "-ac", "1"]),
		...video, "-g", "10", "-pix_fmt", "yuv420p", ...audio, out
	])
	return out
}

const H264 = ["-c:v", "libx264"]

before(() => mkdirSync(tmp, { recursive: true }))
after(() => rmSync(tmp, { recursive: true, force: true }))

describe("stream variants", () => {
	test("switches main and sub for brands whose URL names the stream", () => {
		assert.equal(streamVariant("rtsp://a:b@10.0.0.2:554/h264Preview_01_main", "sub"), "rtsp://a:b@10.0.0.2:554/h264Preview_01_sub")
		assert.equal(streamVariant("rtsp://10.0.0.2/Streaming/Channels/101", "sub"), "rtsp://10.0.0.2/Streaming/Channels/102")
		// channel 11's main stream: the channel digits are not the stream digit
		assert.equal(streamVariant("rtsp://10.0.0.2/Streaming/Channels/1101?transportmode=unicast", "sub"), "rtsp://10.0.0.2/Streaming/Channels/1102?transportmode=unicast")
		assert.equal(streamVariant("rtsp://10.0.0.2/cam/realmonitor?channel=1&subtype=1", "main"), "rtsp://10.0.0.2/cam/realmonitor?channel=1&subtype=0")
		assert.equal(streamVariant("rtsp://u:p@10.0.0.2:554/stream2", "main"), "rtsp://u:p@10.0.0.2:554/stream1")
	})

	test("leaves a URL it doesn't recognise alone", () => {
		assert.equal(streamVariant("rtsp://10.0.0.2/live", "sub"), null)
		// a password that happens to contain a marker is not a stream path
		assert.equal(streamVariant("rtsp://admin:subtype=1@10.0.0.2/live", "main"), null)
		assert.equal(streamOf("rtsp://10.0.0.2/live"), null)
		assert.equal(streamOf("rtsp://10.0.0.2/h265Preview_02_sub"), "sub")
	})
})

describe("fragmented MP4", () => {
	const codecsIn = (bytes: Uint8Array) => codecsOf(bytes.subarray(0, initSegmentEnd(bytes)!))

	test("finds the init segment and the H.264 codec string; no sound track, no audio codec", async () => {
		const bytes = await initOf("libx264")
		const end = initSegmentEnd(bytes)
		assert.ok(end && end < bytes.length)
		// testsrc2 at 320x180 with libx264's defaults: High profile, level 1.2
		assert.deepEqual(codecsOf(bytes.subarray(0, end)), { codecs: "avc1.64000c", video: "avc1.64000c", audio: null })
	})

	test("builds the HEVC codec string from hvcC, named for the sample entry", async () => {
		// x265 repeats its parameter sets in the stream, so ffmpeg writes a `hev1` sample entry
		assert.equal(codecsIn(await initOf("libx265"))?.codecs, "hev1.1.6.L60.90")
	})

	test("adds the sound track's codec after the video's, from esds", async () => {
		assert.deepEqual(codecsIn(await initOf("libx264", ["-c:a", "aac", "-ar", "16000"])), {
			codecs: "avc1.64000c,mp4a.40.2",
			video: "avc1.64000c",
			audio: "mp4a.40.2"
		})
		// 16 kHz MP3 is MPEG-2 audio (object type 0x69), with no AAC object type after it
		assert.equal(codecsIn(await initOf("libx264", ["-c:a", "libmp3lame", "-ar", "16000"]))?.codecs, "avc1.64000c,mp4a.69")
	})

	test("waits for a moov that is still arriving", async () => {
		const bytes = await initOf("libx264")
		const end = initSegmentEnd(bytes)!
		assert.equal(initSegmentEnd(bytes.subarray(0, end - 1)), null)
		assert.equal(initSegmentEnd(bytes.subarray(0, 5)), null)
	})
})

describe("ffmpeg arguments", () => {
	test("pin what the real camera measured", () => {
		const url = "rtsp://a:b@10.0.0.2/h264Preview_01_main"
		const plans = [{ kind: "copy" }, { kind: "transcode", via: "gpu", codec: "hevc" }, { kind: "transcode", via: "nvenc" }, { kind: "transcode", via: "x264" }] as const
		const flags = (args: string[]) => ({
			// nobuffer discards the probed keyframe: a whole extra GOP before the first picture
			nobuffer: args.includes("nobuffer"),
			lowDelay: args.includes("low_delay"),
			threads: args.at(args.indexOf("-threads") + 1) === "4" && args.indexOf("-threads") < args.indexOf("-i"),
			hvc1: args.includes("hvc1"),
			sound: args.includes("0:a:0?")
		})
		assert.deepEqual(
			plans.map(p => flags(mp4Args(url, p))),
			[
				{ nobuffer: false, lowDelay: true, threads: false, hvc1: false, sound: false },
				{ nobuffer: false, lowDelay: false, threads: false, hvc1: false, sound: false },
				{ nobuffer: false, lowDelay: false, threads: true, hvc1: false, sound: false },
				{ nobuffer: false, lowDelay: false, threads: true, hvc1: false, sound: false }
			]
		)
		assert.deepEqual(flags(mp4Args(url, { kind: "copy", hvc1: true }, "copy")), { nobuffer: false, lowDelay: true, threads: false, hvc1: true, sound: true })
	})
})

describe("Motion JPEG", () => {
	test("splits parts whatever the chunk boundaries", () => {
		const a = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])
		const b = Buffer.from([0xff, 0xd8, 9, 0xff, 0xd9])
		const stream = Buffer.concat([mjpegPart(a), mjpegPart(b), mjpegPart(a)])
		for (const size of [1, 3, 17, stream.length]) {
			const parse = createMjpegParser()
			const frames: Buffer[] = []
			for (let i = 0; i < stream.length; i += size) frames.push(...parse(stream.subarray(i, i + size)))
			assert.deepEqual(frames, [a, b, a], `chunks of ${size}`)
		}
	})

	test("reads ffmpeg's own mpjpeg headers", () => {
		const jpeg = Buffer.from([0xff, 0xd8, 7, 0xff, 0xd9])
		const part = Buffer.concat([Buffer.from(`--look4frame\r\nContent-type: image/jpeg\r\nContent-length: ${jpeg.length}\r\n\r\n`), jpeg, Buffer.from("\r\n")])
		assert.deepEqual(createMjpegParser()(Buffer.concat([part, part])), [jpeg, jpeg])
	})
})

describe("Reolink abilities", () => {
	test("the RLC-823S1 pans, tilts, zooms, has presets, IR and a spotlight", () => {
		assert.deepEqual(reolinkCapabilities(ABILITY_823S1, 0), { pan: true, tilt: true, zoom: true, presets: true, ir: true, spotlight: true, snap: true })
	})

	test("a fixed camera gets no PTZ, even with ptzCtrl's permission bits set", () => {
		const fixed = { Ability: { abilityChn: [{ ptzType: { ver: 0 }, ptzCtrl: { permit: 6, ver: 0 }, ledControl: { ver: 1 }, supportFLswitch: { ver: 0 } }] } }
		assert.deepEqual(reolinkCapabilities(fixed, 0), { pan: false, tilt: false, zoom: false, presets: false, ir: true, spotlight: false, snap: true })
	})

	test("an optical-zoom-only camera (ptzType 1) zooms but does not turn", () => {
		const caps = reolinkCapabilities({ Ability: { abilityChn: [{ ptzType: { ver: 1 } }] } }, 0)
		assert.deepEqual([caps.pan, caps.tilt, caps.zoom], [false, false, true])
	})
})

describe("Reolink control", () => {
	let mock: MockReolink
	const ENV = "LOOK4_TEST_LIVE_PW"
	const cfg = (): ReolinkSourceConfig =>
		ReolinkSource.assert({ type: "reolink", name: "cam", host: mock.host, protocol: "http", passwordEnv: ENV })
	before(async () => {
		mock = await startMockReolink({ files: [], abilities: "ptz" })
	})
	after(() => mock.close())

	test("a refused login says how many tries are left", async () => {
		const client = createReolinkClient({ host: mock.host, username: "admin", password: () => "nope", protocol: "http", channel: 0 })
		const e = await client.login().catch(x => x)
		assert.ok(e instanceof ReolinkError)
		assert.equal(e.attemptsLeft, 9)
		// the next right login resets the camera's count
		await createReolinkClient({ host: mock.host, username: "admin", password: () => "hunter2", protocol: "http", channel: 0 }).login()
	})

	test("never signs in again after the camera refused the password", async () => {
		const control = createReolinkControl(cfg(), { [ENV]: "wrong" })
		const logins = () => mock.requests.filter(r => r.cmd === "Login").length
		const before = logins()
		await assert.rejects(control.controls(), (e: unknown) => e instanceof ControlError && e.status === 409 && /9 more wrong tries/.test(e.message))
		await assert.rejects(control.ptz({ op: "move", direction: "left" }), ControlError)
		await assert.rejects(control.snapshot(), ControlError)
		assert.equal(logins() - before, 1)
		await control.close()
	})

	test("reads presets and lights, switches a light, and stops a move whose release never came", async () => {
		const control = createReolinkControl(cfg(), { [ENV]: "hunter2" }, { autoStopMs: 50 })
		const c = await control.controls()
		assert.deepEqual([c.ptz?.pan, c.ptz?.tilt, c.ptz?.zoom, c.ptz?.presets.map(p => [p.id, p.name])], [true, true, true, [[0, "Tree and Left Feeder"], [1, "Feeders"]]])
		assert.deepEqual(c.lights.map(l => [l.id, l.on]), [["ir", true], ["spotlight", false]])
		const after = await control.setLight({ id: "spotlight", on: true })
		assert.equal(after.lights.find(l => l.id === "spotlight")?.on, true)
		mock.state.ptz.length = 0
		await control.ptz({ op: "move", direction: "upLeft", speed: 80 })
		await new Promise(r => setTimeout(r, 120))
		assert.deepEqual(mock.state.ptz, [
			{ channel: 0, op: "LeftUp", speed: 64 },
			{ channel: 0, op: "Stop" }
		])
		await control.close()
	})
})

describe("live sources", () => {
	const raw = (sources: unknown[]) => parseConfig({ sources }, null, tmp)
	const reolink = { type: "reolink", name: "cam", host: "192.168.1.31", passwordEnv: "PW" }
	const createLive = (deps: Omit<LiveDeps, "dataDir">) => createLiveIn({ dataDir: tmp, nvenc: async () => true, ...deps })

	test("a Reolink camera with no password shows stills and says why", async () => {
		const live = createLive({ config: () => raw([reolink]), statuses: () => [], env: { PW: "" }, probe: async () => true })
		const [s] = await live.list()
		assert.equal(s!.feed, "stills")
		assert.equal(s!.problem, "needs-password")
	})

	test("RTSP switched off falls back to stills; a refused login shows nothing and never probes", async () => {
		let probes = 0
		const off = createLive({ config: () => raw([reolink]), statuses: () => [], env: { PW: "x" }, probe: async () => (probes++, false) })
		assert.deepEqual(
			(await off.list()).map(s => [s.feed, s.problem]),
			[["stills", "rtsp-off"]]
		)
		const refused = createLive({
			config: () => raw([reolink]),
			statuses: () => [{ name: "cam", type: "reolink", state: "error", detail: "The camera turned down look4's sign-in: the username or password is wrong", lastPollAt: null, lastClipAt: null, clipsIngested: 0 }],
			env: { PW: "x" },
			probe: async () => (probes++, true)
		})
		assert.deepEqual(
			(await refused.list()).map(s => [s.feed, s.problem]),
			[[null, "login-refused"]]
		)
		assert.equal(probes, 1)
	})

	test("folders have no live view; a generic stream offers main/sub only when its URL says", async () => {
		const live = createLive({
			config: () =>
				raw([
					{ type: "watch", name: "inbox-folder", dir: tmp },
					{ type: "rtsp", name: "hik", url: "rtsp://10.0.0.2/Streaming/Channels/101" },
					{ type: "rtsp", name: "plain", url: "rtsp://10.0.0.3/live" }
				]),
			statuses: () => []
		})
		assert.deepEqual(
			(await live.list()).map(s => [s.name, s.streams]),
			[
				["hik", ["main", "sub"]],
				["plain", []]
			]
		)
	})

	test("an RTSP source at a Reolink camera's host is the same camera: listed once, its name still works", async () => {
		const recording = new Set(["cam-live"])
		const live = createLive({
			config: () =>
				raw([
					reolink,
					{ type: "rtsp", name: "cam-live", url: "rtsp://admin:x@192.168.1.31:554/h264Preview_01_main" },
					{ type: "rtsp", name: "porch", url: "rtsp://admin:x@192.168.1.32:554/h264Preview_01_main" },
					// the same address, another channel: an NVR's other camera
					{ type: "rtsp", name: "nvr-2", url: "rtsp://admin:x@192.168.1.31:554/h264Preview_02_main" }
				]),
			statuses: () => [],
			env: { PW: "x" },
			probe: async () => true,
			recording: n => recording.has(n)
		})
		assert.deepEqual(
			(await live.list()).map(s => [s.name, s.aliases, s.recording]),
			[
				["cam", ["cam-live"], true],
				["porch", [], false],
				["nvr-2", [], false]
			]
		)
		assert.equal(live.find("cam-live").name, "cam")
		assert.equal(live.controlFor("cam-live"), live.controlFor("cam"))
		await live.close()
	})

	test("opens on Sharp only when the server can play it without the CPU re-encoding 4K", async () => {
		const deps = { config: () => raw([reolink, { type: "rtsp", name: "plain", url: "rtsp://10.0.0.3/live" }]), statuses: () => [], env: { PW: "x" }, probe: async () => true }
		const defaults = async (nvenc: boolean) => (await createLive({ ...deps, nvenc: async () => nvenc }).list()).map(s => [s.name, s.defaultStream])
		assert.deepEqual(await defaults(true), [["cam", "main"], ["plain", "main"]])
		assert.deepEqual(await defaults(false), [["cam", "sub"], ["plain", "main"]])
	})
})

describe("live video over HTTP", () => {
	let rtsp: MockRtsp
	before(async () => {
		rtsp = await startMockRtsp({
			paths: {
				"/live": await cameraClip("cam.mp4", H264),
				// a Reolink camera: H.264 main stream with its AAC track
				"/h264Preview_01_main": await cameraClip("reolink.mp4", H264, ["-c:a", "aac", "-ar", "16000"]),
				// a camera whose sound is G.711, which MP4 can't carry as is
				"/alaw": await cameraClip("alaw.mkv", H264, ["-c:a", "pcm_alaw", "-ar", "8000"]),
				"/hevc": await cameraClip("hevc.mp4", ["-c:v", "libx265", "-x265-params", "log-level=0"])
			}
		})
	})
	after(() => rtsp.close())

	const createLive = (deps: Omit<LiveDeps, "dataDir">) => createLiveIn({ dataDir: tmp, nvenc: async () => false, ...deps })

	/** The routes behind the server's own error handler, which turns an HttpError into `{ error }` with its status. */
	const serve = (live: ReturnType<typeof createLive>) => {
		const app = new Hono()
		app.onError((e, c) => c.json({ error: e.message }, (e instanceof HttpError ? e.status : 500) as ContentfulStatusCode))
		app.route("/", liveMediaRoutes(live))
		return app
	}

	const app = (path = "/live", more: unknown[] = []) => {
		const live = createLive({
			config: () => parseConfig({ sources: [{ type: "rtsp", name: "cam", url: `rtsp://admin:hunter2@${rtsp.host}${path}` }, ...more] }, null, tmp),
			statuses: () => [],
			env: { PW: "hunter2" },
			probe: async () => true
		})
		return { live, routes: serve(live) }
	}

	/** Answers one MP4 request: its headers, then hangs up (ending the camera session). */
	const mp4 = async (routes: Hono, url: string) => {
		const res = await routes.request(url)
		const h = (name: string) => res.headers.get(name)
		await res.body?.cancel()
		return { status: res.status, "x-codec": h("x-codec"), "x-audio": h("x-audio"), "x-live-path": h("x-live-path") }
	}

	const describes = (path: string) => rtsp.requests.filter(r => r.method === "DESCRIBE" && r.path === path && r.authorized).length

	test("MP4 copies H.264 and ends the camera session when the viewer leaves", async () => {
		const { live, routes } = app()
		const res = await routes.request("/live/cam/mp4")
		assert.equal(res.status, 200)
		assert.equal(res.headers.get("x-codec"), "avc1.64000c")
		const reader = res.body!.getReader()
		const first = await reader.read()
		assert.equal(String.fromCharCode(...first.value!.subarray(4, 8)), "ftyp")
		assert.equal(rtsp.viewers("/live"), 1)
		await reader.cancel()
		for (let i = 0; i < 50 && rtsp.viewers("/live") > 0; i++) await new Promise(r => setTimeout(r, 100))
		assert.equal(rtsp.viewers("/live"), 0)
		await live.close()
	})

	test("sound only when asked for: the AAC track is copied and named after the video", async () => {
		const { live, routes } = app("/h264Preview_01_main")
		assert.deepEqual(await mp4(routes, "/live/cam/mp4?audio=1"), { status: 200, "x-codec": "avc1.64000c,mp4a.40.2", "x-audio": "1", "x-live-path": "copy" })
		assert.deepEqual(await mp4(routes, "/live/cam/mp4"), { status: 200, "x-codec": "avc1.64000c", "x-audio": "0", "x-live-path": "copy" })
		// a stream with no sound track at all just plays without one
		const silent = app("/live")
		assert.deepEqual(await mp4(silent.routes, "/live/cam/mp4?audio=1"), { status: 200, "x-codec": "avc1.64000c", "x-audio": "0", "x-live-path": "copy" })
		await Promise.all([live.close(), silent.live.close()])
	})

	test("sound MP4 can't carry is re-encoded to AAC, and the next viewer skips the failed copy", async () => {
		const { live, routes } = app("/alaw")
		const before = describes("/alaw")
		assert.equal((await mp4(routes, "/live/cam/mp4?audio=1"))["x-codec"], "avc1.64000c,mp4a.40.2")
		assert.equal(describes("/alaw") - before, 2)
		assert.equal((await mp4(routes, "/live/cam/mp4?audio=1"))["x-codec"], "avc1.64000c,mp4a.40.2")
		assert.equal(describes("/alaw") - before, 3)
		await live.close()
	})

	test("HEVC copy is tagged hvc1 from the first viewer; only that one opens the camera twice to find out", async () => {
		const { live, routes } = app("/hevc")
		const before = describes("/hevc")
		assert.match((await mp4(routes, "/live/cam/mp4?hevc=1"))["x-codec"]!, /^hvc1\./)
		assert.equal(describes("/hevc") - before, 2)
		assert.match((await mp4(routes, "/live/cam/mp4?hevc=1"))["x-codec"]!, /^hvc1\./)
		assert.equal(describes("/hevc") - before, 3)
		await live.close()
	})

	test("viewers arriving together can't open more MP4 sessions than the cap", async () => {
		const { live } = app()
		const tries = await Promise.allSettled(Array.from({ length: MAX_MP4_SESSIONS + 2 }, () => live.mp4("cam", "main", { hevc: false })))
		assert.deepEqual(
			tries.map(t => (t.status === "fulfilled" ? "playing" : t.reason instanceof ControlError ? t.reason.status : t.reason)),
			[...Array(MAX_MP4_SESSIONS).fill("playing"), 429, 429]
		)
		await live.close()
	})

	test("Motion JPEG blames the GPU only when the CPU then gets a picture", async () => {
		const frames = async (url: string, gpu: "h264" | "hevc") => {
			let gpuFailed = 0
			const ac = new AbortController()
			const produce = ffmpegFrames(url, { fps: 8, maxWidth: 320, gpu, onGpuFailed: () => gpuFailed++ })
			const done = produce(() => ac.abort(), ac.signal).catch((e: Error) => e.message)
			return { error: (await done) ?? null, gpuFailed }
		}
		// no CUDA device for ffmpeg (on any machine): the GPU attempt fails at once, whatever the camera
		const cuda = process.env.CUDA_VISIBLE_DEVICES
		process.env.CUDA_VISIBLE_DEVICES = "-1"
		try {
			assert.deepEqual(await frames(`rtsp://admin:hunter2@${rtsp.host}/live`, "h264"), { error: null, gpuFailed: 1 })
			// a refused password is the camera, not the GPU: no CPU retry, so no second wrong login
			const refusedBefore = rtsp.requests.filter(r => r.method === "DESCRIBE" && !r.authorized && r.path === "/live").length
			assert.deepEqual(await frames(`rtsp://admin:nope@${rtsp.host}/live`, "h264"), {
				error: "The camera said the username or password in the address is wrong.",
				gpuFailed: 0
			})
			const refused = rtsp.requests.filter(r => r.method === "DESCRIBE" && !r.authorized && r.path === "/live").length - refusedBefore
			// ffmpeg's first DESCRIBE is unauthenticated by design (to learn the realm); then one with the password
			assert.equal(refused, 2)
		} finally {
			if (cuda === undefined) delete process.env.CUDA_VISIBLE_DEVICES
			else process.env.CUDA_VISIBLE_DEVICES = cuda
		}
	})

	test("a source folded into a Reolink camera plays that camera's stream under its own name", async () => {
		const [host, port] = rtsp.host.split(":")
		const reolink = { type: "reolink", name: "yard", host, protocol: "http", passwordEnv: "PW", rtspPort: Number(port) }
		const { live, routes } = app("/live", [reolink])
		const yard = (await live.list()).find(s => s.name === "yard")!
		// no NVENC (stubbed): Quick, until the main stream turns out to be H.264 and needs no re-encoding
		assert.deepEqual([yard.aliases, yard.defaultStream], [["cam"], "sub"])
		assert.equal((await mp4(routes, "/live/cam/mp4?stream=main&audio=1"))["x-codec"], "avc1.64000c,mp4a.40.2")
		assert.equal((await live.list()).find(s => s.name === "yard")!.defaultStream, "main")
		await live.close()
	})

	test("Motion JPEG viewers share one camera session", async () => {
		const { live, routes } = app()
		const [a, b] = await Promise.all([routes.request("/live/cam/mjpeg"), routes.request("/live/cam/mjpeg")])
		assert.equal(a.headers.get("content-type"), "multipart/x-mixed-replace; boundary=look4frame")
		const frames = createMjpegParser()((await a.body!.getReader().read()).value!)
		assert.equal(frames[0]?.subarray(0, 2).toString("hex"), "ffd8")
		await b.body!.getReader().read()
		assert.equal(rtsp.viewers("/live"), 1)
		await live.close()
	})

	test("a wrong address answers with a sentence, not a hung request", async () => {
		const live = createLive({
			config: () => parseConfig({ sources: [{ type: "rtsp", name: "cam", url: `rtsp://admin:nope@${rtsp.host}/live` }] }, null, tmp),
			statuses: () => []
		})
		const res = await serve(live).request("/live/cam/mp4")
		assert.equal(res.status, 502)
		assert.deepEqual(await res.json(), { error: "The camera said the username or password in the address is wrong." })
		await live.close()
	})
})
