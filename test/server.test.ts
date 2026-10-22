import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { type AddressInfo, createServer as createNetServer } from "node:net"
import { hostname } from "node:os"
import { join, resolve } from "node:path"
import { after, before, beforeEach, describe, test } from "node:test"
import type {
	ApiError,
	ClipDetail,
	ClipSummary,
	ConfirmClipResponse,
	LifeListResponse,
	LookoutDto,
	Page,
	SettingsDto,
	StatsResponse,
	UploadResponse
} from "../src/api-types.ts"
import { loadConfig, parseConfig, type LoadedConfig } from "../src/config.ts"
import type { AppContext } from "../src/context.ts"
import { DETECTOR_ONLY, openStore, type Store } from "../src/db.ts"
import { createBus } from "../src/events.ts"
import { ingestFile } from "../src/ingest.ts"
import { clipMediaDir, dataPaths, ensureDataDirs } from "../src/paths.ts"
import { freeBytes } from "../src/retention.ts"
import type { Clip } from "../src/types.ts"
import { createServer } from "../src/server/index.ts"

const root = resolve(import.meta.dirname, ".tmp/server")

type Fixture = { ctx: AppContext; store: Store; app: ReturnType<typeof createServer>["app"]; dir: string }

let n = 0
const setup = (raw: Record<string, unknown> = {}, webDist?: string): Fixture => {
	const dir = join(root, `case-${process.pid}-${n++}`)
	mkdirSync(dir, { recursive: true })
	let config: LoadedConfig = parseConfig({ dataDir: "data", ...raw }, null, dir)
	const paths = dataPaths(config.dataDir)
	ensureDataDirs(paths)
	const store = openStore(paths.db)
	const bus = createBus()
	const ctx: AppContext = {
		get config() {
			return config
		},
		paths,
		store,
		bus,
		llm: null,
		judge: { provider: "none", detail: "judge is off" },
		detector: {
			status: () => ({ enabled: false, model: "none", ready: true, detail: "off" }),
			warmup: async () => {},
			detectClip: async () => ({ detections: [], frames: new Map() })
		},
		ingest: input => ingestFile({ store, paths, bus }, input),
		compile: async prompt => ({ queries: ["bird"], rubric: prompt, summary: prompt, fineGrained: false, promptHash: "h", compiler: "manual" }),
		kick: () => {},
		sourceStatuses: () => [],
		pollSource: async name => {
			throw new Error(`no source ${name}`)
		},
		reloadConfig: () => (config = loadConfig(join(dir, "look4.config.json"))),
		applySources: async () => {},
		reloadJudge: async () => {},
		liveRecorder: () => null,
		isRecording: () => false
	}
	return { ctx, store, app: createServer(ctx, { webDist: webDist ?? join(dir, "no-dist") }).app, dir }
}

const addClip = (f: Fixture, id: string, recordedAt: string, patch: Partial<Clip> = {}, bytes = Buffer.from("x")) => {
	const path = join(f.dir, `${id}.mp4`)
	writeFileSync(path, bytes)
	f.store.insertClip({ id, source: "test", sourceRef: null, originalName: `${id}.mp4`, path, sizeBytes: bytes.length, sha256: id, recordedAt })
	return f.store.updateClip(id, patch)
}

const addLookout = (f: Fixture, id: string, threshold = 0.6) =>
	f.store.insertLookout({ id, name: id, prompt: `a ${id}`, enabled: true, threshold, compiled: null })

const keep = (f: Fixture, clipId: string, lookoutId: string, confidence = 0.9) =>
	f.store.upsertVerdict({ clipId, lookoutId, match: true, confidence, label: "Northern Cardinal", rationale: "red", model: "mock", createdAt: new Date().toISOString() })

const post = (body: unknown, headers: Record<string, string> = {}) => ({
	method: "POST",
	body: JSON.stringify(body),
	headers: { "Content-Type": "application/json", ...headers }
})

before(() => rmSync(root, { recursive: true, force: true }))
after(() => rmSync(root, { recursive: true, force: true }))

