import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createServer as createHttpServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { after, before, describe, test } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"
import { createContext } from "../src/app.ts"
import { parseConfig, ReolinkSource } from "../src/config.ts"
import { openStore, type Store } from "../src/db.ts"
import { createBus } from "../src/events.ts"
import { ingestFile } from "../src/ingest.ts"
import { logger } from "../src/log.ts"
import { run } from "../src/media/ffmpeg.ts"
import { type DataPaths, dataPaths, ensureDataDirs } from "../src/paths.ts"
import type { Detector } from "../src/pipeline/types.ts"
import { createServer } from "../src/server/index.ts"
import { createSegmentRecorder, GATE, type MotionSample, planCapture } from "../src/sources/recorder.ts"
import { createReolinkSource, LOGIN_REFUSED } from "../src/sources/reolink.ts"
import { startMockReolink } from "./fixtures/mock-reolink.ts"
import { startMockRtsp } from "./fixtures/mock-rtsp.ts"

// per process: two runs of this file at once (several people testing one checkout) must not share files
const root = join(import.meta.dirname, ".tmp", "capture", String(process.pid))
after(() => rmSync(root, { recursive: true, force: true }))

const s = 1000
const T0 = 1_000_000
/** `n` back-to-back 6 s segments from T0. */
const segments = (n: number) => Array.from({ length: n }, (_, i) => ({ i, start: T0 + i * 6 * s, end: T0 + (i + 1) * 6 * s }))
/** One sample a second over [from, to] seconds; `motion` per second. */
const samples = (from: number, to: number, motion: (sec: number) => boolean | null = () => false): MotionSample[] => {
	const out: MotionSample[] = []
	for (let sec = from; sec <= to; sec++) out.push({ t: T0 + sec * s, motion: motion(sec) })
	return out
}
const ids = (plan: ReturnType<typeof planCapture<{ i: number; start: number; end: number }>>) => ({
	clips: plan.clips.map(c => c.map(x => x.i)),
	unchecked: plan.unchecked.map(x => x.i)
})

describe("camera-motion gating", () => {

	test("motion at a segment boundary takes the segments on both sides plus the rolls; settled quiet ones are unchecked, the newest waits", () => {
		// motion seen at 30 s, the boundary of segments 4 and 5; the post-roll reaches into 6. The clip is
		// only finished once more quiet than `joinMs` follows it (7–9), and segment 12 waits for the pre-roll
		const plan = planCapture(segments(13), [samples(0, 80, sec => sec === 30)], T0 + 80 * s)
		assert.deepEqual(ids(plan), { clips: [[4, 5, 6]], unchecked: [0, 1, 2, 3, 7, 8, 9, 10, 11] })
	})

	test("two bursts closer than the post-roll are one clip; far apart, two", () => {
		const close = planCapture(segments(10), [samples(0, 60, sec => sec === 20 || sec === 26)], T0 + 60 * s)
		assert.deepEqual(ids(close).clips, [[2, 3, 4, 5]])
		const apart = planCapture(segments(14), [samples(0, 90, sec => sec === 10 || sec === 50)], T0 + 90 * s)
		assert.deepEqual(ids(apart), { clips: [[0, 1, 2], [7, 8, 9]], unchecked: [3, 4, 5, 6, 10, 11, 12, 13] })
	})

	test("flagged stretches up to two quiet segments apart are one clip, the gap included; three apart stay two", () => {
		// 20 s flags 2–4 and 50 s flags 7–9: segments 5 and 6 between them (12 s) join
		const joined = planCapture(segments(16), [samples(0, 100, sec => sec === 20 || sec === 50)], T0 + 100 * s)
		assert.deepEqual(ids(joined), { clips: [[2, 3, 4, 5, 6, 7, 8, 9]], unchecked: [0, 1, 10, 11, 12, 13, 14, 15] })
		// 56 s flags 8–10: three quiet segments between (18 s) keep them apart
		const split = planCapture(segments(16), [samples(0, 100, sec => sec === 20 || sec === 56)], T0 + 100 * s)
		assert.deepEqual(ids(split), { clips: [[2, 3, 4], [8, 9, 10]], unchecked: [0, 1, 5, 6, 7, 11, 12, 13, 14, 15] })
		// a short gap at the newest end may still be joined: it and its run wait, unless the source stops
		const waiting = planCapture(segments(8), [samples(0, 50, sec => sec === 20)], T0 + 50 * s)
		assert.deepEqual(ids(waiting), { clips: [], unchecked: [0, 1] })
		const stopping = planCapture(segments(8), [samples(0, 50, sec => sec === 20)], T0 + 50 * s, GATE, true)
		assert.deepEqual(ids(stopping), { clips: [[2, 3, 4]], unchecked: [0, 1, 5, 6, 7] })
	})

	test("an event still going gives up 2-minute clips and keeps the rest; stopping the source takes the rest too", () => {
		const motion = samples(0, 290, sec => sec >= 10)
		const plan = planCapture(segments(48), [motion], T0 + 290 * s)
		assert.deepEqual(plan.clips.map(c => [c[0]!.i, c.at(-1)!.i]), [[0, 19], [20, 39]])
		assert.deepEqual(plan.unchecked, [])
		const flushed = planCapture(segments(48), [motion], T0 + 290 * s, GATE, true)
		assert.deepEqual(flushed.clips.map(c => [c[0]!.i, c.at(-1)!.i]), [[0, 19], [20, 39], [40, 47]])
	})

	test("fails open: a failed read and a hole in the readings count as motion, without pre- or post-roll", () => {
		const motion = samples(0, 120, sec => (sec === 30 ? null : false)).filter(x => x.t <= T0 + 59 * s || x.t >= T0 + 70 * s)
		assert.deepEqual(ids(planCapture(segments(20), [motion], T0 + 120 * s)), {
			clips: [[4], [9, 10, 11]],
			unchecked: [0, 1, 2, 3, 5, 6, 7, 8, 12, 13, 14, 15, 16, 17, 18]
		})
	})

	test("readings that stopped coming make everything since a clip", () => {
		// the last reading is 30 s old: nothing after it is known
		const plan = planCapture(segments(15), [samples(0, 60)], T0 + 90 * s, GATE, true)
		assert.deepEqual(ids(plan), { clips: [[10, 11, 12, 13, 14]], unchecked: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] })
	})
})

