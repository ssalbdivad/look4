import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, before, describe, test } from "node:test"
import { openStore, type Store } from "../src/db.ts"
import { createBus } from "../src/events.ts"
import { DiskFullError, ingestFile, parseRecordedAt } from "../src/ingest.ts"
import { type DataPaths, dataPaths, ensureDataDirs } from "../src/paths.ts"

const local = (y: number, mo: number, d: number, h: number, mi: number, s: number) => new Date(y, mo - 1, d, h, mi, s).toISOString()

describe("parseRecordedAt", () => {
	const at = local(2026, 10, 14, 9, 30, 12)

	test("reads every camera naming scheme as local time", () => {
		const names = [
			"RecM07_20261014_093012_093042_6D28808_1E2F3A.mp4",
			"Mp4Record/2026-10-14/RecS07_20261014_093012_093042_6D28808_1E2F3A.mp4",
			"RecM07_DST20261014_093012_093042_6D28808_1E2F3A.mp4",
			"Feeder_00_20261014093012.mp4",
			"backyard_20261014_093012.mkv",
			"20261014093012.mp4",
			"2026-10-14_09-30-12.mov",
			"clip 2026-10-14T09:30:12.mp4",
			// our own clip ids, so re-imported exports keep their time
			"20261014-093012-a1b2c3.mp4"
		]
		assert.deepEqual(
			names.map(n => [n, parseRecordedAt(n)]),
			names.map(n => [n, at])
		)
	})

	test("honors an explicit zone on an ISO stamp only", () => {
		assert.equal(parseRecordedAt("cam-2026-10-14T09:30:12Z.mp4"), "2026-10-14T09:30:12.000Z")
		// `-0700` after a non-ISO stamp is just more name
		assert.equal(parseRecordedAt("20261014_093012-0700.mp4"), at)
	})

	test("rejects impossible dates and stamps buried in longer digit runs", () => {
		assert.equal(parseRecordedAt("RecM07_20260230_093012_093042.mp4"), null)
		assert.equal(parseRecordedAt("20261014_253012.mp4"), null)
		assert.equal(parseRecordedAt("9920261014093012.mp4"), null)
		assert.equal(parseRecordedAt("IMG_1234.MOV"), null)
	})

	test("skips an impossible stamp to find a real one later in the name", () => {
		assert.equal(parseRecordedAt("20261399_000000_then_20261014_093012.mp4"), at)
	})
})