describe("media", () => {
	const id = "20261014-153012-a1b2c3"
	let f: Fixture
	const bytes = Buffer.from(Array.from({ length: 100 }, (_, i) => i))
	beforeEach(() => {
		f = setup()
		addClip(f, id, "2026-10-14T15:30:12.000Z", { media: { poster: "poster.jpg", preview: null, crops: [] } }, bytes)
		mkdirSync(clipMediaDir(f.ctx.paths, id), { recursive: true })
		writeFileSync(join(clipMediaDir(f.ctx.paths, id), "poster.jpg"), "jpeg")
		writeFileSync(join(f.ctx.paths.media, "secret.txt"), "secret")
	})

	test("only allow-listed files of a well-formed clip id are served", async () => {
		assert.equal((await f.app.request(`/media/${id}/poster.jpg`)).status, 200)
		for (const path of [
			`/media/${id}/..%2Fsecret.txt`,
			`/media/${id}/%2e%2e%2f%2e%2e%2flook4.db`,
			`/media/${id}/secret.txt`,
			`/media/..%2F${id}/poster.jpg`,
			"/media/20261014-153012-XYZ123/poster.jpg",
			"/media/20261014-153012-a1b2c3d/poster.jpg"
		]) {
			const res = await f.app.request(path)
			assert.equal(res.status, 404, path)
			assert.doesNotMatch(await res.text(), /secret/, path)
		}
	})

	test("Range answers 206 with exactly the requested bytes; out of range is 416", async () => {
		const res = await f.app.request(`/media/${id}/original`, { headers: { Range: "bytes=10-19" } })
		assert.equal(res.status, 206)
		assert.equal(res.headers.get("content-range"), "bytes 10-19/100")
		assert.equal(res.headers.get("content-type"), "video/mp4")
		assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes.subarray(10, 20))

		const tail = await f.app.request(`/media/${id}/original`, { headers: { Range: "bytes=-5" } })
		assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(95))

		const bad = await f.app.request(`/media/${id}/original`, { headers: { Range: "bytes=100-" } })
		assert.equal(bad.status, 416)
		assert.equal(bad.headers.get("content-range"), "bytes */100")
	})

	test("an original is only ever served as a video or as bytes, sandboxed, under its real (non-Latin) name", async () => {
		const page = "20261014-160000-0d0d0d"
		addClip(f, page, "2026-10-14T16:00:00.000Z", { originalName: "RecM07_x.html" })
		f.store.db.prepare("UPDATE clips SET path = ? WHERE id = ?").run(join(f.dir, "x.html"), page)
		writeFileSync(join(f.dir, "x.html"), "<script>fetch('/api/settings')</script>")
		const html = await f.app.request(`/media/${page}/original`)
		assert.equal(html.status, 200)
		assert.deepEqual(
			[html.headers.get("content-type"), html.headers.get("x-content-type-options"), html.headers.get("content-security-policy")],
			["application/octet-stream", "nosniff", "sandbox; default-src 'none'"]
		)

		const bird = "20261014-160100-0e0e0e"
		addClip(f, bird, "2026-10-14T16:01:00.000Z", { originalName: "鳥の動画 — Mrs. Met's (1).mp4" })
		const res = await f.app.request(`/media/${bird}/original`)
		assert.equal(res.status, 200)
		assert.equal(
			res.headers.get("content-disposition"),
			`inline; filename="____ _ Mrs. Met's (1).mp4"; filename*=UTF-8''%E9%B3%A5%E3%81%AE%E5%8B%95%E7%94%BB%20%E2%80%94%20Mrs.%20Met%27s%20%281%29.mp4`
		)
	})

	test("the zone snapshot is an empty 204, not an error, with no clip or only unreadable ones on disk", async () => {
		// a 4xx here would log a console error on every Settings visit of a fresh install
		for (const app of [setup().app, f.app]) {
			const res = await app.request("/api/snapshot")
			assert.deepEqual([res.status, await res.text()], [204, ""])
		}
	})

	test("static files cannot escape web/dist, and unknown routes fall back to index.html", async () => {
		const dist = join(root, `dist-${process.pid}`)
		mkdirSync(dist, { recursive: true })
		writeFileSync(join(dist, "index.html"), "<html>app</html>")
		writeFileSync(join(root, `outside-${process.pid}.txt`), "secret")
		const g = setup({}, dist)
		const escape = await g.app.request(`/..%2Foutside-${process.pid}.txt`)
		assert.equal(escape.status, 404)
		assert.equal(await (await g.app.request("/lookouts/cardinal")).text(), "<html>app</html>")
	})
})