describe("camera and look4's watch together", () => {
	const withBy = (plan: Parameters<typeof ids>[0]) => ({ ...ids(plan), by: plan.by })
	const quietCamera = samples(0, 60)

	test("motion only the watch saw is a clip with both rolls, marked as the watch's", () => {
		const plan = planCapture(segments(13), [samples(0, 80), samples(0, 80, sec => sec === 30)], T0 + 80 * s)
		assert.deepEqual(withBy(plan), { clips: [[4, 5, 6]], by: [[1]], unchecked: [0, 1, 2, 3, 7, 8, 9, 10, 11] })
	})

	test("a watch that went silent leaves the camera to decide: its quiet footage is unchecked, not a clip", () => {
		const plan = planCapture(segments(10), [quietCamera, samples(0, 20)], T0 + 60 * s)
		assert.deepEqual(withBy(plan), { clips: [], by: [], unchecked: [0, 1, 2, 3, 4, 5, 6, 7, 8] })
	})

	test("a watch that went silent on a motion reading ends that motion with the post-roll; the camera decides after it", () => {
		const plan = planCapture(segments(10), [quietCamera, samples(0, 20, sec => sec === 20)], T0 + 60 * s)
		assert.deepEqual(withBy(plan), { clips: [[2, 3, 4]], by: [[1]], unchecked: [0, 1, 5, 6, 7, 8] })
	})

	test("a second only one of them couldn't read is decided by the other; only one neither could read fails open", () => {
		const cameraFailed = planCapture(segments(10), [samples(0, 60, sec => (sec === 30 ? null : false)), samples(0, 60)], T0 + 60 * s)
		assert.deepEqual(ids(cameraFailed).clips, [])
		const bothFailed = planCapture(segments(10), [samples(0, 60, sec => (sec === 30 ? null : false)), samples(0, 60, sec => (sec === 30 ? null : false))], T0 + 60 * s)
		assert.deepEqual(withBy(bothFailed), { clips: [[4]], by: [[]], unchecked: [0, 1, 2, 3, 5, 6, 7, 8] })
	})

	test("a watch 3 s behind holds the newest segment until its readings pass the segment and the pre-roll; a stale one holds nothing", () => {
		const behind = planCapture(segments(10), [quietCamera, samples(0, 57)], T0 + 60 * s)
		assert.deepEqual(ids(behind).unchecked, [0, 1, 2, 3, 4, 5, 6, 7])
		const stale = planCapture(segments(10), [quietCamera, samples(0, 50)], T0 + 60 * s)
		assert.deepEqual(ids(stale).unchecked, [0, 1, 2, 3, 4, 5, 6, 7, 8])
	})

	test("a clip both saw is marked as both's; split at 2 minutes, each piece is marked by whose motion it holds", () => {
		const camera = samples(0, 200, sec => sec === 20)
		const watch = samples(0, 200, sec => sec >= 20 && sec <= 150)
		const plan = planCapture(segments(34), [camera, watch], T0 + 200 * s)
		assert.deepEqual([plan.clips.map(c => [c[0]!.i, c.at(-1)!.i]), plan.by], [[[2, 21], [22, 26]], [[0, 1], [1]]])
	})
})

