// Retention: rejected clips are kept for a while (so thresholds can be re-tuned
// against real misses), then their file and media go. The row stays, so the
// funnel and cost history survive. When the disk runs low, the clips closest to
// expiring go early, so a full disk never takes the app (or a sighting) down.
// Footage the camera didn't flag (`unchecked/`) has no rows: it goes by age, by
// size, and before anything else when the disk runs low.

import { existsSync, readdirSync, rmdirSync, rmSync, statfsSync, statSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import type { AppContext } from "./context.ts"
import type { Clip } from "./types.ts"
import { logger } from "./log.ts"
import { clipMediaDir } from "./paths.ts"
import { locateClipFile } from "./pipeline/process.ts"

const log = logger("retention")

const sizeOf = (path: string): number => {
	if (!existsSync(path)) return 0
	const st = statSync(path)
	if (!st.isDirectory()) return st.size
	let total = 0
	for (const f of readdirSync(path)) total += sizeOf(join(path, f))
	return total
}

/** Free bytes for an unprivileged writer on the disk holding `dir`. */
export const freeBytes = (dir: string) => {
	const st = statfsSync(dir)
	return Number(st.bavail) * Number(st.bsize)
}

/**
 * Free space kept above the floor once unchecked footage goes for space: the next
 * clip's concat (Record's can be 5 minutes) has to fit, or ingest refuses it. Stream
 * capture raises it for a stream fast enough that 5 minutes is more.
 */
export const UNCHECKED_HEADROOM_BYTES = 1e9

export type UncheckedRules = {
	now: number
	/** Footage older than this goes. Null: age isn't checked this time. */
	maxAgeMs: number | null
	/** The most footage to keep; the oldest goes first. Null: size isn't checked this time. */
	maxBytes: number | null
	/** `retention.minFreeGb` in bytes; 0 = no floor. */
	floorBytes: number
	/** Default `UNCHECKED_HEADROOM_BYTES`. */
	headroomBytes?: number
	freeBytes: (dir: string) => number
}

/**
 * Deletes unchecked footage (`<dir>/<day>/*`), oldest first: what is older than
 * `maxAgeMs`, what takes the total past `maxBytes`, and, once free space is less
 * than the floor plus the headroom, as much as it takes to get twice the headroom
 * over the floor (so a capture cycle isn't back to list the folder two seconds
 * later). Footage nobody checked goes before any clip the pipeline judged.
 */
export const sweepUnchecked = (dir: string, o: UncheckedRules) => {
	const headroom = o.headroomBytes ?? UNCHECKED_HEADROOM_BYTES
	const low = o.floorBytes > 0 && existsSync(dir) && o.freeBytes(dir) < o.floorBytes + headroom
	const out = { deleted: 0, freedBytes: 0 }
	if (o.maxAgeMs === null && o.maxBytes === null && !low) return out
	const days = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()) : []
	const files: Array<{ path: string; mtimeMs: number; size: number }> = []
	for (const d of days)
		for (const f of readdirSync(join(dir, d.name))) {
			const path = join(dir, d.name, f)
			try {
				const st = statSync(path)
				if (st.isFile()) files.push({ path, mtimeMs: st.mtimeMs, size: st.size })
			} catch {}
		}
	files.sort((a, b) => a.mtimeMs - b.mtimeMs)
	let total = files.reduce((n, f) => n + f.size, 0)
	for (const f of files) {
		// oldest first, so once a file breaks none of the rules, no newer one does
		const old = o.maxAgeMs !== null && o.now - f.mtimeMs > o.maxAgeMs
		const over = o.maxBytes !== null && total > o.maxBytes
		if (!old && !over && !(low && o.freeBytes(dir) < o.floorBytes + 2 * headroom)) break
		try {
			unlinkSync(f.path)
		} catch {
			continue
		}
		total -= f.size
		out.deleted++
		out.freedBytes += f.size
	}
	for (const d of days)
		try {
			rmdirSync(join(dir, d.name))
		} catch {}
	return out
}

type SweepCtx = Pick<AppContext, "store" | "paths" | "bus"> & Partial<Pick<AppContext, "config">>

export const sweep = (ctx: SweepCtx, now = new Date(), disk: { freeBytes: (dir: string) => number } = { freeBytes }) => {
	let deleted = 0
	let freedBytes = 0
	const remove = (clip: Clip) => {
		// labeled clips are ground truth for eval and are never deleted
		if (ctx.store.getLabels({ clipId: clip.id }).length) {
			ctx.store.updateClip(clip.id, { expiresAt: null })
			return
		}
		// a crash mid-move can leave the file in the other of clips/ and kept/
		const path = locateClipFile(ctx.paths, clip)!
		const media = clipMediaDir(ctx.paths, clip.id)
		const bytes = sizeOf(path) + sizeOf(media)
		try {
			rmSync(path, { force: true })
			rmSync(media, { recursive: true, force: true })
		} catch (e) {
			log.warn(`could not delete ${clip.id}`, e)
			return
		}
		ctx.store.updateClip(clip.id, { path: null, media: { poster: null, preview: null, crops: [] } })
		ctx.bus.emit("clip", { clipId: clip.id, status: clip.status })
		deleted++
		freedBytes += bytes
	}
	// in the queue (e.g. a backfill): the worker will set a fresh expiry
	const settled = (c: Clip) => c.status !== "pending" && c.status !== "processing"
	const floor = (ctx.config?.retention.minFreeGb ?? 0) * 1e9

	// here rather than in stream capture alone, which isn't running once the camera is paused,
	// removed or switched to its SD card, or with --no-sources
	const retention = ctx.config?.retention
	const unchecked = sweepUnchecked(join(ctx.paths.root, "unchecked"), {
		now: now.getTime(),
		maxAgeMs: retention ? retention.motionlessDays * 86_400_000 : null,
		maxBytes: retention ? retention.uncheckedGb * 1e9 : null,
		floorBytes: floor,
		freeBytes: disk.freeBytes
	})
	if (unchecked.deleted)
		log.info(`deleted ${unchecked.deleted} unchecked file${unchecked.deleted === 1 ? "" : "s"} (${(unchecked.freedBytes / 1e6).toFixed(1)} MB)`)

	for (const clip of ctx.store.expiredClips(now.toISOString())) if (settled(clip)) remove(clip)

	if (floor > 0) {
		let free = disk.freeBytes(ctx.paths.root)
		if (free < floor) {
			const before = deleted
			for (const clip of ctx.store.expiringClips()) {
				if (free >= floor) break
				if (!settled(clip)) continue
				const n = freedBytes
				remove(clip)
				free = disk.freeBytes(ctx.paths.root)
				if (freedBytes > n) log.debug(`${clip.id}: deleted early, the disk is nearly full`)
			}
			if (deleted > before) log.warn(`disk nearly full: deleted ${deleted - before} rejected clip${deleted - before === 1 ? "" : "s"} before their time`)
			if (free < floor) log.warn(`disk nearly full: ${(free / 1e9).toFixed(1)} GB free, below retention.minFreeGb (${floor / 1e9} GB); new clips are refused`)
		}
	}
	if (deleted) log.info(`deleted ${deleted} expired clip${deleted === 1 ? "" : "s"} (${(freedBytes / 1e6).toFixed(1)} MB)`)
	return { deleted, freedBytes }
}