describe("request guards", () => {
	test("a foreign Host is refused, even when bound to every interface for LAN access", async () => {
		const res = await setup().app.request("http://rebind.attacker.example/api/settings")
		assert.equal(res.status, 403)
		assert.match(((await res.json()) as ApiError).error, /not allowed/)
		assert.equal((await setup().app.request("http://127.0.0.1:4040/api/settings")).status, 200)
		// DNS rebinding only works through a name the attacker owns; a phone uses the IP or this machine's name
		const open = setup({ server: { host: "0.0.0.0" } })
		const status = async (host: string) => (await open.app.request(`http://${host}:4040/api/settings`)).status
		assert.deepEqual(
			[await status("rebind.attacker.example"), await status("192.168.1.20"), await status("[fe80::1]"), await status(`${hostname()}.local`)],
			[403, 200, 200, 200]
		)
	})

	test("a cross-origin write is refused; same-origin passes", async () => {
		const f = setup()
		addLookout(f, "cardinal")
		const evil = await f.app.request("http://localhost:4040/api/lookouts/cardinal", {
			method: "DELETE",
			headers: { Origin: "http://evil.example" }
		})
		assert.equal(evil.status, 403)
		assert.ok(f.store.getLookout("cardinal"))
		const ok = await f.app.request("http://localhost:4040/api/lookouts/cardinal", {
			method: "DELETE",
			headers: { Origin: "http://localhost:4040" }
		})
		assert.equal(ok.status, 200)
		assert.equal(f.store.getLookout("cardinal"), null)
	})

	test("JSON bodies over 1 MB are refused", async () => {
		const res = await setup().app.request("/api/lookouts/preview", post({ prompt: "x".repeat(1_100_000) }))
		assert.equal(res.status, 413)
	})
})

describe("settings", () => {
	test("GET never reveals a password or rtsp credentials", async () => {
		process.env.TEST_CAM_PW = "hunter2-env"
		const f = setup({
			sources: [
				{ type: "reolink", name: "feeder", host: "192.168.1.50", passwordEnv: "TEST_CAM_PW", password: "hunter2-typed" },
				{ type: "rtsp", name: "porch", url: "rtsp://admin:hunter2-url@192.168.1.51:554/h264Preview_01_sub" }
			]
		})
		const text = await (await f.app.request("/api/settings")).text()
		assert.doesNotMatch(text, /hunter2/)
		const body = JSON.parse(text) as SettingsDto
		assert.deepEqual(
			body.sources.map(s => (s.type === "reolink" ? s.passwordEnv : s.type === "rtsp" ? s.url : null)),
			["TEST_CAM_PW", "rtsp://admin:•••@192.168.1.51:554/h264Preview_01_sub"]
		)
	})

	test("PATCH creates the config file, applies it live, and rejects out-of-range values untouched", async () => {
		const f = setup()
		const res = await f.app.request("/api/settings", {
			...post({ roi: { x: 0.25, y: 0.1, w: 0.5, h: 0.5 }, retention: { rejectedDays: 3, minFreeGb: 2 } }),
			method: "PATCH"
		})
		assert.equal(res.status, 200)
		const body = (await res.json()) as SettingsDto
		assert.deepEqual([body.roi, body.retention], [{ x: 0.25, y: 0.1, w: 0.5, h: 0.5 }, { rejectedDays: 3, motionlessDays: 2, minFreeGb: 2, uncheckedGb: 10 }])
		assert.deepEqual(f.ctx.config.pipeline.roi, { x: 0.25, y: 0.1, w: 0.5, h: 0.5 })
		assert.equal(f.ctx.config.retention.minFreeGb, 2)
		const before = readFileSync(join(f.dir, "look4.config.json"), "utf8")

		const bad = await f.app.request("/api/settings", { ...post({ judge: { maxCrops: 99 } }), method: "PATCH" })
		assert.equal(bad.status, 400)
		// the field and the limit, without the config file's path the form has no use for
		assert.equal(((await bad.json()) as ApiError).error, "pipeline.judge.maxCrops must be at most 8 (was 99)")
		assert.equal(readFileSync(join(f.dir, "look4.config.json"), "utf8"), before)
	})
})