describe("segment recorder", () => {
	test("a run past segment 99,999 keeps finding its segments, including ones listed after the first read", async () => {
		const dir = join(root, "segments")
		mkdirSync(dir, { recursive: true })
		const epoch = 1_728_912_345_678
		const list = join(dir, `cam_${epoch}.csv`)
		const segment = (seq: number) => writeFileSync(join(dir, `cam_${epoch}_${String(seq).padStart(5, "0")}.mp4`), Buffer.alloc(10))
		segment(99_999)
		segment(100_000)
		writeFileSync(list, `cam_${epoch}_99999.mp4,599994.0,599996.0\ncam_${epoch}_100000.mp4,599996.0,599998.0\n`)
		const recorder = createSegmentRecorder({ name: "cam", dir, url: () => null, missing: () => "", segmentSeconds: 2, audio: false, log: logger("test"), onState: () => {} })
		const found = async () => (await recorder.finished()).map(x => [x.file, x.start - epoch, x.end - epoch])

		assert.deepEqual(await found(), [
			[`cam_${epoch}_99999.mp4`, 599_994_000, 599_996_000],
			[`cam_${epoch}_100000.mp4`, 599_996_000, 599_998_000]
		])
		segment(100_001)
		appendFileSync(list, `cam_${epoch}_100001.mp4,599998.0,600000.0\n`)
		assert.deepEqual((await found()).at(-1), [`cam_${epoch}_100001.mp4`, 599_998_000, 600_000_000])
	})

	test("two reads at once (Record's save and the capture cycle) don't skip the next listed segment", async () => {
		const dir = join(root, "segments-concurrent")
		mkdirSync(dir, { recursive: true })
		const epoch = 1_728_912_345_678
		const list = join(dir, `cam_${epoch}.csv`)
		const add = (seq: number) => {
			writeFileSync(join(dir, `cam_${epoch}_${String(seq).padStart(5, "0")}.mp4`), Buffer.alloc(10))
			appendFileSync(list, `cam_${epoch}_${String(seq).padStart(5, "0")}.mp4,${seq * 6 + 0.5},${seq * 6 + 6.5}\n`)
		}
		const recorder = createSegmentRecorder({ name: "cam", dir, url: () => null, missing: () => "", segmentSeconds: 6, audio: false, log: logger("test"), onState: () => {} })
		add(0)
		await recorder.finished()
		add(1)
		await Promise.all([recorder.finished(), recorder.finished()])
		add(2)
		// an unlisted segment would be timed from its number (12 s), not the list's 12.5 s
		assert.deepEqual(
			(await recorder.finished()).map(x => [x.file, x.start - epoch]),
			[0, 1, 2].map(n => [`cam_${epoch}_0000${n}.mp4`, n * 6000 + 500])
		)
	})
})

const ffmpeg = (() => {
	try {
		execFileSync("ffmpeg", ["-version"], { stdio: "ignore" })
		return true
	} catch {
		return false
	}
})()

const ffprobe = async (file: string) => {
	const out = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", file])
	const j = JSON.parse(out.toString()) as { streams: Array<{ codec_type: string }>; format: { duration: string } }
	return { durationMs: Number(j.format.duration) * 1000, kinds: j.streams.map(x => x.codec_type).sort() }
}

