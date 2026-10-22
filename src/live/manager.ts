// Live view for the configured sources: which can show video and how, the
// running Motion JPEG hubs and MP4 sessions, and each camera's control driver.
// An RTSP source pointing at the same host as a Reolink source is the same
// camera: it is listed once (as the Reolink entry, which can be steered) and its
// own name keeps working everywhere, meaning that entry.

import type { LiveProblem, LiveSourceDto, LiveStream } from "../api-types.ts"
import type { LoadedConfig, ReolinkSourceConfig, SourceConfig } from "../config.ts"
import { logger } from "../log.ts"
import { probePort } from "../setup/discover.ts"
import { grabStreamFrame } from "../setup/snapshot.ts"
import { sourceSignature } from "../setup/sources.ts"
import { LOGIN_REFUSED } from "../sources/reolink.ts"
import type { SourceStatus } from "../types.ts"
import { type CameraControl, type ControlDriver, ControlError, createControl } from "./control.ts"
import { AudioCopyError, CAMERA_FAULT, createHub, FeedError, ffmpegFrames, hasNvenc, type Hub, type Mp4Audio, type Mp4Plan, type Mp4Session, openMp4, polledFrames } from "./feeds.ts"
import { reolinkHostname, reolinkRtspUrl, streamVariant } from "./inputs.ts"
import { reolinkDriver } from "./reolink-control.ts"

const log = logger("live")

type LiveSourceConfig = Extract<SourceConfig, { type: "reolink" | "rtsp" }>

export type LiveDeps = {
	config: () => LoadedConfig
	statuses: () => SourceStatus[]
	env?: NodeJS.ProcessEnv
	/** Control drivers, tried in order. Default: Reolink. */
	drivers?: ControlDriver[]
	/** Whether a TCP port answers; tests stub it. */
	probe?: (host: string, port: number) => Promise<boolean>
	/** look4's data directory: control drivers keep thumbnails and the Home position under `<dataDir>/live/`. */
	dataDir: string
	/** look4 is recording this source's stream (so a clip can be saved from Live). Default: never. */
	recording?: (name: string) => boolean
	/** Whether NVENC works on this machine; tests stub it. Default: checked once with ffmpeg. */
	nvenc?: () => Promise<boolean>
}

type Resolved = { dto: LiveSourceDto; url: string | null; cfg: LiveSourceConfig }

const NEEDS_PASSWORD =
	"Reolink cameras only share live video once the camera has a password. Set one in the Reolink app (camera Settings → Advanced → User Management, or Device Password), then type it in look4's Settings → Sources → Edit. Until then look4 shows a fresh picture every second."

const RTSP_OFF = (host: string, port: number) =>
	`The camera's live video (RTSP, port ${port}) is switched off at ${host}, so look4 shows a fresh picture every second instead. Turn RTSP on in the Reolink app: camera Settings → Network → Advanced → Server Settings (or Port Settings).`

/** Live MP4 viewers at once, across all cameras. Cameras themselves allow a handful of RTSP clients. */
export const MAX_MP4_SESSIONS = 8

const MJPEG = { main: { fps: 8, maxWidth: 1920 }, sub: { fps: 12, maxWidth: 1280 } } as const

const rtspUrlOf = (cfg: Extract<LiveSourceConfig, { type: "rtsp" }>, env: NodeJS.ProcessEnv) => cfg.url ?? (cfg.urlEnv ? env[cfg.urlEnv] : undefined)

const urlHost = (url: string | undefined) => {
	try {
		return url ? new URL(url).hostname.toLowerCase() || null : null
	} catch {
		return null
	}
}

/**
 * RTSP source name → the Reolink source at the same host, which stands for
 * both. A URL naming a Reolink channel (`…Preview_02_main`) only matches that
 * channel, so an NVR's other cameras stay apart. Live Record follows the same
 * rule to find a source recording the camera (src/app.ts).
 */
export const foldedSources = (all: SourceConfig[], env: NodeJS.ProcessEnv = process.env) => {
	const reolinks = all.filter((s): s is Extract<LiveSourceConfig, { type: "reolink" }> => s.type === "reolink")
	const into = new Map<string, string>()
	for (const s of all) {
		if (s.type !== "rtsp") continue
		const url = rtspUrlOf(s, env)
		const host = urlHost(url)
		const channel = /Preview_(\d{2})_/i.exec(url ?? "")?.[1]
		const owner = host && reolinks.find(r => reolinkHostname(r)?.toLowerCase() === host && (channel === undefined || Number(channel) === r.channel + 1))
		if (owner) into.set(s.name, owner.name)
	}
	return into
}

