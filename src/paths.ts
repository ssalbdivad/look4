import { mkdirSync } from "node:fs"
import { join } from "node:path"

/** Every on-disk location under the data directory. */
export const dataPaths = (dataDir: string) => {
	const p = {
		root: dataDir,
		db: join(dataDir, "look4.db"),
		/** Drop any video here and it is ingested (moved). */
		inbox: join(dataDir, "inbox"),
		/** Adapters write here first, then rename into place, so nothing reads a half-written file. */
		partial: join(dataDir, "inbox", ".partial"),
		/** Every ingested clip, by recorded date: clips/2026-10-14/<id>.mp4 */
		clips: join(dataDir, "clips"),
		/** Clips a lookout matched, by recorded date, plus index.jsonl. */
		kept: join(dataDir, "kept"),
		keptIndex: join(dataDir, "kept", "index.jsonl"),
		/** Per-clip artifacts: media/<id>/poster.jpg, preview.mp4, crop-0.jpg, closeup-0.jpg, ... */
		media: join(dataDir, "media"),
		/** Close-ups the camera zoomed in for, until the clip they belong to exists (src/live/closeup.ts). */
		closeUps: join(dataDir, "closeups"),
		/** Downloaded model weights. */
		models: join(dataDir, "models"),
		tmp: join(dataDir, "tmp")
	}
	return p
}

export type DataPaths = ReturnType<typeof dataPaths>

export const ensureDataDirs = (paths: DataPaths) => {
	for (const dir of [paths.root, paths.inbox, paths.partial, paths.clips, paths.kept, paths.media, paths.models, paths.tmp])
		mkdirSync(dir, { recursive: true })
}

export const clipMediaDir = (paths: DataPaths, clipId: string) => join(paths.media, clipId)

/** At most this many close-ups per clip, in its media folder as `closeup-0.jpg`, `closeup-1.jpg`, … in the order they were taken. */
export const MAX_CLOSEUPS = 4
export const closeUpName = (n: number) => `closeup-${n}.jpg`

/** `2026-10-14` from an ISO timestamp, in local time (how people think about "today's birds"). */
export const localDate = (iso: string) => {
	const d = new Date(iso)
	const pad = (n: number) => String(n).padStart(2, "0")
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
