// Wires the long-running app: store, bus, judge, detector, sources, worker, server.

import { existsSync } from "node:fs"
import { join } from "node:path"
import { CONFIG_FILE, loadConfig, type LoadedConfig } from "./config.ts"
import type { AppContext } from "./context.ts"
import { openStore } from "./db.ts"
import { createBus } from "./events.ts"
import { ingestFile } from "./ingest.ts"
import { foldedSources } from "./live/manager.ts"
import { createLlm } from "./llm/index.ts"
import type { VisionLLM } from "./llm/types.ts"
import { logger } from "./log.ts"
import { dataPaths, ensureDataDirs } from "./paths.ts"
import { compileLookout } from "./pipeline/compile.ts"
import { createDetector } from "./pipeline/detect.ts"
import type { Detector } from "./pipeline/types.ts"
import { createWorker } from "./pipeline/worker.ts"
import { createServer } from "./server/index.ts"
import { idleStatus, PAUSED_DETAIL, sourceSignature } from "./setup/sources.ts"
import { createInboxSource, createSource, type SourceAdapter } from "./sources/index.ts"
import type { SourceStatus } from "./types.ts"

const log = logger("app")

type Running = { adapter: SourceAdapter; signature: string }

/** What `startApp` attaches to a context after building it. */
type Hooks = {
	kick: () => void
	inbox: SourceAdapter | null
	/** Configured sources with a live adapter, by name. */
	running: Map<string, Running>
	/** Configured sources without one (paused, or failed to build), with the status to show. */
	idle: Map<string, SourceStatus>
	/** Set by `startApp`; until then `applySources` has nothing to manage. */
	manage: (() => Promise<void>) | null
	/** Serializes `applySources` so two quick saves never start one source twice. */
	applying: Promise<void>
}
const hooks = new WeakMap<AppContext, Hooks>()

export const createContext = async (
	config: LoadedConfig,
	opts: { llm?: VisionLLM | null; detector?: Detector } = {}
): Promise<AppContext> => {
	const paths = dataPaths(config.dataDir)
	ensureDataDirs(paths)
	const store = openStore(paths.db)
	const bus = createBus()
	const judge =
		opts.llm !== undefined
			? { llm: opts.llm, provider: opts.llm?.backend ?? "none", detail: opts.llm ? `${opts.llm.backend} (${opts.llm.model})` : "no spotter" }
			: await createLlm(config.pipeline.judge, { tmpDir: paths.tmp })
	const detector = opts.detector ?? createDetector(config.pipeline.detector, paths.models)
	const h: Hooks = { kick: () => {}, inbox: null, running: new Map(), idle: new Map(), manage: null, applying: Promise.resolve() }

	const ctx: AppContext = {
		config,
		paths,
		store,
		bus,
		llm: judge.llm,
		judge: { provider: judge.provider, detail: judge.detail },
		detector,
		ingest: input => ingestFile({ store, paths, bus, minFreeBytes: () => ctx.config.retention.minFreeGb * 1e9 }, input),
		compile: async prompt => {
			const { compiled, usage } = await compileLookout(prompt, ctx.llm)
			if (usage) store.addUsage(usage)
			return compiled
		},
		kick: () => h.kick(),
		sourceStatuses: () => [
			...(h.inbox ? [h.inbox.status()] : []),
			...ctx.config.sources.flatMap(c => {
				const s = h.running.get(c.name)?.adapter.status() ?? h.idle.get(c.name)
				return s ? [s] : []
			})
		],
		pollSource: async name => {
			const s = name === "inbox" ? h.inbox : h.running.get(name)?.adapter
			if (!s) throw new Error(h.idle.has(name) ? `source "${name}" is not running (${h.idle.get(name)!.detail})` : `no source named "${name}"`)
			await s.pollNow()
		},
		reloadConfig: () => {
			// the server creates look4.config.json on the first settings save when none existed
			const fallback = join(ctx.config.rootDir, CONFIG_FILE)
			const path = ctx.config.configPath ?? (existsSync(fallback) ? fallback : null)
			const next = path ? loadConfig(path) : ctx.config
			// dataDir and the server address only change on restart
			ctx.config = { ...next, dataDir: ctx.config.dataDir, server: ctx.config.server }
			return ctx.config
		},
		applySources: () => {
			const manage = h.manage
			if (!manage) return Promise.resolve()
			h.applying = h.applying.then(manage, manage)
			return h.applying
		},
		reloadJudge: async () => {
			const next = await createLlm(ctx.config.pipeline.judge, { tmpDir: paths.tmp })
			ctx.llm = next.llm
			ctx.judge = { provider: next.provider, detail: next.detail }
			log.info(`judge: ${next.detail}`)
		},
		liveRecorder: name => {
			const cfg = ctx.config.sources.find(s => s.name === name)
			if (!cfg) return null
			// the named source first, then the others Live shows as this camera; a bare host match would
			// hand an NVR channel's Record to another channel's recording
			const into = foldedSources(ctx.config.sources)
			const owner = into.get(name) ?? name
			const same = [owner, ...[...into].filter(([, o]) => o === owner).map(([alias]) => alias)]
			for (const n of [name, ...same.filter(n => n !== name)]) {
				const r = h.running.get(n)?.adapter.liveRecorder?.()
				if (r) return r
			}
			return null
		},
		isRecording: name => ctx.liveRecorder(name) !== null
	}
	hooks.set(ctx, h)
	return ctx
}

