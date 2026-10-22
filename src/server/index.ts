import { serve } from "@hono/node-server"
import { Hono } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { Server } from "node:http"
import { type AddressInfo, isIP } from "node:net"
import { hostname } from "node:os"
import { resolve } from "node:path"
import { ConfigError } from "../config.ts"
import type { AppContext } from "../context.ts"
import { logger } from "../log.ts"
import { LookoutError } from "../lookouts.ts"
import { apiRoutes } from "./api.ts"
import { createCloseUps } from "../live/closeup.ts"
import { createLive } from "../live/manager.ts"
import { clipMediaDir } from "../paths.ts"
import { detectStill } from "../pipeline/detect.ts"
import { CLIP_ID } from "./dto.ts"
import { mediaContentType, sendFile, serveStatic } from "./files.ts"
import { HttpError } from "./http.ts"
import { liveRoutes } from "./live.ts"
import { liveMediaRoutes } from "./live-media.ts"
import { liveRecordRoutes } from "./live-record.ts"
import { setupRoutes } from "./setup.ts"
import { createSseHub } from "./sse.ts"
import { createStatusChecks } from "./status.ts"

const log = logger("server")

const DEFAULT_WEB_DIST = resolve(import.meta.dirname, "../../web/dist")

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])
/** Binding to every interface means the user chose LAN access (a phone on the same Wi-Fi, say). */
const WILDCARD = new Set(["0.0.0.0", "::", "[::]"])
/** Suffixes home routers and mDNS put after a machine's own name: `feeder-pc.local`, `feeder-pc.lan`. */
const LOCAL_SUFFIXES = ["", ".local", ".lan", ".home", ".internal", ".home.arpa", ".localdomain"]
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

const bracketV6 = (host: string) => (host.includes(":") && !host.startsWith("[") ? `[${host}]` : host).toLowerCase()

/**
 * Which Host names may reach this server. Bound to one address, only that
 * address and loopback. Bound to every interface (LAN access), also any IP
 * literal and this machine's own name: DNS rebinding needs a hostile page to
 * be served from a name the attacker controls, and that name always arrives
 * as the Host, so refusing unknown names still stops it while
 * `http://192.168.1.20:4040` from a phone keeps working.
 */
export const hostAllowed = (host: string, bound: string, machine = hostname()) => {
	const h = host.toLowerCase()
	const b = bracketV6(bound)
	if (LOOPBACK.has(h) || h === b) return true
	if (!WILDCARD.has(b)) return false
	if (isIP(h.replace(/^\[|\]$/g, ""))) return true
	const name = machine.toLowerCase()
	return name !== "" && LOCAL_SUFFIXES.some(s => h === name + s)
}

/** `poster.jpg`, `preview.mp4`, `crop-<n>.jpg`, `closeup-<n>.jpg` or `original`: nothing else under /media is reachable. */
const MEDIA_FILE = /^(poster\.jpg|preview\.mp4|crop-\d{1,2}\.jpg|closeup-\d\.jpg|original)$/

export type ServerOptions = {
	/** The built UI. Default: `web/dist` in this repo. */
	webDist?: string
}

