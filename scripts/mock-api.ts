// A stand-in for the look4 server so the web UI can be built and screenshotted without the real
// pipeline. Serves every route in src/api-types.ts with believable, type-checked fake data, real
// frames and clips cut from test/fixtures/videos, SSE heartbeats, and occasional fake sightings.
//
//   node scripts/mock-api.ts [--port 4040] [--empty | --fresh] [--quiet-live] [--judge claude-code] [--no-cameras] [--media <dir>]
//
// --empty starts with no clips, lookouts or sources (for empty-state screenshots); setup counts as done.
// --fresh is --empty on a brand-new install: GET /api/setup says not completed, so / opens the wizard.
// --quiet-live turns off the random sightings and queue churn (for stable screenshots).
// --judge picks what the AI judge looks like: claude-code (default), anthropic, or none (no judge yet).
// --no-cameras makes the network scan find nothing.
// --media <dir> is where the frames and clips cut from the fixtures go (default test/.tmp/ui/mock-media), so
//   two mocks, or a mock beside someone's test run, don't share a scratch dir.
// --disk-free <GB> sets the free space the disk reports (default 41); below retention.minFreeGb (5) the
//   camera source pauses with "disk nearly full" and Activity and Settings warn.
// POST /api/__mock/sighting adds a kept clip and announces it, for screenshotting live sightings.
//
// Guided setup simulations (POST /api/setup/test-camera), so every walkthrough can be screenshotted:
//   host 192.168.1.31   → http-disabled for the first test and two re-checks, fine on the third re-check
//   host 10.0.0.9       → unreachable          host 192.168.1.1 → not-reolink
//   password "wrong"    → bad-credentials (attempts left counting down from 9)   password "locked" → locked-out (retry after 90 s)
//   .31 connects with RTSP off; POST /api/setup/probe finds it on at the third check (the live-video walkthrough)
//   no password + source → tests with that source's saved password
// POST /api/setup/test-rtsp: URLs mentioning 10.0.0.9 or "bad" → nothing answered, ":wrong@" → bad login, else a frame.
//   anything else       → connects (an RLC-823S1 named "Front porch", or "Backyard" for .31)
// RTSP sources whose URL mentions 10.0.0.9 or "bad" go into an error state with no snapshot.

import { spawnSync } from "node:child_process"
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import type {
	AddSourceBody,
	CameraTestBody,
	CameraTestResult,
	ClipDetail,
	ClipMatch,
	ClipSummary,
	CompleteSetupBody,
	CreateLookoutBody,
	DevicePorts,
	DiscoverResponse,
	FolderListing,
	Funnel,
	JudgeKeyBody,
	LabelBody,
	LifeListResponse,
	AddLiferBody,
	ConfirmClipBody,
	ConfirmClipResponse,
	LiveSourceDto,
	ProbeBody,
	ProbeResult,
	LookoutDto,
	Page,
	RtspTestBody,
	RtspTestResult,
	SettingsDto,
	SettingsPatch,
	SetupStatus,
	SourceDto,
	SseEvent,
	StatsResponse,
	UpdateLookoutBody,
	UpdateSourceBody,
	UploadResponse
} from "../src/api-types.ts"
import type { SourceConfig } from "../src/config.ts"
import type { Clip, CompiledLookout, Detection, Label, LifeListEntry, Lookout, NormBox, SourceStatus, Stage, Verdict } from "../src/types.ts"

const { values: args } = parseArgs({
	options: {
		port: { type: "string", default: "4040" },
		host: { type: "string", default: "127.0.0.1" },
		empty: { type: "boolean", default: false },
		fresh: { type: "boolean", default: false },
		"quiet-live": { type: "boolean", default: false },
		judge: { type: "string", default: "claude-code" },
		"no-cameras": { type: "boolean", default: false },
		"disk-free": { type: "string", default: "41" },
		media: { type: "string" }
	}
})
const emptyStart = args.empty || args.fresh

const root = resolve(dirname(new URL(import.meta.url).pathname), "..")
const fixtures = join(root, "test/fixtures/videos")
const mediaRoot = args.media ? resolve(args.media) : join(root, "test/.tmp/ui/mock-media")

// ---------- media prepared from the fixture videos ----------

type Scene = {
	key: string
	file: string
	/** Seconds into the video for the poster frame. */
	t: number
	subjects: { box: NormBox; label: string; noun: string }[]
}

const SCENES: Scene[] = [
	{ key: "blue-jay", file: "blue-jay.mp4", t: 2, subjects: [{ box: { x: 0.33, y: 0.19, w: 0.42, h: 0.74 }, label: "Blue Jay", noun: "bird" }] },
	{
		key: "cardinal",
		file: "cardinal-woodpecker.mp4",
		t: 2,
		subjects: [
			{ box: { x: 0.14, y: 0.6, w: 0.3, h: 0.33 }, label: "Northern Cardinal (male)", noun: "bird" },
			{ box: { x: 0.6, y: 0.36, w: 0.13, h: 0.5 }, label: "Downy Woodpecker", noun: "bird" }
		]
	},
	{
		key: "reolink",
		file: "RecM07_20261014_093012_093042_6D28808_1E2F3A.mp4",
		t: 2,
		subjects: [{ box: { x: 0.04, y: 0.57, w: 0.27, h: 0.32 }, label: "Northern Cardinal (male)", noun: "bird" }]
	},
	{ key: "squirrel", file: "squirrel.mp4", t: 2, subjects: [{ box: { x: 0.3, y: 0.34, w: 0.11, h: 0.32 }, label: "Eastern Gray Squirrel", noun: "squirrel" }] },
	{ key: "sparrow", file: "chipping-sparrow.mp4", t: 2, subjects: [{ box: { x: 0.5, y: 0.21, w: 0.2, h: 0.4 }, label: "Chipping Sparrow", noun: "bird" }] },
	{
		key: "tits",
		file: "great-tits.mp4",
		t: 2,
		subjects: [
			{ box: { x: 0.5, y: 0.56, w: 0.22, h: 0.18 }, label: "Great Tit", noun: "bird" },
			{ box: { x: 0.78, y: 0.57, w: 0.1, h: 0.18 }, label: "Great Tit", noun: "bird" }
		]
	},
	{ key: "snow", file: "empty-feeder-snow.mp4", t: 2, subjects: [] },
	{ key: "static", file: "static.mp4", t: 2, subjects: [] },
	{ key: "light", file: "light-change.mp4", t: 5, subjects: [] }
]

const ffmpeg = (argv: string[]) => {
	const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...argv], { encoding: "utf8" })
	if (r.status !== 0) throw new Error(`ffmpeg ${argv.join(" ")}\n${r.stderr}`)
}

const probeSize = (file: string) => {
	const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], {
		encoding: "utf8"
	})
	const [w, h] = r.stdout.trim().split(",").map(Number)
	return { w: w ?? 1280, h: h ?? 720 }
}

const sceneDir = (s: Scene) => join(mediaRoot, s.key)

/** Posters, square close-ups around each subject, and a short browser-safe preview, cached on disk. */
const prepareMedia = () => {
	const available = new Set(existsSync(fixtures) ? readdirSync(fixtures) : [])
	const ready: Scene[] = []
	for (const s of SCENES) {
		if (!available.has(s.file)) continue
		const src = join(fixtures, s.file)
		const dir = sceneDir(s)
		mkdirSync(dir, { recursive: true })
		const { w, h } = probeSize(src)
		const poster = join(dir, "poster.jpg")
		if (!existsSync(poster)) ffmpeg(["-ss", String(s.t), "-i", src, "-frames:v", "1", "-vf", "scale=1280:-2", "-q:v", "3", poster])
		s.subjects.forEach((sub, i) => {
			const out = join(dir, `crop-${i}.jpg`)
			if (existsSync(out)) return
			const side = Math.min(w, h, Math.round(Math.max(sub.box.w * w, sub.box.h * h) * 1.25))
			const cx = (sub.box.x + sub.box.w / 2) * w
			const cy = (sub.box.y + sub.box.h / 2) * h
			const x = Math.round(Math.min(w - side, Math.max(0, cx - side / 2)))
			const y = Math.round(Math.min(h - side, Math.max(0, cy - side / 2)))
			ffmpeg(["-ss", String(s.t), "-i", src, "-frames:v", "1", "-vf", `crop=${side}:${side}:${x}:${y},scale=512:512`, "-q:v", "3", out])
		})
		const preview = join(dir, "preview.mp4")
		if (!existsSync(preview))
			ffmpeg([
				"-i", src, "-t", "8", "-vf", "scale=960:-2", "-c:v", "libx264", "-preset", "veryfast",
				"-crf", "27", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", preview
			])
		ready.push(s)
	}
	return ready
}

// ---------- fake state ----------

const now = () => new Date()
const iso = (d: Date) => d.toISOString()
const pad = (n: number) => String(n).padStart(2, "0")
let seed = 7
const rand = () => {
	seed = (seed * 16807) % 2147483647
	return (seed - 1) / 2147483646
}
const hex = (n = 6) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("")
const clipId = (d: Date) =>
	`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${hex()}`

type Row = {
	clip: Clip
	scene: Scene | null
	verdicts: Verdict[]
	detections: Detection[]
	labels: Label[]
	usage: { calls: number; inputTokens: number; outputTokens: number; costUsd: number }
}