describe("labels", () => {
	test("set then clear round-trips; a label pins the clip against retention", async () => {
		const f = setup()
		addLookout(f, "hawk")
		const id = "20261014-090000-0abcde"
		addClip(f, id, "2026-10-14T09:00:00.000Z", { status: "rejected", droppedAt: "judge", expiresAt: "2026-10-15T00:00:00.000Z" })

		const set = (await (await f.app.request(`/api/clips/${id}/label`, post({ lookoutId: "hawk", truth: true }))).json()) as ClipDetail
		assert.deepEqual(set.labels.map(l => [l.lookoutId, l.truth]), [["hawk", true]])
		assert.equal(set.clip.expiresAt, null)

		const t0 = Date.now()
		const cleared = (await (await f.app.request(`/api/clips/${id}/label`, post({ lookoutId: "hawk", truth: null }))).json()) as ClipDetail
		assert.deepEqual(cleared.labels, [])
		// unlabeled, the rejected clip is back on the normal 7-day clock
		const expires = Date.parse(cleared.clip.expiresAt ?? "")
		assert.ok(expires >= t0 + 7 * 86_400_000 && expires <= Date.now() + 7 * 86_400_000)
	})

	test("an unknown lookout is a 404, not a stored label", async () => {
		const f = setup()
		const id = "20261014-090000-0abcde"
		addClip(f, id, "2026-10-14T09:00:00.000Z")
		const res = await f.app.request(`/api/clips/${id}/label`, post({ lookoutId: "nope", truth: true }))
		assert.equal(res.status, 404)
		assert.deepEqual(f.store.getLabels(), [])
	})
})

