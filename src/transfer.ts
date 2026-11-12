// Moves a look4 to another machine: settings, secrets, the database, and every clip that is kept
// for good. That is sightings (kept/), labeled clips, life-list clips and Live recordings, with
// their photos. Clips retention will delete anyway (rejected or motionless, due to expire) stay
// behind; their rows come along marked as already deleted, as retention leaves them, so the funnel
// and cost history are whole on the new machine.
//
// The bundle is a tar.gz made and read by the system `tar` (GNU on Linux, bsdtar on macOS):
//
//   manifest.json        { version, exportedAt, from, clips }
//   look4.config.json    the settings, when there is a config file
//   .env                 the secrets, when there is one
//   look4.db             a VACUUM INTO snapshot, safe to take while look4 runs
//   kept-index.jsonl     kept/index.jsonl (its paths are relative to the data dir)
//   clips/<id>.<ext>     each clip that is coming, flat: import files it under kept/ or clips/
//   media/<id>/          its poster, crops, preview and close-ups
//
// Clip paths in the database are absolute, so import rewrites every one to where it filed the clip.

import { spawn } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path"
import type { Readable } from "node:stream"
import { DatabaseSync } from "node:sqlite"
import { CONFIG_FILE, type LoadedConfig } from "./config.ts"
import { dataPaths, ensureDataDirs, localDate } from "./paths.ts"

export class TransferError extends Error {}

const VERSION = 1
const EMPTY_MEDIA = JSON.stringify({ poster: null, preview: null, crops: [] })

export type Manifest = { version: number; exportedAt: string; from: string; clips: number }

/** Clips whose file outlives retention: kept, labeled, on the life list, or never given an expiry (Live recordings, the queue). */
const STAYING = `path IS NOT NULL AND (status = 'kept' OR expires_at IS NULL
	OR id IN (SELECT clip_id FROM labels) OR id IN (SELECT clip_id FROM life_list WHERE clip_id IS NOT NULL))`

/** The file of a clip row, checking kept/ and clips/ when a crash mid-move left the row stale (as `locateClipFile`). */
const clipFile = (paths: ReturnType<typeof dataPaths>, path: string, recordedAt: string) => {
	if (existsSync(path)) return path
	for (const dir of [paths.kept, paths.clips]) {
		const p = join(dir, localDate(recordedAt), basename(path))
		if (existsSync(p)) return p
	}
	return null
}

