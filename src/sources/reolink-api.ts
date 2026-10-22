// Client for the Reolink camera CGI API (`/cgi-bin/api.cgi`), modeled on the
// reference implementation reolink_aio (api.py: login, GetDevInfo, Search,
// Download). Every command is a POST of `[{ cmd, action, param }]` and answers
// `[{ cmd, code, value }]` or `[{ cmd, code, error: { rspCode, detail } }]`,
// with HTTP 200 either way.

import { randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { unlink } from "node:fs/promises"
import http, { type IncomingMessage } from "node:http"
import https from "node:https"
import { basename, extname } from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { CameraProblem } from "../api-types.ts"
import { VIDEO_EXTENSIONS } from "./common.ts"

const VIDEO = new Set(VIDEO_EXTENSIONS)

export type ReolinkProtocol = "http" | "https"

export type ReolinkTime = { year: number; mon: number; day: number; hour: number; min: number; sec: number }

export type ReolinkFile = {
	/** The camera's path for the recording, e.g. `Mp4Record/2026-10-14/RecM07_20261014_093012_093042_6D28808_1E2F3A.mp4`. */
	name: string
	start: Date
	end: Date
	size: number | null
}

export type ReolinkDevInfo = { model: string; firmware: string; name: string | null }

/** One command of a batch. `action: 1` asks the camera for `range` and `initial` too. */
export type ReolinkCall = { cmd: string; action?: 0 | 1; param: unknown }

/** One command's answer within a batch; `error` set when the camera refused that command. */
export type ReolinkResult = { cmd: string; value: any; range: any; initial: any; error: ReolinkError | null }

/** An error answer from the camera (as opposed to a network failure). */
export class ReolinkError extends Error {
	readonly cmd: string
	readonly rspCode: number | null
	/**
	 * For a refused Login: sign-in attempts the camera allows before it locks the
	 * account, when the firmware says (`auth_warning_info.remain_times`).
	 */
	readonly attemptsLeft: number | null
	constructor(cmd: string, rspCode: number | null, detail: string, attemptsLeft: number | null = null) {
		super(`${cmd}: ${detail}${rspCode === null ? "" : ` (rspCode ${rspCode})`}`)
		this.cmd = cmd
		this.rspCode = rspCode
		this.attemptsLeft = attemptsLeft
	}
}

/**
 * `remain_times` from anywhere in a command's answer. Firmware that counts
 * failed logins (RLC-8xx since 2024) reports it next to the error, as
 * `auth_warning_info.remain_times`, but where exactly varies, so look everywhere.
 */
export const remainTimes = (answer: unknown, depth = 0): number | null => {
	if (!answer || typeof answer !== "object" || depth > 5) return null
	for (const [k, v] of Object.entries(answer)) {
		if (k === "remain_times" && Number.isFinite(Number(v)) && v !== null && v !== "") return Number(v)
		const inner = remainTimes(v, depth + 1)
		if (inner !== null) return inner
	}
	return null
}

/** The camera could not be reached or answered with something that is not its API. */
export class ReolinkNetworkError extends Error {
	/** The socket error code (ECONNREFUSED, ETIMEDOUT, …) when the connection itself failed. */
	readonly code: string | null
	constructor(message: string, code: string | null = null) {
		super(message)
		this.code = code
	}
}

/** Failures that mean "nothing is listening there", as opposed to a wrong answer from something that is. */
const NO_SERVER = new Set(["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"])

const STALE_SOCKET = Symbol("stale keep-alive socket")

export const SERVER_SETTINGS_HINT =
	"in the Reolink app: camera Settings → Network → Advanced → Server Settings, turn on HTTPS"

/**
 * Newer Reolink firmware ships with its HTTP and HTTPS servers off (only the
 * proprietary port 9000 is open), so a camera that is right there looks unreachable.
 * Say that plainly instead of "ECONNREFUSED".
 */
export const serversOffMessage = (hostPort: string, failures: Array<{ proto: ReolinkProtocol; code: string }>) => {
	const tried = failures.map(f => f.proto.toUpperCase()).join(" and ")
	const off = `${tried} ${failures.length > 1 ? "are" : "is"} off`
	if (failures.every(f => f.code === "ECONNREFUSED"))
		return `${hostPort} refused ${tried}: the camera is there but ${off} — ${SERVER_SETTINGS_HINT}`
	const codes = [...new Set(failures.map(f => f.code))].join(", ")
	return `cannot reach ${hostPort} over ${tried} (${codes}). Is the camera on and at this address? If so, ${off} — ${SERVER_SETTINGS_HINT}`
}

/** What a refused login means. The lockout text comes first: some firmware sends it with the bad-password code. */
export const loginProblem = (e: ReolinkError): CameraProblem => {
	const detail = e.message
	if (/lock/i.test(detail)) return "locked-out"
	if (e.rspCode === -7 || e.rspCode === -27 || e.rspCode === -502 || /login failed|invalid user|password wrong|wrong password/i.test(detail)) return "bad-credentials"
	// an answer that parsed as JSON but has no Reolink error or token in it
	if (e.rspCode === null && /code undefined|no token/i.test(detail)) return "not-reolink"
	return "unknown"
}

/**
 * Seconds until a locked camera takes logins again, when its message says
 * ("locked, try again in 300 seconds", "… 5 min"). Firmware that reports only
 * "Login has been locked" gives nothing to go on.
 */
export const lockoutSeconds = (detail: string): number | null => {
	const m = /(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?)\b/i.exec(detail.replace(/\(rspCode -?\d+\)/, ""))
	if (!m) return null
	const n = Number(m[1])
	return /^m/i.test(m[2]!) ? n * 60 : n
}

/** -6 is "please login first": the token expired or the camera rebooted. */
const isAuthError = (e: unknown) =>
	e instanceof ReolinkError && (e.rspCode === -6 || /login first|invalid token|token expired/i.test(e.message))

/** Camera wall time, read as this machine's local time. The source shifts it by `clockOffset` when the two clocks disagree. */
export const toReolinkTime = (d: Date): ReolinkTime => ({
	year: d.getFullYear(),
	mon: d.getMonth() + 1,
	day: d.getDate(),
	hour: d.getHours(),
	min: d.getMinutes(),
	sec: d.getSeconds()
})

export const fromReolinkTime = (t: ReolinkTime) => new Date(t.year, t.mon - 1, t.day, t.hour, t.min, t.sec)

/** Splits [from, to] into per-local-day ranges, because Search only lists files within a single day. */
export const splitByDay = (from: Date, to: Date): Array<[Date, Date]> => {
	const out: Array<[Date, Date]> = []
	let s = new Date(from)
	while (s <= to) {
		const endOfDay = new Date(s.getFullYear(), s.getMonth(), s.getDate(), 23, 59, 59)
		const e = endOfDay < to ? endOfDay : new Date(to)
		out.push([s, e])
		s = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1, 0, 0, 0)
	}
	return out
}

