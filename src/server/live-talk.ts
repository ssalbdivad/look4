// Talking through a camera's speaker: a WebSocket at /api/live/:name/talk. The
// page opens it while the Talk button is held; the server claims the speaker
// and answers `{ type: "ready", sampleRate }`, the page streams mono 16-bit
// little-endian PCM at that rate as binary messages, and `"end"` (or closing)
// lets what was sent finish playing before the speaker is released. Failures
// arrive as `{ type: "error", message }` before the server closes.
//
// One voice per camera: a second window that starts talking takes the speaker
// over and the first is told so. The same Host and Origin rules as the HTTP
// routes apply, and Origin is required: browsers always send it on a
// WebSocket, and a page from another site must never reach the speaker.

import type { IncomingMessage, Server } from "node:http"
import type { Duplex } from "node:stream"
import { type RawData, type WebSocket, WebSocketServer } from "ws"
import type { TalkServerMessage } from "../api-types.ts"
import { ControlError } from "../live/control.ts"
import type { Live } from "../live/manager.ts"
import type { TalkStream } from "../live/talk.ts"
import { logger } from "../log.ts"

const log = logger("live")

const PATH = /^\/api\/live\/([^/]+)\/talk$/

/** Nothing heard from the page for this long ends the talk (a tab put to sleep with the button down). */
export const TALK_IDLE_MS = 10_000
/** No one stretch of talking runs longer than this. */
export const TALK_MAX_MS = 5 * 60_000

export type TalkOptions = {
	live: Live
	/** The HTTP routes' Host rule. */
	hostAllowed: (hostname: string) => boolean
	idleMs?: number
	maxMs?: number
}

const refuse = (socket: Duplex, status: number, text: string) => {
	socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`)
}

const say = (ws: WebSocket, m: TalkServerMessage) => {
	if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m))
}

/** Handles upgrades to the talk path on `server`; returns a close that ends every talk in progress. */
export const attachTalk = (server: Server, o: TalkOptions) => {
	const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })
	/** The talk holding each camera's speaker; the next one waits for `released` before claiming it. */
	const talkers = new Map<string, { stop(message: string): void; released: Promise<void> }>()
	const idleMs = o.idleMs ?? TALK_IDLE_MS
	const maxMs = o.maxMs ?? TALK_MAX_MS

	const run = async (ws: WebSocket, name: string) => {
		let stream: TalkStream | null = null
		/** The camera is still being signed in to: whoever finishes first leaves the release to it. */
		let claiming = false
		let over = false
		let release!: () => void
		const released = new Promise<void>(r => (release = r))
		let idle: NodeJS.Timeout | undefined
		let cap: NodeJS.Timeout | undefined
		const fail = (message: string) => {
			say(ws, { type: "error", message })
			void finish(false)
		}
		const finish = async (graceful: boolean) => {
			if (over) return
			over = true
			clearTimeout(idle)
			clearTimeout(cap)
			if (talkers.get(name) === me) talkers.delete(name)
			if (ws.readyState === ws.OPEN) ws.close(1000)
			if (claiming) return
			await (graceful ? stream?.end() : stream?.abort())?.catch(e => log.warn(`talk on ${name}: ${(e as Error).message}`))
			release()
		}
		const keepAlive = () => {
			clearTimeout(idle)
			idle = setTimeout(() => void finish(true), idleMs)
		}
		const me = { stop: fail, released }

		ws.on("close", () => void finish(true))
		ws.on("message", (data: RawData, binary: boolean) => {
			if (!stream || over) return
			if (!binary) {
				if (data.toString() === "end") void finish(true)
				return
			}
			const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
			if (buf.length % 2) return
			keepAlive()
			// copied so the samples are 2-byte aligned whatever the socket's buffer was
			const pcm = new Int16Array(new Uint8Array(buf).buffer)
			try {
				stream.write(pcm)
			} catch (e) {
				fail(`The camera stopped taking sound: ${(e as Error).message}`)
			}
		})

		const before = talkers.get(name)
		talkers.set(name, me)
		if (before) {
			before.stop("Another window started talking through this camera.")
			await before.released
		}
		if (over) return
		const control = o.live.controlFor(name)
		if (!control?.talk) return fail("look4 can't talk through this camera.")
		claiming = true
		try {
			stream = await control.talk()
		} catch (e) {
			claiming = false
			if (over) return release()
			return fail(e instanceof ControlError ? e.message : `Couldn't talk through the camera: ${(e as Error).message}`)
		}
		claiming = false
		// the page let go, or another window took over, while the camera was signing in
		if (over) {
			await stream.abort().catch(() => {})
			return release()
		}
		void stream.closed.then(() => {
			if (!over) fail("The camera dropped the talk connection.")
		})
		cap = setTimeout(() => void finish(true), maxMs)
		keepAlive()
		say(ws, { type: "ready", sampleRate: stream.format.sampleRate })
		log.info(`talking through ${name}`)
	}

	const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		const url = new URL(req.url ?? "/", "http://placeholder")
		const m = PATH.exec(url.pathname)
		if (!m) return refuse(socket, 404, "Not Found")
		const host = req.headers.host ?? ""
		let hostname = ""
		try {
			hostname = new URL(`http://${host}`).hostname
		} catch {}
		if (!hostname || !o.hostAllowed(hostname)) return refuse(socket, 403, "Forbidden")
		let originHost: string | null = null
		try {
			originHost = new URL(req.headers.origin ?? "").host
		} catch {}
		if (originHost !== host) return refuse(socket, 403, "Forbidden")
		let name: string
		try {
			name = decodeURIComponent(m[1]!)
		} catch {
			return refuse(socket, 400, "Bad Request")
		}
		wss.handleUpgrade(req, socket, head, ws => void run(ws, name))
	}
	server.on("upgrade", onUpgrade)

	return {
		close: () => {
			server.off("upgrade", onUpgrade)
			for (const t of talkers.values()) t.stop("look4 is shutting down.")
			for (const ws of wss.clients) ws.terminate()
			wss.close()
		}
	}
}
