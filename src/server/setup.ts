// The guided-setup API: first-run status, camera discovery and testing, the
// folder picker, the judge's API key, and adding/editing/removing sources while
// the app runs. Secrets go to `.env` and are never echoed back.

import Anthropic from "@anthropic-ai/sdk"
import { type } from "arktype"
import { existsSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { Hono } from "hono"
import type {
	AddSourceBody,
	CameraTestResult,
	DiscoverResponse,
	FolderListing,
	ProbeResult,
	RtspTestResult,
	SetupStatus,
	SourceDto
} from "../api-types.ts"
import {
	CONFIG_FILE,
	ConfigError,
	configJsonSchema,
	type ReolinkSourceConfig,
	type SourceConfig,
	updateConfigFile
} from "../config.ts"
import type { AppContext } from "../context.ts"
import { logger } from "../log.ts"
import { slugify } from "../lookouts.ts"
import { splitHostPort, testCamera } from "../setup/camera-test.ts"
import { discover, hostOf, probePorts, sourceHost } from "../setup/discover.ts"
import { parseHost } from "../sources/reolink-api.ts"
import { updateEnvFile } from "../setup/envfile.ts"
import { FolderError, listFolder } from "../setup/fs-list.ts"
import { SnapshotError, sourceSnapshot, testStream } from "../setup/snapshot.ts"
import {
	idleStatus,
	PAUSED_DETAIL,
	secretEnvOf,
	SETUP_KEY,
	type SetupFlag,
	setupCompleted
} from "../setup/sources.ts"
import { publicSource } from "./dto.ts"
import { HttpError, readBody } from "./http.ts"
import type { StatusChecks } from "./status.ts"

const log = logger("setup")

const SCHEMA_FILE = "look4.schema.json"
const SOURCE_NAME = /^[a-z0-9][a-z0-9-]*$/
/** Source names ingest already uses for clips that did not come from a configured source. */
const RESERVED_NAMES = new Set(["inbox", "upload", "scan"])
const STREAM_URL = /^(rtsps?|rtmps?|https?):\/\/\S+$/i

const optionalName = "string.trim"

const CameraTest = type({
	host: "string.trim |> string > 0",
	"username?": "string",
	"password?": "string",
	"protocol?": "'auto' | 'http' | 'https'",
	"source?": "string > 0",
	"+": "delete"
})

const RtspTest = type({ url: "string.trim |> string > 0", "+": "delete" })
const Probe = type({ host: "string.trim |> string > 0", "+": "delete" })

const AddReolink = type({
	type: "'reolink'",
	"name?": optionalName,
	host: "string.trim |> string > 0",
	"username?": "string.trim",
	"password?": "string",
	"stream?": "'main' | 'sub'",
	"lookbackHours?": "0 <= number <= 8760",
	"+": "delete"
})
const AddWatch = type({ type: "'watch'", "name?": optionalName, dir: "string.trim |> string > 0", "move?": "boolean", "+": "delete" })
const AddRtsp = type({
	type: "'rtsp'",
	"name?": optionalName,
	url: "string.trim |> string > 0",
	"segmentSeconds?": "5 <= number <= 600",
	"+": "delete"
})
const AddSource = AddReolink.or(AddWatch).or(AddRtsp)

const UpdateSource = type({
	"host?": "string.trim |> string > 0",
	"username?": "string.trim",
	"password?": "string",
	"stream?": "'main' | 'sub'",
	"dir?": "string.trim |> string > 0",
	"move?": "boolean",
	"url?": "string.trim |> string > 0",
	"enabled?": "boolean",
	"capture?": "'auto' | 'stream' | 'sd'",
	"motionGate?": "'both' | 'camera' | 'all'",
	"closeUps?": "boolean",
	"+": "delete"
})

const CompleteSetup = type({ "skipped?": "boolean", "uploadOnly?": "boolean", "+": "delete" })
const JudgeKey = type({ apiKey: "string.trim |> string > 0", "+": "delete" })

const envSuffix = (name: string) => name.toUpperCase().replace(/-/g, "_")

const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? homedir() + p.slice(1) : p)