export type ReolinkClientOptions = {
	/** IP or hostname, optionally with `:port` or an `http(s)://` prefix. */
	host: string
	username: string
	password: () => string | undefined
	protocol: "auto" | ReolinkProtocol
	channel: number
	/** Per API call. */
	timeoutMs?: number
}

/** `{ hostPort, protocols }` to try, in order. An explicit scheme in `host` wins over `protocol`. */
export const parseHost = (host: string, protocol: "auto" | ReolinkProtocol) => {
	const scheme = /^(https?):\/\//i.exec(host.trim())?.[1]?.toLowerCase() as ReolinkProtocol | undefined
	const hostPort = host.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "")
	// newer firmware is HTTPS-only (self-signed), so try that first
	const protocols: ReolinkProtocol[] = scheme ? [scheme] : protocol === "auto" ? ["https", "http"] : [protocol]
	return { hostPort, protocols }
}

type Response = { status: number; headers: http.IncomingHttpHeaders; res: IncomingMessage }

const MAX_JSON_BYTES = 8 * 1024 * 1024

const readBytes = async (res: IncomingMessage, limit = MAX_JSON_BYTES) => {
	const chunks: Buffer[] = []
	let n = 0
	for await (const c of res as AsyncIterable<Buffer>) {
		n += c.length
		if (n > limit) {
			res.destroy()
			throw new ReolinkNetworkError("response too large")
		}
		chunks.push(c)
	}
	return Buffer.concat(chunks)
}