describe("sightings", () => {
	test("pages with nextBefore visit every sighting exactly once, even when timestamps tie at a page edge", async () => {
		const f = setup()
		addLookout(f, "cardinal")
		addLookout(f, "strict", 0.95)
		const times = ["2026-10-14T10:00:05.000Z", "2026-10-14T10:00:04.000Z", "2026-10-14T10:00:03.000Z", "2026-10-14T10:00:03.000Z", "2026-10-14T10:00:01.000Z"]
		const ids = times.map((t, i) => `20261014-10000${i}-${String(i).repeat(6)}`)
		ids.forEach((id, i) => {
			addClip(f, id, times[i]!, { status: "kept" })
			keep(f, id, "cardinal")
		})
		// kept, but its only verdict is under the lookout's threshold: not a sighting
		addClip(f, "20261014-100009-999999", "2026-10-14T10:00:09.000Z", { status: "kept" })
		keep(f, "20261014-100009-999999", "strict", 0.9)

		const seen: string[] = []
		const cursors: Array<string | null> = []
		let before: string | null = null
		do {
			const qs: string = before ? `&before=${encodeURIComponent(before)}` : ""
			const page = (await (await f.app.request(`/api/sightings?limit=3${qs}`)).json()) as Page<ClipSummary>
			seen.push(...page.items.map(i => i.id))
			cursors.push(page.nextBefore)
			before = page.nextBefore
		} while (before)
		assert.deepEqual([...seen].sort(), [...ids].sort())
		assert.deepEqual(cursors, ["2026-10-14T10:00:03.000Z", null])
	})

	test("a summary carries only the matches that cleared the lookout's threshold, with its name", async () => {
		const f = setup()
		addLookout(f, "cardinal")
		addLookout(f, "strict", 0.95)
		const id = "20261014-100000-abcdef"
		addClip(f, id, "2026-10-14T10:00:00.000Z", { status: "kept" })
		keep(f, id, "cardinal", 0.8)
		keep(f, id, "strict", 0.9)
		const page = (await (await f.app.request("/api/sightings")).json()) as Page<ClipSummary>
		assert.deepEqual(page.items[0]?.matches, [{ lookoutId: "cardinal", lookoutName: "cardinal", label: "Northern Cardinal", species: null, speciesConfidence: null, confidence: 0.8 }])
		assert.deepEqual(page.items[0]?.media, { poster: null, preview: null, original: `/media/${id}/original`, crops: [], closeUps: [] })
	})

	test("unseen counts sightings ingested after the given time, not older clips re-checked since", async () => {
		const f = setup()
		addLookout(f, "cardinal")
		const old = "20261014-100000-aaaaaa"
		addClip(f, old, "2026-10-14T10:00:00.000Z", { status: "kept" })
		await new Promise(r => setTimeout(r, 5))
		const since = new Date().toISOString()
		await new Promise(r => setTimeout(r, 5))
		const fresh = "20261014-100001-bbbbbb"
		const pending = "20261014-100002-cccccc"
		addClip(f, fresh, "2026-10-14T10:00:01.000Z", { status: "kept" })
		addClip(f, pending, "2026-10-14T10:00:02.000Z")
		// a backfill's verdict on the old clip lands now, but the clip isn't new
		keep(f, old, "cardinal")
		keep(f, fresh, "cardinal")
		const res = await f.app.request(`/api/sightings/unseen?since=${encodeURIComponent(since)}`)
		assert.deepEqual(await res.json(), { ids: [fresh] })
		const bad = await f.app.request("/api/sightings/unseen?since=yesterday")
		assert.equal(bad.status, 400)
	})

	test("a detector-only match under the lookout's threshold still shows as the card's match", async () => {
		const f = setup()
		addLookout(f, "cardinal")
		const id = "20261014-100000-abcdef"
		addClip(f, id, "2026-10-14T10:00:00.000Z", { status: "kept" })
		f.store.upsertVerdict({ clipId: id, lookoutId: "cardinal", match: true, confidence: 0.31, label: "bird", rationale: "", model: DETECTOR_ONLY, createdAt: "" })
		const page = (await (await f.app.request("/api/sightings")).json()) as Page<ClipSummary>
		assert.deepEqual(page.items.map(i => i.matches), [[{ lookoutId: "cardinal", lookoutName: "cardinal", label: "bird", species: null, speciesConfidence: null, confidence: 0.31 }]])
	})
})