export const createServer = (ctx: AppContext, opts: ServerOptions = {}) => {
	const webDist = opts.webDist ?? DEFAULT_WEB_DIST
	const hub = createSseHub()
	const app = new Hono()

	app.onError((err, c) => {
		const status =
			err instanceof HttpError || err instanceof LookoutError ? err.status : err instanceof ConfigError ? 400 : 500
		// a deliberate 5xx (a camera that would not hand over a picture) is news, not a bug with a stack trace
		if (status >= 500) {
			if (err instanceof HttpError) log.warn(`${c.req.method} ${c.req.path}: ${err.message}`)
			else log.error(`${c.req.method} ${c.req.path}`, err)
		}
		return c.json({ error: err.message || "internal error" }, status as ContentfulStatusCode)
	})

	// Local-app hardening. DNS rebinding: a hostile page that re-points its own
	// domain at this machine still sends its own name as Host, so only names
	// that mean "this machine" are served (see hostAllowed). CSRF: a browser
	// always sends Origin on a cross-site POST, and it must name this same host.
	app.use("*", async (c, next) => {
		const url = new URL(c.req.url)
		if (!hostAllowed(url.hostname, ctx.config.server.host))
			return c.json({ error: `host "${url.hostname}" is not allowed; open look4 via localhost or this computer's IP address` }, 403)
		const origin = c.req.header("origin")
		if (!SAFE_METHODS.has(c.req.method) && origin !== undefined) {
			let originHost: string | null = null
			try {
				originHost = new URL(origin).host
			} catch {}
			if (originHost !== url.host) return c.json({ error: "cross-origin request refused" }, 403)
		}
		await next()
	})

	const checks = createStatusChecks(ctx)
	const live = createLive({
		config: () => ctx.config,
		statuses: () => ctx.sourceStatuses(),
		dataDir: ctx.config.dataDir,
		recording: name => ctx.isRecording(name)
	})
	// setup and live routes first: apiRoutes ends in a catch-all 404
	app.route("/api", setupRoutes(ctx, checks))
	app.route("/api", liveMediaRoutes(live))
	// the detector's model and switch only change on restart, like the worker's (README, Configuration)
	const detector = ctx.config.pipeline.detector
	const closeUps = createCloseUps({
		bus: ctx.bus,
		config: () => ctx.config,
		live,
		detect: input => (detector.enabled ? detectStill({ ...ctx.config.pipeline.detector, model: detector.model }, ctx.paths.models, input) : Promise.resolve(null)),
		dir: ctx.paths.closeUps,
		mediaDir: id => clipMediaDir(ctx.paths, id),
		clipStatus: id => ctx.store.getClip(id)?.status ?? null
	})
	app.route("/api", liveRoutes(live, { onSteer: name => closeUps.steered(name) }))
	app.route("/api", liveRecordRoutes(ctx))
	app.route("/api", apiRoutes(ctx, hub, checks))

	app.get("/media/:clipId/:file", c => {
		const id = c.req.param("clipId")
		const file = c.req.param("file")
		if (!CLIP_ID.test(id) || !MEDIA_FILE.test(file)) throw new HttpError(404, "not found")
		const clip = ctx.store.getClip(id)
		if (!clip) throw new HttpError(404, `no clip ${id}`)
		if (file === "original") {
			// the path comes from the database, never from the URL
			if (!clip.path) throw new HttpError(404, "the original was deleted by retention")
			// the extension came from an upload or the camera's file list, so it never picks a type a browser would run
			return sendFile(clip.path, c.req.raw, {
				cacheControl: "private, max-age=3600",
				contentType: mediaContentType(clip.path),
				download: clip.originalName,
				sandbox: true
			})
		}
		// URLs carry ?v=<processedAt>, so stills can be cached for good; the preview may be large, so revalidate it
		const still = file.endsWith(".jpg")
		return sendFile(resolve(ctx.paths.media, id, file), c.req.raw, {
			cacheControl: still ? "public, max-age=31536000, immutable" : "private, max-age=3600",
			sandbox: true
		})
	})
	app.all("/media/*", () => {
		throw new HttpError(404, "not found")
	})

	app.get("*", c => serveStatic(webDist, c.req.path, c.req.raw))
	app.notFound(c => c.json({ error: "not found" }, 404))

	const listen = () =>
		new Promise<{ url: string; close(): Promise<void> }>((resolveListen, reject) => {
			const { host, port } = ctx.config.server
			// By default @hono/node-server swaps the global Request/Response for its own
			// classes. transformers.js then sees fetch() results that are not
			// `instanceof Response`, skips writing the downloaded model to its file cache,
			// and a first run fails with "Unable to get model file path or buffer".
			const server = serve({ fetch: app.fetch, hostname: host, port, overrideGlobalObjects: false }) as Server
			const onError = (e: NodeJS.ErrnoException) => {
				reject(
					e.code === "EADDRINUSE"
						? new Error(`port ${port} is already in use (is look4 already running?); pick another with --port`)
						: e
				)
			}
			server.once("error", onError)
			server.once("listening", () => {
				server.off("error", onError)
				const actual = (server.address() as AddressInfo).port
				const shown = WILDCARD.has(bracketV6(host)) ? "localhost" : bracketV6(host)
				resolveListen({
					url: `http://${shown}:${actual}`,
					close: async () => {
						// a close-up in progress sends the camera Home first, through the driver live.close() closes
						await closeUps.close()
						return new Promise<void>(done => {
							// open SSE streams and live video would otherwise hold the server open forever
							hub.closeAll()
							void live.close()
							const force = setTimeout(() => server.closeAllConnections(), 2000)
							force.unref()
							server.close(() => {
								clearTimeout(force)
								done()
							})
							server.closeIdleConnections()
						})
					}
				})
			})
		})

	return { app, listen }
}