describe("stream capture from a Reolink camera", { skip: !ffmpeg && "ffmpeg not installed" }, () => {
	const dir = join(root, "e2e")
	const PASSWORD_ENV = "LOOK4_TEST_CAPTURE_PASSWORD"
	let store: Store
	let paths: DataPaths
	let api: Awaited<ReturnType<typeof startMockReolink>>
	let rtsp: Awaited<ReturnType<typeof startMockRtsp>>

	before(async () => {
		rmSync(dir, { recursive: true, force: true })
		mkdirSync(dir, { recursive: true })
		paths = dataPaths(join(dir, "data"))
		ensureDataDirs(paths)
		store = openStore(paths.db)
		// a camera-like stream: H.264 with 1 s keyframes and an AAC 16 kHz mono track
		const av = join(dir, "av.mp4")
		execFileSync("ffmpeg", [
			"-hide_banner", "-loglevel", "error", "-y",
			"-f", "lavfi", "-i", "testsrc2=s=320x240:r=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000",
			"-t", "30", "-c:v", "libx264", "-g", "25", "-bf", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "1", "-ar", "16000", av
		])
		api = await startMockReolink({ files: [] })
		rtsp = await startMockRtsp({ paths: { "/h264Preview_01_main": av, "/h264Preview_01_sub": av } })
		process.env[PASSWORD_ENV] = api.password
	})
	after(async () => {
		store.close()
		await api.close()
		await rtsp.close()
		delete process.env[PASSWORD_ENV]
	})

	test("a camera motion event becomes exactly one clip covering it, with sound; quiet footage goes to unchecked/; Record saves one pinned clip from 10 s before the press", async t => {
		const cfg = ReolinkSource.assert({
			type: "reolink",
			name: "cam",
			host: api.host,
			protocol: "http",
			passwordEnv: PASSWORD_ENV,
			rtspPort: rtsp.port,
			capture: "stream",
			segmentSeconds: 2,
			motionGate: "camera"
		})
		const bus = createBus()
		const src = createReolinkSource(
			cfg,
			{ store, paths, bus, ingest: input => ingestFile({ store, paths, bus }, input), kick: () => {}, uncheckedDays: () => 2 },
			{ motionIntervalMs: 250, gate: { ...GATE, preMs: 1000, postMs: 2000 } }
		)
		src.start()
		// a failed assertion must not leave ffmpeg and the poller running
		t.after(() => src.stop())
		const t0 = Date.now()
		await sleep(6000)
		api.setMotion(true)
		const motionFrom = Date.now()
		await sleep(1500)
		api.setMotion(false)
		const motionTo = Date.now()

		// past the first 10 s of footage (the stream takes a moment to connect)
		await sleep(Math.max(0, t0 + 14_000 - Date.now()))
		const recorder = src.liveRecorder?.()
		assert.ok(recorder, "a stream-capturing Reolink source can save from Live")
		const pressedAt = Date.now()
		const started = recorder.start()
		assert.ok(Math.abs(Date.parse(started.from) - (pressedAt - 10_000)) < 500)
		assert.equal(started.maxSeconds, 300)
		await sleep(2000)
		const stoppedAt = Date.now()
		const { clipId } = await recorder.stop(started.id)

		const eventClips = () => store.listClips({ source: "cam" }).filter(c => c.id !== clipId)
		for (let i = 0; i < 100 && !eventClips().length; i++) await sleep(200)
		await src.stop()

		const [event, ...extra] = eventClips()
		assert.ok(event, "the motion event became a clip")
		assert.deepEqual(extra, [])
		const e = await ffprobe(event.path!)
		assert.deepEqual(e.kinds, ["audio", "video"])
		const start = Date.parse(event.recordedAt)
		assert.ok(start <= motionFrom, `clip starts ${start - motionFrom} ms after the motion`)
		assert.ok(start + e.durationMs >= motionTo, `clip ends ${motionTo - start - e.durationMs} ms before the motion did`)
		assert.equal(store.getKv(`pin:${event.id}`), null)

		const saved = store.getClip(clipId)!
		assert.equal(store.getKv(`pin:${clipId}`), "live")
		assert.match(saved.originalName, /^cam_live_\d{8}_\d{6}\.mp4$/)
		const r = await ffprobe(saved.path!)
		const from = Date.parse(saved.recordedAt)
		assert.ok(from <= pressedAt - 10_000, `saved clip starts ${from - (pressedAt - 10_000)} ms after press − 10 s`)
		// segment times come from the wall clock, the duration from the file: allow a frame or two
		assert.ok(from + r.durationMs >= stoppedAt - 100, `saved clip ends ${stoppedAt - from - r.durationMs} ms before the stop`)
		// trimmed to the window, not whole 2 s segments: it starts on the keyframe before press − 10 s
		// (the mock stream has one a second) and ends at the stop, within one GOP: a loaded machine
		// once ended it 316 ms late
		assert.ok(from > pressedAt - 10_000 - 1000 - 100, `saved clip starts ${pressedAt - 10_000 - from} ms before press − 10 s`)
		assert.ok(from + r.durationMs < stoppedAt + 1000, `saved clip ends ${from + r.durationMs - stoppedAt} ms after the stop`)

		const unchecked = join(paths.root, "unchecked")
		assert.ok(existsSync(unchecked) && readdirSync(unchecked).flatMap(d => readdirSync(join(unchecked, d))).length > 0)
		assert.deepEqual(readdirSync(join(paths.partial, "capture-cam")).filter(f => f.endsWith(".mp4")), [])
		// one session for the whole run, handed back at the end
		assert.deepEqual(
			api.requests.map(x => x.cmd).filter(c => c === "Login" || c === "Logout"),
			["Login", "Logout"]
		)
	})

	test("a camera whose sessions are full turns down the motion poller, not the stream: recording and Record go on, and everything counts as motion", async t => {
		// answers every command the way a camera with no free session does
		const logins: string[] = []
		const busy = createHttpServer((req, res) => {
			const cmd = new URL(req.url ?? "/", "http://x").searchParams.get("cmd") ?? ""
			if (cmd === "Login") logins.push(cmd)
			req.resume()
			res.setHeader("content-type", "application/json")
			res.end(JSON.stringify([{ cmd, code: 1, error: { rspCode: -5, detail: "max session" } }]))
		})
		await new Promise<void>(r => busy.listen(0, "127.0.0.1", r))
		t.after(() => new Promise<void>(r => busy.close(() => r())))
		const cfg = ReolinkSource.assert({
			type: "reolink",
			name: "busy",
			host: `127.0.0.1:${(busy.address() as AddressInfo).port}`,
			protocol: "http",
			passwordEnv: PASSWORD_ENV,
			rtspPort: rtsp.port,
			capture: "stream",
			segmentSeconds: 2,
			motionGate: "camera"
		})
		const bus = createBus()
		const src = createReolinkSource(cfg, { store, paths, bus, ingest: input => ingestFile({ store, paths, bus }, input), kick: () => {} }, { motionIntervalMs: 250 })
		src.start()
		t.after(() => src.stop())
		await sleep(6000)

		assert.ok(src.liveRecorder?.(), "Record stays available")
		assert.deepEqual([src.status().state, src.status().detail], ["ok", "Recording the camera's stream · can't read the camera's motion right now, so look4 checks everything"])
		await src.stop()
		assert.equal(logins.length, 1, "no second sign-in before the back-off")
		assert.ok(store.countClips({ source: "busy" }) > 0, "with no motion readings, the footage became a clip")
	})

	describe("look4's own motion watch on the preview stream", () => {
		const MAIN = "/h264Preview_01_main"
		const SUB = "/h264Preview_01_sub"
		const until = async (ok: () => boolean, ms: number, what: string) => {
			const end = Date.now() + ms
			while (!ok()) {
				if (Date.now() > end) assert.fail(`waited ${ms / 1000} s for ${what}`)
				await sleep(100)
			}
		}
		const start = (name: string) => {
			const cfg = ReolinkSource.assert({ type: "reolink", name, host: api.host, protocol: "http", passwordEnv: PASSWORD_ENV, rtspPort: rtsp.port, capture: "stream", segmentSeconds: 2 })
			assert.equal(cfg.motionGate, "both")
			const bus = createBus()
			const src = createReolinkSource(cfg, { store, paths, bus, ingest: input => ingestFile({ store, paths, bus }, input), kick: () => {} }, { motionIntervalMs: 250 })
			src.start()
			return src
		}

		test("opens the preview stream only after the recording's first frame; dropped, it comes back after the 2 s backoff and meanwhile only the camera's motion counts", async t => {
			const src = start("dropped")
			t.after(() => src.stop())
			await until(() => rtsp.viewers(SUB) === 1, 15_000, "the watch to play the preview stream")
			const firstPlay = (path: string) => rtsp.requests.findIndex(r => r.method === "PLAY" && r.path === path)
			assert.ok(firstPlay(MAIN) >= 0 && firstPlay(MAIN) < firstPlay(SUB), "the recorder proved the password first")

			rtsp.drop(SUB)
			const droppedAt = Date.now()
			await until(() => /motion watch isn't running \(ffmpeg exited/.test(src.status().detail), 5000, "the status to say so")
			assert.match(
				src.status().detail,
				/^Recording the camera's stream · look4's motion watch isn't running \(ffmpeg exited: [^)]*\), so only the camera's motion counts · camera saw motion 0 times today$/
			)
			await until(() => rtsp.viewers(SUB) === 1, 10_000, "the watch to come back")
			assert.ok(Date.now() - droppedAt >= 2000, `back after ${Date.now() - droppedAt} ms, inside the backoff`)
		})

		test("a watch whose backoff grew comes back with the recording's next first frame, not after its own wait", async t => {
			const src = start("kicked")
			t.after(() => src.stop())
			await until(() => rtsp.viewers(SUB) === 1, 15_000, "the watch to play the preview stream")
			// two failures in a row: the watch's next wait is 8 s
			for (const wait of [2000, 4000]) {
				rtsp.drop(SUB)
				await until(() => rtsp.viewers(SUB) === 0, 2000, "the drop")
				await until(() => rtsp.viewers(SUB) === 1, wait + 5000, "the watch to come back")
			}
			// the camera goes away and comes back: the recorder retries after its 2 s
			rtsp.drop(SUB)
			rtsp.drop(MAIN)
			const droppedAt = Date.now()
			await until(() => rtsp.viewers(SUB) === 0, 2000, "the drop")
			await until(() => rtsp.viewers(SUB) === 1, 8000, "the watch to come back")
			assert.ok(Date.now() - droppedAt < 7000, `back after ${Date.now() - droppedAt} ms: it sat out its 8 s backoff`)
		})

		test("after a password change, a camera that drops both streams gets one try, the recorder's: the watch waits for its first frame", async t => {
			const src = start("both-dropped")
			t.after(() => src.stop())
			await until(() => rtsp.viewers(SUB) === 1 && rtsp.viewers(MAIN) === 1, 15_000, "both streams to play")
			rtsp.setPassword("changed-on-the-camera")
			t.after(() => rtsp.setPassword(api.password))
			const tries = rtsp.requests.length
			rtsp.drop(SUB)
			rtsp.drop(MAIN)
			await until(() => src.status().detail.startsWith(LOGIN_REFUSED), 10_000, "the refusal")
			// past both 2 s backoffs: the watch's restart, had it gone ahead, would have tried by now
			await sleep(2 * 2000 + 500)
			assert.deepEqual([...new Set(rtsp.requests.slice(tries).filter(r => r.method !== "OPTIONS").map(r => r.path))], [MAIN])
		})

		test("a password changed on the camera refuses the watch's next try: the source stops at once and nothing tries the camera again", async t => {
			const src = start("refused")
			t.after(() => src.stop())
			await until(() => rtsp.viewers(SUB) === 1, 15_000, "the watch to play the preview stream")
			rtsp.setPassword("changed-on-the-camera")
			t.after(() => rtsp.setPassword(api.password))
			rtsp.drop(SUB)

			await until(() => src.status().detail.startsWith(LOGIN_REFUSED), 10_000, "the refusal")
			assert.deepEqual([src.status().state, /the username or password is wrong/.test(src.status().detail)], ["error", true])
			await until(() => rtsp.viewers(MAIN) === 0, 6000, "the recorder to pause")
			assert.equal(src.liveRecorder?.(), null)
			const tries = rtsp.requests.length
			// twice the shortest backoff: a retry of either stream would have come by now
			await sleep(2 * 2000 + 500)
			assert.deepEqual(rtsp.requests.slice(tries), [])
		})
	})
})

describe("POST /api/live/:name/record", () => {
	const noDetector: Detector = {
		status: () => ({ enabled: false, model: "none", ready: true, detail: "off" }),
		warmup: async () => {},
		detectClip: async () => ({ detections: [], frames: new Map() })
	}

	test("a camera whose clips come from its SD card answers 409 with what to change", async () => {
		const config = parseConfig(
			{ dataDir: "data", sources: [{ type: "reolink", name: "yard", host: "192.0.2.1", capture: "sd" }] },
			null,
			join(root, "route")
		)
		const ctx = await createContext(config, { llm: null, detector: noDetector })
		const app = createServer(ctx, { webDist: join(root, "no-dist") }).app
		const res = await app.request("/api/live/yard/record", { method: "POST", body: JSON.stringify({ op: "start" }) })
		assert.equal(res.status, 409)
		assert.deepEqual(await res.json(), {
			error:
				"look4 gets this camera's clips from its SD card, so it isn't recording the live stream. Choose “Live stream” under Clips from in Settings → Sources to save clips from here."
		})
		ctx.store.close()
	})
})
