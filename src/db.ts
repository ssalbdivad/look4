import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import type {
	Clip,
	ClipMedia,
	ClipStatus,
	CompiledLookout,
	Detection,
	Label,
	LifeListEntry,
	Lookout,
	MotionResult,
	Stage,
	Usage,
	Verdict
} from "./types.ts"

const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS clips (
	id TEXT PRIMARY KEY,
	source TEXT NOT NULL,
	source_ref TEXT,
	original_name TEXT NOT NULL,
	path TEXT,
	size_bytes INTEGER NOT NULL,
	sha256 TEXT NOT NULL,
	recorded_at TEXT NOT NULL,
	ingested_at TEXT NOT NULL,
	duration_s REAL,
	width INTEGER,
	height INTEGER,
	status TEXT NOT NULL,
	dropped_at TEXT,
	reason TEXT,
	motion_json TEXT,
	timings_json TEXT NOT NULL DEFAULT '{}',
	error TEXT,
	processed_at TEXT,
	expires_at TEXT,
	pending_lookouts TEXT,
	media_json TEXT NOT NULL DEFAULT '{"poster":null,"preview":null,"crops":[]}'
);
CREATE UNIQUE INDEX IF NOT EXISTS clips_sha ON clips(sha256);
CREATE INDEX IF NOT EXISTS clips_status ON clips(status, recorded_at);
CREATE INDEX IF NOT EXISTS clips_recorded ON clips(recorded_at);
CREATE UNIQUE INDEX IF NOT EXISTS clips_source_ref ON clips(source, source_ref) WHERE source_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS lookouts (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	prompt TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1,
	threshold REAL NOT NULL DEFAULT 0.6,
	compiled_json TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS detections (
	clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
	frame_t REAL NOT NULL,
	label TEXT NOT NULL,
	score REAL NOT NULL,
	box_json TEXT NOT NULL,
	via TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS detections_clip ON detections(clip_id);

CREATE TABLE IF NOT EXISTS verdicts (
	clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
	lookout_id TEXT NOT NULL REFERENCES lookouts(id) ON DELETE CASCADE,
	match INTEGER NOT NULL,
	confidence REAL NOT NULL,
	label TEXT,
	rationale TEXT NOT NULL,
	model TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (clip_id, lookout_id)
);
CREATE INDEX IF NOT EXISTS verdicts_lookout ON verdicts(lookout_id, match);

CREATE TABLE IF NOT EXISTS labels (
	clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
	lookout_id TEXT NOT NULL REFERENCES lookouts(id) ON DELETE CASCADE,
	truth INTEGER NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (clip_id, lookout_id)
);

CREATE TABLE IF NOT EXISTS usage (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ts TEXT NOT NULL,
	clip_id TEXT,
	purpose TEXT NOT NULL,
	backend TEXT NOT NULL,
	model TEXT NOT NULL,
	input_tokens INTEGER NOT NULL,
	output_tokens INTEGER NOT NULL,
	cache_read_tokens INTEGER NOT NULL,
	cost_usd REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);

CREATE TABLE IF NOT EXISTS kv (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS life_list (
	species TEXT PRIMARY KEY COLLATE NOCASE,
	first_seen_at TEXT,
	clip_id TEXT REFERENCES clips(id) ON DELETE SET NULL,
	added_at TEXT NOT NULL
);
`

/**
 * When a verdict keeps its clip. A judge's confidence must clear the lookout's threshold.
 * A detector-only verdict (no judge configured) carries the raw detector score, which
 * already cleared `pipeline.detector.threshold` to exist at all and lives on a different
 * scale (real birds score from ~0.5), so its match alone keeps the clip.
 * `KEEPS_SQL` is the same rule for queries joining `verdicts v` and `lookouts l`.
 */
export const DETECTOR_ONLY = "detector-only"
export const verdictKeeps = (v: Pick<Verdict, "match" | "confidence" | "model">, l: Pick<Lookout, "threshold">) =>
	v.match && (v.model === DETECTOR_ONLY || v.confidence >= l.threshold)
export const KEEPS_SQL = `(v.match = 1 AND (v.model = '${DETECTOR_ONLY}' OR v.confidence >= l.threshold))`

/** Whether a process is still running; a process we may not signal still exists. */
const alive = (pid: number) => {
	try {
		process.kill(pid, 0)
		return true
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM"
	}
}

/**
 * A `processing` claim names its process by pid, and a pid alone proves little: after a reboot
 * (WSL restarts often) the dead server's pid can belong to any live process, and the claim would
 * then hold its clip forever. So each process with the store open keeps a heartbeat in kv, and a
 * claim is live only while its pid runs, its heartbeat is fresh, and that process had started by
 * the time of the claim (so a later process given the same pid does not inherit it).
 */
const HEARTBEAT_MS = 30_000
const HEARTBEAT_STALE_MS = 3 * HEARTBEAT_MS
const PROCESS_STARTED = Math.floor(performance.timeOrigin)
const heartbeatKey = (pid: number) => `proc:${pid}`
type Heartbeat = { startedAt: number; beat: number }

const now = () => new Date().toISOString()
const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v))
const parse = <t>(s: unknown, fallback: t): t => (typeof s === "string" ? (JSON.parse(s) as t) : fallback)

type Row = Record<string, SQLInputValue>

/** No human label says this verdict's lookout is not what the clip shows. */
const NOT_REFUTED = "NOT EXISTS (SELECT 1 FROM labels b WHERE b.clip_id = v.clip_id AND b.lookout_id = v.lookout_id AND b.truth = 0)"

const clipFromRow = (r: Row): Clip => ({
	id: r.id as string,
	source: r.source as string,
	sourceRef: (r.source_ref as string | null) ?? null,
	originalName: r.original_name as string,
	path: (r.path as string | null) ?? null,
	sizeBytes: Number(r.size_bytes),
	sha256: r.sha256 as string,
	recordedAt: r.recorded_at as string,
	ingestedAt: r.ingested_at as string,
	durationS: (r.duration_s as number | null) ?? null,
	width: r.width == null ? null : Number(r.width),
	height: r.height == null ? null : Number(r.height),
	status: r.status as ClipStatus,
	droppedAt: (r.dropped_at as Stage | null) ?? null,
	reason: (r.reason as string | null) ?? null,
	motion: parse<MotionResult | null>(r.motion_json, null),
	timings: parse<Clip["timings"]>(r.timings_json, {}),
	error: (r.error as string | null) ?? null,
	processedAt: (r.processed_at as string | null) ?? null,
	expiresAt: (r.expires_at as string | null) ?? null,
	pendingLookouts: parse<string[] | null>(r.pending_lookouts, null),
	media: parse<ClipMedia>(r.media_json, { poster: null, preview: null, crops: [] })
})

const lookoutFromRow = (r: Row): Lookout => ({
	id: r.id as string,
	name: r.name as string,
	prompt: r.prompt as string,
	enabled: Number(r.enabled) === 1,
	threshold: Number(r.threshold),
	compiled: parse<CompiledLookout | null>(r.compiled_json, null),
	createdAt: r.created_at as string,
	updatedAt: r.updated_at as string
})

const verdictFromRow = (r: Row): Verdict => ({
	clipId: r.clip_id as string,
	lookoutId: r.lookout_id as string,
	match: Number(r.match) === 1,
	confidence: Number(r.confidence),
	label: (r.label as string | null) ?? null,
	species: (r.species as string | null) ?? null,
	speciesConfidence: r.species_confidence == null ? null : Number(r.species_confidence),
	rationale: r.rationale as string,
	model: r.model as string,
	createdAt: r.created_at as string
})

const detectionFromRow = (r: Row): Detection => ({
	clipId: r.clip_id as string,
	frameT: Number(r.frame_t),
	label: r.label as string,
	score: Number(r.score),
	box: JSON.parse(r.box_json as string),
	via: r.via as Detection["via"]
})

const lifeListEntryFromRow = (r: Row): LifeListEntry => ({
	species: r.species as string,
	firstSeenAt: (r.first_seen_at as string | null) ?? null,
	clipId: (r.clip_id as string | null) ?? null,
	addedAt: r.added_at as string
})

const labelFromRow = (r: Row): Label => ({
	clipId: r.clip_id as string,
	lookoutId: r.lookout_id as string,
	truth: Number(r.truth) === 1,
	species: (r.species as string | null) ?? null,
	createdAt: r.created_at as string
})

/** Columns a caller may patch, mapped to how they are stored. */
const clipColumns: { [k in keyof Clip]?: [column: string, encode: (v: any) => SQLInputValue] } = {
	source: ["source", v => v],
	sourceRef: ["source_ref", v => v],
	originalName: ["original_name", v => v],
	path: ["path", v => v],
	sizeBytes: ["size_bytes", v => v],
	recordedAt: ["recorded_at", v => v],
	durationS: ["duration_s", v => v],
	width: ["width", v => v],
	height: ["height", v => v],
	status: ["status", v => v],
	droppedAt: ["dropped_at", v => v],
	reason: ["reason", v => v],
	motion: ["motion_json", json],
	timings: ["timings_json", json],
	error: ["error", v => v],
	processedAt: ["processed_at", v => v],
	expiresAt: ["expires_at", v => v],
	pendingLookouts: ["pending_lookouts", json],
	media: ["media_json", json]
}

export type NewClip = Pick<Clip, "id" | "source" | "sourceRef" | "originalName" | "path" | "sizeBytes" | "sha256" | "recordedAt">

export type ClipQuery = {
	status?: ClipStatus | ClipStatus[]
	source?: string
	droppedAt?: Stage
	/** Only clips with a verdict for this lookout (any outcome). */
	lookoutId?: string
	/** Keyset pagination: clips recorded strictly before this ISO time. */
	before?: string
	/** Clips recorded at or after this ISO time. */
	since?: string
	limit?: number
}

export type Funnel = {
	ingested: number
	pending: number
	processing: number
	errors: number
	/** Clips that got past each stage. */
	passed: { motion: number; detect: number }
	kept: number
	/** Rejections by the stage that made them. */
	droppedAt: Record<Stage, number>
}

export type Store = ReturnType<typeof openStore>

export const openStore = (path: string) => {
	const db = new DatabaseSync(path)
	db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
	db.exec(SCHEMA)
	const stmt = (sql: string) => db.prepare(sql)
	const all = (sql: string, ...params: SQLInputValue[]) => stmt(sql).all(...params) as Row[]
	// which process holds a `processing` clip, so a second look4 process (a scan beside the server)
	// only takes back the clips of one that died
	const columns = new Set(all("PRAGMA table_info(clips)").map(c => c.name as string))
	if (!columns.has("claimed_by")) db.exec("ALTER TABLE clips ADD COLUMN claimed_by INTEGER")
	if (!columns.has("claimed_at")) db.exec("ALTER TABLE clips ADD COLUMN claimed_at INTEGER")
	const verdictColumns = new Set(all("PRAGMA table_info(verdicts)").map(c => c.name as string))
	if (!verdictColumns.has("species")) db.exec("ALTER TABLE verdicts ADD COLUMN species TEXT")
	if (!verdictColumns.has("species_confidence")) db.exec("ALTER TABLE verdicts ADD COLUMN species_confidence REAL")
	// on a "no": what the bird really was, when the person said ("Wrong bird")
	if (!new Set(all("PRAGMA table_info(labels)").map(c => c.name as string)).has("species")) db.exec("ALTER TABLE labels ADD COLUMN species TEXT")
	const get = (sql: string, ...params: SQLInputValue[]) => stmt(sql).get(...params) as Row | undefined
	const getKv = <t>(key: string): t | null => {
		const r = get("SELECT value FROM kv WHERE key = ?", key)
		return r ? (JSON.parse(r.value as string) as t) : null
	}
	const setKv = (key: string, value: unknown) => {
		stmt("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value))
	}

	const beat = () => {
		try {
			setKv(heartbeatKey(process.pid), { startedAt: PROCESS_STARTED, beat: Date.now() } satisfies Heartbeat)
		} catch {
			// a full disk or a lock held too long: the next beat tries again, and a missed one only
			// lets another process take this one's clips after HEARTBEAT_STALE_MS
		}
	}
	beat()
	const heartbeat = setInterval(beat, HEARTBEAT_MS)
	heartbeat.unref()

	/** Whether the process that claimed a `processing` clip may still be working on it. */
	const claimLive = (r: Row) => {
		if (r.claimed_by == null || r.claimed_at == null) return false
		const pid = Number(r.claimed_by)
		const at = Number(r.claimed_at)
		if (pid === process.pid) return at >= PROCESS_STARTED
		if (!alive(pid)) return false
		const hb = getKv<Heartbeat>(heartbeatKey(pid))
		return !!hb && Date.now() - hb.beat < HEARTBEAT_STALE_MS && hb.startedAt <= at
	}

	/** Runs `fn` atomically. Nested calls join the outer transaction. */
	const transaction = <t>(fn: () => t): t => {
		if (db.isTransaction) return fn()
		db.exec("BEGIN IMMEDIATE")
		try {
			const result = fn()
			db.exec("COMMIT")
			return result
		} catch (e) {
			db.exec("ROLLBACK")
			throw e
		}
	}

	const getClip = (id: string) => {
		const r = get("SELECT * FROM clips WHERE id = ?", id)
		return r ? clipFromRow(r) : null
	}

	const updateClip = (id: string, patch: Partial<Clip>) => {
		const sets: string[] = []
		const values: SQLInputValue[] = []
		for (const [key, value] of Object.entries(patch)) {
			const col = clipColumns[key as keyof Clip]
			if (!col) throw new Error(`clip field "${key}" cannot be updated`)
			sets.push(`${col[0]} = ?`)
			values.push(value === undefined ? null : col[1](value))
		}
		if (sets.length) stmt(`UPDATE clips SET ${sets.join(", ")} WHERE id = ?`).run(...values, id)
		const clip = getClip(id)
		if (!clip) throw new Error(`no clip ${id}`)
		return clip
	}

	const clipWhere = (q: ClipQuery) => {
		const where: string[] = []
		const params: SQLInputValue[] = []
		if (q.status) {
			const list = Array.isArray(q.status) ? q.status : [q.status]
			where.push(`c.status IN (${list.map(() => "?").join(",")})`)
			params.push(...list)
		}
		if (q.source) {
			where.push("c.source = ?")
			params.push(q.source)
		}
		if (q.droppedAt) {
			where.push("c.dropped_at = ?")
			params.push(q.droppedAt)
		}
		if (q.lookoutId) {
			where.push("EXISTS (SELECT 1 FROM verdicts v WHERE v.clip_id = c.id AND v.lookout_id = ?)")
			params.push(q.lookoutId)
		}
		if (q.before) {
			where.push("c.recorded_at < ?")
			params.push(q.before)
		}
		if (q.since) {
			where.push("c.recorded_at >= ?")
			params.push(q.since)
		}
		return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params }
	}

	return {
		db,
		transaction,
		close: () => {
			clearInterval(heartbeat)
			try {
				stmt("DELETE FROM kv WHERE key = ?").run(heartbeatKey(process.pid))
			} catch {}
			db.close()
		},

		// ---- clips ----

		insertClip: (c: NewClip): Clip => {
			stmt(
				`INSERT INTO clips (id, source, source_ref, original_name, path, size_bytes, sha256, recorded_at, ingested_at, status)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
			).run(c.id, c.source, c.sourceRef, c.originalName, c.path, c.sizeBytes, c.sha256, c.recordedAt, now())
			return getClip(c.id)!
		},
		getClip,
		updateClip,
		/**
		 * Removes the row and its detections, verdicts and labels (cascade), and the kv rows keyed by it
		 * (`gate:<id>` and `pin:<id>`, see gateKey and pinKey in pipeline/process.ts). Usage rows stay: that money was spent.
		 */
		deleteClip: (id: string) => {
			stmt("DELETE FROM clips WHERE id = ?").run(id)
			stmt("DELETE FROM kv WHERE key IN (?, ?)").run(`gate:${id}`, `pin:${id}`)
		},
		findClipBySha: (sha256: string) => {
			const r = get("SELECT * FROM clips WHERE sha256 = ?", sha256)
			return r ? clipFromRow(r) : null
		},
		findClipBySourceRef: (source: string, sourceRef: string) => {
			const r = get("SELECT * FROM clips WHERE source = ? AND source_ref = ?", source, sourceRef)
			return r ? clipFromRow(r) : null
		},
		/** Atomically takes the newest pending clip (recent events first) and marks it processing. */
		claimNextPending: (): Clip | null =>
			transaction(() => {
				const r = get("SELECT * FROM clips WHERE status = 'pending' ORDER BY recorded_at DESC LIMIT 1")
				if (!r) return null
				stmt("UPDATE clips SET status = 'processing', claimed_by = ?, claimed_at = ? WHERE id = ?").run(process.pid, Date.now(), r.id as string)
				return { ...clipFromRow(r), status: "processing" as const }
			}),
		/**
		 * Takes one clip for processing now, whatever its status (a scan re-checking a file),
		 * with `pendingLookouts` for the run. Null when a live process is already processing it;
		 * a claim whose process is gone (a crashed server) is taken over.
		 */
		claimClip: (id: string, pendingLookouts: string[] | null): Clip | null =>
			transaction(() => {
				const r = get("SELECT status, claimed_by, claimed_at FROM clips WHERE id = ?", id)
				if (!r || (r.status === "processing" && claimLive(r))) return null
				stmt("UPDATE clips SET status = 'processing', pending_lookouts = ?, claimed_by = ?, claimed_at = ? WHERE id = ?").run(
					json(pendingLookouts),
					process.pid,
					Date.now(),
					id
				)
				return getClip(id)
			}),
		/**
		 * After a crash, clips left mid-flight go back in the queue. Only those of processes
		 * that are gone: a `look4 scan` running beside the server keeps its own. Called as this
		 * process starts its worker, so none of its own claims are in flight.
		 */
		resetProcessing: () =>
			transaction(() => {
				const stale = all("SELECT id, claimed_by, claimed_at FROM clips WHERE status = 'processing'").filter(
					r => Number(r.claimed_by) === process.pid || !claimLive(r)
				)
				for (const r of stale) stmt("UPDATE clips SET status = 'pending' WHERE id = ?").run(r.id as string)
				return stale.length
			}),
		listClips: (q: ClipQuery = {}): Clip[] => {
			const { sql, params } = clipWhere(q)
			return all(`SELECT c.* FROM clips c ${sql} ORDER BY c.recorded_at DESC LIMIT ?`, ...params, q.limit ?? 50).map(clipFromRow)
		},
		countClips: (q: ClipQuery = {}): number => {
			const { sql, params } = clipWhere(q)
			return Number(get(`SELECT COUNT(*) AS n FROM clips c ${sql}`, ...params)?.n ?? 0)
		},
		queueDepth: () => {
			const r = get(
				"SELECT SUM(status = 'pending') AS pending, SUM(status = 'processing') AS processing FROM clips"
			)
			return { pending: Number(r?.pending ?? 0), processing: Number(r?.processing ?? 0) }
		},
		/** Clips whose file retention should delete now. */
		expiredClips: (nowIso = now()): Clip[] =>
			all("SELECT * FROM clips WHERE expires_at IS NOT NULL AND expires_at <= ? AND path IS NOT NULL", nowIso).map(clipFromRow),
		/** Clips with a file that retention will delete some day, soonest first (what goes early when the disk is full). */
		expiringClips: (): Clip[] =>
			all("SELECT * FROM clips WHERE expires_at IS NOT NULL AND path IS NOT NULL ORDER BY expires_at").map(clipFromRow),
		/** Stage-by-stage counts for clips ingested at or after `sinceIso` (all time when omitted). */
		funnel: (sinceIso?: string): Funnel => {
			const r = get(
				`SELECT
					COUNT(*) AS ingested,
					SUM(status = 'pending') AS pending,
					SUM(status = 'processing') AS processing,
					SUM(status = 'error') AS errors,
					SUM(status = 'kept') AS kept,
					SUM(status = 'kept' OR dropped_at IN ('detect', 'judge')) AS passed_motion,
					SUM(status = 'kept' OR dropped_at = 'judge') AS passed_detect,
					SUM(dropped_at = 'probe') AS d_probe,
					SUM(dropped_at = 'motion') AS d_motion,
					SUM(dropped_at = 'detect') AS d_detect,
					SUM(dropped_at = 'judge') AS d_judge
				FROM clips WHERE ingested_at >= ?`,
				sinceIso ?? ""
			)
			const n = (k: string) => Number(r?.[k] ?? 0)
			return {
				ingested: n("ingested"),
				pending: n("pending"),
				processing: n("processing"),
				errors: n("errors"),
				passed: { motion: n("passed_motion"), detect: n("passed_detect") },
				kept: n("kept"),
				droppedAt: { probe: n("d_probe"), motion: n("d_motion"), detect: n("d_detect"), judge: n("d_judge") }
			}
		},

		// ---- lookouts ----

		listLookouts: (): Lookout[] => all("SELECT * FROM lookouts ORDER BY created_at").map(lookoutFromRow),
		getLookout: (idOrName: string) => {
			const r = get("SELECT * FROM lookouts WHERE id = ? OR name = ?", idOrName, idOrName)
			return r ? lookoutFromRow(r) : null
		},
		insertLookout: (l: Pick<Lookout, "id" | "name" | "prompt" | "enabled" | "threshold" | "compiled">): Lookout => {
			const t = now()
			stmt(
				"INSERT INTO lookouts (id, name, prompt, enabled, threshold, compiled_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
			).run(l.id, l.name, l.prompt, l.enabled ? 1 : 0, l.threshold, json(l.compiled), t, t)
			return lookoutFromRow(get("SELECT * FROM lookouts WHERE id = ?", l.id)!)
		},
		updateLookout: (id: string, patch: Partial<Pick<Lookout, "name" | "prompt" | "enabled" | "threshold" | "compiled">>): Lookout => {
			const cur = get("SELECT * FROM lookouts WHERE id = ?", id)
			if (!cur) throw new Error(`no lookout ${id}`)
			const l = { ...lookoutFromRow(cur), ...patch }
			stmt("UPDATE lookouts SET name = ?, prompt = ?, enabled = ?, threshold = ?, compiled_json = ?, updated_at = ? WHERE id = ?").run(
				l.name,
				l.prompt,
				l.enabled ? 1 : 0,
				l.threshold,
				json(l.compiled),
				now(),
				id
			)
			return lookoutFromRow(get("SELECT * FROM lookouts WHERE id = ?", id)!)
		},
		deleteLookout: (id: string) => {
			stmt("DELETE FROM lookouts WHERE id = ?").run(id)
		},

		// ---- detections ----

		replaceDetections: (clipId: string, dets: Detection[]) =>
			transaction(() => {
				stmt("DELETE FROM detections WHERE clip_id = ?").run(clipId)
				const ins = stmt("INSERT INTO detections (clip_id, frame_t, label, score, box_json, via) VALUES (?, ?, ?, ?, ?, ?)")
				for (const d of dets) ins.run(clipId, d.frameT, d.label, d.score, JSON.stringify(d.box), d.via)
			}),
		getDetections: (clipId: string): Detection[] =>
			all("SELECT * FROM detections WHERE clip_id = ? ORDER BY score DESC", clipId).map(detectionFromRow),

		// ---- verdicts ----

		upsertVerdict: (v: Verdict) => {
			stmt(
				`INSERT INTO verdicts (clip_id, lookout_id, match, confidence, label, species, species_confidence, rationale, model, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT (clip_id, lookout_id) DO UPDATE SET
					match = excluded.match, confidence = excluded.confidence, label = excluded.label, species = excluded.species,
					species_confidence = excluded.species_confidence, rationale = excluded.rationale, model = excluded.model, created_at = excluded.created_at`
			).run(v.clipId, v.lookoutId, v.match ? 1 : 0, v.confidence, v.label, v.species ?? null, v.speciesConfidence ?? null, v.rationale, v.model, v.createdAt)
		},
		getVerdicts: (clipId: string): Verdict[] =>
			all("SELECT * FROM verdicts WHERE clip_id = ? ORDER BY confidence DESC", clipId).map(verdictFromRow),
		deleteVerdicts: (clipId: string, lookoutIds?: string[]) => {
			if (!lookoutIds) stmt("DELETE FROM verdicts WHERE clip_id = ?").run(clipId)
			else for (const l of lookoutIds) stmt("DELETE FROM verdicts WHERE clip_id = ? AND lookout_id = ?").run(clipId, l)
		},
		/**
		 * Kept clips with at least one keeping verdict, newest first, optionally for one lookout.
		 * A verdict someone marked "not this" no longer counts. A kept clip queued again (a
		 * backfill, a reprocess) stays in the feed on its previous verdicts until it is re-decided.
		 */
		listSightings: (q: { lookoutId?: string; before?: string; since?: string; ingestedAfter?: string; limit?: number } = {}) => {
			const where = ["c.status IN ('kept', 'pending', 'processing')", KEEPS_SQL, NOT_REFUTED]
			const params: SQLInputValue[] = []
			if (q.lookoutId) {
				where.push("v.lookout_id = ?")
				params.push(q.lookoutId)
			}
			if (q.before) {
				where.push("c.recorded_at < ?")
				params.push(q.before)
			}
			if (q.since) {
				where.push("c.recorded_at >= ?")
				params.push(q.since)
			}
			if (q.ingestedAfter) {
				where.push("c.ingested_at > ?")
				params.push(q.ingestedAfter)
			}
			const clips = all(
				`SELECT DISTINCT c.* FROM clips c JOIN verdicts v ON v.clip_id = c.id JOIN lookouts l ON l.id = v.lookout_id
				 WHERE ${where.join(" AND ")} ORDER BY c.recorded_at DESC LIMIT ?`,
				...params,
				q.limit ?? 48
			).map(clipFromRow)
			return clips.map(clip => ({
				clip,
				verdicts: all(
					`SELECT v.* FROM verdicts v JOIN lookouts l ON l.id = v.lookout_id
					 WHERE v.clip_id = ? AND ${KEEPS_SQL} AND ${NOT_REFUTED} ORDER BY v.confidence DESC`,
					clip.id
				).map(verdictFromRow)
			}))
		},

		// ---- labels (human ground truth) ----

		setLabel: (l: Omit<Label, "createdAt">) => {
			stmt(
				`INSERT INTO labels (clip_id, lookout_id, truth, species, created_at) VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT (clip_id, lookout_id) DO UPDATE SET truth = excluded.truth, species = excluded.species, created_at = excluded.created_at`
			).run(l.clipId, l.lookoutId, l.truth ? 1 : 0, l.species ?? null, now())
		},
		/**
		 * The species the spotter named on a verdict the person said "no" to, with what the bird really
		 * was when they said: this camera's misreads, most frequent first.
		 */
		misreads: (): { said: string; actual: string | null; count: number }[] =>
			all(
				`SELECT v.species said, b.species actual, COUNT(DISTINCT v.clip_id) n FROM labels b
				 JOIN verdicts v ON v.clip_id = b.clip_id AND v.lookout_id = b.lookout_id
				 WHERE b.truth = 0 AND v.species IS NOT NULL
				 GROUP BY v.species COLLATE NOCASE, b.species COLLATE NOCASE ORDER BY n DESC`
			).map(r => ({ said: r.said as string, actual: (r.actual as string | null) ?? null, count: Number(r.n) })),
		/** How many clips the spotter named each species in, most first. */
		speciesCounts: (): { species: string; clips: number }[] =>
			all("SELECT species, COUNT(DISTINCT clip_id) n FROM verdicts WHERE species IS NOT NULL GROUP BY species COLLATE NOCASE ORDER BY n DESC").map(r => ({
				species: r.species as string,
				clips: Number(r.n)
			})),
		clearLabel: (clipId: string, lookoutId: string) => {
			stmt("DELETE FROM labels WHERE clip_id = ? AND lookout_id = ?").run(clipId, lookoutId)
		},
		getLabels: (q: { clipId?: string; lookoutId?: string } = {}): Label[] => {
			const where: string[] = []
			const params: SQLInputValue[] = []
			if (q.clipId) {
				where.push("clip_id = ?")
				params.push(q.clipId)
			}
			if (q.lookoutId) {
				where.push("lookout_id = ?")
				params.push(q.lookoutId)
			}
			return all(`SELECT * FROM labels ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at`, ...params).map(
				labelFromRow
			)
		},

		// ---- usage / cost ----

		addUsage: (u: Usage) => {
			stmt(
				`INSERT INTO usage (ts, clip_id, purpose, backend, model, input_tokens, output_tokens, cache_read_tokens, cost_usd)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			).run(u.ts, u.clipId, u.purpose, u.backend, u.model, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.costUsd)
		},
		/** Totals since `sinceIso` (all time when omitted). */
		usageSince: (sinceIso?: string) => {
			const r = get(
				`SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output,
					COALESCE(SUM(cost_usd), 0) AS cost FROM usage WHERE ts >= ?`,
				sinceIso ?? ""
			)
			return {
				calls: Number(r?.calls ?? 0),
				inputTokens: Number(r?.input ?? 0),
				outputTokens: Number(r?.output ?? 0),
				costUsd: Number(r?.cost ?? 0)
			}
		},
		getUsage: (clipId: string): Usage[] =>
			all("SELECT * FROM usage WHERE clip_id = ? ORDER BY ts", clipId).map(r => ({
				ts: r.ts as string,
				clipId: r.clip_id as string,
				purpose: r.purpose as Usage["purpose"],
				backend: r.backend as string,
				model: r.model as string,
				inputTokens: Number(r.input_tokens),
				outputTokens: Number(r.output_tokens),
				cacheReadTokens: Number(r.cache_read_tokens),
				costUsd: Number(r.cost_usd)
			})),

		// ---- life list ----

		/**
		 * The life list, alphabetically, each species with the clips the judge has named it in since
		 * (kept or not: once a species is on the list a "new species" lookout stops keeping it, but
		 * look4 still counts it). A clip someone marked "not this" does not count.
		 */
		listLifeList: (): Array<LifeListEntry & { sightings: number; lastSeenAt: string | null }> =>
			all(
				`SELECT x.*, COUNT(DISTINCT c.id) AS sightings, MAX(c.recorded_at) AS last_seen_at
				 FROM life_list x
				 LEFT JOIN verdicts v ON x.species = v.species AND ${NOT_REFUTED}
				 LEFT JOIN clips c ON c.id = v.clip_id
				 GROUP BY x.species ORDER BY x.species`
			).map(r => {
				const entry = lifeListEntryFromRow(r)
				const last = (r.last_seen_at as string | null) ?? null
				return {
					...entry,
					sightings: Number(r.sightings),
					lastSeenAt: [last, entry.firstSeenAt].filter(t => t !== null).sort().at(-1) ?? null
				}
			}),
		lifeListSpecies: (): string[] => all("SELECT species FROM life_list ORDER BY species").map(r => r.species as string),
		lifeListWithoutClip: (): string[] =>
			all("SELECT species FROM life_list WHERE clip_id IS NULL ORDER BY species").map(r => r.species as string),
		setLiferClip: (species: string, clipId: string): void => {
			stmt("UPDATE life_list SET clip_id = ? WHERE species = ?").run(clipId, species)
		},
		getLifer: (species: string): LifeListEntry | null => {
			const r = get("SELECT * FROM life_list WHERE species = ?", species)
			return r ? lifeListEntryFromRow(r) : null
		},
		addLifer: (e: Pick<LifeListEntry, "species" | "firstSeenAt" | "clipId">): LifeListEntry => {
			stmt("INSERT INTO life_list (species, first_seen_at, clip_id, added_at) VALUES (?, ?, ?, ?)").run(e.species, e.firstSeenAt, e.clipId, now())
			return lifeListEntryFromRow(get("SELECT * FROM life_list WHERE species = ?", e.species)!)
		},
		/**
		 * The best clip on disk the judge named this species in, for a life list bird with none of its
		 * own: one someone confirmed first, then a kept one, then the surest, then the newest.
		 */
		bestClipFor: (species: string): string | null =>
			(get(
				`SELECT c.id FROM clips c JOIN verdicts v ON v.clip_id = c.id
				 WHERE v.species = ? COLLATE NOCASE AND ${NOT_REFUTED} AND c.path IS NOT NULL
				 ORDER BY EXISTS (SELECT 1 FROM labels b WHERE b.clip_id = c.id AND b.truth = 1) DESC, c.status = 'kept' DESC,
					v.confidence DESC, c.recorded_at DESC
				 LIMIT 1`,
				species
			)?.id as string | undefined) ?? null,
		removeLifer: (species: string): boolean => Number(stmt("DELETE FROM life_list WHERE species = ?").run(species).changes) > 0,
		// ---- kv (adapter cursors, misc state) ----

		getKv,
		setKv,
		deleteKv: (key: string) => {
			stmt("DELETE FROM kv WHERE key = ?").run(key)
		}
	}
}
