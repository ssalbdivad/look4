import { type } from "arktype"
import { existsSync, readFileSync } from "node:fs"
import { lstat, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { Hono } from "hono"
import type {
	BackfillResponse,
	ClipSummary,
	CompilePreviewResponse,
	ConfirmClipResponse,
	WrongBirdResponse,
	LifeListResponse,
	LookoutDto,
	Page,
	StatsResponse,
	UnseenSightingsResponse,
	UploadResponse
} from "../api-types.ts"
import { CONFIG_FILE, ConfigError, NormBox, updateConfigFile } from "../config.ts"
import type { AppContext } from "../context.ts"
import { backfill, createLookout, deleteLookout, updateLookout } from "../lookouts.ts"
import { extractFrame } from "../media/ffmpeg.ts"
import { clipMediaDir } from "../paths.ts"
import { freeBytes } from "../retention.ts"
import type { Clip, ClipStatus, Stage } from "../types.ts"
import { CLIP_ID, clipDetail, clipSummary, lookoutDto, lookoutMap, mediaUrls, settingsDto } from "./dto.ts"
import { HttpError, intParam, readBody } from "./http.ts"
import { sseResponse, type SseHub } from "./sse.ts"
import type { StatusChecks } from "./status.ts"
import { ingestMultipart, ingestRawUpload, MULTIPART_LIMIT_BYTES } from "./upload.ts"
import { logger } from "../log.ts"

const log = logger("server")

const VERSION: string = (() => {
	try {
		return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version ?? "0.0.0"
	} catch {
		return "0.0.0"
	}
})()

const STATUSES: ReadonlySet<string> = new Set<ClipStatus>(["pending", "processing", "kept", "rejected", "error"])
const STAGES: ReadonlySet<string> = new Set<Stage>(["probe", "motion", "detect", "judge"])

const CreateLookout = type({
	prompt: "string.trim |> string > 0",
	"name?": "string.trim |> string > 0",
	"threshold?": "0 <= number <= 1",
	"enabled?": "boolean",
	"+": "delete"
})

const UpdateLookout = type({
	"name?": "string.trim |> string > 0",
	"prompt?": "string.trim |> string > 0",
	"threshold?": "0 <= number <= 1",
	"enabled?": "boolean",
	"queries?": "(string.trim |> string > 0)[] > 0",
	"+": "delete"
})

const CompilePreview = type({ prompt: "string.trim |> string > 0", "+": "delete" })
const Backfill = type({ "since?": "string > 0", "+": "delete" })
const LabelBody = type({ lookoutId: "string > 0", truth: "boolean | null", "+": "delete" })
const ConfirmBody = type({ "species?": "string.trim |> 0 < string <= 80", "+": "delete" })
const WrongBirdBody = type({ "species?": "string.trim |> 0 < string <= 80 | null", "+": "delete" })
const ReprocessBody = type({ "lookoutIds?": "string[]", "+": "delete" })
const AddLifer = type({
	species: "string.trim |> 0 < string <= 80",
	"clipId?": "string > 0",
	"seenAt?": "string.date.iso | /^\\d{4}-\\d{2}-\\d{2}$/",
	"+": "delete"
})

// Ranges are checked by the config schema itself when the patch is applied.
const SettingsPatch = type({
	"roi?": NormBox.or("null"),
	"motion?": {
		"sampleFps?": "number",
		"pixelThreshold?": "number",
		"minArea?": "number",
		"maxArea?": "number",
		"maxFrames?": "number",
		"+": "delete"
	},
	"detector?": { "enabled?": "boolean", "model?": "string > 0", "threshold?": "number", "zoom?": "boolean", "+": "delete" },
	"judge?": {
		"provider?": "string",
		"model?": "string > 0",
		"escalateModel?": "string > 0 | null",
		"escalateBelow?": "number",
		"maxCrops?": "number",
		"cropSize?": "number",
		"+": "delete"
	},
	"retention?": { "rejectedDays?": "number", "motionlessDays?": "number", "minFreeGb?": "number", "uncheckedGb?": "number", "+": "delete" },
	"alerts?": { "desktop?": "boolean", "+": "delete" },
	"+": "delete"
})

const DAY_MS = 86_400_000

const localMidnight = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate())