const tar = (args: string[], stdin?: Readable) => {
	// COPYFILE_DISABLE: macOS tar would otherwise add a ._ file of extended attributes per entry
	const child = spawn("tar", args, { stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"], env: { ...process.env, COPYFILE_DISABLE: "1" } })
	let stderr = ""
	child.stderr!.on("data", d => (stderr += d))
	if (stdin) stdin.pipe(child.stdin!)
	const done = new Promise<void>((ok, fail) => {
		child.on("error", fail)
		child.on("close", code => (code === 0 ? ok() : fail(new TransferError(`tar ${args[0]} failed (${code}): ${stderr.trim()}`))))
	})
	return { stdout: child.stdout!, done }
}

export type ExportResult = { stream: Readable; manifest: Manifest; done: Promise<void> }

/** Stages a bundle (symlinks, so nothing big is copied) and streams it as tar.gz. The stage is removed once the stream ends. */
export const exportBundle = (config: LoadedConfig): ExportResult => {
	const paths = dataPaths(config.dataDir)
	if (!existsSync(paths.db)) throw new TransferError(`no look4 database at ${paths.db}`)
	mkdirSync(paths.tmp, { recursive: true })
	const stage = mkdtempSync(join(paths.tmp, "export-"))
	try {
		const dbPath = join(stage, "look4.db")
		const live = new DatabaseSync(paths.db)
		live.exec("PRAGMA busy_timeout = 5000")
		live.prepare("VACUUM INTO ?").run(dbPath)
		live.close()

		const db = new DatabaseSync(dbPath)
		mkdirSync(join(stage, "clips"))
		mkdirSync(join(stage, "media"))
		let clips = 0
		for (const r of db.prepare(`SELECT id, path, recorded_at FROM clips WHERE ${STAYING}`).all()) {
			const id = r.id as string
			const file = clipFile(paths, r.path as string, r.recorded_at as string)
			if (!file) continue
			symlinkSync(file, join(stage, "clips", `${id}${extname(file)}`))
			const media = join(paths.media, id)
			if (existsSync(media)) symlinkSync(media, join(stage, "media", id))
			clips++
		}
		// everything else is due to go: on the new machine it is already gone, as retention leaves a deleted clip
		db.prepare(`UPDATE clips SET path = NULL, media_json = ? WHERE path IS NOT NULL AND NOT (${STAYING})`).run(EMPTY_MEDIA)
		// this machine's processes and their claims mean nothing there
		db.exec("DELETE FROM kv WHERE key LIKE 'proc:%'")
		db.exec("UPDATE clips SET status = 'pending', claimed_by = NULL, claimed_at = NULL WHERE status = 'processing'")
		db.close()

		if (config.configPath && existsSync(config.configPath)) copyFileSync(config.configPath, join(stage, CONFIG_FILE))
		const env = join(config.rootDir, ".env")
		if (existsSync(env)) copyFileSync(env, join(stage, ".env"))
		if (existsSync(paths.keptIndex)) copyFileSync(paths.keptIndex, join(stage, "kept-index.jsonl"))

		const manifest: Manifest = { version: VERSION, exportedAt: new Date().toISOString(), from: config.dataDir, clips }
		writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, "\t") + "\n")

		// -h follows the symlinks, so the files themselves go in
		const t = tar(["-czhf", "-", "-C", stage, "."])
		const done = t.done.finally(() => rmSync(stage, { recursive: true, force: true }))
		return { stream: t.stdout, manifest, done }
	} catch (e) {
		rmSync(stage, { recursive: true, force: true })
		throw e
	}
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0)
		return true
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM"
	}
}

/** Pids of look4 processes with this database open: a live pid with a heartbeat in the last 90 s (see db.ts). */
const runningLook4 = (dbPath: string) => {
	if (!existsSync(dbPath)) return []
	const db = new DatabaseSync(dbPath, { readOnly: true })
	try {
		const rows = db.prepare("SELECT key, value FROM kv WHERE key LIKE 'proc:%'").all()
		return rows
			.map(r => ({ pid: Number((r.key as string).slice(5)), beat: (JSON.parse(r.value as string) as { beat: number }).beat }))
			.filter(p => p.pid !== process.pid && Date.now() - p.beat < 90_000 && alive(p.pid))
			.map(p => p.pid)
	} catch {
		return []
	} finally {
		db.close()
	}
}

/** What this machine already holds that an import would replace. */
const existingData = (dbPath: string) => {
	if (!existsSync(dbPath)) return null
	const db = new DatabaseSync(dbPath, { readOnly: true })
	try {
		const count = (table: string) => {
			try {
				return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)
			} catch {
				return 0
			}
		}
		const held = { clips: count("clips"), lookouts: count("lookouts"), lifeList: count("life_list") }
		return held.clips + held.lookouts + held.lifeList ? held : null
	} finally {
		db.close()
	}
}

/** `KEY=value` lines of `add` whose key `base` lacks, appended to `base`. */
export const mergeEnv = (base: string, add: string) => {
	const key = (line: string) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1]
	const has = new Set(base.split("\n").map(key))
	const extra = add.split("\n").filter(l => key(l) && !has.has(key(l)))
	if (!extra.length) return base
	return (base && !base.endsWith("\n") ? base + "\n" : base) + extra.join("\n") + "\n"
}

export type ImportResult = { manifest: Manifest; clips: number; missing: number; lifeList: number; configPath: string | null; envKeys: number }

/**
 * Unpacks a bundle into this machine's data dir and config. Refuses while a look4 is running on
 * this data, and, unless `force`, when there is already data here an import would replace.
 * The data dir stays where it is: the imported config's `dataDir` is rewritten to point at it.
 */
