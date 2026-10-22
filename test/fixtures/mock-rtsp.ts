// A minimal RTSP server for tests and the live-view demo: enough of RFC 2326
// (OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN, GET_PARAMETER) for ffmpeg's RTSP
// client over TCP-interleaved RTP, the transport look4 always asks for.
//
// Each path is a looping video file. ffmpeg itself packetizes it (`-f rtp`) to
// local UDP ports at real-time pace, one RTP + RTCP pair per track, and the
// server relays those packets to every playing client as `$<channel><len><packet>`
// frames on the channels the client asked for in SETUP. The SDP ffmpeg writes is
// the DESCRIBE answer, so codec parameters (SPS/PPS, HEVC VPS, AAC config) are
// always right. A file with a sound track is served like a Reolink camera serves
// its streams: an `m=video` and an `m=audio` (AAC) track.
//
// Like a Reolink camera, it answers 401 to a missing or wrong login, and can be
// told to refuse every login when the camera's password is blank.

import { type ChildProcess, spawn } from "node:child_process"
import { createSocket, type Socket as UdpSocket } from "node:dgram"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, type AddressInfo, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

export type MockRtspOptions = {
	/** URL path (`/h264Preview_01_sub`) → looping video file. Codecs are copied, so the file's codecs are the stream's. */
	paths: Record<string, string>
	username?: string
	/** "" = a camera with no password, which (like Reolink firmware) refuses every RTSP login. */
	password?: string
	port?: number
	/** Host the server binds to. */
	host?: string
	/** The file's sound: copied into RTP (default; AAC, G.711…) or re-encoded to AAC first. */
	audioCodec?: "copy" | "aac"
}

type Kind = "video" | "audio"
/** A playing client's interleaved RTP channel per track (RTCP is the next one). */
type Channels = Partial<Record<Kind, number>>
type Feed = {
	proc: ChildProcess
	sockets: UdpSocket[]
	sdp: string
	/** Track order in the SDP, so `trackID=N` names a kind. */
	kinds: Kind[]
	clients: Map<Socket, Channels>
	dropAudio: boolean
}

const udp = () =>
	new Promise<UdpSocket>((resolve, reject) => {
		// a 4K keyframe arrives as a burst of ~1 MB; the default 208 KB buffer drops part of it, and the picture turns green
		const s = createSocket({ type: "udp4", recvBufferSize: 4 << 20 })
		s.once("error", reject)
		s.bind(0, "127.0.0.1", () => resolve(s))
	})

const portOf = (s: UdpSocket) => (s.address() as AddressInfo).port

const waitFor = async (read: () => string | null, ms: number) => {
	const end = Date.now() + ms
	while (Date.now() < end) {
		const v = read()
		if (v) return v
		await new Promise(r => setTimeout(r, 50))
	}
	throw new Error("mock RTSP: ffmpeg never wrote its SDP")
}

// A test file that ends without close() (a failed before(), a crash) would leave these
// ffmpeg loops running for good. "exit" handlers must be synchronous, and kill() is.
const children = new Set<ChildProcess>()
process.once("exit", () => {
	for (const p of children) p.kill("SIGKILL")
})