/**
 * Checks a key against the Models API, which costs nothing. Only a definite
 * "no" from Anthropic blocks saving; an unreachable API should not stop an
 * offline setup.
 */
const verifyApiKey = async (apiKey: string): Promise<"ok" | "rejected" | "unverified"> => {
	const client = new Anthropic({ apiKey, authToken: null, maxRetries: 0, timeout: 10_000 })
	try {
		await client.models.list({ limit: 1 })
		return "ok"
	} catch (e) {
		if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return "rejected"
		log.warn(`could not verify the API key (saving it anyway): ${e instanceof Error ? e.message : String(e)}`)
		return "unverified"
	}
}

export const setupRoutes = (ctx: AppContext, checks: StatusChecks) => {
	const api = new Hono()

	const flag = () => ctx.store.getKv<SetupFlag>(SETUP_KEY)
	/** Recent frames per source: the zone editor and a re-render must not log in to the camera each time. */
	const snapshots = new Map<string, { at: number; jpeg: Promise<Buffer> }>()

	const sourceDto = (cfg: SourceConfig): SourceDto => ({
		config: publicSource(cfg),
		status:
			ctx.sourceStatuses().find(s => s.name === cfg.name) ??
			idleStatus(cfg, "stopped", cfg.enabled ? "not running" : PAUSED_DETAIL, ctx.store.countClips({ source: cfg.name }))
	})

	const setupStatus = async (): Promise<SetupStatus> => {
		const f = flag()
		const sources = ctx.config.sources
		const lookouts = ctx.store.listLookouts().length
		const judge = await checks.judgeStatus()
		return {
			completed: setupCompleted(ctx.store, sources),
			steps: {
				source: sources.length > 0 || (f?.uploadOnly ?? false),
				zone: ctx.config.pipeline.roi !== null,
				lookout: lookouts > 0,
				judge: judge.ok
			},
			sources: sources.map(sourceDto),
			judge,
			detector: checks.detectorStatus(),
			configPath: ctx.config.configPath
		}
	}

	const findSource = (name: string) => {
		const cfg = ctx.config.sources.find(s => s.name === name)
		if (!cfg) throw new HttpError(404, `There's no source called “${name}”.`)
		return cfg
	}

	/**
	 * Edits the `sources` list in look4.config.json, creating the file (with its
	 * JSON schema, as `look4 init` does) on the first save, then reloads the config.
	 */
	const editSources = (mutate: (list: Array<Record<string, any>>) => void) => {
		const path = ctx.config.configPath ?? join(ctx.config.rootDir, CONFIG_FILE)
		const fresh = !existsSync(path)
		try {
			updateConfigFile(path, raw => {
				const list: Array<Record<string, any>> = Array.isArray(raw.sources) ? raw.sources : []
				mutate(list)
				raw.sources = list
				if (fresh) {
					const rest = { ...raw }
					for (const k of Object.keys(raw)) delete raw[k]
					Object.assign(raw, { $schema: `./${SCHEMA_FILE}` }, rest)
				}
			})
		} catch (e) {
			if (e instanceof ConfigError) throw new HttpError(400, e.message.replace(/^[^\n]* is invalid:\n/, ""))
			throw e
		}
		if (fresh) writeFileSync(join(dirname(path), SCHEMA_FILE), JSON.stringify(configJsonSchema(), null, "\t") + "\n")
		return ctx.reloadConfig()
	}

	/**
	 * The saved camera password only ever goes to the address it was saved for.
	 * Otherwise anything that can reach this API (a LAN device when look4 is
	 * bound to 0.0.0.0) could point a saved camera at its own address and
	 * collect the password from the login attempt.
	 */
	const savedPasswordFor = (saved: ReolinkSourceConfig, host: string) => {
		if (hostOf(host) !== hostOf(saved.host))
			throw new HttpError(
				400,
				`${host} is a new address for “${saved.name}”, so type the camera's password again. look4 only sends the saved password to the address it was saved for.`
			)
	}

	const checkDir = (raw: string) => {
		const dir = resolve(ctx.config.rootDir, expandHome(raw))
		if (!isAbsolute(expandHome(raw))) throw new HttpError(400, "Pick a folder with the folder browser, or type its full path (starting with /).")
		let isDir = false
		try {
			isDir = statSync(dir).isDirectory()
		} catch {}
		if (!isDir) throw new HttpError(400, `There's no folder at ${dir}.`)
		return dir
	}

	const checkStreamUrl = (url: string) => {
		if (!STREAM_URL.test(url))
			throw new HttpError(400, "That address should start with rtsp:// (for example rtsp://192.168.1.50:554/h264Preview_01_main).")
	}

	const pickName = (requested: string | undefined, base: string) => {
		const taken = new Set([...ctx.config.sources.map(s => s.name), ...RESERVED_NAMES])
		if (requested) {
			if (!SOURCE_NAME.test(requested) || requested.length > 40)
				throw new HttpError(400, "Names can use lowercase letters, numbers and dashes, like “backyard” or “porch-cam”.")
			if (taken.has(requested)) throw new HttpError(409, `There's already a source called “${requested}”. Pick another name.`)
			return requested
		}
		const stem = base || "camera"
		if (!taken.has(stem)) return stem
		for (let i = 2; ; i++) if (!taken.has(`${stem}-${i}`)) return `${stem}-${i}`
	}

	// ---- setup status ----

	api.get("/setup", async c => c.json(await setupStatus()))

	api.post("/setup/complete", async c => {
		const body = await readBody(c, CompleteSetup)
		const prev = flag()
		ctx.store.setKv(SETUP_KEY, {
			at: new Date().toISOString(),
			skipped: body.skipped ?? false,
			uploadOnly: (body.uploadOnly ?? false) || (prev?.uploadOnly ?? false)
		} satisfies SetupFlag)
		return c.json(await setupStatus())
	})

	// ---- finding and testing a camera ----

	/** One scan at a time: a second click joins the running one instead of doubling the probes. */
	let scanning: Promise<DiscoverResponse> | null = null
	api.post("/setup/discover", async c => {
		scanning ??= discover({ sources: ctx.config.sources }).finally(() => (scanning = null))
		return c.json(await scanning)
	})

	api.post("/setup/test-camera", async c => {
		const { source, ...body } = await readBody(c, CameraTest)
		// "Fix it" and Edit re-test a saved camera without making the user retype its login
		let { username, password } = body
		if (source !== undefined) {
			const saved = findSource(source)
			if (saved.type !== "reolink") throw new HttpError(400, `“${source}” isn't a Reolink camera.`)
			username ??= saved.username
			if (password === undefined) {
				savedPasswordFor(saved, body.host)
				password = process.env[saved.passwordEnv] ?? ""
			}
		}
		const result: CameraTestResult = await testCamera({ ...body, username, password: password ?? "" })
		return c.json(result)
	})

	// "Check again" in the port walkthrough: knocks on the camera's ports, never signs in
	api.post("/setup/probe", async c => {
		const { host } = await readBody(c, Probe)
		const { hostPort } = parseHost(host, "auto")
		const { hostname } = splitHostPort(hostPort)
		if (!hostOf(hostname)) throw new HttpError(400, "That doesn't look like a camera address.")
		const { ports } = await probePorts(hostname, 1500)
		const result: ProbeResult = { host: hostname, ports }
		return c.json(result)
	})

	api.post("/setup/test-rtsp", async c => {
		const { url } = await readBody(c, RtspTest)
		const result: RtspTestResult = STREAM_URL.test(url)
			? await testStream(url)
			: { ok: false, detail: "That address should start with rtsp:// (for example rtsp://192.168.1.50:554/h264Preview_01_main)." }
		return c.json(result)
	})

	// ---- the judge ----

	api.post("/setup/judge-key", async c => {
		const { apiKey } = await readBody(c, JudgeKey)
		if (!/^sk-ant-[\w-]{8,}$/.test(apiKey) || /\s/.test(apiKey))
			throw new HttpError(400, "That doesn't look like an Anthropic API key. Keys start with “sk-ant-”.")
		if ((await verifyApiKey(apiKey)) === "rejected")
			throw new HttpError(400, "Anthropic didn't accept that key. Copy it again from console.anthropic.com (it's shown only once when created).")
		updateEnvFile(ctx.config.rootDir, { ANTHROPIC_API_KEY: apiKey })
		// a judge that was switched off or pinned to Claude Code would ignore the key
		const provider = ctx.config.pipeline.judge.provider
		if (provider !== "auto" && provider !== "anthropic") {
			const path = ctx.config.configPath ?? join(ctx.config.rootDir, CONFIG_FILE)
			updateConfigFile(path, raw => {
				const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? v : {})
				const pipeline = (raw.pipeline = obj(raw.pipeline))
				pipeline.judge = { ...obj(pipeline.judge), provider: "auto" }
			})
			ctx.reloadConfig()
		}
		await ctx.reloadJudge()
		return c.json(await setupStatus())
	})

	// ---- folder picker ----

	api.get("/fs/list", async c => {
		try {
			const body: FolderListing = await listFolder(c.req.query("path"))
			return c.json(body)
		} catch (e) {
			if (e instanceof FolderError) throw new HttpError(e.status, e.message)
			throw e
		}
	})

	// ---- sources ----

	api.get("/sources", c => c.json(ctx.config.sources.map(sourceDto)))

	api.post("/sources", async c => {
		const body: AddSourceBody = await readBody(c, AddSource)
		const env: Record<string, string> = {}
		let entry: Record<string, unknown>
		if (body.type === "reolink") {
			const host = hostOf(body.host)
			const twin = ctx.config.sources.find(s => sourceHost(s) === host)
			if (twin) throw new HttpError(409, `That camera is already set up as “${twin.name}”.`)
			const name = pickName(body.name || undefined, "camera")
			const firstReolink = !ctx.config.sources.some(s => s.type === "reolink" && s.passwordEnv === "REOLINK_PASSWORD")
			const passwordEnv = firstReolink ? "REOLINK_PASSWORD" : `REOLINK_PASSWORD_${envSuffix(name)}`
			env[passwordEnv] = body.password ?? ""
			entry = {
				type: "reolink",
				name,
				host: body.host,
				username: body.username || "admin",
				passwordEnv,
				...(body.stream ? { stream: body.stream } : {}),
				...(body.lookbackHours !== undefined ? { lookbackHours: body.lookbackHours } : {})
			}
		} else if (body.type === "watch") {
			const dir = checkDir(body.dir)
			const twin = ctx.config.sources.find(s => s.type === "watch" && resolve(ctx.config.rootDir, expandHome(s.dir)) === dir)
			if (twin) throw new HttpError(409, `That folder is already watched as “${twin.name}”.`)
			const name = pickName(body.name || undefined, slugify(dir.split("/").filter(Boolean).at(-1) ?? "") || "folder")
			entry = { type: "watch", name, dir, ...(body.move !== undefined ? { move: body.move } : {}) }
		} else {
			checkStreamUrl(body.url)
			const name = pickName(body.name || undefined, "camera")
			const urlEnv = `LOOK4_RTSP_URL_${envSuffix(name)}`
			env[urlEnv] = body.url
			entry = { type: "rtsp", name, urlEnv, ...(body.segmentSeconds !== undefined ? { segmentSeconds: body.segmentSeconds } : {}) }
		}
		// the secret first: the adapter reads it the moment the config change starts it
		const before = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k] ?? null]))
		updateEnvFile(ctx.config.rootDir, env)
		try {
			editSources(list => list.push(entry))
		} catch (e) {
			updateEnvFile(ctx.config.rootDir, before)
			throw e
		}
		await ctx.applySources()
		log.info(`added ${entry.type} source "${entry.name}"`)
		return c.json(sourceDto(findSource(String(entry.name))), 201)
	})

	api.patch("/sources/:name", async c => {
		const cfg = findSource(c.req.param("name"))
		snapshots.delete(cfg.name)
		const body = await readBody(c, UpdateSource)
		const env: Record<string, string> = {}
		const patch: Record<string, unknown> = {}
		const drop: string[] = []
		if (cfg.type === "reolink") {
			if (body.host !== undefined) {
				if (body.password === undefined) savedPasswordFor(cfg, body.host)
				patch.host = body.host
			}
			if (body.username !== undefined) patch.username = body.username || "admin"
			if (body.stream !== undefined) patch.stream = body.stream
			if (body.capture !== undefined) patch.capture = body.capture
			if (body.motionGate !== undefined) patch.motionGate = body.motionGate
			// off is the default, so switching close-ups off just drops the key
			if (body.closeUps === true) patch.closeUps = true
			if (body.closeUps === false) drop.push("closeUps")
			if (body.password !== undefined) env[cfg.passwordEnv] = body.password
		} else if (cfg.type === "watch") {
			if (body.dir !== undefined) patch.dir = checkDir(body.dir)
			if (body.move !== undefined) patch.move = body.move
		} else if (body.url !== undefined) {
			checkStreamUrl(body.url)
			// a URL that sat in the config file moves to .env now that it is being changed
			const urlEnv = cfg.urlEnv ?? `LOOK4_RTSP_URL_${envSuffix(cfg.name)}`
			env[urlEnv] = body.url
			if (!cfg.urlEnv) {
				patch.urlEnv = urlEnv
				drop.push("url")
			}
		}
		// the schema default is true, so turning a source back on just drops the flag
		if (body.enabled === false) patch.enabled = false
		if (body.enabled === true && !cfg.enabled) drop.push("enabled")
		if (Object.keys(env).length) updateEnvFile(ctx.config.rootDir, env)
		if (Object.keys(patch).length || drop.length)
			editSources(list => {
				const raw = list.find(s => s?.name === cfg.name)
				if (!raw) return
				Object.assign(raw, patch)
				for (const k of drop) delete raw[k]
			})
		await ctx.applySources()
		return c.json(sourceDto(findSource(cfg.name)))
	})

	api.delete("/sources/:name", async c => {
		const cfg = findSource(c.req.param("name"))
		snapshots.delete(cfg.name)
		editSources(list => {
			const i = list.findIndex(s => s?.name === cfg.name)
			if (i >= 0) list.splice(i, 1)
		})
		// a re-added source with this name starts from its lookback again, not from the old cursor
		ctx.store.db.prepare("DELETE FROM kv WHERE key = ?").run(`reolink:${cfg.name}:cursor`)
		await ctx.applySources()
		const secret = secretEnvOf(cfg)
		if (secret && !ctx.config.sources.some(s => secretEnvOf(s) === secret)) updateEnvFile(ctx.config.rootDir, { [secret]: null })
		log.info(`removed source "${cfg.name}"`)
		return c.json({ ok: true as const })
	})

	api.get("/sources/:name/snapshot", async c => {
		const cfg = findSource(c.req.param("name"))
		const hit = snapshots.get(cfg.name)
		let jpeg: Promise<Buffer>
		if (hit && Date.now() - hit.at < 3000) jpeg = hit.jpeg
		else {
			const status = ctx.sourceStatuses().find(s => s.name === cfg.name)
			jpeg = sourceSnapshot(cfg, { store: ctx.store, rootDir: ctx.config.rootDir, status })
			snapshots.set(cfg.name, { at: Date.now(), jpeg })
			jpeg.catch(() => snapshots.delete(cfg.name))
		}
		try {
			const bytes = await jpeg
			return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" } })
		} catch (e) {
			if (e instanceof SnapshotError) throw new HttpError(502, e.message)
			throw e
		}
	})

	return api
}