describe("life list", () => {
	const named = (f: Fixture, clipId: string, lookoutId: string, species: string, confidence = 0.9) =>
		f.store.upsertVerdict({ clipId, lookoutId, match: true, confidence, label: `${species} (adult)`, species, speciesConfidence: confidence, rationale: "", model: "mock", createdAt: "" })

	test("confirming a sighting says yes to its lookouts and adds its species, dated to the clip; the same species in another case is not added twice", async () => {
		const f = setup()
		addLookout(f, "new-bird")
		const dove = "20261014-100000-aaaaaa"
		const later = "20261015-100000-bbbbbb"
		addClip(f, dove, "2026-10-14T10:00:00.000Z", { status: "kept", expiresAt: "2026-10-30T00:00:00.000Z" })
		addClip(f, later, "2026-10-15T10:00:00.000Z", { status: "kept" })
		named(f, dove, "new-bird", "Mourning Dove")
		named(f, later, "new-bird", "mourning dove")
		const page = (await (await f.app.request("/api/sightings")).json()) as Page<ClipSummary>
		assert.deepEqual(page.items.map(i => [i.newSpecies, i.confirmed]), [["mourning dove", false], ["Mourning Dove", false]])

		const first = (await (await f.app.request(`/api/clips/${dove}/confirm`, post({}))).json()) as ConfirmClipResponse
		assert.deepEqual([first.added, first.clip.confirmed, first.clip.newSpecies], ["Mourning Dove", true, null])
		assert.deepEqual(f.store.getLabels({ clipId: dove }).map(l => [l.lookoutId, l.truth]), [["new-bird", true]])
		assert.equal(f.store.getClip(dove)!.expiresAt, null)

		const second = (await (await f.app.request(`/api/clips/${later}/confirm`, post({}))).json()) as ConfirmClipResponse
		assert.deepEqual([second.added, second.clip.confirmed, second.clip.newSpecies], [null, true, null])
		const list = (await (await f.app.request("/api/life-list")).json()) as LifeListResponse
		assert.deepEqual(
			list.entries.map(e => [e.species, e.firstSeenAt, e.clipId, e.sightings, e.lastSeenAt]),
			[["Mourning Dove", "2026-10-14T10:00:00.000Z", dove, 2, "2026-10-15T10:00:00.000Z"]]
		)

		const dup = await f.app.request("/api/life-list", post({ species: "MOURNING DOVE" }))
		assert.equal(dup.status, 409)
		assert.equal(((await dup.json()) as ApiError).error, "Mourning Dove is already on your life list")
	})

	test("a species added by hand stays new until a clip of it is confirmed, which becomes its clip without moving its first-seen date", async () => {
		const f = setup()
		addLookout(f, "new-bird")
		const kept = "20261014-100000-aaaaaa"
		addClip(f, kept, "2026-10-14T10:00:00.000Z", { status: "kept" })
		named(f, kept, "new-bird", "Blue Jay")
		await f.app.request("/api/life-list", post({ species: "Blue Jay", seenAt: "2025-06-01" }))
		assert.equal(((await (await f.app.request(`/api/clips/${kept}`)).json()) as ConfirmClipResponse["clip"]).newSpecies, "Blue Jay")

		const res = (await (await f.app.request(`/api/clips/${kept}/confirm`, post({}))).json()) as ConfirmClipResponse
		assert.deepEqual([res.added, res.clip.newSpecies], [null, null])
		const { clipId, firstSeenAt } = f.store.getLifer("Blue Jay")!
		assert.deepEqual([clipId, firstSeenAt], [kept, "2025-06-01T12:00:00.000Z"])
	})

	test("confirming a clip the spotter named no species for takes the name given, and with none is refused even when a lookout kept it", async () => {
		const f = setup()
		addLookout(f, "new-bird")
		const kept = "20261014-100000-aaaaaa"
		const bare = "20261015-100000-bbbbbb"
		addClip(f, kept, "2026-10-14T10:00:00.000Z", { status: "kept" })
		addClip(f, bare, "2026-10-15T10:00:00.000Z", { status: "rejected", droppedAt: "judge" })
		f.store.upsertVerdict({ clipId: kept, lookoutId: "new-bird", match: true, confidence: 0.3, label: "bird", rationale: "", model: DETECTOR_ONLY, createdAt: "" })

		// kept but unnamed: a yes with no bird would add nothing to the life list
		assert.equal((await f.app.request(`/api/clips/${kept}/confirm`, post({}))).status, 400)
		assert.deepEqual(f.store.getLabels({ clipId: kept }), [])
		const named = (await (await f.app.request(`/api/clips/${kept}/confirm`, post({ species: " Carolina Wren " }))).json()) as ConfirmClipResponse
		assert.equal(named.added, "Carolina Wren")
		const refused = await f.app.request(`/api/clips/${bare}/confirm`, post({}))
		assert.equal(refused.status, 400)
		assert.deepEqual(f.store.getLabels({ clipId: bare }), [])
	})

	test("a species added by hand on a bare date is first seen at noon UTC that day; one marked not this does not count as seen", async () => {
		const f = setup()
		addLookout(f, "new-bird")
		const wren = "20261014-100000-aaaaaa"
		const notWren = "20261015-100000-bbbbbb"
		addClip(f, wren, "2026-10-14T10:00:00.000Z", { status: "rejected", droppedAt: "judge" })
		addClip(f, notWren, "2026-10-15T10:00:00.000Z", { status: "rejected", droppedAt: "judge" })
		named(f, wren, "new-bird", "Carolina Wren")
		named(f, notWren, "new-bird", "Carolina Wren")
		f.store.setLabel({ clipId: notWren, lookoutId: "new-bird", truth: false })

		const body = (await (await f.app.request("/api/life-list", post({ species: "Carolina Wren", seenAt: "2025-06-01" }))).json()) as LifeListResponse
		assert.deepEqual(
			body.entries.map(e => [e.species, e.firstSeenAt, e.clipId, e.sightings, e.lastSeenAt]),
			// added by hand it has no clip of its own, so it links to the best one look4 caught, never the refuted one
			[["Carolina Wren", "2025-06-01T12:00:00.000Z", wren, 1, "2026-10-14T10:00:00.000Z"]]
		)

		assert.equal((await f.app.request("/api/life-list/carolina%20wren", { method: "DELETE" })).status, 200)
		assert.equal((await f.app.request("/api/life-list/Carolina%20Wren", { method: "DELETE" })).status, 404)
	})
})

