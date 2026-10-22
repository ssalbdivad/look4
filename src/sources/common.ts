import { readdir, stat } from "node:fs/promises"
import { extname, join, relative } from "node:path"
import type { IngestInput, IngestResult } from "../context.ts"
import type { Store } from "../db.ts"
import type { Bus } from "../events.ts"
import type { DataPaths } from "../paths.ts"
import type { LiveRecorder } from "./recorder.ts"
import type { SourceState, SourceStatus } from "../types.ts"

export type SourceAdapter = {
	name: string
	type: string
	start(): void
	stop(): Promise<void>
	status(): SourceStatus
	/** Runs one cycle now (the UI's "Check now"); waits for an in-flight cycle first. */
	pollNow(): Promise<void>
	/** Saving clips from Live; null (or absent) while this source isn't recording a stream. */
	liveRecorder?(): LiveRecorder | null
}

export type SourceContext = {
	store: Store
	paths: DataPaths
	bus: Bus
	ingest: (input: IngestInput) => Promise<IngestResult>
	/** Wakes the worker after new clips are pending. */
	kick: () => void
	/** Relative `watch` directories resolve against this (the config file's directory). Default: cwd. */
	rootDir?: string
	/** `retention.minFreeGb` in bytes: adapters that download stop pulling below it. 0 or absent = no floor. */
	minFreeBytes?: () => number
	/** Free bytes on the disk holding `dir`; injectable for tests. Default: `freeBytes` from src/retention.ts. */
	freeBytes?: (dir: string) => number
	/** `retention.motionlessDays`: footage the camera didn't flag is kept this long in `unchecked/`. Default 2. */
	uncheckedDays?: () => number
	/** `retention.uncheckedGb`: 0 keeps no unchecked footage at all. Default 10. */
	uncheckedGb?: () => number
}

/** What counts as a video when scanning a directory. */
export const VIDEO_EXTENSIONS = [
	".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".ts", ".mts", ".m2ts", ".3gp", ".flv", ".wmv", ".mpg", ".mpeg"
]

export const errorMessage = (e: unknown) =>
	e instanceof Error ? ((e as NodeJS.ErrnoException).code === "ENOENT" ? `not found: ${(e as NodeJS.ErrnoException).path ?? e.message}` : e.message) : String(e)

/**
 * Holds a source's status and emits it on the bus whenever something other than
 * `lastPollAt` changes (a 2-second poll would otherwise flood the SSE stream).
 */
export const createStatus = (ctx: SourceContext, name: string, type: string) => {
	let current: SourceStatus = {
		name,
		type,
		state: "starting",
		detail: "starting",
		lastPollAt: null,
		lastClipAt: null,
		// survives restarts, so the health view shows a lifetime count
		clipsIngested: ctx.store.countClips({ source: name })
	}
	const significant = (s: SourceStatus) => JSON.stringify({ ...s, lastPollAt: null })
	const set = (patch: Partial<SourceStatus>) => {
		const next = { ...current, ...patch }
		const changed = significant(next) !== significant(current)
		current = next
		if (changed) ctx.bus.emit("source", { ...current })
	}
	return {
		get: (): SourceStatus => ({ ...current }),
		set,
		state: (state: SourceState, detail: string) => set({ state, detail }),
		polled: () => set({ lastPollAt: new Date().toISOString() }),
		ingested: () => set({ clipsIngested: current.clipsIngested + 1, lastClipAt: new Date().toISOString() })
	}
}

export type StatusHandle = ReturnType<typeof createStatus>

/**
 * Runs `cycle` every `intervalMs` without ever overlapping itself. `pollNow` queues
 * behind a running cycle and then runs a fresh one, so a "Check now" always sees
 * files that arrived after the click. It works on a stopped source too (one-shot use).
 */