const compile = (prompt: string): CompiledLookout => {
	const p = prompt.toLowerCase()
	const birdWords = /\b(bird|cardinal|jay|hawk|sparrow|woodpecker|finch|owl|eagle|robin|chickadee|tit|hummingbird|raptor|prey|wren|nuthatch|dove|crow)s?\b/
	const queries: string[] = []
	if (birdWords.test(p)) queries.push("bird")
	for (const w of ["squirrel", "cat", "dog", "deer", "raccoon", "person", "fox", "rabbit", "bear"]) if (p.includes(w)) queries.push(w)
	if (!queries.length) queries.push("animal")
	const fineGrained = /cardinal|jay|hawk|sparrow|woodpecker|finch|owl|eagle|robin|chickadee|wren|nuthatch|species|male|female/.test(p)
	const summary = prompt.trim().replace(/^(a|an|any|the)\s+/i, "").replace(/^./, c => c.toUpperCase())
	return {
		queries,
		rubric: `Match only if a close-up clearly shows ${prompt.trim()}.\nSay no for other species, blurry shapes, or empty perches.\nReport the most specific name you can see (species, sex when visible).`,
		summary,
		fineGrained,
		promptHash: hex(16),
		compiler: "mock"
	}
}

const makeLookout = (name: string, prompt: string, threshold: number, enabled = true, daysAgo = 6): Lookout => ({
	id: `lk-${hex(8)}`,
	name,
	prompt,
	enabled,
	threshold,
	compiled: compile(prompt),
	createdAt: iso(new Date(Date.now() - daysAgo * 86400_000)),
	updatedAt: iso(new Date(Date.now() - daysAgo * 86400_000))
})

const lookouts: Lookout[] = []

/** What the judge would name as the species: a bird's label without its "(male)". */
const speciesOf = (sub: { label: string; noun: string } | undefined) => (sub?.noun === "bird" ? sub.label.replace(/\s*\(.*\)$/, "") : null)

/** Seen before the mock's clips start, so the feed's other birds are new species to confirm. */
const lifeList: LifeListEntry[] = emptyStart
	? []
	: ["Blue Jay", "Northern Cardinal", "House Finch"].map(species => ({ species, firstSeenAt: "2026-05-02T12:00:00.000Z", clipId: null, addedAt: "2026-05-02T12:00:00.000Z" }))
const rows: Row[] = []
let roi: NormBox | null = null
const sources: SourceStatus[] = []
let queue = { pending: 0, processing: 0 }

const MOTIONLESS = ["peak 0.01% of the zone changed", "nothing moved in the zone", "global light change (82% of the frame)"]

const addClip = (opts: {
	at: Date
	scene: Scene | null
	source: string
	status: Clip["status"]
	droppedAt?: Stage | null
	reason?: string
	matchLookouts?: { lookout: Lookout; subject: number; confidence: number }[]
	judged?: { lookout: Lookout; match: boolean; confidence: number; label: string | null; rationale: string }[]
	originalName?: string
}) => {
	const { at, scene, status } = opts
	const id = clipId(at)
	const isKept = status === "kept"
	const verdicts: Verdict[] = []
	for (const m of opts.matchLookouts ?? []) {
		const sub = scene?.subjects[m.subject]
		verdicts.push({
			clipId: id,
			lookoutId: m.lookout.id,
			match: true,
			confidence: m.confidence,
			label: sub?.label ?? null,
			species: speciesOf(sub),
			speciesConfidence: speciesOf(sub) ? m.confidence : null,
			rationale: sub
				? `${sub.label} perched on the feeder, ${sub.noun === "squirrel" ? "climbing the pole" : "facing the camera"}; field marks clearly visible.`
				: "A clear subject on the feeder.",
			model: "claude-code:haiku",
			createdAt: iso(at)
		})
	}
	for (const j of opts.judged ?? [])
		verdicts.push({ clipId: id, lookoutId: j.lookout.id, match: j.match, confidence: j.confidence, label: j.label, rationale: j.rationale, model: "claude-code:haiku", createdAt: iso(at) })
	const reached = status === "kept" || opts.droppedAt === "judge" || opts.droppedAt === "detect"
	const detections: Detection[] =
		reached && scene
			? scene.subjects.flatMap((s, i) => [
					{ clipId: id, frameT: scene.t, label: s.noun, score: 0.42 - i * 0.07 + rand() * 0.1, box: s.box, via: "full" as const },
					{ clipId: id, frameT: scene.t + 0.5, label: s.noun, score: 0.3 + rand() * 0.1, box: { ...s.box, x: s.box.x + 0.01, y: s.box.y - 0.01 }, via: "zoom" as const }
				])
			: []
	const judged = verdicts.length > 0
	const clip: Clip = {
		id,
		source: opts.source,
		sourceRef: null,
		originalName: opts.originalName ?? scene?.file ?? `${id}.mp4`,
		path: scene ? join(fixtures, scene.file) : null,
		sizeBytes: 2_400_000 + Math.round(rand() * 6_000_000),
		sha256: hex(64),
		recordedAt: iso(at),
		ingestedAt: iso(new Date(at.getTime() + 40_000)),
		durationS: scene ? 8 + Math.round(rand() * 20) : null,
		width: scene?.key === "reolink" ? 3840 : 1280,
		height: scene?.key === "reolink" ? 2160 : 720,
		status,
		droppedAt: opts.droppedAt ?? null,
		reason: opts.reason ?? null,
		motion: null,
		timings:
			status === "pending" || status === "processing"
				? {}
				: {
						probe: 30 + Math.round(rand() * 30),
						motion: 600 + Math.round(rand() * 500),
						...(reached ? { detect: 1800 + Math.round(rand() * 1400) } : {}),
						...(judged ? { judge: 1400 + Math.round(rand() * 1600) } : {})
					},
		error: status === "error" ? "ffprobe: moov atom not found (the file was cut off mid-write)" : null,
		processedAt: status === "pending" ? null : iso(new Date(at.getTime() + 90_000)),
		expiresAt: isKept || status === "pending" ? null : iso(new Date(at.getTime() + 7 * 86400_000)),
		pendingLookouts: null,
		media: {
			poster: scene ? "poster.jpg" : null,
			preview: isKept && scene ? "preview.mp4" : null,
			crops: judged && scene ? scene.subjects.map((_, i) => `crop-${i}.jpg`) : []
		}
	}
	const calls = judged ? 1 : 0
	const row: Row = {
		clip,
		scene,
		verdicts,
		detections,
		labels: [],
		usage: {
			calls,
			inputTokens: calls * (1600 + Math.round(rand() * 900)),
			outputTokens: calls * (70 + Math.round(rand() * 60)),
			costUsd: calls * (0.00018 + rand() * 0.0002)
		}
	}
	rows.push(row)
	return row
}

