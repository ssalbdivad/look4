// One current frame from a configured source, for drawing the feeder zone on
// what the camera sees right now: Reolink's `Snap`, a single ffmpeg grab from a
// stream, or a frame of the newest clip a watched folder produced.

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import type { RtspTestResult } from "../api-types.ts"
import type { SourceConfig } from "../config.ts"
import type { Store } from "../db.ts"
import { extractFrame, FFMPEG } from "../media/ffmpeg.ts"
import { listFiles } from "../sources/common.ts"
import { LOGIN_REFUSED } from "../sources/reolink.ts"
import { createReolinkClient } from "../sources/reolink-api.ts"
import { maskWith } from "../sources/rtsp.ts"
import type { SourceStatus } from "../types.ts"

/** A snapshot that could not be taken, with a sentence for the user. */
export class SnapshotError extends Error {}

const TIMEOUT_MS = 15_000

const reolinkSnapshot = async (cfg: Extract<SourceConfig, { type: "reolink" }>, status: SourceStatus | undefined) => {
	// the adapter is already being refused; another login would only bring a lockout closer
	if (status?.state === "error" && status.detail.startsWith(LOGIN_REFUSED))
		throw new SnapshotError("The camera turned down look4's sign-in, so there's no picture yet. Fix the password first.")
	if (process.env[cfg.passwordEnv] === undefined) throw new SnapshotError(`The camera's password isn't saved yet (${cfg.passwordEnv}).`)
	const client = createReolinkClient({
		host: cfg.host,
		username: cfg.username,
		password: () => process.env[cfg.passwordEnv],
		protocol: cfg.protocol,
		channel: cfg.channel,
		timeoutMs: TIMEOUT_MS
	})
	try {
		return await client.snapshot(AbortSignal.timeout(TIMEOUT_MS))
	} catch (e) {
		throw new SnapshotError(`Couldn't get a picture from the camera: ${e instanceof Error ? e.message : String(e)}`)
	} finally {
		await client.close()
	}
}

export type StreamFrame = { jpeg: Buffer; width?: number; height?: number; codec?: string }

/** Grabs one frame; rejects with ffmpeg's stderr (credentials masked) or "timeout". */
const grab = (url: string, timeoutMs: number) =>
	new Promise<StreamFrame>((resolve, reject) => {
		const mask = maskWith(url)
		const args = [
			"-hide_banner", "-loglevel", "info", "-nostdin",
			// TCP: UDP through NAT (WSL) usually delivers nothing
			...(/^rtsps?:/i.test(url) ? ["-rtsp_transport", "tcp"] : []),
			"-i", url,
			"-frames:v", "1", "-q:v", "3", "-f", "image2", "-c:v", "mjpeg", "pipe:1"
		]
		const child = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] })
		const out: Buffer[] = []
		let err = ""
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			child.kill("SIGKILL")
		}, timeoutMs)
		child.stdout.on("data", (d: Buffer) => out.push(d))
		child.stderr.on("data", (d: Buffer) => {
			err = (err + d.toString()).slice(-20_000)
		})
		child.on("error", e => {
			clearTimeout(timer)
			reject(new Error((e as NodeJS.ErrnoException).code === "ENOENT" ? `${FFMPEG} is not installed` : e.message))
		})
		child.on("close", code => {
			clearTimeout(timer)
			const jpeg = Buffer.concat(out)
			if (timedOut) return reject(new Error("timeout"))
			if (code !== 0 || !jpeg.length) return reject(new Error(mask(err.trim()) || `ffmpeg exited ${code}`))
			const m = /Stream #\d+:\d+.*?: Video: (\w+).*?, (\d{2,5})x(\d{2,5})/.exec(err)
			resolve(m ? { jpeg, codec: m[1]!, width: Number(m[2]), height: Number(m[3]) } : { jpeg })
		})
	})

/**
 * ffmpeg's failure, as one sentence for someone who has never seen ffmpeg. The
 * stderr is already masked, and is quoted only when nothing better matched.
 */
