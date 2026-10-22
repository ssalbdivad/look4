import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { after, before, describe, test } from "node:test"
import { parseConfig } from "../src/config.ts"
import { openStore, type Store } from "../src/db.ts"
import { createBus } from "../src/events.ts"
import { backfill, createLookout, deleteLookout, LookoutError, type LookoutCtx, NO_LOOKOUTS, redecided, updateLookout } from "../src/lookouts.ts"
import { dataPaths } from "../src/paths.ts"
import { promptHash } from "../src/pipeline/compile.ts"
import { isRetryable, redecideClips } from "../src/pipeline/process.ts"

const root = join(import.meta.dirname, ".tmp", "worker", "lookouts")
let store: Store
let compiles = 0

const ctx = (): LookoutCtx => ({
	store,
	paths: dataPaths(root),
	config: parseConfig({}, null, root),
	bus: createBus(),
	kick: () => {},
	compile: async prompt => {
		compiles++
		return { queries: ["bird"], rubric: prompt, summary: "Hawk Watch", fineGrained: true, promptHash: promptHash(prompt), compiler: "test" }
	}
})

before(() => {
	rmSync(root, { recursive: true, force: true })
	mkdirSync(root, { recursive: true })
	store = openStore(join(root, "look4.db"))
})
after(() => store.close())

const rejects409 = (p: Promise<unknown>, name: string) =>
	assert.rejects(p, (e: unknown) => e instanceof LookoutError && e.status === 409 && e.message === `a lookout named "${name}" already exists`)

test("a typed name that is taken is refused with 409 before any compile; a generated one gets a suffix", async () => {
	const first = await createLookout(ctx(), { prompt: "a hawk", name: "Hawk Watch" })
	assert.equal(first.name, "hawk-watch")
	const before = compiles
	await rejects409(createLookout(ctx(), { prompt: "a cooper's hawk", name: "hawk watch" }), "hawk-watch")
	assert.equal(compiles, before)
	// no name given: the summary's slug is taken, so it is made unique instead
	assert.equal((await createLookout(ctx(), { prompt: "any hawk" })).name, "hawk-watch-2")
	// renaming onto another lookout's name is refused the same way; keeping its own name is fine
	await rejects409(updateLookout(ctx(), "hawk-watch-2", { name: "Hawk Watch" }), "hawk-watch")
	assert.equal((await updateLookout(ctx(), "hawk-watch-2", { name: "hawk-watch-2" })).name, "hawk-watch-2")
})

test("clips that arrived while nothing was on watch are queued again once a lookout is on", async () => {
	const clip = (id: string, reason: string, file = true) => {
		const path = join(root, `${id}.mp4`)
		if (file) writeFileSync(path, "x")
		store.insertClip({ id, source: "cam", sourceRef: null, originalName: `${id}.mp4`, path, sizeBytes: 1, sha256: id, recordedAt: "2026-10-14T10:00:00.000Z" })
		store.updateClip(id, { status: "rejected", droppedAt: "detect", reason })
	}
	clip("unwatched", NO_LOOKOUTS)
	clip("gone", NO_LOOKOUTS, false)
	clip("judged", "no bird in view")
	const status = (id: string) => store.getClip(id)!.status

	// a lookout created switched off changes nothing
	const off = await createLookout(ctx(), { prompt: "a jay", enabled: false })
	assert.equal(status("unwatched"), "rejected")

	await updateLookout(ctx(), off.id, { enabled: true })
	assert.deepEqual(["unwatched", "gone", "judged"].map(status), ["pending", "rejected", "rejected"])
	assert.equal(store.getClip("unwatched")!.pendingLookouts, null)
})