export const importBundle = async (config: LoadedConfig, bundle: Readable, opts: { force?: boolean } = {}): Promise<ImportResult> => {
	const paths = dataPaths(config.dataDir)
	const running = runningLook4(paths.db)
	if (running.length) throw new TransferError(`look4 is running on ${config.dataDir} (pid ${running.join(", ")}); stop it first`)
	const held = existingData(paths.db)
	if (held && !opts.force)
		throw new TransferError(
			`${config.dataDir} already has ${held.clips} clips, ${held.lookouts} lookouts and ${held.lifeList} life-list birds; --force replaces them`
		)

	ensureDataDirs(paths)
	const stage = mkdtempSync(join(paths.tmp, "import-"))
	try {
		await tar(["-xzf", "-", "-C", stage], bundle).done
		const manifestPath = join(stage, "manifest.json")
		if (!existsSync(manifestPath)) throw new TransferError("not a look4 export (no manifest.json)")
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest
		if (manifest.version !== VERSION) throw new TransferError(`export version ${manifest.version} is not supported (expected ${VERSION})`)

		// file each clip by status, as the pipeline does, and point its row at it
		const db = new DatabaseSync(join(stage, "look4.db"))
		const staged = new Map(readdirSync(join(stage, "clips")).map(f => [basename(f, extname(f)), f]))
		let clips = 0
		let missing = 0
		const setPath = db.prepare("UPDATE clips SET path = ? WHERE id = ?")
		const gone = db.prepare("UPDATE clips SET path = NULL, media_json = ? WHERE id = ?")
		for (const r of db.prepare("SELECT id, path, status, recorded_at FROM clips WHERE path IS NOT NULL").all()) {
			const id = r.id as string
			const file = staged.get(id)
			if (!file) {
				gone.run(EMPTY_MEDIA, id)
				missing++
				continue
			}
			const dest = join(r.status === "kept" ? paths.kept : paths.clips, localDate(r.recorded_at as string), file)
			mkdirSync(dirname(dest), { recursive: true })
			renameSync(join(stage, "clips", file), dest)
			setPath.run(dest, id)
			const media = join(stage, "media", id)
			if (existsSync(media)) {
				rmSync(join(paths.media, id), { recursive: true, force: true })
				renameSync(media, join(paths.media, id))
			}
			clips++
		}
		const lifeList = Number(db.prepare("SELECT count(*) AS n FROM life_list").get()!.n)
		db.close()

		for (const suffix of ["", "-wal", "-shm"]) rmSync(paths.db + suffix, { force: true })
		renameSync(join(stage, "look4.db"), paths.db)
		if (existsSync(join(stage, "kept-index.jsonl"))) renameSync(join(stage, "kept-index.jsonl"), paths.keptIndex)

		let configPath: string | null = null
		if (existsSync(join(stage, CONFIG_FILE))) {
			configPath = config.configPath ?? join(config.rootDir, CONFIG_FILE)
			const raw = JSON.parse(readFileSync(join(stage, CONFIG_FILE), "utf8")) as Record<string, unknown>
			// keep the data where it was just imported to, whatever the other machine called its data dir
			const here = relative(dirname(configPath), config.dataDir)
			if (here === "data") delete raw.dataDir
			else raw.dataDir = here && !here.startsWith("..") && !isAbsolute(here) ? `./${here}` : config.dataDir
			writeFileSync(configPath, JSON.stringify(raw, null, "\t") + "\n")
		}

		let envKeys = 0
		if (existsSync(join(stage, ".env"))) {
			const envPath = join(configPath ? dirname(configPath) : config.rootDir, ".env")
			const before = existsSync(envPath) ? readFileSync(envPath, "utf8") : ""
			const merged = mergeEnv(before, readFileSync(join(stage, ".env"), "utf8"))
			envKeys = merged.split("\n").filter(Boolean).length - before.split("\n").filter(Boolean).length
			writeFileSync(envPath, merged, { mode: 0o600 })
		}
		return { manifest, clips, missing, lifeList, configPath, envKeys }
	} finally {
		rmSync(stage, { recursive: true, force: true })
	}
}