export const createPoller = (opts: {
	intervalMs: () => number
	cycle: (signal: AbortSignal) => Promise<void>
	onError: (e: unknown) => void
}) => {
	let timer: NodeJS.Timeout | null = null
	let chain: Promise<void> = Promise.resolve()
	let stopped = true
	let abort = new AbortController()

	const enqueue = (force: boolean) => {
		chain = chain.then(async () => {
			if (stopped && !force) return
			const signal = abort.signal
			try {
				await opts.cycle(signal)
			} catch (e) {
				if (!signal.aborted) opts.onError(e)
			}
		})
		return chain
	}

	const schedule = () => {
		if (stopped) return
		timer = setTimeout(() => {
			timer = null
			void enqueue(false).then(schedule)
		}, opts.intervalMs())
	}

	return {
		start: () => {
			if (!stopped) return
			stopped = false
			abort = new AbortController()
			void enqueue(false).then(schedule)
		},
		stop: async () => {
			stopped = true
			if (timer) clearTimeout(timer)
			timer = null
			abort.abort()
			await chain
		},
		pollNow: () => {
			if (abort.signal.aborted) abort = new AbortController()
			return enqueue(true)
		},
		isRunning: () => !stopped
	}
}

export type FileEntry = { path: string; rel: string; size: number; mtimeMs: number }

/** Every file under `dir` with a matching extension, skipping dot-files and dot-directories. */
export const listFiles = async (
	dir: string,
	opts: { recursive: boolean; extensions: string[] | null; signal?: AbortSignal; exclude?: string[] }
): Promise<FileEntry[]> => {
	const exts = opts.extensions?.map(e => (e.startsWith(".") ? e : `.${e}`).toLowerCase()) ?? null
	const out: FileEntry[] = []
	const walk = async (d: string) => {
		if (opts.signal?.aborted) return
		let entries
		try {
			entries = await readdir(d, { withFileTypes: true })
		} catch (e) {
			// a subdirectory vanishing mid-scan is normal (someone moved it); the root is not
			if (d === dir) throw e
			return
		}
		for (const ent of entries) {
			if (ent.name.startsWith(".")) continue
			const p = join(d, ent.name)
			if (ent.isDirectory()) {
				if (opts.recursive && !opts.exclude?.includes(p)) await walk(p)
				continue
			}
			if (!ent.isFile()) continue
			if (exts && !exts.includes(extname(ent.name).toLowerCase())) continue
			try {
				const s = await stat(p)
				out.push({ path: p, rel: relative(dir, p), size: s.size, mtimeMs: s.mtimeMs })
			} catch {}
		}
	}
	await walk(dir)
	return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

/**
 * Decides when a file is done being written: its size and mtime must hold still
 * for `stableMs`. Polling rather than fs.watch because inotify never fires for
 * Windows-side paths (`/mnt/c/...`) in WSL, or for most network mounts.
 */
export const createStabilityTracker = (stableMs: () => number) => {
	const seen = new Map<string, { size: number; mtimeMs: number; since: number }>()
	return {
		/** Feeds one scan; returns the files that are now stable. Forgets files that disappeared. */
		update: (files: FileEntry[], now = Date.now()): FileEntry[] => {
			const present = new Set<string>()
			const stable: FileEntry[] = []
			for (const f of files) {
				present.add(f.path)
				const prev = seen.get(f.path)
				if (!prev || prev.size !== f.size || prev.mtimeMs !== f.mtimeMs) {
					seen.set(f.path, { size: f.size, mtimeMs: f.mtimeMs, since: now })
					// with no wait configured a first sighting is enough, except for empty files,
					// which are almost always a writer that has only just opened them
					if (stableMs() <= 0 && f.size > 0) stable.push(f)
					continue
				}
				if (f.size > 0 && now - prev.since >= stableMs()) stable.push(f)
			}
			for (const p of seen.keys()) if (!present.has(p)) seen.delete(p)
			return stable
		},
		forget: (path: string) => seen.delete(path)
	}
}
