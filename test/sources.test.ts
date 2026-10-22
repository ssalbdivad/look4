import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, before, describe, test } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"
import { RtspSource, WatchSource } from "../src/config.ts"
import { openStore, type Store } from "../src/db.ts"
import { createBus } from "../src/events.ts"
import { ingestFile } from "../src/ingest.ts"
import { type DataPaths, dataPaths, ensureDataDirs } from "../src/paths.ts"
import { createInboxSource, createSource, type SourceContext } from "../src/sources/index.ts"
import { createRtspSource } from "../src/sources/rtsp.ts"
import { createDirSource } from "../src/sources/watch.ts"
import type { SourceStatus } from "../src/types.ts"

const root = join(import.meta.dirname, ".tmp", "sources", "adapters")
let store: Store
let paths: DataPaths
const bus = createBus()
const statuses: SourceStatus[] = []
bus.on("source", s => statuses.push(s))

const ctx = (): SourceContext => ({
	store,
	paths,
	bus,
	ingest: input => ingestFile({ store, paths, bus }, input),
	kick: () => {},
	rootDir: root
})

before(() => {
	rmSync(root, { recursive: true, force: true })
	paths = dataPaths(join(root, "data"))
	ensureDataDirs(paths)
	store = openStore(paths.db)
})
after(() => store.close())

describe("watch", () => {
	test("a growing file is ingested only once it holds still, then never again", async () => {
		const dir = join(root, "ftp")
		mkdirSync(join(dir, "2026", "10"), { recursive: true })
		const cfg = WatchSource.assert({ type: "watch", name: "ftp", dir: "ftp", stableSeconds: 0.3 })
		const src = createSource(cfg, ctx())
		const file = join(dir, "2026", "10", "Feeder_00_20261014093012.mp4")
		const count = () => store.countClips({ source: "ftp" })

		writeFileSync(file, randomBytes(2048))
		writeFileSync(join(dir, "notes.txt"), "not a video")
		await src.pollNow()
		appendFileSync(file, randomBytes(2048))
		await src.pollNow()
		await sleep(150)
		await src.pollNow()
		assert.equal(count(), 0)

		await sleep(350)
		await src.pollNow()
		assert.equal(count(), 1)
		const [clip] = store.listClips({ source: "ftp" })
		assert.equal(clip!.sizeBytes, 4096)
		assert.match(clip!.sourceRef!, /^2026\/10\/Feeder_00_20261014093012\.mp4\|4096\|\d+$/)
		assert.ok(existsSync(file), "copy mode leaves the original")

		await sleep(350)
		await src.pollNow()
		assert.equal(count(), 1)
		assert.equal(src.status().state, "ok")
		await src.stop()
	})

	test("a missing directory is an error status, not a crash", async () => {
		const cfg = WatchSource.assert({ type: "watch", name: "gone", dir: join(root, "nope") })
		const src = createSource(cfg, ctx())
		await src.pollNow()
		assert.equal(src.status().state, "error")
		assert.match(src.status().detail, /^cannot read .*nope: not found/)
	})
})

describe("inbox", () => {
	test("moves settled videos in and leaves .partial alone", async () => {
		const inbox = createInboxSource(ctx())
		writeFileSync(join(paths.partial, "half.mp4"), randomBytes(2048))
		const dropped = join(paths.inbox, "RecM07_20261013_070000_070030_6D28808_1.mp4")
		writeFileSync(dropped, randomBytes(2048))
		await inbox.pollNow()
		assert.ok(existsSync(dropped), "not taken on first sight")
		await sleep(2100)
		await inbox.pollNow()
		assert.equal(existsSync(dropped), false)
		assert.ok(existsSync(join(paths.partial, "half.mp4")))
		const [clip] = store.listClips({ source: "inbox" })
		assert.equal(clip?.originalName, "RecM07_20261013_070000_070030_6D28808_1.mp4")
		assert.equal(inbox.status().clipsIngested, 1)
		assert.equal(statuses.filter(s => s.name === "inbox").at(-1)?.clipsIngested, 1)
	})

	test("a file refused for a nearly full disk is not given up on: it is taken once space frees up", async () => {
		const dir = join(root, "drop")
		mkdirSync(dir, { recursive: true })
		let free = 10
		const src = createDirSource(
			{ ...ctx(), ingest: input => ingestFile({ store, paths, bus, minFreeBytes: () => 1000, freeBytes: () => free }, input) },
			{ name: "drop", type: "watch", dir, extensions: [".mp4"], pollMs: 60_000, stableMs: 0, move: false, trackRefs: true, idleDetail: "drop" }
		)
		const file = join(dir, "feeder_20261014_093012.mp4")
		writeFileSync(file, randomBytes(2048))
		utimesSync(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
		// more polls than the attempts a broken file gets
		for (let i = 0; i < 4; i++) await src.pollNow()
		assert.deepEqual(
			[src.status().state, src.status().detail],
			["error", "disk nearly full: 0.0 GB free, and look4 stops taking clips below 0.0 GB (retention.minFreeGb), taking files paused · drop"]
		)
		assert.equal(store.countClips({ source: "drop" }), 0)

		free = 1e12
		await src.pollNow()
		assert.equal(store.countClips({ source: "drop" }), 1)
		assert.deepEqual([src.status().state, src.status().detail], ["ok", "drop"])
		await src.stop()
	})
})

describe("rtsp", () => {
	const ffmpeg = (() => {
		try {
			execFileSync("ffmpeg", ["-version"], { stdio: "ignore" })
			return true
		} catch {
			return false
		}
	})()

	test("never puts the stream password in its status", { skip: !ffmpeg && "ffmpeg not installed" }, async () => {
		// a closed port: ffmpeg fails at once and echoes the URL in its error
		const cfg = RtspSource.assert({ type: "rtsp", name: "porch", url: "rtsp://admin:s3cretpw@127.0.0.1:9/h264Preview_01_sub" })
		const src = createSource(cfg, ctx())
		src.start()
		for (let i = 0; i < 50 && src.status().state !== "error"; i++) await sleep(100)
		await src.stop()
		const seen = statuses.filter(s => s.name === "porch").map(s => s.detail)
		assert.ok(seen.some(d => d.startsWith("ffmpeg exited:")), seen.join("\n"))
		assert.ok(seen.some(d => d.includes("rtsp://***@127.0.0.1:9")), seen.join("\n"))
		assert.equal(seen.filter(d => d.includes("s3cretpw")).length, 0)
	})

	test("cuts a stream into segments and ingests each finished one", { skip: !ffmpeg && "ffmpeg not installed" }, async () => {
		// any ffmpeg-readable URL works; a local file stands in for a camera
		const input = join(root, "stream.mp4")
		execFileSync("ffmpeg", [
			"-hide_banner", "-loglevel", "error", "-y",
			"-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=12",
			"-c:v", "libx264", "-g", "10", "-pix_fmt", "yuv420p", input
		])
		const cfg = RtspSource.assert({ type: "rtsp", name: "lane", url: input, segmentSeconds: 5 })
		// a file plays faster than real time, so there's no Live recording to hold footage back for
		const src = createRtspSource(cfg, ctx(), { holdMs: 0 })
		src.start()
		for (let i = 0; i < 50 && store.countClips({ source: "lane" }) < 3; i++) await sleep(100)
		await src.stop()
		const clips = store.listClips({ source: "lane" })
		assert.equal(clips.length, 3)
		assert.ok(clips.every(c => /^lane_\d{8}_\d{6}\.mp4$/.test(c.originalName)))
		assert.deepEqual(readdirSync(join(paths.partial, "rtsp-lane")), [])
	})
})