/** Never spawnSync here: a test runs this server in-process, and a blocked event loop stalls every relay. */
const hasAudio = (file: string) =>
	new Promise<boolean>(resolve => {
		const p = spawn("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file])
		let out = ""
		p.stdout.on("data", d => (out += d))
		p.once("error", () => resolve(false))
		p.once("close", () => resolve(out.trim() !== ""))
	})

const startFeed = async (file: string, dir: string, key: string, audioCodec: "copy" | "aac"): Promise<Feed> => {
	const kinds: Kind[] = (await hasAudio(file)) ? ["video", "audio"] : ["video"]
	const pairs = new Map<Kind, [UdpSocket, UdpSocket]>()
	for (const k of kinds) pairs.set(k, [await udp(), await udp()])
	const sdpFile = join(dir, `${key.replace(/\W/g, "_")}.sdp`)
	const target = (k: Kind) => `rtp://127.0.0.1:${portOf(pairs.get(k)![0])}?rtcpport=${portOf(pairs.get(k)![1])}&pkt_size=1400`
	const args = [
		"-hide_banner", "-loglevel", "error", "-nostdin",
		"-re", "-stream_loop", "-1", "-i", file,
		"-map", "0:v:0", "-c:v", "copy", "-payload_type", "96", "-f", "rtp", target("video"),
		...(kinds.includes("audio")
			? [
					"-map", "0:a:0", ...(audioCodec === "copy" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "32k"]), "-payload_type", "97",
					// one AAC frame per RTP packet, like a Reolink camera (ffmpeg's default 0.7 s bundles ~5 and holds video back)
					"-max_delay", "70000", "-f", "rtp", target("audio")
				]
			: []),
		"-sdp_file", sdpFile
	]
	const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "inherit"] })
	children.add(proc)
	proc.once("exit", () => children.delete(proc))
	const feed: Feed = { proc, sockets: [...pairs.values()].flat(), sdp: "", kinds, clients: new Map(), dropAudio: false }
	for (const [k, [rtp, rtcp]] of pairs) {
		const relay = (offset: 0 | 1) => (pkt: Buffer) => {
			if (k === "audio" && feed.dropAudio) return
			for (const [c, ch] of feed.clients) {
				const at = ch[k]
				if (at === undefined || c.destroyed || c.writableLength >= 4 << 20) continue
				c.write(Buffer.concat([Buffer.from([0x24, at + offset, pkt.length >> 8, pkt.length & 0xff]), pkt]))
			}
		}
		rtp.on("message", relay(0))
		rtcp.on("message", relay(1))
	}
	const sdp = await waitFor(() => {
		try {
			const t = readFileSync(sdpFile, "utf8")
			return kinds.every(k => t.includes(`m=${k}`)) ? t : null
		} catch {
			return null
		}
	}, 10_000)
	let track = 0
	// ffmpeg's SDP points at its UDP targets; a client only needs the media descriptions plus a control URL per track
	feed.sdp =
		sdp
			.replace(/^SDP:\s*/m, "")
			.split(/\r?\n/)
			.filter(Boolean)
			.flatMap(l => {
				const m = /^m=(video|audio) \d+ (.*)$/.exec(l)
				return m ? [`m=${m[1]} 0 ${m[2]}`, `a=control:trackID=${track++}`] : /^c=IN IP4/.test(l) ? ["c=IN IP4 0.0.0.0"] : [l]
			})
			.join("\r\n")
			.replace(/(s=[^\r\n]*)/, "$1\r\na=control:*") + "\r\n"
	return feed
}