export const streamProblem = (stderr: string): string => {
	if (stderr === "timeout" || /timed out|Connection timed out/i.test(stderr))
		return "Nothing answered at that address in time. Check the camera's address, and that RTSP is turned on in the camera's settings."
	if (/401 Unauthorized|authorization failed/i.test(stderr))
		return "The camera said the username or password in the address is wrong."
	if (/404 Not Found/i.test(stderr))
		return "The camera answered, but there's no stream at that path. Check the part of the address after the port (for example /h264Preview_01_main)."
	if (/Connection refused/i.test(stderr))
		return "Nothing answered at that address: RTSP may be turned off on the camera, or the port is wrong."
	if (/No route to host|Network is unreachable|Name or service not known|Temporary failure in name resolution|Invalid argument/i.test(stderr))
		return "Couldn't reach that address. Check that the camera is on the same network and the address is typed correctly."
	const last = stderr.trim().split("\n").at(-1) ?? ""
	return `Couldn't get a picture from the stream: ${last.replace(/^\[[^\]]*\]\s*/, "")}`
}

/** "Test" for an RTSP address in the wizard: one frame, ~10 s at most, nothing saved. */
export const testStream = async (url: string, timeoutMs = 10_000): Promise<RtspTestResult> => {
	try {
		const f = await grab(url, timeoutMs)
		return {
			ok: true,
			detail: "Got a picture from the camera.",
			...(f.width ? { width: f.width, height: f.height } : {}),
			...(f.codec ? { codec: f.codec } : {}),
			preview: `data:image/jpeg;base64,${f.jpeg.toString("base64")}`
		}
	} catch (e) {
		return { ok: false, detail: streamProblem(e instanceof Error ? e.message : String(e)) }
	}
}

/** One decoded frame from a live stream, for the zone editor. */
export const grabStreamFrame = async (url: string, timeoutMs = TIMEOUT_MS) => {
	try {
		return (await grab(url, timeoutMs)).jpeg
	} catch (e) {
		throw new SnapshotError(streamProblem(e instanceof Error ? e.message : String(e)))
	}
}

const watchSnapshot = async (cfg: Extract<SourceConfig, { type: "watch" }>, store: Store, rootDir: string) => {
	// newest clip this source brought in (move mode leaves the folder empty), else the newest file still in the folder
	const clip = store.listClips({ source: cfg.name, limit: 5 }).find(c => c.path && existsSync(c.path))
	const dir = resolve(rootDir, cfg.dir === "~" || cfg.dir.startsWith("~/") ? homedir() + cfg.dir.slice(1) : cfg.dir)
	const file =
		clip ?
			{ path: clip.path!, t: Math.min(1, (clip.durationS ?? 2) / 2) }
		:	await listFiles(dir, { recursive: true, extensions: cfg.extensions })
				.then(fs => fs.sort((a, b) => b.mtimeMs - a.mtimeMs)[0])
				.then(f => (f ? { path: f.path, t: 0 } : null), () => null)
	if (!file) throw new SnapshotError(`There are no videos in ${dir} yet, so there's no picture to show.`)
	try {
		return await extractFrame(file.path, file.t)
	} catch (e) {
		throw new SnapshotError(`Couldn't read a frame from the newest video: ${e instanceof Error ? e.message : String(e)}`)
	}
}

export const sourceSnapshot = (
	cfg: SourceConfig,
	deps: { store: Store; rootDir: string; status?: SourceStatus }
): Promise<Buffer> => {
	switch (cfg.type) {
		case "reolink":
			return reolinkSnapshot(cfg, deps.status)
		case "rtsp": {
			const url = cfg.url ?? (cfg.urlEnv ? process.env[cfg.urlEnv] : undefined)
			if (!url) return Promise.reject(new SnapshotError(`The stream's address isn't saved yet (${cfg.urlEnv}).`))
			return grabStreamFrame(url)
		}
		case "watch":
			return watchSnapshot(cfg, deps.store, deps.rootDir)
	}
}