/**
 * Keyset pagination on `recordedAt`. `before` is strict, so when rows sharing
 * one timestamp straddle the page boundary the whole tie is pulled into this
 * page; otherwise the next page would silently skip the rest of it.
 */
const paginate = <row>(
	fetch: (q: { before?: string; since?: string; limit: number }) => row[],
	clipOf: (r: row) => Clip,
	before: string | undefined,
	limit: number
): { rows: row[]; nextBefore: string | null } => {
	const rows = fetch({ before, limit: limit + 1 })
	if (rows.length <= limit) return { rows, nextBefore: null }
	const page = rows.slice(0, limit)
	const edge = clipOf(page.at(-1)!).recordedAt
	if (clipOf(rows[limit]!).recordedAt !== edge) return { rows: page, nextBefore: edge }
	const seen = new Set(page.map(r => clipOf(r).id))
	// " " sorts below every character an ISO timestamp could continue with, so [edge, edge+" ") is exactly `edge`
	for (const r of fetch({ since: edge, before: `${edge} `, limit: 100_000 })) if (!seen.has(clipOf(r).id)) page.push(r)
	return { rows: page, nextBefore: fetch({ before: edge, limit: 1 }).length ? edge : null }
}

/** Recursive byte count, not following symlinks. */
const dirBytes = async (dir: string): Promise<number> => {
	let entries
	try {
		entries = await readdir(dir, { withFileTypes: true, recursive: true })
	} catch {
		return 0
	}
	let total = 0
	for (const e of entries) {
		if (!e.isFile()) continue
		try {
			total += (await lstat(join(e.parentPath, e.name))).size
		} catch {}
	}
	return total
}

/** Memoizes an async value for `ttlMs`; concurrent callers share one computation. */
const cached = <t>(ttlMs: number, compute: () => Promise<t>) => {
	let entry: { at: number; value: Promise<t> } | null = null
	return () => {
		if (!entry || Date.now() - entry.at > ttlMs) {
			const value = compute()
			entry = { at: Date.now(), value }
			value.catch(() => (entry = null))
		}
		return entry.value
	}
}