describe("stats", () => {
	test("reports free space on the data disk next to the retention.minFreeGb floor", async () => {
		const f = setup({ retention: { minFreeGb: 2.5 } })
		const body = (await (await f.app.request("/api/stats")).json()) as StatsResponse
		assert.equal(body.diskFloorBytes, 2.5e9)
		// other suites write files meanwhile: the same disk, give or take
		assert.ok(Math.abs(body.diskFreeBytes! - freeBytes(f.ctx.paths.root)) < 1e9, `diskFreeBytes ${body.diskFreeBytes}`)
	})
})

describe("lookouts", () => {
	test("stats: precision over labeled kept clips, recall over positive labels", async () => {
		const f = setup()
		addLookout(f, "cardinal")
		const [a, b, c] = ["20261014-100001-aaaaaa", "20261014-100002-bbbbbb", "20261014-100003-cccccc"]
		addClip(f, a, "2026-10-14T10:00:01.000Z", { status: "kept" })
		addClip(f, b, "2026-10-14T10:00:02.000Z", { status: "kept" })
		addClip(f, c, "2026-10-14T10:00:03.000Z", { status: "rejected", droppedAt: "judge" })
		keep(f, a, "cardinal")
		keep(f, b, "cardinal")
		f.store.upsertVerdict({ clipId: c, lookoutId: "cardinal", match: false, confidence: 0.7, label: "sparrow", rationale: "", model: "mock", createdAt: "" })
		f.store.setLabel({ clipId: a, lookoutId: "cardinal", truth: true })
		f.store.setLabel({ clipId: b, lookoutId: "cardinal", truth: false })
		// the judge missed it: a cardinal the user says should have matched
		f.store.setLabel({ clipId: c, lookoutId: "cardinal", truth: true })
		const [dto] = (await (await f.app.request("/api/lookouts")).json()) as LookoutDto[]
		assert.deepEqual(dto?.stats, { kept: 2, judged: 3, labeled: 3, precision: 0.5, recall: 0.5, lastSeenAt: "2026-10-14T10:00:02.000Z" })
	})

	test("stats count a detector-only match at any score, and a kept clip queued again by a backfill", async () => {
		const f = setup()
		addLookout(f, "cardinal")
		const [d, p, r] = ["20261014-100001-dddddd", "20261014-100002-eeeeee", "20261014-100003-ffffff"]
		addClip(f, d, "2026-10-14T10:00:01.000Z", { status: "kept" })
		// detector scores live on their own scale: 0.31 is under the 0.6 threshold but still keeps the clip
		f.store.upsertVerdict({ clipId: d, lookoutId: "cardinal", match: true, confidence: 0.31, label: "bird", rationale: "", model: DETECTOR_ONLY, createdAt: "" })
		addClip(f, p, "2026-10-14T10:00:02.000Z", { status: "pending", pendingLookouts: ["hawk"] })
		keep(f, p, "cardinal")
		// a judge verdict under the threshold keeps nothing, whatever the clip's status
		addClip(f, r, "2026-10-14T10:00:03.000Z", { status: "kept" })
		keep(f, r, "cardinal", 0.5)
		f.store.setLabel({ clipId: d, lookoutId: "cardinal", truth: true })
		f.store.setLabel({ clipId: p, lookoutId: "cardinal", truth: false })
		const [dto] = (await (await f.app.request("/api/lookouts")).json()) as LookoutDto[]
		// the "not this" on p still counts against precision while it waits in the queue
		assert.deepEqual(dto?.stats, { kept: 2, judged: 3, labeled: 2, precision: 0.5, recall: 1, lastSeenAt: "2026-10-14T10:00:02.000Z" })
	})
})