const seedData = (scenes: Scene[]) => {
	const byKey = (k: string) => scenes.find(s => s.key === k) ?? null
	const jay = makeLookout("cardinal-or-jay", "a cardinal or blue jay at the feeder", 0.6)
	const squirrel = makeLookout("squirrel-on-pole", "any squirrel on the feeder pole", 0.55, true, 5)
	const woodpecker = makeLookout("woodpecker", "a woodpecker on the suet cage", 0.6, true, 3)
	const hawk = makeLookout("hawk", "a hawk or any bird of prey", 0.7, false, 2)
	lookouts.push(jay, squirrel, woodpecker, hawk)
	sources.push(
		// the details the real adapter appends while it is healthy: a skewed camera clock, recordings waiting for a retry
		{ name: "backyard", type: "reolink", state: "ok", detail: "RLC-823S1 · 14 clips today · camera clock is 62 min behind this computer: check its time zone and DST in the Reolink app · 2 recordings to retry: RecM07_20261014_101512_101542.mp4: socket hang up", lastPollAt: iso(new Date(Date.now() - 38_000)), lastClipAt: iso(new Date(Date.now() - 22 * 60_000)), clipsIngested: 214 },
		{ name: "nvr-export", type: "watch", state: "idle", detail: "Watching /mnt/c/Users/david/Videos/NVR (no new files)", lastPollAt: iso(new Date(Date.now() - 4_000)), lastClipAt: iso(new Date(Date.now() - 3 * 86400_000)), clipsIngested: 12 },
		{ name: "inbox", type: "inbox", state: "ok", detail: "Watching data/inbox", lastPollAt: iso(new Date(Date.now() - 2_000)), lastClipAt: null, clipsIngested: 3 }
	)
	roi = { x: 0.08, y: 0.12, w: 0.8, h: 0.82 }
	if (diskFree() < diskFloor()) {
		const yard = sources[0]!
		yard.state = "error"
		yard.detail = `disk nearly full: ${(diskFree() / 1e9).toFixed(1)} GB free, pulling paused`
	}
	settings.sources = [
		{ type: "reolink", name: "backyard", enabled: true, host: "192.168.1.50", username: "admin", passwordEnv: "REOLINK_PASSWORD", channel: 0, stream: "main", protocol: "auto", rtspPort: 554, pollSeconds: 60, lookbackHours: 24, capture: "auto", segmentSeconds: 6, motionGate: "both", closeUps: false },
		{ type: "watch", name: "nvr-export", enabled: true, dir: "/mnt/c/Users/david/Videos/NVR", extensions: [".mp4", ".mov"], pollSeconds: 5, stableSeconds: 5, move: false }
	]

	const t = (daysAgo: number, h: number, m: number) => {
		const d = new Date()
		d.setDate(d.getDate() - daysAgo)
		d.setHours(h, m, Math.floor(rand() * 60), 0)
		return d.getTime() > Date.now() ? new Date(Date.now() - (60 + m) * 60_000) : d
	}
	const kept = (at: Date, key: string, matches: { lookout: Lookout; subject: number; confidence: number }[], source = "backyard") => {
		const scene = byKey(key)
		if (!scene) return null
		return addClip({ at, scene, source, status: "kept", matchLookouts: matches, reason: `kept: ${matches.map(m => scene.subjects[m.subject]?.label).join(", ")}` })
	}
	// the judge said yes, but under the lookout's threshold: the near-misses worth labeling
	const closeCall = (at: Date, key: string, lookout: Lookout, label: string, confidence: number) =>
		byKey(key) &&
		addClip({
			at,
			scene: byKey(key),
			source: "backyard",
			status: "rejected",
			droppedAt: "judge",
			reason: `judge: ${label} for ${lookout.name}, below its threshold (${confidence.toFixed(2)} < ${lookout.threshold.toFixed(2)})`,
			judged: [{ lookout, match: true, confidence, label, rationale: `Probably a ${label}, but half hidden behind the feeder post.` }]
		})
	const rejectJudge = (at: Date, key: string, label: string) =>
		byKey(key) &&
		addClip({
			at,
			scene: byKey(key),
			source: "backyard",
			status: "rejected",
			droppedAt: "judge",
			reason: `judge: a ${label.toLowerCase()}, not a cardinal or blue jay`,
			// for match:false the judge's confidence is how sure it is the lookout is NOT there (src/pipeline/judge.ts)
			judged: [{ lookout: jay, match: false, confidence: 0.8 + rand() * 0.17, label, rationale: `A ${label} on the tray. Brown streaked plumage, no red or blue.` }]
		})

	// Today
	const fresh = kept(t(0, 9, 30), "reolink", [{ lookout: jay, subject: 0, confidence: 0.87 }])
	kept(t(0, 8, 12), "blue-jay", [{ lookout: jay, subject: 0, confidence: 0.96 }])
	rejectJudge(t(0, 7, 55), "sparrow", "Chipping Sparrow")
	addClip({ at: t(0, 7, 41), scene: byKey("light"), source: "backyard", status: "rejected", droppedAt: "motion", reason: "global light change (82% of the frame)" })
	const rechecked = kept(t(0, 7, 20), "squirrel", [{ lookout: squirrel, subject: 0, confidence: 0.91 }])
	// a sighting whose re-check (a backfill) failed: still kept, with a warning
	if (rechecked) {
		rechecked.clip.error = "claude CLI timed out after 60 s"
		rechecked.clip.reason = `${rechecked.clip.reason} · re-check failed at judge: claude CLI timed out after 60 s`
	}
	closeCall(t(0, 7, 8), "blue-jay", jay, "Blue Jay", 0.52)
	// a judge call that failed for a passing reason; the worker retries it on its own
	const retrying = addClip({ at: t(0, 7, 2), scene: byKey("sparrow"), source: "backyard", status: "error", reason: "failed at judge: claude CLI exited 1: overloaded (retry 4 at 14:00)" })
	retrying.clip.error = "claude CLI exited 1: overloaded"
	addClip({ at: t(0, 6, 58), scene: byKey("static"), source: "backyard", status: "rejected", droppedAt: "motion", reason: "nothing moved in the zone" })
	kept(t(0, 6, 31), "cardinal", [
		{ lookout: jay, subject: 0, confidence: 0.93 },
		{ lookout: woodpecker, subject: 1, confidence: 0.84 }
	])
	addClip({ at: t(0, 6, 5), scene: byKey("snow"), source: "backyard", status: "rejected", droppedAt: "detect", reason: "no bird or squirrel found (falling snow)" })
	// Yesterday
	// queued again by a backfill: still a sighting until it is re-decided
	const requeued = kept(t(1, 16, 44), "blue-jay", [{ lookout: jay, subject: 0, confidence: 0.89 }])
	if (requeued) requeued.clip.status = "pending"
	closeCall(t(1, 14, 26), "cardinal", woodpecker, "Downy Woodpecker", 0.47)
	rejectJudge(t(1, 15, 2), "tits", "Great Tit")
	kept(t(1, 13, 37), "squirrel", [{ lookout: squirrel, subject: 0, confidence: 0.78 }])
	addClip({ at: t(1, 12, 20), scene: null, source: "nvr-export", status: "error", reason: "could not read the file", originalName: "export_0412.mp4" })
	kept(t(1, 9, 3), "cardinal", [{ lookout: jay, subject: 0, confidence: 0.95 }])
	for (let i = 0; i < 6; i++)
		addClip({ at: t(1, 8 - i, 10 + i * 7), scene: byKey(i % 2 ? "static" : "light"), source: "backyard", status: "rejected", droppedAt: "motion", reason: MOTIONLESS[i % 3] })
	// Earlier
	for (let d = 2; d <= 6; d++) {
		kept(t(d, 15, 10 + d), d % 2 ? "blue-jay" : "reolink", [{ lookout: jay, subject: 0, confidence: 0.7 + rand() * 0.28 }])
		if (d % 2 === 0) kept(t(d, 11, 5 * d), "squirrel", [{ lookout: squirrel, subject: 0, confidence: 0.6 + rand() * 0.35 }])
		if (d === 3) kept(t(d, 10, 2), "cardinal", [{ lookout: woodpecker, subject: 1, confidence: 0.81 }], "nvr-export")
		rejectJudge(t(d, 9, 40), d % 2 ? "sparrow" : "tits", d % 2 ? "Chipping Sparrow" : "Great Tit")
		if (d % 2) closeCall(t(d, 8, 50), "reolink", jay, "Northern Cardinal (female)", 0.44 + d * 0.02)
		for (let i = 0; i < 4; i++)
			addClip({ at: t(d, 7 + i, 3 * i), scene: byKey("static"), source: "backyard", status: "rejected", droppedAt: "motion", reason: MOTIONLESS[i % 3] })
	}
	rows.sort((a, b) => b.clip.recordedAt.localeCompare(a.clip.recordedAt))
	// A couple of human labels so precision/recall have something to say.
	if (fresh) fresh.labels.push({ clipId: fresh.clip.id, lookoutId: jay.id, truth: true, createdAt: iso(now()) })
	const missed = rows.find(r => r.clip.droppedAt === "judge")
	if (missed) missed.labels.push({ clipId: missed.clip.id, lookoutId: jay.id, truth: false, createdAt: iso(now()) })
	queue = { pending: 2, processing: 1 }
	const p1 = addClip({ at: new Date(Date.now() - 50_000), scene: byKey("blue-jay"), source: "backyard", status: "processing" })
	const p2 = addClip({ at: new Date(Date.now() - 20_000), scene: byKey("static"), source: "backyard", status: "pending" })
	rows.sort((a, b) => b.clip.recordedAt.localeCompare(a.clip.recordedAt))
	void p1
	void p2
}

// ---------- DTO builders ----------

const lookoutById = (id: string) => lookouts.find(l => l.id === id)

const mediaUrls = (r: Row): ClipSummary["media"] => {
	const base = `/media/${r.clip.id}`
	// like the real server: stills carry ?v=<processedAt> so a reprocess busts the cache; the UI must use URLs as given
	const v = r.clip.processedAt ? `?v=${Date.parse(r.clip.processedAt)}` : ""
	return {
		poster: r.clip.media.poster ? `${base}/poster.jpg${v}` : null,
		preview: r.clip.media.preview ? `${base}/preview.mp4${v}` : null,
		original: r.clip.path ? `${base}/original` : null,
		crops: r.clip.media.crops.map(c => `${base}/${c}${v}`),
		closeUps: []
	}
}

/** src/db.ts verdictKeeps: a detector-only verdict keeps on its match alone. */
const keeps = (v: Verdict, l: Lookout) => v.match && (v.model === "detector-only" || v.confidence >= l.threshold)
/** A verdict someone marked "Not this" no longer counts as a sighting. */
const refuted = (r: Row, lookoutId: string) => r.labels.some(x => x.lookoutId === lookoutId && x.truth === false)

const matchesOf = (r: Row): ClipMatch[] =>
	r.verdicts
		.flatMap(v => {
			const l = lookoutById(v.lookoutId)
			return l && keeps(v, l) && !refuted(r, l.id)
				? [{ lookoutId: l.id, lookoutName: l.name, label: v.label, species: v.species ?? null, speciesConfidence: v.speciesConfidence ?? null, confidence: v.confidence }]
				: []
		})
		.sort((a, b) => b.confidence - a.confidence)

/** Like the real feed: kept clips, and kept clips queued again for a backfill or a reprocess. */
const isSighting = (r: Row) => ["kept", "pending", "processing"].includes(r.clip.status) && matchesOf(r).length > 0