const readBody = async (res: IncomingMessage, limit = MAX_JSON_BYTES) => (await readBytes(res, limit)).toString("utf8")

export const createReolinkClient = (o: ReolinkClientOptions) => {
	const { hostPort, protocols } = parseHost(o.host, o.protocol)
	const timeoutMs = o.timeoutMs ?? 15_000
	// Cameras ship self-signed certificates. Verification is off only for this
	// agent, i.e. only for requests to this camera.
	const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 2 })
	const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 2 })

	let protocol: ReolinkProtocol | null = protocols.length === 1 ? protocols[0]! : null
	let token: string | null = null
	let tokenExpiresAt = 0
	let downloadCmd: "Download" | "Playback" = "Download"

	type SendInit = { method: "GET" | "POST"; body?: string | Buffer; contentType?: string; signal?: AbortSignal; idleMs?: number }

	/**
	 * Opens a request; resolves with the response stream. `idleMs` bounds silence on the socket, not total time.
	 * A keep-alive socket the camera closed while idle fails with ECONNRESET on reuse; that
	 * request never reached the camera, so it is sent once more on a fresh socket.
	 */
	const send = async (proto: ReolinkProtocol, query: Record<string, string>, init: SendInit): Promise<Response> => {
		try {
			return await sendOnce(proto, query, init)
		} catch (e) {
			if (e !== STALE_SOCKET) throw e
			return sendOnce(proto, query, init, false)
		}
	}

	const sendOnce = (proto: ReolinkProtocol, query: Record<string, string>, init: SendInit, retryStale = true): Promise<Response> =>
		new Promise((resolve, reject) => {
			const qs = new URLSearchParams(query).toString()
			const lib = proto === "https" ? https : http
			const req = lib.request(
				`${proto}://${hostPort}/cgi-bin/api.cgi?${qs}`,
				{
					method: init.method,
					agent: proto === "https" ? httpsAgent : httpAgent,
					headers: init.body
						? { "content-type": init.contentType ?? "application/json", "content-length": Buffer.byteLength(init.body) }
						: undefined,
					signal: init.signal
				},
				res => resolve({ status: res.statusCode ?? 0, headers: res.headers, res })
			)
			req.setTimeout(init.idleMs ?? timeoutMs, () =>
				req.destroy(new ReolinkNetworkError(`no answer within ${Math.round((init.idleMs ?? timeoutMs) / 1000)} s`, "ETIMEDOUT"))
			)
			// never let the URL (it carries the token) into an error message
			req.on("error", e => {
				const code = (e as NodeJS.ErrnoException).code
				if (retryStale && req.reusedSocket && (code === "ECONNRESET" || code === "EPIPE")) return reject(STALE_SOCKET)
				reject(
					e instanceof ReolinkNetworkError || e.name === "AbortError"
						? e
						: new ReolinkNetworkError(
								`cannot reach ${hostPort} over ${proto}: ${(e as NodeJS.ErrnoException).code ?? e.message}`,
								(e as NodeJS.ErrnoException).code ?? null
							)
				)
			})
			req.end(init.body)
		})

	/** One JSON command; returns its `value` or throws ReolinkError. */
	const postCommand = async (proto: ReolinkProtocol, cmd: string, param: unknown, tok: string | null, signal?: AbortSignal) => {
		const query: Record<string, string> = { cmd }
		if (tok) query.token = tok
		const { status, res } = await send(proto, query, {
			method: "POST",
			body: JSON.stringify([{ cmd, action: 0, param }]),
			signal
		})
		const text = await readBody(res)
		if (status === 401) throw new ReolinkError(cmd, -6, "please login first")
		let parsed: unknown
		try {
			parsed = JSON.parse(text)
		} catch {
			throw new ReolinkNetworkError(`${hostPort} over ${proto} answered HTTP ${status} without JSON; is this a Reolink camera?`)
		}
		const item = (Array.isArray(parsed) ? parsed : [parsed]).find((x: any) => x?.cmd === cmd) ?? (Array.isArray(parsed) ? parsed[0] : parsed)
		if (!item || typeof item !== "object") throw new ReolinkNetworkError(`${cmd}: unexpected answer`)
		const r = item as { code?: number; value?: any; error?: { rspCode?: number; detail?: string } }
		if (r.code !== 0 || r.error) throw new ReolinkError(cmd, r.error?.rspCode ?? null, r.error?.detail ?? `code ${r.code}`, remainTimes(item))
		return r.value
	}

	const login = async (signal?: AbortSignal) => {
		const password = o.password()
		// "" is a real password: Reolink cameras ship as admin with a blank one
		if (password === undefined) throw new ReolinkError("Login", null, "no password")
		const param = { User: { userName: o.username, password } }
		let lastNetwork: unknown = null
		const unreachable: Array<{ proto: ReolinkProtocol; code: string }> = []
		const tried = protocol ? [protocol] : protocols
		for (const proto of tried) {
			try {
				const value = await postCommand(proto, "Login", param, null, signal)
				const t = value?.Token
				if (!t?.name) throw new ReolinkError("Login", null, "no token in answer")
				token = String(t.name)
				// renew a minute early so a long download never starts on a dying token
				tokenExpiresAt = Date.now() + Math.max(30, Number(t.leaseTime ?? 3600) - 60) * 1000
				protocol = proto
				return
			} catch (e) {
				if (!(e instanceof ReolinkNetworkError)) throw e
				lastNetwork = e
				if (e.code && NO_SERVER.has(e.code)) unreachable.push({ proto, code: e.code })
			}
		}
		// next login re-detects, in case the camera's firmware (and scheme) changed
		if (protocols.length > 1) protocol = null
		if (unreachable.length === tried.length) throw new ReolinkNetworkError(serversOffMessage(hostPort, unreachable), unreachable[0]!.code)
		throw lastNetwork
	}

	const ensureLogin = async (signal?: AbortSignal) => {
		if (!token || Date.now() >= tokenExpiresAt) await login(signal)
	}

	/** Runs a command with a valid token, logging in again once if the camera says the token is dead. */
	const command = async (cmd: string, param: unknown, signal?: AbortSignal) => {
		await ensureLogin(signal)
		try {
			return await postCommand(protocol!, cmd, param, token, signal)
		} catch (e) {
			if (!isAuthError(e)) throw e
			token = null
			await login(signal)
			return postCommand(protocol!, cmd, param, token, signal)
		}
	}

	/** Several commands in one POST: the camera answers each in order, in the same array. */
	const postBatch = async (proto: ReolinkProtocol, calls: ReolinkCall[], tok: string, signal?: AbortSignal): Promise<ReolinkResult[]> => {
		const first = calls[0]!.cmd
		const { status, res } = await send(proto, { cmd: first, token: tok }, {
			method: "POST",
			body: JSON.stringify(calls.map(c => ({ cmd: c.cmd, action: c.action ?? 0, param: c.param }))),
			signal
		})
		const text = await readBody(res)
		if (status === 401) throw new ReolinkError(first, -6, "please login first")
		let parsed: unknown
		try {
			parsed = JSON.parse(text)
		} catch {
			throw new ReolinkNetworkError(`${hostPort} over ${proto} answered HTTP ${status} without JSON; is this a Reolink camera?`)
		}
		const items: any[] = Array.isArray(parsed) ? parsed : [parsed]
		return calls.map((c, i) => {
			// in order; a firmware that drops or reorders answers is matched by name instead
			const item = items[i]?.cmd === c.cmd ? items[i] : items.find(x => x?.cmd === c.cmd)
			if (!item || typeof item !== "object") return { cmd: c.cmd, value: null, range: null, initial: null, error: new ReolinkError(c.cmd, null, "no answer") }
			const failed = item.code !== 0 || item.error
			return {
				cmd: c.cmd,
				value: item.value ?? null,
				range: item.range ?? null,
				initial: item.initial ?? null,
				error: failed ? new ReolinkError(c.cmd, item.error?.rspCode ?? null, item.error?.detail ?? `code ${item.code}`, remainTimes(item)) : null
			}
		})
	}

	/**
	 * Several commands in one round trip (the camera answers twenty `Get*` in about the time of one).
	 * Each answer carries its own error instead of throwing, so one unsupported command doesn't sink the rest.
	 */
	const batch = async (calls: ReolinkCall[], signal?: AbortSignal): Promise<ReolinkResult[]> => {
		if (calls.length === 0) return []
		await ensureLogin(signal)
		let results: ReolinkResult[]
		try {
			results = await postBatch(protocol!, calls, token!, signal)
		} catch (e) {
			if (!isAuthError(e)) throw e
			results = []
		}
		if (results.length === 0 || results.some(r => isAuthError(r.error))) {
			token = null
			await login(signal)
			results = await postBatch(protocol!, calls, token!, signal)
		}
		return results
	}

	/** One command with `action: 1`, which also returns the camera's `range` (limits) and `initial` (factory value). */
	const commandFull = async (cmd: string, param: unknown, signal?: AbortSignal) => {
		const [r] = await batch([{ cmd, action: 1, param }], signal)
		if (r!.error) throw r!.error
		return { value: r!.value, range: r!.range, initial: r!.initial }
	}

	/** Answers that are a file (an image) on success and a JSON error otherwise. */
	const fileAnswer = async (cmd: string, { status, headers, res }: Response): Promise<Buffer> => {
		const type = String(headers["content-type"] ?? "")
		const body = await readBytes(res, 16 * 1024 * 1024)
		if (status === 200 && /image|octet-stream/i.test(type)) return body
		if (status === 401) throw new ReolinkError(cmd, -6, "please login first")
		let err: { rspCode?: number; detail?: string } | undefined
		try {
			const parsed = JSON.parse(body.toString("utf8"))
			err = (Array.isArray(parsed) ? parsed[0] : parsed)?.error
		} catch {}
		throw new ReolinkError(cmd, err?.rspCode ?? null, err?.detail ?? `HTTP ${status} ${type || "(no content type)"}`)
	}

	const withToken = async <t>(fn: () => Promise<t>, signal?: AbortSignal): Promise<t> => {
		await ensureLogin(signal)
		try {
			return await fn()
		} catch (e) {
			if (!isAuthError(e)) throw e
			token = null
			await login(signal)
			return fn()
		}
	}

	/**
	 * A stored image, e.g. a preset's thumbnail (`ExportImg` with `FileName: "preset_00"`): a JSON
	 * command whose answer is the raw JPEG, as the camera's own web UI reads it.
	 */
	const exportImage = (fileName: string, signal?: AbortSignal): Promise<Buffer> =>
		withToken(async () => {
			const cmd = "ExportImg"
			const r = await send(protocol!, { cmd, token: token! }, {
				method: "POST",
				body: JSON.stringify([{ cmd, action: 0, param: { ExportImg: { channel: o.channel, FileName: fileName } } }]),
				signal
			})
			return fileAnswer(cmd, r)
		}, signal)

	/**
	 * Stores a preset (or guard) thumbnail on the camera as `imgName`, the upload the camera's web UI
	 * makes (`imgUpload`): multipart field `ptz-image`, file name `<uuid>&<imgName>&<bytes>&<channel>`.
	 * The Reolink app then shows the same picture.
	 */
	const importImage = (imgName: string, jpeg: Buffer, signal?: AbortSignal): Promise<void> =>
		withToken(async () => {
			const cmd = "ImportImg"
			const boundary = `----look4${randomUUID().replaceAll("-", "")}`
			const body = Buffer.concat([
				Buffer.from(
					`--${boundary}\r\nContent-Disposition: form-data; name="ptz-image"; filename="${randomUUID()}&${imgName}&${jpeg.length}&${o.channel}"\r\nContent-Type: image/jpeg\r\n\r\n`
				),
				jpeg,
				Buffer.from(`\r\n--${boundary}--\r\n`)
			])
			const { status, res } = await send(protocol!, { token: token!, cmd, file: "ptz-image" }, {
				method: "POST",
				body,
				contentType: `multipart/form-data; boundary=${boundary}`,
				signal,
				idleMs: 120_000
			})
			const text = await readBody(res)
			if (status === 401) throw new ReolinkError(cmd, -6, "please login first")
			let item: any
			try {
				const parsed = JSON.parse(text)
				item = Array.isArray(parsed) ? parsed[0] : parsed
			} catch {
				throw new ReolinkNetworkError(`${cmd}: HTTP ${status} without JSON`)
			}
			if (item?.code !== 0 || item?.error) throw new ReolinkError(cmd, item?.error?.rspCode ?? null, item?.error?.detail ?? `code ${item?.code}`)
		}, signal)

	const devInfo = async (signal?: AbortSignal): Promise<ReolinkDevInfo> => {
		const v = await command("GetDevInfo", { channel: o.channel }, signal)
		const d = v?.DevInfo ?? {}
		return { model: String(d.model ?? "Reolink"), firmware: String(d.firmVer ?? "unknown"), name: d.name ? String(d.name) : null }
	}

	/**
	 * How far the camera's clock is from this machine's, in ms (camera minus
	 * here), read with `GetTime`. Search speaks the camera's wall time, so a
	 * camera on the wrong time zone or with Reolink's own DST switch off files
	 * its recordings an hour (or more) away from where this machine looks.
	 */
	const clockOffset = async (now: () => number = Date.now, signal?: AbortSignal): Promise<number> => {
		await ensureLogin(signal)
		const before = now()
		const v = await command("GetTime", {}, signal)
		const after = now()
		const t = v?.Time
		if (!t || ![t.year, t.mon, t.day, t.hour, t.min, t.sec].every(n => Number.isFinite(Number(n))))
			throw new ReolinkError("GetTime", null, "no time in answer")
		const camera = fromReolinkTime({ year: +t.year, mon: +t.mon, day: +t.day, hour: +t.hour, min: +t.min, sec: +t.sec })
		// the camera read its clock somewhere in the round trip, and only to the whole second
		return camera.getTime() + 500 - (before + after) / 2
	}

	/** Recordings on the SD card that start within [from, to]; both must fall on one local day. */
	const search = async (from: Date, to: Date, stream: "main" | "sub", signal?: AbortSignal): Promise<ReolinkFile[]> => {
		const v = await command(
			"Search",
			{
				Search: {
					channel: o.channel,
					onlyStatus: 0,
					streamType: stream,
					StartTime: toReolinkTime(from),
					EndTime: toReolinkTime(to)
				}
			},
			signal
		)
		const files: any[] = v?.SearchResult?.File ?? []
		return files
			// the name becomes the clip's original file name, which the UI serves back; only videos qualify
			.filter(f => typeof f?.name === "string" && VIDEO.has(extname(f.name).toLowerCase()) && f.StartTime && f.EndTime)
			.map(f => ({
				name: f.name as string,
				start: fromReolinkTime(f.StartTime),
				end: fromReolinkTime(f.EndTime),
				// firmware disagrees on whether this is a number or a string
				size: Number.isFinite(Number(f.size)) && Number(f.size) > 0 ? Number(f.size) : null
			}))
	}

	/**
	 * Streams one recording to `dest`. `idleMs` aborts a stalled transfer; `maxMs`
	 * caps the whole thing (the camera serves files slowly, but not forever).
	 */
	const download = async (
		name: string,
		dest: string,
		opts: { signal?: AbortSignal; idleMs?: number; maxMs?: number } = {}
	): Promise<number> => {
		const signal = AbortSignal.any([opts.signal ?? new AbortController().signal, AbortSignal.timeout(opts.maxMs ?? 15 * 60_000)])
		const attempt = async (cmd: "Download" | "Playback"): Promise<number> => {
			await ensureLogin(signal)
			const { status, headers, res } = await send(
				protocol!,
				{ cmd, source: name, output: name.replaceAll("/", "_"), token: token! },
				{ method: "GET", signal, idleMs: opts.idleMs ?? 60_000 }
			)
			const type = String(headers["content-type"] ?? "")
			// errors come back as a small JSON (or HTML) body instead of the file
			if (status !== 200 || /json|text|html/i.test(type)) {
				const text = await readBody(res, 64 * 1024).catch(() => "")
				if (status === 401) throw new ReolinkError(cmd, -6, "please login first")
				let err: { rspCode?: number; detail?: string } | undefined
				try {
					const parsed = JSON.parse(text)
					err = (Array.isArray(parsed) ? parsed[0] : parsed)?.error
				} catch {}
				throw new ReolinkError(cmd, err?.rspCode ?? null, err?.detail ?? `HTTP ${status} ${type || "(no content type)"}`)
			}
			let bytes = 0
			const counter = new Transform({
				transform(chunk: Buffer, _enc, cb) {
					bytes += chunk.length
					cb(null, chunk)
				}
			})
			try {
				await pipeline(res, counter, createWriteStream(dest), { signal })
			} catch (e) {
				await unlink(dest).catch(() => {})
				throw signal.aborted && !opts.signal?.aborted ? new ReolinkNetworkError(`download of ${basename(name)} timed out`) : e
			}
			const expected = Number(headers["content-length"])
			if (Number.isFinite(expected) && expected > 0 && bytes !== expected) {
				await unlink(dest).catch(() => {})
				throw new ReolinkNetworkError(`download of ${basename(name)} was cut short (${bytes} of ${expected} bytes)`)
			}
			return bytes
		}

		const withRelogin = async (cmd: "Download" | "Playback") => {
			try {
				return await attempt(cmd)
			} catch (e) {
				if (!isAuthError(e)) throw e
				token = null
				return attempt(cmd)
			}
		}

		try {
			return await withRelogin(downloadCmd)
		} catch (e) {
			// some firmware only serves recordings through `Playback`
			if (!(e instanceof ReolinkError) || downloadCmd === "Playback") throw e
			const bytes = await withRelogin("Playback").catch(() => {
				throw e
			})
			downloadCmd = "Playback"
			return bytes
		}
	}

	/** One live JPEG from the camera (`Snap`), for drawing the feeder zone on what the camera sees right now. */
	const snapshot = async (signal?: AbortSignal): Promise<Buffer> => {
		const attempt = async () => {
			await ensureLogin(signal)
			const { status, headers, res } = await send(
				protocol!,
				{ cmd: "Snap", channel: String(o.channel), rs: Math.random().toString(36).slice(2, 12), token: token! },
				{ method: "GET", signal }
			)
			const type = String(headers["content-type"] ?? "")
			const body = await readBytes(res, 16 * 1024 * 1024)
			if (status === 200 && /image/i.test(type)) return body
			if (status === 401) throw new ReolinkError("Snap", -6, "please login first")
			let err: { rspCode?: number; detail?: string } | undefined
			try {
				const parsed = JSON.parse(body.toString("utf8"))
				err = (Array.isArray(parsed) ? parsed[0] : parsed)?.error
			} catch {}
			throw new ReolinkError("Snap", err?.rspCode ?? null, err?.detail ?? `HTTP ${status} ${type || "(no content type)"}`)
		}
		try {
			return await attempt()
		} catch (e) {
			if (!isAuthError(e)) throw e
			token = null
			return attempt()
		}
	}

	const logout = async () => {
		if (!token || !protocol) return
		const tok = token
		token = null
		await postCommand(protocol, "Logout", {}, tok).catch(() => {})
	}

	return {
		login,
		/** Logs in only when there is no live token. */
		ensureLogin,
		logout,
		/** Any API command with a valid token (logging in again once if the token died); returns its `value`. */
		command,
		batch,
		commandFull,
		exportImage,
		importImage,
		devInfo,
		clockOffset,
		search,
		download,
		snapshot,
		/** The scheme that worked, once a login has succeeded. */
		protocol: () => protocol,
		close: async () => {
			await logout()
			httpsAgent.destroy()
			httpAgent.destroy()
		}
	}
}

export type ReolinkClient = ReturnType<typeof createReolinkClient>