export const startMockRtsp = async (opts: MockRtspOptions) => {
	const username = opts.username ?? "admin"
	let password = opts.password ?? "hunter2"
	const dir = mkdtempSync(join(tmpdir(), "look4-mock-rtsp-"))
	const feeds = new Map<string, Feed>()
	for (const [path, file] of Object.entries(opts.paths)) feeds.set(path, await startFeed(file, dir, path, opts.audioCodec ?? "copy"))
	/** Every request line, for asserting what a client did. */
	const requests: Array<{ method: string; path: string; authorized: boolean; transport?: string }> = []

	const authorized = (headers: Map<string, string>) => {
		if (password === "") return false
		const h = headers.get("authorization") ?? ""
		const m = /^Basic\s+(\S+)/i.exec(h)
		if (!m) return false
		return Buffer.from(m[1]!, "base64").toString() === `${username}:${password}`
	}

	const sockets = new Set<Socket>()
	const server = createServer(sock => {
		sockets.add(sock)
		let buf = Buffer.alloc(0)
		let playing: Feed | null = null
		const channels: Channels = {}
		const session = Math.random().toString().slice(2, 10)
		sock.on("error", () => {})
		sock.on("close", () => {
			sockets.delete(sock)
			playing?.clients.delete(sock)
		})
		sock.on("data", (chunk: Buffer) => {
			buf = Buffer.concat([buf, chunk])
			for (;;) {
				// interleaved RTCP from the client: skip it
				if (buf[0] === 0x24) {
					if (buf.length < 4) return
					const len = buf.readUInt16BE(2)
					if (buf.length < 4 + len) return
					buf = buf.subarray(4 + len)
					continue
				}
				const end = buf.indexOf("\r\n\r\n")
				if (end < 0) return
				const text = buf.subarray(0, end).toString()
				buf = buf.subarray(end + 4)
				const [line, ...rest] = text.split("\r\n")
				const headers = new Map(rest.map(l => [l.slice(0, l.indexOf(":")).trim().toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]))
				const [method = "", url = ""] = line!.split(" ")
				const cseq = headers.get("cseq") ?? "0"
				let path = "/"
				let track = 0
				try {
					const p = new URL(url).pathname
					track = Number(/\/trackID=(\d+)$/.exec(p)?.[1] ?? 0)
					path = p.replace(/\/trackID=\d+$/, "").replace(/\/$/, "") || "/"
				} catch {}
				const ok = authorized(headers)
				requests.push({ method, path, authorized: ok, transport: headers.get("transport") })
				const reply = (status: string, extra: Record<string, string> = {}, body = "") => {
					const lines = [`RTSP/1.0 ${status}`, `CSeq: ${cseq}`, ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`)]
					if (body) lines.push(`Content-Length: ${Buffer.byteLength(body)}`)
					sock.write(`${lines.join("\r\n")}\r\n\r\n${body}`)
				}
				if (method === "OPTIONS") {
					reply("200 OK", { Public: "OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN, GET_PARAMETER" })
					continue
				}
				if (!ok) {
					reply("401 Unauthorized", { "WWW-Authenticate": 'Basic realm="mock camera"' })
					continue
				}
				const feed = feeds.get(path)
				if (!feed && method !== "TEARDOWN" && method !== "GET_PARAMETER") {
					reply("404 Not Found")
					continue
				}
				if (method === "DESCRIBE")
					reply("200 OK", { "Content-Type": "application/sdp", "Content-Base": `${url.replace(/\/$/, "")}/` }, feed!.sdp)
				else if (method === "SETUP") {
					const transport = headers.get("transport") ?? ""
					const kind = feed!.kinds[track]
					if (!/TCP/i.test(transport)) reply("461 Unsupported Transport")
					else if (!kind) reply("404 Not Found")
					else {
						// the channel pair the client asked for (ffmpeg: 0-1, then 2-3); else one pair per track
						const asked = /interleaved=(\d+)/.exec(transport)
						const ch = asked ? Number(asked[1]) : track * 2
						channels[kind] = ch
						reply("200 OK", { Transport: `RTP/AVP/TCP;unicast;interleaved=${ch}-${ch + 1}`, Session: `${session};timeout=60` })
					}
				} else if (method === "PLAY") {
					reply("200 OK", { Session: session, Range: "npt=0.000-" })
					playing = feed!
					feed!.clients.set(sock, channels)
				} else if (method === "TEARDOWN") {
					reply("200 OK", { Session: session })
					playing?.clients.delete(sock)
					playing = null
				} else reply("200 OK", { Session: session })
			}
		})
	})
	await new Promise<void>(resolve => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve))
	const port = (server.address() as AddressInfo).port

	return {
		port,
		host: `${opts.host ?? "127.0.0.1"}:${port}`,
		requests,
		/** The DESCRIBE answer for a path. */
		sdp: (path: string) => feeds.get(path)?.sdp ?? null,
		/** Playing clients right now, per path. */
		viewers: (path: string) => feeds.get(path)?.clients.size ?? 0,
		/** The camera's password changed: sessions already playing go on, every new login needs this one. */
		setPassword: (next: string) => {
			password = next
		},
		/** Drops every client playing a path, like a camera that cut the stream off. */
		drop: (path: string) => {
			for (const c of feeds.get(path)?.clients.keys() ?? []) c.destroy()
		},
		/** Stop (or resume) relaying a path's sound while its video keeps flowing, like a camera whose audio drops out. */
		dropAudio: (path: string, drop: boolean) => {
			const f = feeds.get(path)
			if (f) f.dropAudio = drop
		},
		close: async () => {
			for (const f of feeds.values()) {
				f.proc.kill("SIGKILL")
				for (const s of f.sockets) s.close()
			}
			for (const s of sockets) s.destroy()
			await new Promise<void>(resolve => {
				server.close(() => resolve())
			})
			rmSync(dir, { recursive: true, force: true })
		}
	}
}

export type MockRtsp = Awaited<ReturnType<typeof startMockRtsp>>