/** PATCH a lookout's threshold: past clips are re-decided against it (src/lookouts.ts does this for real). */
const redecide = (l: Lookout) => {
	for (const r of rows) {
		const v = r.verdicts.find(x => x.lookoutId === l.id)
		if (!v || (r.clip.status !== "kept" && r.clip.droppedAt !== "judge")) continue
		const kept = r.verdicts.some(x => {
			const lk = lookoutById(x.lookoutId)
			return lk && keeps(x, lk)
		})
		if (kept && r.clip.status === "rejected") {
			Object.assign(r.clip, { status: "kept", droppedAt: null, reason: `kept: ${v.label ?? l.name} (${v.confidence.toFixed(2)}) for ${l.name}`, expiresAt: null })
			r.clip.media = { ...r.clip.media, preview: r.scene ? "preview.mp4" : null }
		} else if (!kept && r.clip.status === "kept") {
			Object.assign(r.clip, {
				status: "rejected",
				droppedAt: "judge",
				reason: `judge: ${v.label ?? "a possible match"} for ${l.name}, below its threshold (${v.confidence.toFixed(2)} < ${l.threshold.toFixed(2)})`
			})
		}
	}
}

const summary = (r: Row): ClipSummary => ({
	id: r.clip.id,
	source: r.clip.source,
	recordedAt: r.clip.recordedAt,
	durationS: r.clip.durationS,
	status: r.clip.status,
	droppedAt: r.clip.droppedAt,
	reason: r.clip.reason,
	media: mediaUrls(r),
	matches: matchesOf(r),
	newSpecies: matchesOf(r).find(x => x.species && !onLifeList(x.species))?.species ?? null,
	confirmed: r.labels.some(l => l.truth)
})

const onLifeList = (species: string) => lifeList.some(e => e.species.toLowerCase() === species.toLowerCase())

/** GET /api/life-list, from the rows: src/db.ts listLifeList does this for real. */
const lifeListBody = (): LifeListResponse => {
	const named = (species: string) =>
		rows
			.filter(r => r.verdicts.some(v => v.species?.toLowerCase() === species.toLowerCase()))
			.sort((a, b) => b.clip.recordedAt.localeCompare(a.clip.recordedAt))
	return {
		entries: [...lifeList]
			.sort((a, b) => a.species.localeCompare(b.species))
			.map(e => {
				const seen = named(e.species)
				const clip = e.clipId ? rows.find(r => r.clip.id === e.clipId) : seen[0]
				const media = clip ? mediaUrls(clip) : null
				return {
					...e,
					clipId: clip?.clip.id ?? null,
					sightings: seen.length,
					lastSeenAt: seen[0]?.clip.recordedAt ?? e.firstSeenAt,
					image: media ? (media.closeUps[0] ?? media.crops[0] ?? media.poster) : null
				}
			})
	}
}

const detail = (r: Row): ClipDetail => ({
	...summary(r),
	clip: r.clip,
	verdicts: r.verdicts.flatMap(v => {
		const l = lookoutById(v.lookoutId)
		return l ? [{ ...v, lookoutName: l.name, threshold: l.threshold }] : []
	}),
	detections: r.detections,
	labels: r.labels,
	usage: r.usage
})

const lookoutDto = (l: Lookout): LookoutDto => {
	const keptRows = rows.filter(r => isSighting(r) && matchesOf(r).some(m => m.lookoutId === l.id))
	const labels = rows.flatMap(r => r.labels.filter(x => x.lookoutId === l.id).map(x => ({ x, r })))
	const labeledKept = labels.filter(({ r }) => keptRows.includes(r))
	const positives = labels.filter(({ x }) => x.truth)
	return {
		...l,
		stats: {
			kept: keptRows.length,
			judged: rows.filter(r => r.verdicts.some(v => v.lookoutId === l.id)).length,
			labeled: labels.length,
			precision: labeledKept.length ? labeledKept.filter(({ x }) => x.truth).length / labeledKept.length : null,
			recall: positives.length ? positives.filter(({ r }) => keptRows.includes(r)).length / positives.length : null,
			lastSeenAt: keptRows[0]?.clip.recordedAt ?? null
		}
	}
}

const funnel = (sinceMs: number): Funnel => {
	const rs = rows.filter(r => new Date(r.clip.recordedAt).getTime() >= sinceMs)
	const count = (f: (r: Row) => boolean) => rs.filter(f).length
	return {
		ingested: rs.length,
		pending: count(r => r.clip.status === "pending"),
		processing: count(r => r.clip.status === "processing"),
		errors: count(r => r.clip.status === "error"),
		passed: {
			motion: count(r => r.clip.status === "kept" || r.clip.droppedAt === "detect" || r.clip.droppedAt === "judge"),
			detect: count(r => r.clip.status === "kept" || r.clip.droppedAt === "judge")
		},
		kept: count(r => r.clip.status === "kept"),
		droppedAt: {
			probe: count(r => r.clip.droppedAt === "probe"),
			motion: count(r => r.clip.droppedAt === "motion"),
			detect: count(r => r.clip.droppedAt === "detect"),
			judge: count(r => r.clip.droppedAt === "judge")
		}
	}
}

const startOfToday = () => {
	const d = new Date()
	d.setHours(0, 0, 0, 0)
	return d.getTime()
}

const stats = (): StatsResponse => {
	const cost = (since: number) => rows.filter(r => new Date(r.clip.recordedAt).getTime() >= since).reduce((s, r) => s + r.usage.costUsd, 0)
	const month = new Date()
	month.setDate(1)
	month.setHours(0, 0, 0, 0)
	return {
		funnel: { today: funnel(startOfToday()), week: funnel(Date.now() - 7 * 86400_000), all: funnel(0) },
		cost: {
			todayUsd: cost(startOfToday()),
			monthUsd: cost(month.getTime()),
			allUsd: cost(0) + (emptyStart ? 0 : 0.84),
			callsToday: rows.filter(r => new Date(r.clip.recordedAt).getTime() >= startOfToday()).reduce((s, r) => s + r.usage.calls, 0)
		},
		queue,
		sources,
		pipeline: {
			judge: judgeStatus(),
			detector: { ok: true, detail: "OWL-ViT base, 1.4 s per frame on CPU", enabled: settings.detector.enabled, model: settings.detector.model },
			roi
		},
		diskBytes: emptyStart ? 0 : 3_870_000_000,
		diskFreeBytes: diskFree(),
		diskFloorBytes: diskFloor(),
		version: "0.1.0"
	}
}

const settings: SettingsDto = {
	configPath: join(root, "look4.config.json"),
	dataDir: join(root, "data"),
	server: { host: "127.0.0.1", port: 4040 },
	roi: null,
	motion: { sampleFps: 2, pixelThreshold: 22, minArea: 0.0008, maxArea: 0.7, maxFrames: 6 },
	detector: { enabled: true, model: "Xenova/owlvit-base-patch32", threshold: 0.1, zoom: true },
	judge: { provider: "auto", model: "claude-haiku-5-5", escalateModel: null, escalateBelow: 0.6, maxCrops: 4, cropSize: 512 },
	retention: { rejectedDays: 7, motionlessDays: 2, minFreeGb: 5, uncheckedGb: 10 },
	alerts: { desktop: true },
	sources: []
}

const diskFree = () => Number(args["disk-free"]) * 1e9
const diskFloor = () => (settings.retention.minFreeGb ?? 0) * 1e9

// ---------- SSE ----------

const clients = new Set<ServerResponse>()
const emit = (e: SseEvent) => {
	const msg = `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`
	for (const c of clients) c.write(msg)
}

const finishClip = (r: Row, scenes: Scene[]) => {
	const scene = r.scene ?? scenes[0] ?? null
	r.clip.status = "processing"
	emit({ event: "clip", data: { clipId: r.clip.id, status: "processing" } })
	setTimeout(() => {
		const jay = lookouts[0]
		const sub = scene?.subjects[0]
		if (jay && sub && scene && scene.key !== "sparrow" && scene.key !== "tits") {
			r.clip.status = "kept"
			r.scene = scene
			r.clip.reason = `kept: ${sub.label}`
			r.clip.media = { poster: "poster.jpg", preview: "preview.mp4", crops: scene.subjects.map((_, i) => `crop-${i}.jpg`) }
			r.verdicts = [{ clipId: r.clip.id, lookoutId: jay.id, match: true, confidence: 0.9, label: sub.label, species: speciesOf(sub), rationale: `${sub.label} on the feeder.`, model: "claude-code:haiku", createdAt: iso(now()) }]
			r.usage = { calls: 1, inputTokens: 1900, outputTokens: 88, costUsd: 0.00023 }
			r.clip.timings = { probe: 41, motion: 730, detect: 2100, judge: 1650 }
			emit({ event: "clip", data: { clipId: r.clip.id, status: "kept" } })
			emit({ event: "sighting", data: { clipId: r.clip.id, lookoutId: jay.id, lookoutName: jay.name, label: sub.label, confidence: 0.9, source: r.clip.source, recordedAt: r.clip.recordedAt, image: `/media/${r.clip.id}/crop-0.jpg` } })
		} else {
			r.clip.status = "rejected"
			r.clip.droppedAt = "motion"
			r.clip.reason = "nothing moved in the zone"
			emit({ event: "clip", data: { clipId: r.clip.id, status: "rejected" } })
		}
		queue = { pending: Math.max(0, queue.pending - 1), processing: 0 }
		emit({ event: "queue", data: queue })
	}, 2500)
}