export const startApp = async (
	config: LoadedConfig,
	opts: { server?: boolean; sources?: boolean } = {}
): Promise<{ ctx: AppContext; url: string | null; stop(): Promise<void> }> => {
	const ctx = await createContext(config)
	const h = hooks.get(ctx)!
	// listen first: a taken port should fail before any source has moved a file out of the inbox
	let server: { url: string; close(): Promise<void> } | null = null
	try {
		if (opts.server !== false) server = await createServer(ctx).listen()
	} catch (e) {
		ctx.store.close()
		throw e
	}
	const worker = createWorker(ctx)
	h.kick = worker.kick

	const sourceCtx = {
		store: ctx.store,
		paths: ctx.paths,
		bus: ctx.bus,
		ingest: ctx.ingest,
		kick: ctx.kick,
		rootDir: config.rootDir,
		minFreeBytes: () => ctx.config.retention.minFreeGb * 1e9,
		uncheckedDays: () => ctx.config.retention.motionlessDays,
		uncheckedGb: () => ctx.config.retention.uncheckedGb
	}
	// the inbox is a local drop folder, so it runs even with --no-sources
	h.inbox = createInboxSource(sourceCtx)

	/**
	 * Diffs `ctx.config.sources` against the running adapters: stops the ones
	 * that were removed, paused or changed (config or secret), starts the rest.
	 */
	const manage = async () => {
		const wanted = new Map(ctx.config.sources.filter(c => c.enabled).map(c => [c.name, c]))
		const stopping: Promise<void>[] = []
		for (const [name, r] of h.running) {
			const cfg = wanted.get(name)
			if (cfg && sourceSignature(cfg) === r.signature) continue
			h.running.delete(name)
			log.info(`source "${name}" ${cfg ? "changed; restarting it" : ctx.config.sources.some(c => c.name === name) ? "paused" : "removed"}`)
			stopping.push(r.adapter.stop().catch(e => log.warn(`stopping source "${name}" failed`, e)))
		}
		await Promise.all(stopping)
		h.idle.clear()
		for (const cfg of ctx.config.sources) {
			if (h.running.has(cfg.name)) continue
			if (!cfg.enabled) {
				const st = idleStatus(cfg, "stopped", PAUSED_DETAIL, ctx.store.countClips({ source: cfg.name }))
				h.idle.set(cfg.name, st)
				ctx.bus.emit("source", st)
				continue
			}
			if (opts.sources === false) {
				h.idle.set(cfg.name, idleStatus(cfg, "stopped", "Not started: look4 was started with --no-sources", ctx.store.countClips({ source: cfg.name })))
				continue
			}
			try {
				const adapter = createSource(cfg, sourceCtx)
				h.running.set(cfg.name, { adapter, signature: sourceSignature(cfg) })
				adapter.start()
			} catch (e) {
				log.error(`source "${cfg.name}" could not start`, e)
				const st = idleStatus(cfg, "error", `could not start: ${e instanceof Error ? e.message : String(e)}`)
				h.idle.set(cfg.name, st)
				ctx.bus.emit("source", st)
			}
		}
	}
	h.manage = manage

	worker.start()
	h.inbox.start()
	await ctx.applySources()

	if (config.pipeline.detector.enabled)
		ctx.detector.warmup().catch(e => log.warn(`detector warmup failed: ${e instanceof Error ? e.message : e}`))

	let stopping: Promise<void> | null = null
	const stop = () =>
		(stopping ??= (async () => {
			process.off("SIGINT", onSignal)
			process.off("SIGTERM", onSignal)
			await server?.close().catch(e => log.warn("server close failed", e))
			// no source may start after this point
			h.manage = null
			await h.applying.catch(() => {})
			await Promise.allSettled([h.inbox, ...[...h.running.values()].map(r => r.adapter)].map(s => s?.stop()))
			await worker.stop()
			ctx.store.close()
		})())
	const onSignal = (sig: NodeJS.Signals) => {
		log.info(`${sig}: shutting down`)
		// a second Ctrl-C while draining means "now"
		process.once(sig, () => process.exit(130))
		stop().then(
			() => process.exit(0),
			e => {
				log.error("shutdown failed", e)
				process.exit(1)
			}
		)
	}
	process.once("SIGINT", onSignal)
	process.once("SIGTERM", onSignal)

	return { ctx, url: server?.url ?? null, stop }
}