describe("decisions follow the lookout", () => {
	let seq = 0
	/** A judged clip with a real file under clips/ or kept/ and one verdict. */
	const judged = (lookoutId: string, status: "kept" | "rejected", confidence: number) => {
		const id = `20261014-1300${String(++seq).padStart(2, "0")}-abcdef`
		const p = dataPaths(root)
		const path = join(status === "kept" ? p.kept : p.clips, "2026-10-14", `${id}.mp4`)
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(path, "x")
		store.insertClip({ id, source: "cam", sourceRef: null, originalName: `${id}.mp4`, path, sizeBytes: 1, sha256: id, recordedAt: "2026-10-14T13:00:00.000Z" })
		store.updateClip(id, { status, droppedAt: status === "kept" ? null : "judge", expiresAt: status === "kept" ? null : "2026-10-21T13:00:00.000Z" })
		store.upsertVerdict({ clipId: id, lookoutId, match: true, confidence, label: "Northern Cardinal", rationale: "Red.", model: "m", createdAt: "2026-10-14T13:00:00.000Z" })
		return id
	}
	const fresh = async (name: string) => createLookout(ctx(), { prompt: `a ${name}`, name, threshold: 0.6 })

	test("moving the threshold re-decides clips already judged: near-misses become sightings, lost ones expire", async () => {
		const l = await fresh("thresh-cardinal")
		const near = judged(l.id, "rejected", 0.55)
		const strong = judged(l.id, "kept", 0.7)

		await updateLookout(ctx(), l.id, { threshold: 0.5 })
		const kept = store.getClip(near)!
		assert.equal(kept.status, "kept")
		assert.equal(kept.expiresAt, null)
		assert.equal(kept.path, join(dataPaths(root).kept, "2026-10-14", `${near}.mp4`))
		assert.ok(existsSync(kept.path!))
		assert.deepEqual(store.listSightings({ lookoutId: l.id }).map(s => s.clip.id).sort(), [near, strong].sort())

		await updateLookout(ctx(), l.id, { threshold: 0.8 })
		for (const id of [near, strong]) {
			const c = store.getClip(id)!
			assert.equal(c.status, "rejected", id)
			assert.equal(c.droppedAt, "judge")
			assert.equal(c.path, join(dataPaths(root).clips, "2026-10-14", `${id}.mp4`))
			assert.ok(c.expiresAt && Date.parse(c.expiresAt) > Date.now())
		}
		await redecided(ctx())
	})

	test("what lands while a re-decision moves a file wins: a backfill stays queued, a delete costs the batch nothing", async () => {
		const l = await fresh("race-cardinal")
		const hawk = await fresh("race-hawk")
		await updateLookout(ctx(), l.id, { threshold: 0.5 })
		// each lands at the re-decision's first await, the file move, as a request handled meanwhile would
		const queued = judged(l.id, "rejected", 0.55)
		const first = redecideClips(ctx(), [queued])
		backfill(ctx(), hawk.id)
		await (await first).previews()
		const c = store.getClip(queued)!
		assert.deepEqual([c.status, c.pendingLookouts], ["pending", [hawk.id]])

		const deleted = judged(l.id, "rejected", 0.55)
		const next = judged(l.id, "rejected", 0.56)
		const second = redecideClips(ctx(), [deleted, next])
		rmSync(store.getClip(deleted)!.path!)
		store.deleteClip(deleted)
		const r = await second
		await r.previews()
		assert.equal(r.kept, 1)
		assert.deepEqual([store.getClip(next)!.status, store.getClip(next)!.path], ["kept", join(dataPaths(root).kept, "2026-10-14", `${next}.mp4`)])
	})

	test("a sighting whose judge retry is still due is left to that retry, not rejected out from under it", async () => {
		const l = await fresh("retry-cardinal")
		const hawk = await fresh("retry-hawk")
		const id = judged(l.id, "kept", 0.65)
		// what processClip records for a hawk backfill whose judge call timed out
		store.updateClip(id, {
			reason: "kept: Northern Cardinal (0.65) for retry-cardinal · re-check failed at judge: Claude Code timed out after 120s",
			error: "Claude Code timed out after 120s",
			pendingLookouts: [hawk.id]
		})
		await updateLookout(ctx(), l.id, { threshold: 0.7 })
		const c = store.getClip(id)!
		assert.deepEqual([c.status, c.pendingLookouts, isRetryable(c)], ["kept", [hawk.id], true])
	})

	test("a second slider save is not held up by the previews the first one is encoding", async () => {
		const l = await fresh("slider-cardinal")
		const video = join(root, "slider.mp4")
		execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=1280x720:d=4:r=25",
			"-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", video])
		const ids = [0.55, 0.55, 0.55].map(c => judged(l.id, "rejected", c))
		for (const id of ids) copyFileSync(video, store.getClip(id)!.path!)
		const previews = () => ids.filter(id => existsSync(join(dataPaths(root).media, id, "preview.mp4"))).length

		await updateLookout(ctx(), l.id, { threshold: 0.5 })
		// one notch over: re-decides nothing, so it has nothing to wait for
		await updateLookout(ctx(), l.id, { threshold: 0.52 })
		assert.ok(previews() < ids.length, "the second save waited for every preview")
		await redecided(ctx())
		assert.equal(previews(), ids.length)
		assert.deepEqual(ids.map(id => store.getClip(id)!.media.preview), ["preview.mp4", "preview.mp4", "preview.mp4"])
	})

	test("a backfill keeps sightings in the feed while they wait in the queue; 'not this' takes one out", async () => {
		const l = await fresh("feed-cardinal")
		const a = judged(l.id, "kept", 0.9)
		const b = judged(l.id, "kept", 0.8)
		await createLookout(ctx(), { prompt: "a feed hawk", name: "feed-hawk" }).then(h => backfill(ctx(), h.id))
		assert.equal(store.getClip(a)!.status, "pending")
		assert.deepEqual(store.listSightings({ lookoutId: l.id }).map(s => s.clip.id).sort(), [a, b].sort())

		store.setLabel({ clipId: b, lookoutId: l.id, truth: false })
		assert.deepEqual(store.listSightings({ lookoutId: l.id }).map(s => s.clip.id), [a])
	})

	test("deleting a lookout spares the clips someone labeled for it from retention", async () => {
		const l = await fresh("doomed")
		const labeled = judged(l.id, "kept", 0.9)
		const plain = judged(l.id, "kept", 0.9)
		store.setLabel({ clipId: labeled, lookoutId: l.id, truth: true })
		deleteLookout(ctx(), l.id)
		assert.deepEqual(
			[labeled, plain].map(id => [store.getClip(id)!.status, store.getClip(id)!.expiresAt === null]),
			[["rejected", true], ["rejected", false]]
		)
	})
})