// ---------- HTTP ----------

const send = (res: ServerResponse, status: number, body: unknown) => {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
	res.end(JSON.stringify(body))
}

const readBody = async (req: IncomingMessage) => {
	const chunks: Buffer[] = []
	for await (const c of req) chunks.push(c as Buffer)
	return Buffer.concat(chunks)
}

const readJson = async <t>(req: IncomingMessage): Promise<t> => {
	const buf = await readBody(req)
	return (buf.length ? JSON.parse(buf.toString("utf8")) : {}) as t
}

const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".mp4": "video/mp4" }

const sendFile = (req: IncomingMessage, res: ServerResponse, file: string) => {
	if (!existsSync(file)) return send(res, 404, { error: "not found" })
	const size = statSync(file).size
	const type = MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream"
	const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "")
	if (range) {
		const start = range[1] ? Number(range[1]) : 0
		const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
		res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1, "accept-ranges": "bytes" })
		createReadStream(file, { start, end }).pipe(res)
		return
	}
	res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes", "cache-control": "max-age=3600" })
	createReadStream(file).pipe(res)
}

const paginate = (items: Row[], url: URL): Page<ClipSummary> => {
	const before = url.searchParams.get("before")
	const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 24) || 24)
	const after = before ? items.filter(r => r.clip.recordedAt < before) : items
	const page = after.slice(0, limit)
	return { items: page.map(summary), nextBefore: after.length > limit ? (page.at(-1)?.clip.recordedAt ?? null) : null }
}

// ---------- guided setup ----------

let readyScenes: Scene[] = []

/** A new kept clip for the first enabled lookout, announced over SSE the way a real sighting is. */
const fakeSighting = () => {
	const keptScenes = readyScenes.filter(s => ["blue-jay", "cardinal", "reolink"].includes(s.key))
	const scene = keptScenes[Math.floor(rand() * keptScenes.length)]
	const jay = lookouts.find(l => l.enabled)
	if (!scene || !jay) return null
	const r = addClip({ at: now(), scene, source: "backyard", status: "kept", matchLookouts: [{ lookout: jay, subject: 0, confidence: 0.82 + rand() * 0.15 }] })
	rows.sort((a, b) => b.clip.recordedAt.localeCompare(a.clip.recordedAt))
	const best = r.verdicts[0]
	emit({ event: "clip", data: { clipId: r.clip.id, status: "kept" } })
	if (best) emit({ event: "sighting", data: { clipId: r.clip.id, lookoutId: jay.id, lookoutName: jay.name, label: best.label, confidence: best.confidence, source: r.clip.source, recordedAt: r.clip.recordedAt, image: `/media/${r.clip.id}/crop-0.jpg` } })
	return r.clip.id
}
let setupCompleted = !args.fresh
let uploadOnly = false
/** What a source was saved with that the config must not show (passwords, RTSP URLs). */
const secrets = new Map<string, string>()
const testCounts = new Map<string, number>()

const judgeStatus = (): StatsResponse["pipeline"]["judge"] => {
	const model = settings.judge.model
	if (args.judge === "none")
		return { ok: false, provider: "none", model, detail: "No judge yet: no Anthropic API key and no Claude Code login on this computer" }
	if (args.judge === "anthropic") return { ok: true, provider: "anthropic", model, detail: "Anthropic API key from .env" }
	return { ok: true, provider: "claude-code", model, detail: "claude CLI 2.1.4, logged in" }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const NO_PORTS: DevicePorts = { https: false, http: false, rtsp: false, reolinkApp: false, onvif: false }
const ALL_PORTS: DevicePorts = { https: true, http: true, rtsp: true, reolinkApp: true, onvif: true }

const maskConfig = (c: SourceConfig): SourceConfig =>
	c.type === "rtsp" && c.url ? { ...c, url: c.url.replace(/^(rtsp:\/\/[^:@/]*):[^@/]*@/i, "$1:•••@") } : c

const statusOf = (name: string) => sources.find(s => s.name === name)
const isPaused = (name: string) => settings.sources.find(x => x.name === name)?.enabled === false

const sourceDto = (c: SourceConfig): SourceDto => ({
	config: maskConfig(c),
	status: statusOf(c.name) ?? { name: c.name, type: c.type, state: "stopped", detail: "Not running", lastPollAt: null, lastClipAt: null, clipsIngested: 0 }
})

const setupStatus = (): SetupStatus => {
	const j = judgeStatus()
	return {
		completed: setupCompleted || settings.sources.length > 0 || lookouts.length > 0,
		steps: { source: settings.sources.length > 0 || uploadOnly, zone: roi !== null, lookout: lookouts.length > 0, judge: j.ok },
		sources: settings.sources.map(sourceDto),
		judge: j,
		detector: { ok: true, detail: "OWL-ViT base, 1.4 s per frame on CPU", enabled: settings.detector.enabled, model: settings.detector.model },
		configPath: settings.sources.length || setupCompleted ? settings.configPath : null
	}
}

const setStatus = (name: string, patch: Partial<SourceStatus>) => {
	const s = statusOf(name)
	if (!s) return
	Object.assign(s, patch)
	emit({ event: "source", data: { ...s } })
}

const isBroken = (c: SourceConfig) => c.type === "rtsp" && /10\.0\.0\.9|bad/i.test(secrets.get(c.name) ?? c.url ?? "")

/** Pretend to start an adapter: "starting", then healthy (or broken), then a first pull of a few clips. */
const startSource = (c: SourceConfig) => {
	const existing = statusOf(c.name)
	const status: SourceStatus = { name: c.name, type: c.type, state: "starting", detail: "Starting…", lastPollAt: null, lastClipAt: null, clipsIngested: existing?.clipsIngested ?? 0 }
	if (existing) Object.assign(existing, status)
	else sources.push(status)
	emit({ event: "source", data: { ...status } })
	const gen = (pulls.get(c.name) ?? 0) + 1
	pulls.set(c.name, gen)
	setTimeout(() => {
		if (pulls.get(c.name) !== gen || isPaused(c.name)) return
		if (isBroken(c)) {
			setStatus(c.name, { state: "error", detail: "Couldn't open the stream: the camera didn't answer (connection timed out)", lastPollAt: iso(now()) })
			return
		}
		const total = c.type === "reolink" ? 9 : c.type === "watch" ? 4 : 2
		const what = c.type === "reolink" ? `RLC-823S1 · pulling the last ${c.lookbackHours} hours` : c.type === "watch" ? `Watching ${c.dir}` : "Recording 30-second clips from the stream"
		setStatus(c.name, { state: "ok", detail: what, lastPollAt: iso(now()) })
		let n = 0
		const tick = setInterval(() => {
			if (pulls.get(c.name) !== gen || isPaused(c.name) || !statusOf(c.name)) return clearInterval(tick)
			const pool = readyScenes.filter(x => ["blue-jay", "reolink", "static", "squirrel", "cardinal", "light"].includes(x.key))
			const scene = pool[n % Math.max(1, pool.length)] ?? null
			const r = addClip({ at: new Date(Date.now() - (total - n) * 7 * 60_000), scene, source: c.name, status: "pending" })
			rows.sort((a, b) => b.clip.recordedAt.localeCompare(a.clip.recordedAt))
			queue = { ...queue, pending: queue.pending + 1 }
			emit({ event: "queue", data: queue })
			setTimeout(() => finishClip(r, readyScenes), 900)
			n++
			const s = statusOf(c.name)
			setStatus(c.name, {
				clipsIngested: (s?.clipsIngested ?? 0) + 1,
				lastClipAt: r.clip.recordedAt,
				lastPollAt: iso(now()),
				detail: n >= total ? (c.type === "reolink" ? "RLC-823S1 · up to date" : what) : what
			})
			if (n >= total) clearInterval(tick)
		}, 1600)
	}, 1400)
}
const pulls = new Map<string, number>()

const slugName = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 32)

const uniqueName = (base: string) => {
	let name = base || "camera"
	for (let i = 2; settings.sources.some(x => x.name === name); i++) name = `${base}-${i}`
	return name
}

const envName = (prefix: string, name: string, first: boolean) => (first ? prefix : `${prefix}_${name.toUpperCase().replace(/-/g, "_")}`)