describe("ingestFile", () => {
	const root = join(import.meta.dirname, ".tmp", "sources", "ingest")
	let store: Store
	let paths: DataPaths
	const bus = createBus()
	const events: string[] = []
	bus.on("clip", e => events.push(`clip:${e.status}`))
	bus.on("queue", e => events.push(`queue:${e.pending}`))
	const ctx = () => ({ store, paths, bus })

	before(() => {
		rmSync(root, { recursive: true, force: true })
		paths = dataPaths(join(root, "data"))
		ensureDataDirs(paths)
		store = openStore(paths.db)
	})
	after(() => store.close())

	const video = (name: string, bytes = randomBytes(4096)) => {
		const dir = join(root, "in")
		mkdirSync(dir, { recursive: true })
		const p = join(dir, name)
		writeFileSync(p, bytes)
		return p
	}

	test("copy keeps the original; the same bytes again are a duplicate, and in move mode the redundant input is deleted", async () => {
		events.length = 0
		const bytes = randomBytes(4096)
		const src = video("RecM07_20261014_093012_093042_6D28808_1E2F3A.MP4", bytes)
		const first = await ingestFile(ctx(), { file: src, source: "cam", mode: "copy" })
		const { clip } = first

		assert.equal(first.duplicate, false)
		assert.match(clip.id, /^20261014-093012-[0-9a-f]{6}$/)
		assert.equal(clip.id.slice(-6), clip.sha256.slice(0, 6))
		assert.equal(clip.path, join(paths.clips, "2026-10-14", `${clip.id}.mp4`))
		assert.deepEqual(readFileSync(clip.path!), bytes)
		assert.equal(clip.recordedAt, local(2026, 10, 14, 9, 30, 12))
		assert.equal(clip.status, "pending")
		assert.ok(existsSync(src))
		assert.deepEqual(events, ["clip:pending", "queue:1"])

		const again = video("renamed.mp4", bytes)
		const second = await ingestFile(ctx(), { file: again, source: "inbox", mode: "move" })
		assert.equal(second.duplicate, true)
		assert.equal(second.clip.id, clip.id)
		assert.equal(existsSync(again), false)
		assert.equal(store.countClips(), 1)
	})

	test("move takes the file; with no stamp in the name, recordedAt is the file mtime", async () => {
		const src = video("backyard.webm")
		const mtime = new Date(2026, 6, 4, 18, 0, 5)
		utimesSync(src, mtime, mtime)
		const { clip } = await ingestFile(ctx(), { file: src, source: "inbox", mode: "move" })
		assert.equal(existsSync(src), false)
		assert.equal(clip.recordedAt, mtime.toISOString())
		assert.equal(clip.path, join(paths.clips, "2026-07-04", `${clip.id}.webm`))
		assert.ok(existsSync(clip.path!))
	})

	test("a name that is not a video keeps no extension of its own: the clip is stored as .mp4", async () => {
		const src = video("upload-1.tmp")
		const { clip } = await ingestFile(ctx(), { file: src, source: "upload", originalName: "20261012_070000 page.html", mode: "move" })
		assert.equal(clip.originalName, "20261012_070000 page.html")
		assert.equal(clip.path, join(paths.clips, "2026-10-12", `${clip.id}.mp4`))
	})

	test("dropping the same bytes again after retention deleted the file re-attaches them instead of deleting the drop", async () => {
		const bytes = randomBytes(4096)
		const { clip } = await ingestFile(ctx(), { file: video("RecM07_20261013_080000_080030_6D28808_1E2F3A.mp4", bytes), source: "cam", mode: "copy" })
		// what retention leaves behind
		rmSync(clip.path!)
		store.updateClip(clip.id, { path: null, status: "rejected", droppedAt: "judge", reason: "judge: a sparrow (0.80)", expiresAt: "2026-10-13T00:00:00.000Z" })

		const dropped = video("again.mp4", bytes)
		const r = await ingestFile(ctx(), { file: dropped, source: "inbox", mode: "move" })
		assert.equal(r.duplicate, false)
		assert.equal(r.clip.id, clip.id)
		assert.equal(r.clip.path, clip.path)
		assert.deepEqual(readFileSync(r.clip.path!), bytes)
		assert.deepEqual([r.clip.status, r.clip.reason, r.clip.expiresAt], ["pending", null, null])
		assert.equal(existsSync(dropped), false)
	})

	test("below the free-space floor a clip is refused and the input is left where it was", async () => {
		const src = video("full.mp4")
		const tight = { ...ctx(), minFreeBytes: () => 5e9, freeBytes: () => 4.2e9 }
		await assert.rejects(ingestFile(tight, { file: src, source: "inbox", mode: "move" }), (e: unknown) =>
			e instanceof DiskFullError && e.message === "disk nearly full: 4.2 GB free, and look4 stops taking clips below 5.0 GB (retention.minFreeGb)"
		)
		assert.ok(existsSync(src))
	})

	test("a file moved within the data disk is not counted against the floor twice; a copy's new bytes are", async () => {
		// 4096 bytes fit above the floor, with 500 to spare, once they are on the disk
		const tight = { ...ctx(), minFreeBytes: () => 10_000, freeBytes: () => 10_500 }
		const copied = video("copied.mp4")
		await assert.rejects(ingestFile(tight, { file: copied, source: "upload", mode: "copy" }), DiskFullError)
		// already on the data disk (a download in data/.partial): the move adds no bytes
		const partial = join(paths.partial, "downloaded.mp4")
		writeFileSync(partial, randomBytes(4096))
		const r = await ingestFile(tight, { file: partial, source: "cam", mode: "move" })
		assert.deepEqual([r.duplicate, existsSync(r.clip.path!), existsSync(partial)], [false, true, false])
	})

	test("concurrent ingests of the same bytes store one clip", async () => {
		const bytes = randomBytes(8192)
		const files = [video("a.mp4", bytes), video("b.mp4", bytes), video("c.mp4", bytes)]
		const before = store.countClips()
		const results = await Promise.all(files.map(file => ingestFile(ctx(), { file, source: "upload", mode: "copy", recordedAt: local(2026, 10, 1, 7, 0, 0) })))
		assert.deepEqual(results.map(r => r.duplicate).sort(), [false, true, true])
		assert.equal(new Set(results.map(r => r.clip.id)).size, 1)
		assert.equal(store.countClips(), before + 1)
	})
})