export const apiRoutes = (ctx: AppContext, hub: SseHub, checks: StatusChecks) => {
	const api = new Hono()
	const deps = { store: ctx.store, paths: ctx.paths }

	const getClipOr404 = (id: string) => {
		if (!CLIP_ID.test(id)) throw new HttpError(400, `"${id}" is not a clip id`)
		const clip = ctx.store.getClip(id)
		if (!clip) throw new HttpError(404, `no clip ${id}`)
		return clip
	}

	const getLookoutOr404 = (idOrName: string) => {
		const l = ctx.store.getLookout(idOrName)
		if (!l) throw new HttpError(404, `no lookout "${idOrName}"`)
		return l
	}

	/** The last snapshot frame; reused until a newer clip lands. */
	let snapshotCache: { id: string; jpeg: Buffer } | null = null

	const emitQueue = () => ctx.bus.emit("queue", ctx.store.queueDepth())

	// ---- stats ----

	const diskBytes = cached(60_000, async () => {
		const sizes = await Promise.all([ctx.paths.clips, ctx.paths.kept, ctx.paths.media].map(dirBytes))
		return sizes.reduce((a, b) => a + b, 0)
	})

	/** statfs is cheap, and the floor check should see a disk filling up between polls. */
	const diskFree = (): Pick<StatsResponse, "diskFreeBytes" | "diskFloorBytes"> => {
		const diskFloorBytes = ctx.config.retention.minFreeGb * 1e9
		try {
			return { diskFreeBytes: freeBytes(ctx.paths.root), diskFloorBytes }
		} catch (e) {
			log.debug(`could not read free space: ${e instanceof Error ? e.message : e}`)
			return { diskFloorBytes }
		}
	}

	// The desktop window's handshake (desktop/src/server.ts): cheap, and names the app, since a port
	// answers for whoever holds it.
	api.get("/health", c => c.json({ ok: true, app: "look4", version: VERSION }))

	api.get("/stats", async c => {
		const now = new Date()
		const today = localMidnight(now).toISOString()
		const month = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
		const { store } = ctx
		const body: StatsResponse = {
			funnel: {
				today: store.funnel(today),
				week: store.funnel(new Date(now.getTime() - 7 * DAY_MS).toISOString()),
				all: store.funnel()
			},
			cost: {
				todayUsd: store.usageSince(today).costUsd,
				monthUsd: store.usageSince(month).costUsd,
				allUsd: store.usageSince().costUsd,
				callsToday: store.usageSince(today).calls
			},
			queue: store.queueDepth(),
			sources: ctx.sourceStatuses(),
			pipeline: {
				judge: await checks.judgeStatus(),
				detector: checks.detectorStatus(),
				roi: ctx.config.pipeline.roi
			},
			diskBytes: await diskBytes(),
			...diskFree(),
			version: VERSION
		}
		return c.json(body)
	})

	// ---- sightings + clips ----

	api.get("/sightings", c => {
		const lookoutId = c.req.query("lookout") ? getLookoutOr404(c.req.query("lookout")!).id : undefined
		const limit = intParam(c.req.query("limit"), 48, 1, 200)
		const lookouts = lookoutMap(ctx.store)
		const { rows, nextBefore } = paginate(
			q => ctx.store.listSightings({ ...q, lookoutId }),
			r => r.clip,
			c.req.query("before") || undefined,
			limit
		)
		const body: Page<ClipSummary> = { items: rows.map(r => clipSummary(deps, r.clip, lookouts, r.verdicts)), nextBefore }
		return c.json(body)
	})

	// The Sightings tab's count: what was ingested after you last looked at the feed and became a
	// sighting, whether or not a page was open to hear it. A re-check of older footage isn't new.
	api.get("/sightings/unseen", c => {
		const since = c.req.query("since") ?? ""
		if (Number.isNaN(Date.parse(since))) throw new HttpError(400, "since must be an ISO time")
		// the badge reads "99+" past 99, so a hundred is all it needs
		const rows = ctx.store.listSightings({ ingestedAfter: new Date(since).toISOString(), limit: 100 })
		const body: UnseenSightingsResponse = { ids: rows.map(r => r.clip.id) }
		return c.json(body)
	})

	api.get("/clips", c => {
		const status = c.req.query("status")?.split(",").filter(Boolean)
		for (const s of status ?? []) if (!STATUSES.has(s)) throw new HttpError(400, `unknown status "${s}"`)
		const droppedAt = c.req.query("droppedAt") || undefined
		if (droppedAt && !STAGES.has(droppedAt)) throw new HttpError(400, `unknown stage "${droppedAt}"`)
		const lookoutId = c.req.query("lookout") ? getLookoutOr404(c.req.query("lookout")!).id : undefined
		const limit = intParam(c.req.query("limit"), 50, 1, 200)
		const lookouts = lookoutMap(ctx.store)
		const { rows, nextBefore } = paginate(
			q =>
				ctx.store.listClips({
					...q,
					status: status?.length ? (status as ClipStatus[]) : undefined,
					droppedAt: droppedAt as Stage | undefined,
					source: c.req.query("source") || undefined,
					lookoutId
				}),
			clip => clip,
			c.req.query("before") || undefined,
			limit
		)
		const body: Page<ClipSummary> = { items: rows.map(clip => clipSummary(deps, clip, lookouts)), nextBefore }
		return c.json(body)
	})

	api.get("/clips/:id", c => c.json(clipDetail(deps, getClipOr404(c.req.param("id")))))

	api.post("/clips/:id/label", async c => {
		const clip = getClipOr404(c.req.param("id"))
		const body = await readBody(c, LabelBody)
		const lookout = getLookoutOr404(body.lookoutId)
		if (body.truth === null) ctx.store.clearLabel(clip.id, lookout.id)
		else ctx.store.setLabel({ clipId: clip.id, lookoutId: lookout.id, truth: body.truth })
		const labeled = ctx.store.getLabels({ clipId: clip.id }).length > 0
		if (labeled) {
			// ground truth is what eval and threshold tuning learn from: never let retention take it
			if (clip.expiresAt !== null) ctx.store.updateClip(clip.id, { expiresAt: null })
		} else if (clip.status === "rejected" && clip.path) {
			// unlabeled again: the rejected clip goes back to normal retention, counted from now
			const { motionlessDays, rejectedDays } = ctx.config.retention
			const days = clip.droppedAt === "motion" ? motionlessDays : rejectedDays
			ctx.store.updateClip(clip.id, { expiresAt: new Date(Date.now() + days * DAY_MS).toISOString() })
		}
		const updated = ctx.store.getClip(clip.id)!
		ctx.bus.emit("clip", { clipId: clip.id, status: updated.status })
		return c.json(clipDetail(deps, updated))
	})

	// "Wrong bird": a "no" on every lookout that kept the clip, with what it really was when the person
	// says. The clip leaves the feed and stays as ground truth, and the confirming call learns the misread.
	api.post("/clips/:id/wrong", async c => {
		const clip = getClipOr404(c.req.param("id"))
		const body = await readBody(c, WrongBirdBody)
		const before = clipSummary(deps, clip, lookoutMap(ctx.store))
		if (!before.matches.length) throw new HttpError(409, "this clip is not a sighting")
		for (const m of before.matches) ctx.store.setLabel({ clipId: clip.id, lookoutId: m.lookoutId, truth: false, species: body.species ?? null })
		// a labeled clip is ground truth: retention never takes it
		if (clip.expiresAt !== null) ctx.store.updateClip(clip.id, { expiresAt: null })
		const updated = ctx.store.getClip(clip.id)!
		ctx.bus.emit("clip", { clipId: clip.id, status: updated.status })
		const res: WrongBirdResponse = { clip: clipSummary(deps, updated, lookoutMap(ctx.store)), undo: before.matches.map(m => m.lookoutId) }
		return c.json(res)
	})

	api.post("/clips/:id/confirm", async c => {
		const clip = getClipOr404(c.req.param("id"))
		const body = await readBody(c, ConfirmBody)
		const lookouts = lookoutMap(ctx.store)
		const before = clipSummary(deps, clip, lookouts)
		const species = body.species ?? before.newSpecies ?? before.matches.find(m => m.species)?.species ?? null
		// a confirmation is a life-list sighting: without a species it would record a yes and add nothing
		if (!species) throw new HttpError(400, "name the bird: the spotter named no species for this clip")
		for (const m of before.matches) ctx.store.setLabel({ clipId: clip.id, lookoutId: m.lookoutId, truth: true })
		// a labeled clip is ground truth: retention never takes it
		if (before.matches.length && clip.expiresAt !== null) ctx.store.updateClip(clip.id, { expiresAt: null })
		let added: string | null = null
		const lifer = species ? ctx.store.getLifer(species) : null
		if (species && !lifer) {
			ctx.store.addLifer({ species, clipId: clip.id, firstSeenAt: clip.recordedAt })
			added = species
			ctx.bus.emit("lifelist", { species })
		} else if (lifer && lifer.clipId === null) {
			// added by hand: this is its first clip
			ctx.store.setLiferClip(lifer.species, clip.id)
			ctx.bus.emit("lifelist", { species: lifer.species })
		}
		const updated = ctx.store.getClip(clip.id)!
		ctx.bus.emit("clip", { clipId: clip.id, status: updated.status })
		const res: ConfirmClipResponse = { clip: clipSummary(deps, updated, lookouts), added }
		return c.json(res)
	})

	api.post("/clips/:id/reprocess", async c => {
		const clip = getClipOr404(c.req.param("id"))
		const body = await readBody(c, ReprocessBody)
		if (clip.status === "processing") throw new HttpError(409, "the clip is being processed right now")
		if (!clip.path || !existsSync(clip.path)) throw new HttpError(409, "the clip's file is gone (retention deleted it)")
		const lookoutIds = body.lookoutIds?.map(id => getLookoutOr404(id).id)
		ctx.store.updateClip(clip.id, {
			status: "pending",
			pendingLookouts: lookoutIds?.length ? lookoutIds : null,
			droppedAt: null,
			reason: null,
			error: null,
			expiresAt: null
		})
		ctx.bus.emit("clip", { clipId: clip.id, status: "pending" })
		emitQueue()
		ctx.kick()
		return c.json({ ok: true as const })
	})

	api.delete("/clips/:id", async c => {
		const clip = getClipOr404(c.req.param("id"))
		if (clip.status === "processing") throw new HttpError(409, "the clip is being processed right now; try again in a moment")
		if (clip.path) await rm(clip.path, { force: true })
		await rm(clipMediaDir(ctx.paths, clip.id), { recursive: true, force: true })
		// detections, verdicts and labels cascade; usage rows stay, since that money was spent
		ctx.store.deleteClip(clip.id)
		snapshotCache = snapshotCache?.id === clip.id ? null : snapshotCache
		ctx.bus.emit("clip", { clipId: clip.id, status: "deleted" })
		emitQueue()
		return c.json({ ok: true as const })
	})

	// ---- lookouts ----

	api.get("/lookouts", c => c.json(ctx.store.listLookouts().map(l => lookoutDto(ctx.store, l)) satisfies LookoutDto[]))

	// before /lookouts/:id so "preview" is not taken for an id
	api.post("/lookouts/preview", async c => {
		const { prompt } = await readBody(c, CompilePreview)
		const body: CompilePreviewResponse = await ctx.compile(prompt)
		return c.json(body)
	})

	api.post("/lookouts", async c => {
		const body = await readBody(c, CreateLookout)
		const l = await createLookout(ctx, body)
		return c.json(lookoutDto(ctx.store, l), 201)
	})

	api.patch("/lookouts/:id", async c => {
		const cur = getLookoutOr404(c.req.param("id"))
		const body = await readBody(c, UpdateLookout)
		const l = await updateLookout(ctx, cur.id, body)
		return c.json(lookoutDto(ctx.store, l))
	})

	api.delete("/lookouts/:id", c => {
		deleteLookout(ctx, getLookoutOr404(c.req.param("id")).id)
		return c.json({ ok: true as const })
	})

	api.post("/lookouts/:id/backfill", async c => {
		const l = getLookoutOr404(c.req.param("id"))
		const { since } = await readBody(c, Backfill)
		const body: BackfillResponse = { queued: await backfill(ctx, l.id, since) }
		return c.json(body)
	})

	// ---- life list ----

	const lifeList = (): LifeListResponse => ({
		entries: ctx.store.listLifeList().map(e => {
			// a bird with no clip of its own (added by hand) still shows the best one look4 has caught of it
			const id = e.clipId ?? ctx.store.bestClipFor(e.species)
			const clip = id ? ctx.store.getClip(id) : null
			const media = clip ? mediaUrls(ctx.paths, clip) : null
			return { ...e, clipId: clip?.id ?? null, image: media ? (media.closeUps[0] ?? media.crops[0] ?? media.poster) : null }
		})
	})

	api.get("/life-list", c => c.json(lifeList()))

	api.post("/life-list", async c => {
		const body = await readBody(c, AddLifer)
		const clip = body.clipId ? getClipOr404(body.clipId) : null
		const known = ctx.store.getLifer(body.species)
		if (known) throw new HttpError(409, `${known.species} is already on your life list`)
		// a bare date is a day, not midnight UTC: noon keeps it on that day in every time zone
		const seenAt = body.seenAt && /^\d{4}-\d{2}-\d{2}$/.test(body.seenAt) ? `${body.seenAt}T12:00:00.000Z` : body.seenAt
		ctx.store.addLifer({ species: body.species, clipId: clip?.id ?? null, firstSeenAt: seenAt ?? clip?.recordedAt ?? null })
		ctx.bus.emit("lifelist", { species: body.species })
		return c.json(lifeList(), 201)
	})

	api.delete("/life-list/:species", c => {
		const species = c.req.param("species")
		if (!ctx.store.removeLifer(species)) throw new HttpError(404, `${species} is not on your life list`)
		ctx.bus.emit("lifelist", { species })
		return c.json(lifeList())
	})

	// ---- settings ----

	api.get("/settings", c => c.json(settingsDto(ctx.config)))

	api.patch("/settings", async c => {
		const patch = await readBody(c, SettingsPatch)
		const path = ctx.config.configPath ?? join(ctx.config.rootDir, CONFIG_FILE)
		const before = ctx.config.pipeline.judge
		try {
			applySettingsPatch(path, patch)
		} catch (e) {
			// the config error names the whole file; the settings form only needs which value is out of range
			if (e instanceof ConfigError) throw new HttpError(400, e.message.replace(/^[^\n]* is invalid:\n/, ""))
			throw e
		}
		const config = ctx.reloadConfig()
		// the backend is built with its model baked in, so "applies to the next clip" means building a new one
		const judge = config.pipeline.judge
		if (judge.provider !== before.provider || judge.model !== before.model) await ctx.reloadJudge()
		return c.json(settingsDto(config))
	})

	const applySettingsPatch = (path: string, patch: typeof SettingsPatch.infer) =>
		updateConfigFile(path, raw => {
			const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? v : {})
			const pipeline = (raw.pipeline = obj(raw.pipeline))
			if (patch.roi !== undefined) pipeline.roi = patch.roi
			if (patch.motion) pipeline.motion = { ...obj(pipeline.motion), ...patch.motion }
			if (patch.detector) pipeline.detector = { ...obj(pipeline.detector), ...patch.detector }
			if (patch.judge) pipeline.judge = { ...obj(pipeline.judge), ...patch.judge }
			if (patch.retention) raw.retention = { ...obj(raw.retention), ...patch.retention }
			if (patch.alerts) raw.alerts = { ...obj(raw.alerts), ...patch.alerts }
		})

	// ---- snapshot (a real frame to draw the detection zone on) ----

	api.get("/snapshot", async () => {
		const rows = ctx.store.db
			.prepare("SELECT id FROM clips WHERE path IS NOT NULL ORDER BY recorded_at DESC LIMIT 25")
			.all() as Array<{ id: string }>
		let attempts = 0
		for (const { id } of rows) {
			const clip = ctx.store.getClip(id)
			if (!clip?.path || !existsSync(clip.path)) continue
			if (snapshotCache?.id !== clip.id) {
				// a few unreadable clips in a row should not hide an older good one, nor stall the request
				if (attempts++ >= 4) break
				try {
					const t = Math.min(1, (clip.durationS ?? 2) / 2)
					snapshotCache = { id: clip.id, jpeg: await extractFrame(clip.path, t) }
				} catch (e) {
					log.warn(`snapshot: could not read a frame from ${clip.id}`, e instanceof Error ? e.message : e)
					continue
				}
			}
			return new Response(new Uint8Array(snapshotCache.jpeg), {
				headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-cache", "X-Clip-Id": clip.id }
			})
		}
		// No frame yet is the normal state of a new install, not an error: 204 still fires the <img>'s
		// onError (the UI then explains there is nothing to draw on), but a 4xx would also put a red
		// "Failed to load resource" in the browser console on every visit to Settings.
		return new Response(null, { status: 204, headers: { "Cache-Control": "no-cache" } })
	})

	// ---- upload ----

	api.post("/upload", async c => {
		const type = c.req.header("content-type") ?? ""
		let results
		if (type.startsWith("multipart/form-data")) {
			if (Number(c.req.header("content-length") ?? 0) > MULTIPART_LIMIT_BYTES)
				throw new HttpError(413, "multipart uploads are for small files; send big videos as the raw body with ?name=")
			const form = await c.req.parseBody({ all: true })
			const raw = form.files
			const files = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter((f): f is File => f instanceof File)
			results = await ingestMultipart(ctx, files)
		} else {
			results = [await ingestRawUpload(ctx, c.req.query("name"), c.req.raw.body, c.req.query("lastModified"))]
		}
		ctx.kick()
		const lookouts = lookoutMap(ctx.store)
		const body: UploadResponse = { clips: results.map(r => clipSummary(deps, r.clip, lookouts)) }
		return c.json(body)
	})

	// ---- sources ----

	api.post("/sources/:name/poll", c => {
		const name = c.req.param("name")
		if (!ctx.sourceStatuses().some(s => s.name === name)) throw new HttpError(404, `no running source "${name}"`)
		// a Reolink poll can download for minutes; progress arrives over SSE as `source` events
		ctx.pollSource(name).catch(e => log.warn(`poll ${name} failed`, e instanceof Error ? e.message : e))
		return c.json({ ok: true as const })
	})

	// ---- live events ----

	api.get("/events", c => sseResponse(ctx.bus, hub, c.req.raw.signal))

	api.all("*", () => {
		throw new HttpError(404, "no such API route")
	})

	return api
}