const configFromBody = (b: AddSourceBody): SourceConfig | string => {
	const requested = b.name?.trim()
	if (requested !== undefined && requested !== "" && !/^[a-z0-9][a-z0-9-]*$/.test(requested))
		return "Names can use lowercase letters, numbers and dashes, like “backyard” or “porch-cam”."
	if (requested && settings.sources.some(x => x.name === requested)) return `There's already a source called “${requested}”. Pick another name.`
	if (b.type === "reolink") {
		if (!b.host?.trim()) return "The camera's address is missing."
		const name = requested || uniqueName("camera")
		const first = !settings.sources.some(x => x.type === "reolink")
		return { type: "reolink", name, enabled: true, host: b.host.trim(), username: b.username || "admin", passwordEnv: envName("REOLINK_PASSWORD", name, first), channel: 0, stream: b.stream ?? "main", protocol: "auto", rtspPort: 554, pollSeconds: 60, lookbackHours: b.lookbackHours ?? 24, capture: "auto", segmentSeconds: 6, motionGate: "both", closeUps: false }
	}
	if (b.type === "watch") {
		if (!b.dir?.startsWith("/")) return "Pick a folder first."
		const name = requested || uniqueName(slugName(b.dir.split("/").filter(Boolean).at(-1) ?? "folder") || "folder")
		return { type: "watch", name, enabled: true, dir: b.dir, extensions: [".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"], pollSeconds: 5, stableSeconds: 5, move: b.move ?? false }
	}
	if (!/^rtsps?:\/\/\S+$/i.test(b.url?.trim() ?? "")) return "That address should start with rtsp:// (for example rtsp://192.168.1.50:554/stream1)."
	const name = requested || uniqueName("camera")
	return { type: "rtsp", name, enabled: true, urlEnv: envName("LOOK4_RTSP_URL", name, false), segmentSeconds: b.segmentSeconds ?? 30 }
}

/** A made-up but plausible file system for the folder picker (directories and how many videos each holds). */
const TREE: Record<string, { dirs?: string[]; videos?: number }> = {
	"/": { dirs: ["home", "mnt"] },
	"/home": { dirs: ["david"] },
	"/home/david": { dirs: ["Downloads", "Videos", "look4", "projects"] },
	"/home/david/Downloads": { videos: 2 },
	"/home/david/Videos": { dirs: ["birds-2025"], videos: 4 },
	"/home/david/Videos/birds-2025": { videos: 37 },
	"/home/david/look4": { dirs: ["data", "web"] },
	"/home/david/look4/data": { dirs: ["inbox"] },
	"/home/david/look4/data/inbox": {},
	"/home/david/look4/web": {},
	"/home/david/projects": {},
	"/mnt": { dirs: ["c", "d"] },
	"/mnt/c": { dirs: ["Program Files", "Users", "Windows"] },
	"/mnt/c/Program Files": {},
	"/mnt/c/Windows": {},
	"/mnt/c/Users": { dirs: ["David", "Public"] },
	"/mnt/c/Users/Public": {},
	"/mnt/c/Users/David": { dirs: ["Desktop", "Documents", "Downloads", "Pictures", "Videos"] },
	"/mnt/c/Users/David/Desktop": { videos: 1 },
	"/mnt/c/Users/David/Documents": {},
	"/mnt/c/Users/David/Downloads": { videos: 6 },
	"/mnt/c/Users/David/Pictures": {},
	"/mnt/c/Users/David/Videos": { dirs: ["NVR", "Reolink"], videos: 3 },
	"/mnt/c/Users/David/Videos/NVR": { videos: 12 },
	"/mnt/c/Users/David/Videos/Reolink": { dirs: ["2026-10-13", "2026-10-14"] },
	"/mnt/c/Users/David/Videos/Reolink/2026-10-13": { videos: 61 },
	"/mnt/c/Users/David/Videos/Reolink/2026-10-14": { videos: 48 },
	"/mnt/d": { dirs: ["Backups"] },
	"/mnt/d/Backups": {}
}

const folderListing = (path: string): FolderListing | null => {
	const clean = path.length > 1 ? path.replace(/\/+$/, "") : path
	const node = TREE[clean]
	if (!node) return null
	const join2 = (a: string, b: string) => (a === "/" ? `/${b}` : `${a}/${b}`)
	return {
		path: clean,
		parent: clean === "/" ? null : clean.slice(0, clean.lastIndexOf("/")) || "/",
		shortcuts: [
			{ label: "Home", path: "/home/david" },
			{ label: "Videos", path: "/home/david/Videos" },
			{ label: "Downloads", path: "/home/david/Downloads" },
			{ label: "Windows Videos", path: "/mnt/c/Users/David/Videos" },
			{ label: "Windows Downloads", path: "/mnt/c/Users/David/Downloads" },
			{ label: "Windows Desktop", path: "/mnt/c/Users/David/Desktop" },
			{ label: "C: drive", path: "/mnt/c" }
		],
		dirs: (node.dirs ?? []).map(name => ({ name, path: join2(clean, name) })),
		videoCount: node.videos ?? 0
	}
}

const DISCOVERED = (): DiscoverResponse["cameras"] => {
	const configured = (host: string) => settings.sources.find(x => x.type === "reolink" && x.host === host)?.name ?? null
	return [
		{ host: "192.168.1.31", mac: "EC:71:DB:3A:91:0C", vendor: "reolink", ports: { ...NO_PORTS, reolinkApp: true }, configuredAs: configured("192.168.1.31") },
		{ host: "192.168.1.50", mac: "EC:71:DB:12:7F:A4", vendor: "reolink", ports: ALL_PORTS, configuredAs: configured("192.168.1.50") },
		{ host: "192.168.1.64", mac: "28:57:BE:0D:44:19", vendor: "unknown", ports: { ...NO_PORTS, http: true, rtsp: true, onvif: true }, configuredAs: null }
	]
}

const testCamera = (body: CameraTestBody): CameraTestResult => {
	// password omitted + source = test with that saved source's login, so Fix it never asks to retype it
	const b = body.password === undefined && body.source ? { ...body, password: secrets.get(body.source) ?? "" } : body
	const host = b.host.trim()
	const n = (testCounts.get(host) ?? 0) + 1
	testCounts.set(host, n)
	if (host === "10.0.0.9" || host.startsWith("10."))
		return { ok: false, problem: "unreachable", detail: `Nothing answered at ${host}. The camera may be off, on another network, or at a new address.`, ports: NO_PORTS }
	if (host === "192.168.1.1")
		return { ok: false, problem: "not-reolink", detail: `Something answered at ${host}, but it isn't a Reolink camera. It looks like your router.`, ports: { ...NO_PORTS, http: true, https: true } }
	if (host === "192.168.1.31" && n < 4)
		return { ok: false, problem: "http-disabled", detail: "Your camera is there, but its HTTPS setting is switched off, so look4 can't sign in to it yet.", ports: { ...NO_PORTS, reolinkApp: true } }
	if (b.password === "wrong") {
		// like RLC-8xx firmware since 2024: each wrong password counts down to a lockout
		wrongTries++
		return { ok: false, problem: "bad-credentials", detail: "The camera said that username or password is wrong.", ports: ALL_PORTS, protocol: "https", attemptsLeft: Math.max(0, 10 - wrongTries) }
	}
	if (b.password === "locked")
		return { ok: false, problem: "locked-out", detail: "The camera is refusing sign-ins for a few minutes after too many wrong passwords.", ports: ALL_PORTS, protocol: "https", retryAfterSeconds: 90 }
	return {
		ok: true,
		problem: null,
		detail: "Signed in to the camera.",
		model: "RLC-823S1",
		firmware: "v3.1.0.4054_2408191440",
		name: host === "192.168.1.31" ? "Backyard" : "Front porch",
		protocol: "https",
		// .31 is the fresh-from-the-box camera: RTSP stays off until the probe walkthrough turns it on
		ports: host === "192.168.1.31" ? { ...ALL_PORTS, rtsp: false } : ALL_PORTS
	}
}

let wrongTries = 0
/** Like the real server: a saved password only ever goes to the address it was saved for. */
const newAddress = (host: string, name: string) =>
	`${host} is a new address for “${name}”, so type the camera's password again. look4 only sends the saved password to the address it was saved for.`
const probeCounts = new Map<string, number>()
/** Mirrors POST /api/setup/probe. 192.168.1.31's RTSP comes on at the third check, so the walkthrough turns green. */
const probe = (host: string): ProbeResult => {
	const n = (probeCounts.get(host) ?? 0) + 1
	probeCounts.set(host, n)
	if (host.startsWith("10.")) return { host, ports: NO_PORTS }
	if (host === "192.168.1.31") return { host, ports: { ...ALL_PORTS, rtsp: n >= 3 } }
	return { host, ports: ALL_PORTS }
}

/** Mirrors POST /api/setup/test-rtsp: one frame grab, before anything is saved. */
const testRtsp = (url: string): RtspTestResult => {
	if (!/^rtsps?:\/\/\S+$/i.test(url)) return { ok: false, detail: "That address should start with rtsp:// (for example rtsp://192.168.1.50:554/stream1)." }
	if (/10\.0\.0\.9|bad/i.test(url)) return { ok: false, detail: "Nothing answered at that address. Check the camera is on and the address is right." }
	if (/:wrong@/i.test(url)) return { ok: false, detail: "The camera said the username or password in the address is wrong." }
	const scene = readyScenes.find(x => x.key === "reolink") ?? readyScenes[0]
	const preview = scene ? `data:image/jpeg;base64,${readFileSync(join(sceneDir(scene), "poster.jpg")).toString("base64")}` : undefined
	return { ok: true, detail: "Got a picture from the camera.", width: 3840, height: 2160, codec: "h264", preview }
}

const sourceSnapshot = (c: SourceConfig) => {
	if (isBroken(c) || isPaused(c.name)) return null
	const own = rows.find(r => r.clip.source === c.name && r.scene)?.scene
	const scene = (c.type === "watch" ? own : null) ?? readyScenes.find(x => x.key === "reolink") ?? readyScenes[0]
	return scene ? join(sceneDir(scene), "poster.jpg") : null
}

