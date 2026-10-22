import { homedir } from "node:os"
import { resolve } from "node:path"
import type { WatchSourceConfig } from "../config.ts"
import { DiskFullError } from "../ingest.ts"
import { logger } from "../log.ts"
import {
	createPoller,
	createStabilityTracker,
	createStatus,
	errorMessage,
	listFiles,
	type SourceAdapter,
	type SourceContext,
	VIDEO_EXTENSIONS
} from "./common.ts"

/** An ingest attempt that fails this many times is skipped until the file changes. */
const MAX_ATTEMPTS = 3

type DirSourceOptions = {
	name: string
	type: string
	dir: string
	extensions: string[]
	pollMs: number
	stableMs: number
	move: boolean
	/** Record `<rel path>|<size>|<mtime>` as the clip's sourceRef so copy mode never re-ingests a file. */
	trackRefs: boolean
	idleDetail: string
}

/** Polls a directory tree and ingests each video once it stops changing. Backs both `watch` and the inbox. */
export const createDirSource = (ctx: SourceContext, o: DirSourceOptions): SourceAdapter => {
	const log = logger(`source:${o.name}`)
	const status = createStatus(ctx, o.name, o.type)
	const tracker = createStabilityTracker(() => o.stableMs)
	/** Refs settled for this process: ingested, duplicate, or given up on. Saves re-hashing in copy mode. */
	const done = new Set<string>()
	const failures = new Map<string, number>()
	/** Taking files is paused for a nearly full disk; logged once per pause, not every poll. */
	let paused = false
	// never sweep up our own data (e.g. `dir: "."` with move on)
	const exclude = [ctx.paths.root]

	const cycle = async (signal: AbortSignal) => {
		let files
		try {
			files = await listFiles(o.dir, { recursive: true, extensions: o.extensions, signal, exclude })
		} catch (e) {
			status.polled()
			status.state("error", `cannot read ${o.dir}: ${errorMessage(e)}`)
			return
		}
		status.polled()
		const refOf = (f: { rel: string; size: number; mtimeMs: number }) => `${f.rel}|${f.size}|${Math.round(f.mtimeMs)}`
		const fresh = files.filter(f => !done.has(refOf(f)))
		const ready = tracker.update(fresh)
		let lastError: string | null = null
		let diskFull: string | null = null
		for (const f of ready) {
			if (signal.aborted) return
			const ref = refOf(f)
			if (o.trackRefs && !o.move && ctx.store.findClipBySourceRef(o.name, ref)) {
				done.add(ref)
				continue
			}
			try {
				const r = await ctx.ingest({
					file: f.path,
					source: o.name,
					sourceRef: o.trackRefs ? ref : null,
					mode: o.move ? "move" : "copy"
				})
				// a moved file is gone; only copy mode needs to remember it
				if (!o.move) done.add(ref)
				tracker.forget(f.path)
				paused = false
				if (!r.duplicate) {
					status.ingested()
					ctx.kick()
				}
			} catch (e) {
				if (e instanceof DiskFullError) {
					// not this file's fault, and every file after it would be refused the same way: it is not
					// counted as an attempt (three quick polls would give up on it for good), just tried again
					// on each poll until space frees up
					diskFull = `${errorMessage(e)}, taking files paused`
					if (!paused) log.warn(diskFull)
					paused = true
					break
				}
				const n = (failures.get(ref) ?? 0) + 1
				failures.set(ref, n)
				lastError = `${f.rel}: ${errorMessage(e)}`
				log.warn(`ingest failed (attempt ${n}/${MAX_ATTEMPTS}) ${lastError}`)
				if (n >= MAX_ATTEMPTS) {
					done.add(ref)
					failures.delete(ref)
				}
			}
		}
		const settling = fresh.length - ready.length
		const parts = [o.idleDetail]
		if (settling > 0) parts.push(`${settling} file${settling === 1 ? "" : "s"} still being written`)
		if (lastError) parts.push(`last error: ${lastError}`)
		if (diskFull) status.state("error", [diskFull, ...parts].join(" · "))
		else status.state("ok", parts.join(" · "))
	}

	const poller = createPoller({
		intervalMs: () => o.pollMs,
		cycle,
		onError: e => {
			log.error("poll failed", e)
			status.state("error", errorMessage(e))
		}
	})

	return {
		name: o.name,
		type: o.type,
		start: () => {
			log.info(`watching ${o.dir}${o.move ? " (move)" : ""}`)
			poller.start()
		},
		stop: async () => {
			await poller.stop()
			status.state("stopped", "stopped")
		},
		status: status.get,
		pollNow: poller.pollNow
	}
}

const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? homedir() + p.slice(1) : p)

export const createWatchSource = (cfg: WatchSourceConfig, ctx: SourceContext): SourceAdapter => {
	const dir = resolve(ctx.rootDir ?? process.cwd(), expandHome(cfg.dir))
	return createDirSource(ctx, {
		name: cfg.name,
		type: "watch",
		dir,
		extensions: cfg.extensions,
		pollMs: cfg.pollSeconds * 1000,
		stableMs: cfg.stableSeconds * 1000,
		move: cfg.move,
		trackRefs: true,
		idleDetail: `watching ${dir}`
	})
}

/** `data/inbox/`: drop any video in and it is moved into the library. `.partial/` is skipped (dot-dir). */
export const createInboxSource = (ctx: SourceContext): SourceAdapter =>
	createDirSource(ctx, {
		name: "inbox",
		type: "inbox",
		dir: ctx.paths.inbox,
		extensions: VIDEO_EXTENSIONS,
		pollMs: 2000,
		stableMs: 2000,
		move: true,
		trackRefs: false,
		idleDetail: `drop videos into ${ctx.paths.inbox}`
	})
