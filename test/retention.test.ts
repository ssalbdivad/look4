import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { parseConfig } from "../src/config.ts"
import { openStore, type Store } from "../src/db.ts"
import { createBus } from "../src/events.ts"
import { type DataPaths, dataPaths, ensureDataDirs } from "../src/paths.ts"
import { sweep, sweepUnchecked } from "../src/retention.ts"
import type { ClipStatus } from "../src/types.ts"

const root = join(import.meta.dirname, ".tmp", "worker", "retention")
const now = new Date("2026-10-14T12:00:00Z")
const past = "2026-10-13T00:00:00.000Z"
const future = "2026-10-20T00:00:00.000Z"

let store: Store
let paths: DataPaths
let ctx: Parameters<typeof sweep>[0]

before(() => {
	rmSync(root, { recursive: true, force: true })
	paths = dataPaths(root)
	ensureDataDirs(paths)
	store = openStore(paths.db)
	ctx = { store, paths, bus: createBus() }
	store.insertLookout({ id: "lk", name: "cardinal", prompt: "a cardinal", enabled: true, threshold: 0.6, compiled: null })
})
after(() => {
	store.close()
	rmSync(root, { recursive: true, force: true })
})

/** A clip with a 1000-byte file and a 500-byte poster. */
const clip = (id: string, status: ClipStatus, expiresAt: string | null) => {
	const path = join(paths.clips, `${id}.mp4`)
	writeFileSync(path, Buffer.alloc(1000))
	mkdirSync(join(paths.media, id), { recursive: true })
	writeFileSync(join(paths.media, id, "poster.jpg"), Buffer.alloc(500))
	store.insertClip({ id, source: "scan", sourceRef: null, originalName: `${id}.mp4`, path, sizeBytes: 1000, sha256: id, recordedAt: past })
	return store.updateClip(id, { status, expiresAt, media: { poster: "poster.jpg", preview: null, crops: [] } })
}

test("sweep deletes expired clips' files and media but keeps the row; spares labeled, queued and unexpired clips", () => {
	const expired = clip("20261013-000000-aaaaaa", "rejected", past)
	const labeled = clip("20261013-000000-bbbbbb", "rejected", past)
	store.setLabel({ clipId: labeled.id, lookoutId: "lk", truth: true })
	const queued = clip("20261013-000000-cccccc", "pending", past)
	const fresh = clip("20261013-000000-dddddd", "rejected", future)

	assert.deepEqual(sweep(ctx, now), { deleted: 1, freedBytes: 1500 })

	const gone = store.getClip(expired.id)!
	assert.equal(gone.path, null)
	assert.deepEqual(gone.media, { poster: null, preview: null, crops: [] })
	assert.equal(gone.status, "rejected")
	assert.ok(!existsSync(expired.path!) && !existsSync(join(paths.media, expired.id)))

	// a labeled clip is ground truth: it stays and stops expiring
	assert.ok(existsSync(labeled.path!))
	assert.equal(store.getClip(labeled.id)!.expiresAt, null)
	for (const c of [queued, fresh]) {
		assert.ok(existsSync(c.path!), c.id)
		assert.equal(store.getClip(c.id)!.expiresAt, c.expiresAt)
	}

	// nothing left to do on a second pass
	assert.deepEqual(sweep(ctx, now), { deleted: 0, freedBytes: 0 })
})

test("when the disk runs low, unlabeled clips closest to expiry go early, until the floor is met", () => {
	const soon = clip("20261014-000000-eeeeee", "rejected", "2026-10-15T00:00:00.000Z")
	const later = clip("20261014-000000-ffffff", "rejected", "2026-10-19T00:00:00.000Z")
	const labeled = clip("20261014-000000-111111", "rejected", "2026-10-14T13:00:00.000Z")
	store.setLabel({ clipId: labeled.id, lookoutId: "lk", truth: false })
	const kept = clip("20261014-000000-222222", "kept", null)
	// 1 GB short of a 5 GB floor; each deletion "frees" what it would take to get there
	let free = 4e9
	const disk = { freeBytes: () => free }
	const full = { ...ctx, config: parseConfig({ retention: { minFreeGb: 5 } }, null, root) }
	ctx.bus.on("clip", () => (free += 1e9))

	assert.deepEqual(sweep(full, now, disk), { deleted: 1, freedBytes: 1500 })
	assert.equal(store.getClip(soon.id)!.path, null)
	for (const c of [later, labeled, kept]) assert.ok(existsSync(c.path!), c.id)
	assert.equal(store.getClip(labeled.id)!.expiresAt, null)
})

/** Unchecked footage: `name` → age in hours, each file 100 bytes, under `<dir>/<day>/`. */
const footage = (dir: string, ages: Record<string, number>) => {
	rmSync(dir, { recursive: true, force: true })
	mkdirSync(join(dir, "2026-10-14"), { recursive: true })
	for (const [name, hours] of Object.entries(ages)) {
		const path = join(dir, "2026-10-14", name)
		writeFileSync(path, Buffer.alloc(100))
		const at = new Date(now.getTime() - hours * 3600_000)
		utimesSync(path, at, at)
	}
	return () => (existsSync(dir) ? readdirSync(dir).flatMap(d => readdirSync(join(dir, d))).sort() : [])
}

test("unchecked footage goes once older than its days, then oldest first while past its size cap", () => {
	const left = footage(join(root, "unchecked-rules"), { "a.mp4": 72, "b.mp4": 30, "c.mp4": 20, "d.mp4": 1 })
	const r = sweepUnchecked(join(root, "unchecked-rules"), { now: now.getTime(), maxAgeMs: 48 * 3600_000, maxBytes: 250, floorBytes: 0, freeBytes: () => 0 })
	assert.deepEqual(r, { deleted: 2, freedBytes: 200 })
	assert.deepEqual(left(), ["c.mp4", "d.mp4"])
})

test("near the disk floor, unchecked footage goes first, until twice the headroom is free; rejected clips only once it's all gone", () => {
	const soon = clip("20261014-000000-333333", "rejected", "2026-10-14T13:00:00.000Z")
	const left = footage(join(root, "unchecked"), { "a.mp4": 5, "b.mp4": 4, "c.mp4": 3, "d.mp4": 2 })
	// each unchecked file stands for 0.6 GB and the clip for 1 GB; the floor is 5 GB and the headroom 1 GB
	let base = 5.5e9
	let clipsGone = 0
	const disk = { freeBytes: () => base + (4 - left().length) * 0.6e9 + clipsGone * 1e9 }
	const bus = createBus()
	bus.on("clip", () => clipsGone++)
	const full = { ...ctx, bus, config: parseConfig({ retention: { minFreeGb: 5 } }, null, root) }

	// above the floor, inside the headroom: 5.5 → 7.3 GB, three files, and no clip
	assert.deepEqual(sweep(full, now, disk), { deleted: 0, freedBytes: 0 })
	assert.deepEqual(left(), ["d.mp4"])
	assert.ok(existsSync(soon.path!))

	// below the floor with too little unchecked footage to climb out of it: the clip goes too
	base = 2e9
	assert.deepEqual(sweep(full, now, disk), { deleted: 1, freedBytes: 1500 })
	assert.deepEqual(left(), [])
	assert.equal(store.getClip(soon.id)!.path, null)
})