/** Every /api/setup, /api/sources and /api/fs route. Returns false when the request is not one of them. */
const routeSetup = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
	const p = url.pathname
	const m = req.method ?? "GET"
	let match: RegExpExecArray | null
	if (p === "/api/setup" && m === "GET") return send(res, 200, setupStatus()), true
	if (p === "/api/setup/complete" && m === "POST") {
		const body = await readJson<CompleteSetupBody>(req)
		setupCompleted = true
		if (body.uploadOnly) uploadOnly = true
		return send(res, 200, setupStatus()), true
	}
	if (p === "/api/setup/discover" && m === "POST") {
		await sleep(2600)
		const out: DiscoverResponse = args["no-cameras"]
			? { cameras: [], scannedSubnets: ["192.168.1.0/24"], note: null }
			: { cameras: DISCOVERED(), scannedSubnets: ["192.168.1.0/24"], note: null }
		return send(res, 200, out), true
	}
	if (p === "/api/setup/test-camera" && m === "POST") {
		const body = await readJson<CameraTestBody>(req)
		if (!body.host?.trim()) return send(res, 400, { error: "Type the camera's address first." }), true
		const saved = body.source ? settings.sources.find(x => x.name === body.source) : undefined
		if (body.password === undefined && saved?.type === "reolink" && saved.host !== body.host.trim()) return send(res, 400, { error: newAddress(body.host.trim(), saved.name) }), true
		await sleep(900)
		return send(res, 200, testCamera(body)), true
	}
	if (p === "/api/setup/probe" && m === "POST") {
		const body = await readJson<ProbeBody>(req)
		await sleep(400)
		return send(res, 200, probe(body.host.trim())), true
	}
	if (p === "/api/live" && m === "GET") {
		// no video here: scripts/live-demo.ts runs the real live view against fake cameras
		const out: LiveSourceDto[] = settings.sources.flatMap(c =>
			c.type === "watch"
				? []
				: [{ name: c.name, type: c.type, feed: null, streams: [], defaultStream: "main" as const, problem: null, detail: "The UI mock has no live video. Run scripts/live-demo.ts for that.", controllable: false, host: null, aliases: [], recording: false }]
		)
		return send(res, 200, out), true
	}
	if (p === "/api/setup/test-rtsp" && m === "POST") {
		const body = await readJson<RtspTestBody>(req)
		await sleep(1100)
		return send(res, 200, testRtsp(body.url?.trim() ?? "")), true
	}
	if (p === "/api/setup/judge-key" && m === "POST") {
		const body = await readJson<JudgeKeyBody>(req)
		await sleep(700)
		if (!/^sk-ant-[\w-]{8,}$/.test(body.apiKey?.trim() ?? ""))
			return send(res, 400, { error: "That doesn't look like an Anthropic API key. Keys start with “sk-ant-”." }), true
		args.judge = "anthropic"
		return send(res, 200, setupStatus()), true
	}
	if (p === "/api/fs/list" && m === "GET") {
		const path = url.searchParams.get("path") || "/home/david"
		if (!path.startsWith("/")) return send(res, 400, { error: "path must be absolute" }), true
		const listing = folderListing(path)
		if (!listing) return send(res, 404, { error: `There's no folder at ${path}` }), true
		return send(res, 200, listing), true
	}
	// screenshot hook, not part of the contract: flip what the judge looks like without restarting
	if (p === "/api/__mock/judge" && m === "POST") {
		args.judge = url.searchParams.get("provider") ?? "claude-code"
		return send(res, 200, judgeStatus()), true
	}
	// screenshot hook: a sighting right now (the new-sighting glow, the first-sighting celebration)
	if (p === "/api/__mock/sighting" && m === "POST") {
		const id = fakeSighting()
		return send(res, id ? 200 : 409, id ? { clipId: id } : { error: "needs an enabled lookout and a fixture video" }), true
	}
	if (p === "/api/sources" && m === "GET") return send(res, 200, settings.sources.map(sourceDto)), true
	if (p === "/api/sources" && m === "POST") {
		const body = await readJson<AddSourceBody>(req)
		await sleep(500)
		const c = configFromBody(body)
		if (typeof c === "string") return send(res, c.startsWith("There's already") ? 409 : 400, { error: c }), true
		if (body.type === "reolink") secrets.set(c.name, body.password ?? "")
		if (body.type === "rtsp") secrets.set(c.name, body.url)
		settings.sources.push(c)
		startSource(c)
		return send(res, 201, sourceDto(c)), true
	}
	if ((match = /^\/api\/sources\/([^/]+)(?:\/(snapshot))?$/.exec(p))) {
		const name = decodeURIComponent(match[1] ?? "")
		const i = settings.sources.findIndex(x => x.name === name)
		const c = settings.sources[i]
		if (!c) return send(res, 404, { error: `There's no source called “${name}”.` }), true
		if (m === "GET" && match[2] === "snapshot") {
			await sleep(600)
			const file = sourceSnapshot(c)
			if (!file) return send(res, 502, { error: isPaused(name) ? `${name} is paused.` : "Couldn't get a picture: the camera didn't answer." }), true
			return sendFile(req, res, file), true
		}
		if (m === "PATCH" && !match[2]) {
			const b = await readJson<UpdateSourceBody>(req)
			await sleep(400)
			let next: SourceConfig = c
			if (c.type === "reolink" && b.host && b.host !== c.host && b.password === undefined) return send(res, 400, { error: newAddress(b.host, c.name) }), true
			if (c.type === "reolink")
				next = { ...c, ...(b.host ? { host: b.host } : {}), ...(b.username ? { username: b.username } : {}), ...(b.stream ? { stream: b.stream } : {}), ...(b.capture ? { capture: b.capture } : {}), ...(b.motionGate ? { motionGate: b.motionGate } : {}) }
			if (c.type === "watch") next = { ...c, ...(b.dir ? { dir: b.dir } : {}), ...(b.move !== undefined ? { move: b.move } : {}) }
			if (c.type === "rtsp" && b.url) {
				if (!/^rtsps?:\/\/\S+$/i.test(b.url)) return send(res, 400, { error: "That address should start with rtsp://" }), true
				secrets.set(c.name, b.url)
			}
			if (b.password !== undefined) secrets.set(c.name, b.password)
			if (b.enabled !== undefined) next = { ...next, enabled: b.enabled }
			settings.sources[i] = next
			if (!next.enabled) {
				pulls.set(name, (pulls.get(name) ?? 0) + 1)
				setStatus(name, { state: "stopped", detail: "Paused. Nothing new is pulled until you resume it." })
			} else {
				startSource(next)
			}
			return send(res, 200, sourceDto(next)), true
		}
		if (m === "DELETE" && !match[2]) {
			settings.sources.splice(i, 1)
			pulls.set(name, (pulls.get(name) ?? 0) + 1)
			const si = sources.findIndex(x => x.name === name)
			if (si >= 0) sources.splice(si, 1)
			return send(res, 200, { ok: true }), true
		}
	}
	return false
}