export const createLive = (deps: LiveDeps) => {
	const env = deps.env ?? process.env
	const probe = deps.probe ?? ((host: string, port: number) => probePort(host.replace(/^\[|\]$/g, ""), port, 1500))
	const nvencOk = deps.nvenc ?? hasNvenc
	const hubs = new Map<string, Hub>()
	const sessions = new Set<Mp4Session>()
	const controls = new Map<string, { sig: string; control: CameraControl }>()
	/** Input codec per source and stream, learned from the first MP4 session or Motion JPEG hub. */
	const codecs = new Map<string, string>()
	/** How each source's sound goes into MP4, once copying it failed (G.711 cameras): re-encoded. */
	const audioModes = new Map<string, Exclude<Mp4Audio, "none">>()
	const ports = new Map<string, { at: number; open: Promise<boolean> }>()
	let ladder: Array<Extract<Mp4Plan, { kind: "transcode" }>["via"]> | null = null
	/** Motion JPEG of a main stream decodes on the GPU until that fails once. */
	let gpuMjpeg = true
	/** MP4 sessions whose ffmpeg is still starting: not in `sessions` yet, but holding a slot under the cap. */
	let opening = 0

	const loginRefused = (name: string) => {
		const s = deps.statuses().find(x => x.name === name)
		return s?.state === "error" && s.detail.startsWith(LOGIN_REFUSED) ? s.detail : null
	}

	const drivers = deps.drivers ?? [reolinkDriver((cfg: ReolinkSourceConfig) => ({ blocked: () => loginRefused(cfg.name), dataDir: deps.dataDir }))]

	const liveSources = () => deps.config().sources.filter((s): s is LiveSourceConfig => s.type === "reolink" || s.type === "rtsp")

	const rtspUrl = (cfg: Extract<LiveSourceConfig, { type: "rtsp" }>) => rtspUrlOf(cfg, env)

	const folded = (all: LiveSourceConfig[]) => foldedSources(all, env)

	const find = (name: string): LiveSourceConfig => {
		const all = liveSources()
		const owner = folded(all).get(name) ?? name
		const cfg = all.find(s => s.name === owner)
		if (!cfg) throw new ControlError(404, `There's no camera called “${name}”.`)
		return cfg
	}

	const portOpen = (host: string, port: number) => {
		const key = `${host}:${port}`
		const hit = ports.get(key)
		if (hit && Date.now() - hit.at < 10_000) return hit.open
		const open = probe(host, port)
		ports.set(key, { at: Date.now(), open })
		return open
	}

	const sig = (cfg: SourceConfig) => sourceSignature(cfg, env)
	const codecKey = (cfg: LiveSourceConfig, stream: LiveStream) => `${cfg.name}\n${stream}\n${sig(cfg)}`

	/** The transcode rungs this machine has, best first (the GPU ones drop out once they fail). */
	const rungs = async () => (ladder ??= (await nvencOk()) ? ["gpu", "nvenc", "x264"] : ["x264"])

	/**
	 * Sharp (main) when it plays without the CPU re-encoding it: the server has
	 * NVENC, or the main stream is already H.264. The CPU transcode of a 4K main
	 * stream can't keep up, so without NVENC the page opens on Quick.
	 */
	const defaultStream = async (cfg: LiveSourceConfig, streams: LiveStream[]): Promise<LiveStream> => {
		if (!streams.includes("main")) return streams[0] ?? "main"
		if (codecs.get(codecKey(cfg, "main")) === "h264") return "main"
		return (await rungs()).some(v => v !== "x264") ? "main" : "sub"
	}

	const resolve = async (cfg: LiveSourceConfig, stream: LiveStream): Promise<Resolved> => {
		const aliases = [...folded(liveSources())].filter(([, owner]) => owner === cfg.name).map(([alias]) => alias)
		const base = {
			name: cfg.name,
			type: cfg.type,
			controllable: drivers.some(d => d.name === cfg.type),
			aliases,
			recording: [cfg.name, ...aliases].some(n => deps.recording?.(n) ?? false)
		}
		const none = (feed: LiveSourceDto["feed"], problem: LiveProblem, detail: string, host: string | null = null): Resolved => ({
			dto: { ...base, feed, streams: [], defaultStream: "main", problem, detail, host },
			url: null,
			cfg
		})
		const streamDto = async (streams: LiveStream[], host: string | null): Promise<LiveSourceDto> => ({
			...base,
			feed: "stream",
			streams,
			defaultStream: await defaultStream(cfg, streams),
			problem: null,
			detail: null,
			host
		})
		if (cfg.type === "reolink") {
			const host = reolinkHostname(cfg)
			const refused = loginRefused(cfg.name)
			if (refused) return none(null, "login-refused", refused, host)
			const password = env[cfg.passwordEnv]
			if (password === undefined) return none(null, "login-refused", `The camera's password isn't saved yet (${cfg.passwordEnv}).`, host)
			// RTSP on Reolink refuses an empty password outright; asking would only count as a failed login
			if (password === "") return none("stills", "needs-password", NEEDS_PASSWORD, host)
			if (!host || !(await portOpen(host, cfg.rtspPort))) return none("stills", "rtsp-off", RTSP_OFF(host ?? cfg.host, cfg.rtspPort), host)
			return { dto: await streamDto(["main", "sub"], host), url: reolinkRtspUrl(cfg, password, stream), cfg }
		}
		const url = rtspUrl(cfg)
		if (!url) return none(null, "no-address", `The stream's address isn't saved yet${cfg.urlEnv ? ` (${cfg.urlEnv})` : ""}.`)
		const variants = streamVariant(url, "main") !== null
		return {
			dto: await streamDto(variants ? ["main", "sub"] : [], urlHost(url)),
			url: variants ? streamVariant(url, stream)! : url,
			cfg
		}
	}

	const controlFor = (name: string): CameraControl | null => {
		const cfg = find(name)
		const s = sig(cfg)
		const hit = controls.get(cfg.name)
		if (hit?.sig === s) return hit.control
		void hit?.control.close().catch(() => {})
		controls.delete(cfg.name)
		const control = createControl(drivers, cfg, env)
		if (control) controls.set(cfg.name, { sig: s, control })
		return control
	}

	const hubFor = async (name: string, stream: LiveStream): Promise<Hub> => {
		const cfg = find(name)
		const r = await resolve(cfg, stream)
		if (!r.dto.feed) throw new ControlError(409, r.dto.detail ?? "This camera has no live picture right now.")
		const key = `${cfg.name}\n${stream}\n${r.dto.feed}\n${sig(cfg)}`
		const hit = hubs.get(key)
		if (hit) return hit
		let produce
		if (r.url) {
			const ck = codecKey(cfg, stream)
			const known = codecs.get(ck)
			// a 4K main stream decoded on the CPU falls behind real time; NVDEC keeps up at ~0.1 core
			const gpu = stream === "main" && gpuMjpeg && (known === "hevc" || known === "h264") && (await rungs()).includes("gpu") ? known : null
			produce = ffmpegFrames(r.url, {
				...MJPEG[stream],
				gpu,
				onCodec: c => codecs.set(ck, c),
				onGpuFailed: () => {
					gpuMjpeg = false
					log.warn("live Motion JPEG on the GPU failed; decoding on the CPU from now on")
				}
			})
		} else {
			const control = controlFor(cfg.name)
			if (!control) throw new ControlError(409, r.dto.detail ?? "This camera has no live picture right now.")
			produce = polledFrames(signal => control.snapshot(signal), { intervalMs: 1000, maxWidth: 1280 })
		}
		const hub = createHub(produce, { onIdle: () => hubs.get(key) === hub && hubs.delete(key) })
		hubs.set(key, hub)
		return hub
	}

	/** The camera itself failing (not an encoder or the muxer): no point trying another way. */
	const cameraFault = (e: unknown) => e instanceof FeedError && CAMERA_FAULT.test(e.message)

	const transcode = async (open: (plan: Mp4Plan) => Promise<Mp4Session>, codec: string | undefined): Promise<Mp4Session> => {
		let last: unknown = null
		for (const via of [...(await rungs())]) {
			// NVDEC needs to know the codec up front; an unknown one goes straight to the CPU decoders
			if (via === "gpu" && codec !== "h264" && codec !== "hevc") continue
			try {
				return await open(via === "gpu" ? { kind: "transcode", via, codec: codec as "h264" | "hevc" } : { kind: "transcode", via })
			} catch (e) {
				last = e
				// only drop a rung that broke on its own
				if (cameraFault(e)) throw e
				log.warn(`live transcode via ${via} failed, trying the next way: ${e instanceof Error ? e.message : String(e)}`)
				if (ladder && ladder.length > 1) ladder = ladder.filter(v => v !== via)
			}
		}
		throw last
	}

	/**
	 * A fragmented-MP4 session the browser can play: copied when it can, transcoded
	 * to H.264 when it can't (`hevc`: the browser plays HEVC). `audio` adds the
	 * camera's sound track when it has one: copied, or re-encoded to AAC once
	 * copying it failed for this source.
	 */
	const mp4 = async (name: string, stream: LiveStream, opts: { hevc: boolean; audio?: boolean }): Promise<Mp4Session> => {
		// one ffmpeg (and one camera connection) per viewer: cap them, so a page reloaded in a loop or a LAN client can't pile them up.
		// A session still starting holds its slot too: requests arriving together would otherwise all see the same count and all open
		if (sessions.size + opening >= MAX_MP4_SESSIONS)
			throw new ControlError(429, `${MAX_MP4_SESSIONS} live videos are already playing. Close one (a tab or pop-out) and try again.`)
		opening++
		try {
			const session = await startMp4(name, stream, opts)
			sessions.add(session)
			session.closed.then(() => sessions.delete(session))
			return session
		} finally {
			opening--
		}
	}

	const startMp4 = async (name: string, stream: LiveStream, opts: { hevc: boolean; audio?: boolean }): Promise<Mp4Session> => {
		const cfg = find(name)
		const r = await resolve(cfg, stream)
		const url = r.url
		if (!url) throw new ControlError(409, r.dto.detail ?? "This camera has no video stream to play.")
		const key = codecKey(cfg, stream)
		const audioKey = `${cfg.name}\n${sig(cfg)}`
		const open = async (plan: Mp4Plan) => {
			const audio: Mp4Audio = opts.audio ? (audioModes.get(audioKey) ?? "copy") : "none"
			try {
				return await openMp4(url, plan, audio)
			} catch (e) {
				if (!(e instanceof AudioCopyError)) throw e
				log.info(`${cfg.name}: its sound can't be copied into MP4; re-encoding it to AAC`)
				audioModes.set(audioKey, "aac")
				return openMp4(url, plan, "aac")
			}
		}
		const playable = (codec: string) => codec === "h264" || (opts.hevc && codec === "hevc")
		const known = codecs.get(key)
		let session: Mp4Session
		if (known && !playable(known)) session = await transcode(open, known)
		else {
			try {
				session = await open({ kind: "copy", hvc1: known === "hevc" })
				// Safari plays HEVC only under the `hvc1` sample entry, not ffmpeg's default `hev1`, and the muxer refuses
				// `hvc1` on H.264, so a stream not yet known to be HEVC is opened once to find out and again tagged for
				// Safari: one extra start per source until the server restarts or the stream changes
				if (opts.hevc && session.video.startsWith("hev1")) {
					session.kill()
					session = await open({ kind: "copy", hvc1: true })
				}
			} catch (e) {
				// what the stream was may have changed (the camera's encoder settings): learn it again next time
				if (!cameraFault(e)) codecs.delete(key)
				throw e
			}
			const codec = session.video.startsWith("avc") ? "h264" : /^(hvc1|hev1)/.test(session.video) ? "hevc" : (session.inputCodec ?? "other")
			codecs.set(key, codec)
			if (!playable(codec)) {
				session.kill()
				session = await transcode(open, codec)
			}
		}
		return session
	}

	/** The newest frame a running Motion JPEG hub already has for this camera, preferring `stream`. */
	const latestFrame = (cfg: LiveSourceConfig, stream: LiveStream): Buffer | null => {
		let other: Buffer | null = null
		for (const [key, hub] of hubs) {
			const [hubName, hubStream] = key.split("\n")
			const frame = hubName === cfg.name ? hub.latest() : null
			if (!frame) continue
			if (hubStream === stream) return frame
			other ??= frame
		}
		return other
	}

	/**
	 * A still for the Snapshot button: the camera's own full-resolution picture
	 * when it has one, else the live stream's. `fast`: a picture to show while the
	 * video connects, so a frame a running hub already has will do.
	 */
	const snapshot = async (name: string, stream: LiveStream, signal?: AbortSignal, opts: { fast?: boolean } = {}): Promise<Buffer> => {
		const cfg = find(name)
		if (opts.fast) {
			const frame = latestFrame(cfg, stream)
			if (frame) return frame
		}
		const control = controlFor(cfg.name)
		if (control) {
			try {
				return await control.snapshot(signal)
			} catch (e) {
				if (e instanceof ControlError && e.status === 409) throw e
				log.warn(`camera snapshot failed, using the stream: ${e instanceof Error ? e.message : String(e)}`)
			}
		}
		const frame = latestFrame(cfg, stream)
		if (frame) return frame
		const r = await resolve(cfg, stream)
		if (!r.url) throw new ControlError(409, r.dto.detail ?? "This camera has no live picture right now.")
		return grabStreamFrame(r.url)
	}

	return {
		list: async (): Promise<LiveSourceDto[]> => {
			const all = liveSources()
			const aliases = folded(all)
			return Promise.all(all.filter(s => !aliases.has(s.name)).map(async s => (await resolve(s, "main")).dto))
		},
		find,
		resolve: async (name: string, stream: LiveStream) => resolve(find(name), stream),
		controlFor,
		hubFor,
		mp4,
		snapshot,
		close: async () => {
			for (const h of hubs.values()) h.stop()
			hubs.clear()
			for (const s of sessions) s.kill()
			sessions.clear()
			await Promise.all([...controls.values()].map(c => c.control.close().catch(() => {})))
			controls.clear()
		}
	}
}

export type Live = ReturnType<typeof createLive>
export { FeedError }