describe("events", () => {
	test("SSE relays bus events and removes its listeners when the client goes away", async () => {
		const f = setup()
		const abort = new AbortController()
		const res = await f.app.request("/api/events", { signal: abort.signal })
		assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8")
		const reader = res.body!.getReader()
		const text = async () => new TextDecoder().decode((await reader.read()).value)
		assert.match(await text(), /: connected/)
		assert.equal(f.ctx.bus.listenerCount("clip"), 1)

		f.ctx.bus.emit("clip", { clipId: "20261014-100000-abcdef", status: "kept" })
		assert.equal(await text(), 'event: clip\ndata: {"clipId":"20261014-100000-abcdef","status":"kept"}\n\n')

		abort.abort()
		for (const e of ["clip", "sighting", "source", "queue", "lookout"] as const) assert.equal(f.ctx.bus.listenerCount(e), 0, e)
	})

	test("cancelling the body (the node adapter's disconnect path) also unsubscribes", async () => {
		const f = setup()
		const res = await f.app.request("/api/events")
		await res.body!.cancel()
		assert.equal(f.ctx.bus.listenerCount("sighting"), 0)
	})
})

describe("upload", () => {
	test("a raw-body video is ingested as an upload; other files and empty bodies are refused", async () => {
		const f = setup()
		const ok = await f.app.request("/api/upload?name=" + encodeURIComponent("RecM07_20261014_093012_093042_6D28808_1E2F3A.mp4"), {
			method: "POST",
			body: "fake video bytes"
		})
		assert.equal(ok.status, 200)
		const { clips } = (await ok.json()) as UploadResponse
		assert.deepEqual(clips.map(c => [c.source, c.status, c.recordedAt]), [["upload", "pending", new Date(2026, 9, 14, 9, 30, 12).toISOString()]])
		assert.deepEqual(readFileSync(f.store.getClip(clips[0]!.id)!.path!, "utf8"), "fake video bytes")

		// no timestamp in the name: the browser's File.lastModified dates the clip
		const when = new Date(2026, 9, 1, 8, 0, 0)
		const dated = await f.app.request(`/api/upload?name=feeder.mp4&lastModified=${when.getTime()}`, { method: "POST", body: "other bytes" })
		assert.equal(((await dated.json()) as UploadResponse).clips[0]?.recordedAt, when.toISOString())

		const txt = await f.app.request("/api/upload?name=notes.txt", { method: "POST", body: "hello" })
		assert.equal(txt.status, 415)
		const empty = await f.app.request("/api/upload?name=a.mp4", { method: "POST", body: "" })
		assert.equal(empty.status, 400)
		assert.equal(f.store.countClips(), 2)
	})
})

describe("listen", () => {
	// transformers.js only writes a downloaded model to its file cache when fetch()
	// returns an `instanceof Response`; the node adapter's global swap broke first-run downloads
	test("serving leaves the global Request and Response untouched", async () => {
		const free = createNetServer().listen(0, "127.0.0.1")
		await once(free, "listening")
		const port = (free.address() as AddressInfo).port
		await new Promise(r => free.close(r))
		const f = setup({ server: { host: "127.0.0.1", port } })
		const { Request: Req, Response: Res } = globalThis
		const s = await createServer(f.ctx, { webDist: join(f.dir, "no-dist") }).listen()
		try {
			const res = await fetch(`${s.url}/api/nope`)
			assert.equal(res.status, 404)
			assert.equal(globalThis.Response, Res)
			assert.equal(globalThis.Request, Req)
			assert.ok(res instanceof Response)
		} finally {
			await s.close()
		}
	})
})