const route = async (req: IncomingMessage, res: ServerResponse, scenes: Scene[]) => {
	const url = new URL(req.url ?? "/", "http://x")
	const p = url.pathname
	const m = req.method ?? "GET"
	let match: RegExpExecArray | null

	if (await routeSetup(req, res, url)) return
	if (m === "GET" && p === "/api/stats") return send(res, 200, stats())
	if (m === "GET" && p === "/api/sightings") {
		const lk = url.searchParams.get("lookout")
		return send(res, 200, paginate(rows.filter(r => isSighting(r) && (!lk || matchesOf(r).some(x => x.lookoutId === lk))), url))
	}
	if (m === "GET" && p === "/api/clips") {
		const q = url.searchParams
		const list = rows.filter(
			r =>
				(!q.get("status") || r.clip.status === q.get("status")) &&
				(!q.get("droppedAt") || r.clip.droppedAt === q.get("droppedAt")) &&
				(!q.get("source") || r.clip.source === q.get("source"))
		)
		return send(res, 200, paginate(list, url))
	}
	if ((match = /^\/api\/clips\/([^/]+)(?:\/(label|reprocess|confirm))?$/.exec(p))) {
		const id = decodeURIComponent(match[1] ?? "")
		const r = rows.find(x => x.clip.id === id)
		if (!r) return send(res, 404, { error: `clip ${id} not found` })
		if (m === "GET" && !match[2]) return send(res, 200, detail(r))
		if (m === "DELETE" && !match[2]) {
			rows.splice(rows.indexOf(r), 1)
			return send(res, 200, { ok: true })
		}
		if (m === "POST" && match[2] === "confirm") {
			const body = await readJson<ConfirmClipBody>(req)
			const s = summary(r)
			const species = body.species?.trim() || s.newSpecies || s.matches.find(x => x.species)?.species || null
			if (!s.matches.length && !species) return send(res, 400, { error: "name the bird: no lookout kept this clip and the spotter named no species" })
			for (const x of s.matches) {
				r.labels = r.labels.filter(l => l.lookoutId !== x.lookoutId)
				r.labels.push({ clipId: id, lookoutId: x.lookoutId, truth: true, createdAt: iso(now()) })
			}
			let added: string | null = null
			if (species && !onLifeList(species)) {
				lifeList.push({ species, clipId: id, firstSeenAt: r.clip.recordedAt, addedAt: iso(now()) })
				added = species
				emit({ event: "lifelist", data: { species } })
			}
			return send(res, 200, { clip: summary(r), added } satisfies ConfirmClipResponse)
		}
		if (m === "POST" && match[2] === "label") {
			const body = await readJson<LabelBody>(req)
			r.labels = r.labels.filter(l => l.lookoutId !== body.lookoutId)
			if (body.truth !== null) r.labels.push({ clipId: id, lookoutId: body.lookoutId, truth: body.truth, createdAt: iso(now()) })
			r.clip.expiresAt = r.labels.length || r.clip.status === "kept" ? null : r.clip.expiresAt
			return send(res, 200, detail(r))
		}
		if (m === "POST" && match[2] === "reprocess") {
			r.clip.status = "pending"
			queue = { ...queue, pending: queue.pending + 1 }
			emit({ event: "queue", data: queue })
			setTimeout(() => finishClip(r, scenes), 1500)
			return send(res, 200, { ok: true })
		}
	}
	if (p === "/api/life-list" && m === "GET") return send(res, 200, lifeListBody())
	if (p === "/api/life-list" && m === "POST") {
		const body = await readJson<AddLiferBody>(req)
		const species = body.species?.trim()
		if (!species) return send(res, 400, { error: "species must be a non-empty string" })
		if (onLifeList(species)) return send(res, 409, { error: `${species} is already on your life list` })
		const clip = body.clipId ? rows.find(r => r.clip.id === body.clipId) : undefined
		const seenAt = body.seenAt && /^\d{4}-\d{2}-\d{2}$/.test(body.seenAt) ? `${body.seenAt}T12:00:00.000Z` : body.seenAt
		lifeList.push({ species, clipId: clip?.clip.id ?? null, firstSeenAt: seenAt ?? clip?.clip.recordedAt ?? null, addedAt: iso(now()) })
		emit({ event: "lifelist", data: { species } })
		return send(res, 201, lifeListBody())
	}
	if ((match = /^\/api\/life-list\/([^/]+)$/.exec(p)) && m === "DELETE") {
		const species = decodeURIComponent(match[1] ?? "")
		const i = lifeList.findIndex(e => e.species.toLowerCase() === species.toLowerCase())
		if (i === -1) return send(res, 404, { error: `${species} is not on your life list` })
		lifeList.splice(i, 1)
		emit({ event: "lifelist", data: { species } })
		return send(res, 200, lifeListBody())
	}
	if (p === "/api/lookouts" && m === "GET") return send(res, 200, lookouts.map(lookoutDto))
	if (p === "/api/lookouts" && m === "POST") {
		const body = await readJson<CreateLookoutBody>(req)
		if (!body.prompt?.trim()) return send(res, 400, { error: "prompt is required" })
		await new Promise(r => setTimeout(r, 500))
		const c = compile(body.prompt)
		const name = body.name ?? c.summary.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32)
		if (lookouts.some(l => l.name === name)) return send(res, 409, { error: `a lookout named "${name}" already exists` })
		const l = makeLookout(name, body.prompt.trim(), body.threshold ?? 0.6, body.enabled ?? true, 0)
		lookouts.push(l)
		emit({ event: "lookout", data: { lookoutId: l.id } })
		return send(res, 201, lookoutDto(l))
	}
	if (p === "/api/lookouts/preview" && m === "POST") {
		const body = await readJson<{ prompt: string }>(req)
		await new Promise(r => setTimeout(r, 450))
		return send(res, 200, compile(body.prompt ?? ""))
	}
	if ((match = /^\/api\/lookouts\/([^/]+)(?:\/(backfill))?$/.exec(p))) {
		const l = lookoutById(decodeURIComponent(match[1] ?? ""))
		if (!l) return send(res, 404, { error: "lookout not found" })
		if (m === "PATCH") {
			const body = await readJson<UpdateLookoutBody>(req)
			if (body.name !== undefined) l.name = body.name
			if (body.threshold !== undefined) {
				l.threshold = body.threshold
				redecide(l)
			}
			if (body.enabled !== undefined) l.enabled = body.enabled
			if (body.prompt !== undefined) {
				l.prompt = body.prompt
				l.compiled = compile(body.prompt)
			}
			if (body.queries && l.compiled) l.compiled = { ...l.compiled, queries: body.queries, compiler: "manual" }
			l.updatedAt = iso(now())
			return send(res, 200, lookoutDto(l))
		}
		if (m === "DELETE") {
			lookouts.splice(lookouts.indexOf(l), 1)
			for (const r of rows) r.verdicts = r.verdicts.filter(v => v.lookoutId !== l.id)
			return send(res, 200, { ok: true })
		}
		if (m === "POST" && match[2] === "backfill") {
			const body = await readJson<{ since?: string }>(req)
			const queued = rows.filter(r => r.clip.path && (!body.since || r.clip.recordedAt >= body.since)).length
			return send(res, 200, { queued })
		}
	}
	if (p === "/api/settings" && m === "GET") return send(res, 200, { ...settings, roi })
	if (p === "/api/settings" && m === "PATCH") {
		const body = await readJson<SettingsPatch>(req)
		if (body.roi !== undefined) roi = body.roi
		if (body.motion) Object.assign(settings.motion, body.motion)
		if (body.detector) Object.assign(settings.detector, body.detector)
		if (body.judge) Object.assign(settings.judge, body.judge)
		if (body.retention) Object.assign(settings.retention, body.retention)
		if (body.alerts) Object.assign(settings.alerts, body.alerts)
		return send(res, 200, { ...settings, roi })
	}
	if (p === "/api/snapshot" && m === "GET") {
		const newest = rows.find(r => r.scene && r.clip.media.poster)
		if (!newest?.scene) {
			res.writeHead(204, { "Cache-Control": "no-cache" })
			return res.end()
		}
		return sendFile(req, res, join(sceneDir(newest.scene), "poster.jpg"))
	}
	if (p === "/api/upload" && m === "POST") {
		const name = url.searchParams.get("name") ?? "upload.mp4"
		const body = await readBody(req)
		if (!body.length) return send(res, 400, { error: "empty upload" })
		if (!/\.(mp4|mov|mkv|avi|webm|m4v)$/i.test(name)) return send(res, 415, { error: `${name} is not a video` })
		const scene = scenes[Math.floor(rand() * Math.min(4, scenes.length))] ?? null
		const r = addClip({ at: now(), scene, source: "upload", status: "pending", originalName: name })
		rows.sort((a, b) => b.clip.recordedAt.localeCompare(a.clip.recordedAt))
		queue = { ...queue, pending: queue.pending + 1 }
		emit({ event: "queue", data: queue })
		setTimeout(() => finishClip(r, scenes), 1200)
		const out: UploadResponse = { clips: [summary(r)] }
		return send(res, 200, out)
	}
	if ((match = /^\/api\/sources\/([^/]+)\/poll$/.exec(p)) && m === "POST") {
		const s = sources.find(x => x.name === decodeURIComponent(match?.[1] ?? ""))
		if (!s) return send(res, 404, { error: "unknown source" })
		await new Promise(r => setTimeout(r, 700))
		s.lastPollAt = iso(now())
		emit({ event: "source", data: s })
		return send(res, 200, { ok: true })
	}
	if (p === "/api/events" && m === "GET") {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
		res.write(": hello\n\n")
		clients.add(res)
		req.on("close", () => clients.delete(res))
		return
	}
	if ((match = /^\/media\/([^/]+)\/(poster\.jpg|preview\.mp4|crop-\d+\.jpg|original)$/.exec(p))) {
		const r = rows.find(x => x.clip.id === match?.[1])
		if (!r?.scene) return send(res, 404, { error: "not found" })
		if (match[2] === "original") return sendFile(req, res, join(fixtures, r.scene.file))
		return sendFile(req, res, join(sceneDir(r.scene), match[2] ?? ""))
	}
	if (p.startsWith("/api/")) return send(res, 404, { error: `no route for ${m} ${p}` })
	res.writeHead(200, { "content-type": "text/html" })
	res.end("<p>look4 mock API. Run Vite (<code>npx vite</code>) for the UI.</p>")
}

// ---------- main ----------

const scenes = prepareMedia()
readyScenes = scenes
if (!scenes.length) console.warn("mock-api: no fixture videos in test/fixtures/videos; thumbnails will be empty")
if (!emptyStart) seedData(scenes)

const server = createServer((req, res) => {
	route(req, res, scenes).catch(e => {
		console.error(e)
		if (!res.headersSent) send(res, 500, { error: String(e) })
	})
})
server.listen(Number(args.port), args.host, () => console.log(`mock-api: http://${args.host}:${args.port} (${rows.length} clips, ${lookouts.length} lookouts)`))

setInterval(() => {
	for (const c of clients) c.write(": heartbeat\n\n")
}, 15_000)

if (!args["quiet-live"]) {
	// Queue churn and an occasional sighting, so the live dot, queue badge and highlight get exercised.
	setInterval(() => {
		queue = { pending: Math.floor(rand() * 4), processing: rand() > 0.5 ? 1 : 0 }
		emit({ event: "queue", data: queue })
	}, 9_000)
	setInterval(fakeSighting, 40_000)
}
