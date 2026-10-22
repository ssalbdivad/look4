import { createHash } from "node:crypto"
import { createReadStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs"
import { copyFile, rename, stat, unlink } from "node:fs/promises"
import { basename, extname, join } from "node:path"
import { pipeline } from "node:stream/promises"
import type { IngestInput, IngestResult } from "./context.ts"
import type { Store } from "./db.ts"
import type { Bus } from "./events.ts"
import { logger } from "./log.ts"
import { type DataPaths, localDate } from "./paths.ts"
import { gateKey, locateClipFile } from "./pipeline/process.ts"
import { freeBytes } from "./retention.ts"
import { VIDEO_EXTENSIONS } from "./sources/common.ts"
import type { Clip } from "./types.ts"

const log = logger("ingest")

export type IngestContext = {
	store: Store
	paths: DataPaths
	bus: Bus
	/** Refuse new clips while the data disk has less than this free (bytes); 0 or absent = no floor. */
	minFreeBytes?: () => number
	/** Free bytes on the disk holding `dir`; injectable for tests. */
	freeBytes?: (dir: string) => number
}

/** The data disk is too full to take another clip. */
export class DiskFullError extends Error {
	override name = "DiskFullError"
}

const VIDEO: ReadonlySet<string> = new Set(VIDEO_EXTENSIONS)

/**
 * The stored clip's extension. Only a known video extension survives: the name
 * comes from an upload or a camera, and /media serves originals by their stored
 * name, so `x.html` must not land on disk as a clip ending in `.html`.
 */
const storedExtension = (originalName: string, file: string) =>
	[originalName, file].map(n => extname(n).toLowerCase()).find(e => VIDEO.has(e)) ?? ".mp4"

const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`

const pad = (n: number, width = 2) => String(n).padStart(width, "0")

const validParts = (y: number, mo: number, d: number, h: number, mi: number, s: number) =>
	y >= 1990 &&
	y <= 2100 &&
	mo >= 1 &&
	mo <= 12 &&
	d >= 1 &&
	// day 0 of the next month is the last day of this one
	d <= new Date(y, mo, 0).getDate() &&
	h <= 23 &&
	mi <= 59 &&
	s <= 59

// One pattern covers every naming scheme we know of, because they all embed
// `YYYY MM DD <sep> HH MM SS` with optional separators:
//   Reolink SD:      RecM07_20261014_093012_093042_6D28808_1E2F3A.mp4 (and RecS…, RecM07_DST2026…)
//   Reolink FTP/NVR: Feeder_00_20261014093012.mp4
//   generic:         20261014_093012, 20261014093012, 2026-10-14_09-30-12, 2026-10-14T09:30:12
// The digit lookarounds stop it matching inside longer digit runs (hashes, serials).
const STAMP =
	/(?<!\d)(\d{4})(-?)(\d{2})\2(\d{2})([T_ -]?)(\d{2})([:.-]?)(\d{2})\7(\d{2})(?!\d)(Z|[+-]\d{2}:?\d{2})?/g

/**
 * When a clip was recorded, from its file name, as an ISO string. Names carry
 * camera-local wall time, so they are read in this machine's local time unless
 * the name has an explicit zone (`…T09:30:12Z`). Null when nothing plausible is found.
 */
export const parseRecordedAt = (name: string): string | null => {
	for (const m of basename(name).matchAll(STAMP)) {
		const [y, mo, d, h, mi, s] = [m[1], m[3], m[4], m[6], m[8], m[9]].map(Number) as [number, number, number, number, number, number]
		if (!validParts(y, mo, d, h, mi, s)) continue
		// only an ISO-style `T` stamp can carry a zone; elsewhere `-1234` is just more name
		const zone = m[5] === "T" ? m[10] : undefined
		if (zone) {
			const iso = `${m[1]}-${m[3]}-${m[4]}T${m[6]}:${m[8]}:${m[9]}${zone === "Z" ? "Z" : `${zone.slice(0, 3)}:${zone.slice(-2)}`}`
			const t = Date.parse(iso)
			if (!Number.isNaN(t)) return new Date(t).toISOString()
			continue
		}
		return new Date(y, mo - 1, d, h, mi, s).toISOString()
	}
	return null
}

/** `20261014-153012` in local time. */
const idStamp = (iso: string) => {
	const d = new Date(iso)
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export const sha256File = async (path: string, signal?: AbortSignal) => {
	const hash = createHash("sha256")
	await pipeline(createReadStream(path), hash, { signal })
	return hash.digest("hex")
}

/** rename, falling back to copy + unlink across filesystems (e.g. /mnt/c → ext4 in WSL). */
const moveFile = async (from: string, to: string) => {
	try {
		await rename(from, to)
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e
		await copyFile(from, to)
		await unlink(from)
	}
}

const isUniqueViolation = (e: unknown) => e instanceof Error && /UNIQUE constraint/i.test(e.message)

const tryUnlink = (path: string) => {
	try {
		unlinkSync(path)
	} catch {}
}

/**
 * Stores one complete video file as a pending clip. Idempotent on content: the same
 * bytes (sha256) or the same `source` + `sourceRef` return the existing clip with
 * `duplicate: true`, and in `move` mode the redundant input is deleted so a drop
 * folder never loops on it.
 */
export const ingestFile = async (ctx: IngestContext, input: IngestInput): Promise<IngestResult> => {
	const { store, paths, bus } = ctx
	const info = await stat(input.file)
	if (!info.isFile()) throw new Error(`not a file: ${input.file}`)

	const originalName = input.originalName ?? basename(input.file)
	const sourceRef = input.sourceRef ?? null

	const duplicateOf = (sha: string): Clip | null =>
		store.findClipBySha(sha) ?? (sourceRef === null ? null : store.findClipBySourceRef(input.source, sourceRef))

	const asDuplicate = async (clip: Clip): Promise<IngestResult> => {
		if (input.mode === "move") await unlink(input.file).catch(() => {})
		log.debug(`${originalName}: duplicate of ${clip.id}`)
		return { clip, duplicate: true }
	}

	// a full disk fails every write after it (downloads, SQLite, media), so stop taking clips first
	const floor = ctx.minFreeBytes?.() ?? 0
	if (floor > 0) {
		const free = (ctx.freeBytes ?? freeBytes)(paths.root)
		// a move within the data disk (a Reolink download in data/.partial, an upload in data/tmp, the
		// inbox) is a rename: those bytes are already counted out of `free`, and subtracting them again
		// refused a clip that fits, which the adapter then downloaded again on every poll
		const sameDisk = input.mode === "move" && statSync(paths.root, { throwIfNoEntry: false })?.dev === info.dev
		if (free - (sameDisk ? 0 : info.size) < floor)
			throw new DiskFullError(`disk nearly full: ${gb(free)} free, and look4 stops taking clips below ${gb(floor)} (retention.minFreeGb)`)
	}

	const sha = await sha256File(input.file)
	const ext = storedExtension(originalName, input.file)

	// Stage under a temp name in the destination directory so the final rename is
	// atomic and a half-copied file never sits at a clip's path.
	const stage = async (dir: string) => {
		mkdirSync(dir, { recursive: true })
		const tmp = join(dir, `.ingest-${process.pid}-${Date.now()}-${sha.slice(0, 8)}.tmp`)
		try {
			if (input.mode === "move") await moveFile(input.file, tmp)
			else await copyFile(input.file, tmp)
		} catch (e) {
			// a failed cross-device copy leaves a partial temp file; the original is intact
			if (existsSync(input.file)) tryUnlink(tmp)
			throw e
		}
		return tmp
	}

	const existing = duplicateOf(sha)
	if (existing) {
		// Retention deleted the earlier copy's file, and these are the same bytes: they become the
		// clip's file again and it is looked at afresh (labels kept). Without this a dropped file
		// would be deleted as a "duplicate" of nothing. Adapters that track their own refs in copy
		// mode (a watch folder) are left out, or each restart would re-ingest what retention cleared.
		const gone = locateClipFile(paths, existing)
		const reattach =
			existing.sha256 === sha &&
			existing.status !== "processing" &&
			(!gone || !existsSync(gone)) &&
			(input.mode === "move" || sourceRef === null)
		if (!reattach) return asDuplicate(existing)
		const dir = join(paths.clips, localDate(existing.recordedAt))
		const tmp = await stage(dir)
		const dest = join(dir, `${existing.id}${ext}`)
		renameSync(tmp, dest)
		const clip = store.updateClip(existing.id, {
			path: dest,
			status: "pending",
			droppedAt: null,
			reason: null,
			error: null,
			processedAt: null,
			expiresAt: null,
			pendingLookouts: null,
			media: { poster: null, preview: null, crops: [] }
		})
		log.info(`${input.source}: ${originalName} → ${clip.id} (its earlier copy had been deleted)`)
		bus.emit("clip", { clipId: clip.id, status: clip.status })
		bus.emit("queue", store.queueDepth())
		return { clip, duplicate: false }
	}

	const recordedAt = input.recordedAt ?? parseRecordedAt(originalName) ?? info.mtime.toISOString()
	const dir = join(paths.clips, localDate(recordedAt))
	const tmp = await stage(dir)
	/** Undo the staging step so a failed move never loses the input. */
	const giveBack = (from: string) => {
		if (input.mode === "copy") return tryUnlink(from)
		try {
			renameSync(from, input.file)
		} catch {
			log.error(`could not return ${originalName} to ${input.file}; it is at ${from}`)
		}
	}

	// From here to the insert everything is synchronous, so no other ingest in this
	// process can interleave between "path is free" and "row exists".
	const stamp = idStamp(recordedAt)
	// a concurrent ingest of the same bytes may have finished while we were copying
	const raced = duplicateOf(sha)
	if (raced) {
		tryUnlink(tmp)
		return asDuplicate(raced)
	}
	for (const len of [6, 10, 16, 64]) {
		const id = `${stamp}-${sha.slice(0, len)}`
		const dest = join(dir, `${id}${ext}`)
		// a different clip with the same second and hash prefix; lengthen the prefix
		if (store.getClip(id) || existsSync(dest)) continue
		renameSync(tmp, dest)
		let clip: Clip
		try {
			clip = store.insertClip({
				id,
				source: input.source,
				sourceRef,
				originalName,
				path: dest,
				sizeBytes: info.size,
				sha256: sha,
				recordedAt
			})
		} catch (e) {
			// another ingest (or process) won the race for these bytes
			const raced = isUniqueViolation(e) ? duplicateOf(sha) : null
			if (raced) {
				tryUnlink(dest)
				return asDuplicate(raced)
			}
			giveBack(dest)
			throw e
		}
		// before the worker can see it, like Record's pin: the motion stage reads it
		if (input.gate) store.setKv(gateKey(clip.id), input.gate)
		log.info(`${input.source}: ${originalName} → ${id}`)
		bus.emit("clip", { clipId: clip.id, status: clip.status })
		bus.emit("queue", store.queueDepth())
		return { clip, duplicate: false }
	}
	// unreachable in practice: a full-length sha collision is a duplicate
	giveBack(tmp)
	throw new Error(`could not allocate a clip id for ${originalName}`)
}
