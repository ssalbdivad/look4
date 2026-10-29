// Reolink's own protocol ("Baichuan", TCP 9000), for the one thing the HTTP API
// can't do: talk through the camera's speaker. Only what talking needs is here:
// signing in, reading the camera's talk format, and streaming IMA ADPCM to it.
// The wire format follows neolink (github.com/QuantumEntangledAndy/neolink),
// which reverse-engineered it from Reolink's clients.
//
// A message is a little-endian header (magic, message id, body length, channel,
// stream type, message number, response code, class, and for most classes the
// offset where the payload starts after an "Extension" XML) and a body. Sign-in
// starts with an empty legacy message naming the strongest encryption we take;
// the camera answers with the encryption it picked and a nonce, and the real
// sign-in sends MD5s of user+nonce and password+nonce. From then on the XML is
// encrypted: AES-128-CFB keyed by MD5(nonce-password) on current firmware, a
// fixed XOR on older firmware, never the sign-in itself (which stays on XOR).
// Each XML block is encrypted on its own, from a fresh IV. Talk audio is sent as
// binary payload, unencrypted.

import { createCipheriv, createDecipheriv, createHash } from "node:crypto"
import { connect, type Socket } from "node:net"

const MAGIC = 0x0abcdef0
const MAGIC_REV = 0x0fedcba0

export const MSG = { login: 1, talkAbility: 10, talkReset: 11, talkConfig: 201, talk: 202 } as const

const XOR_KEY = [0x1f, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0xff]
const AES_IV = Buffer.from("0123456789abcdef")

type Encryption = { kind: "none" } | { kind: "xor" } | { kind: "aes"; key: Buffer }

const xor = (offset: number, buf: Buffer) => {
	const out = Buffer.allocUnsafe(buf.length)
	for (let i = 0; i < buf.length; i++) out[i] = buf[i]! ^ XOR_KEY[(i + offset) % 8]! ^ (offset & 0xff)
	return out
}

const encrypt = (enc: Encryption, channel: number, buf: Buffer) => {
	if (enc.kind === "none") return buf
	if (enc.kind === "xor") return xor(channel, buf)
	const c = createCipheriv("aes-128-cfb", enc.key, AES_IV)
	return Buffer.concat([c.update(buf), c.final()])
}

const decrypt = (enc: Encryption, channel: number, buf: Buffer) => {
	if (enc.kind !== "aes") return encrypt(enc, channel, buf)
	const d = createDecipheriv("aes-128-cfb", enc.key, AES_IV)
	return Buffer.concat([d.update(buf), d.final()])
}

/** Uppercase hex MD5 cut to 31 characters: the camera compares 31 (neolink's `md5_string`, Truncate). */
const md5_31 = (s: string) => createHash("md5").update(s).digest("hex").toUpperCase().slice(0, 31)

/** The AES key: the first 16 characters of the uppercase hex MD5 of `nonce-password`. */
export const aesKey = (nonce: string, password: string) =>
	Buffer.from(createHash("md5").update(`${nonce}-${password}`).digest("hex").toUpperCase().slice(0, 16), "latin1")

/** Classes with a payload-offset word in the header (24 bytes instead of 20). */
const hasOffset = (cls: number) => cls === 0x6414 || cls === 0x0000

const XML_DECL = `<?xml version="1.0" encoding="UTF-8" ?>`

export const extension = (channel: number, binary = false) =>
	`${XML_DECL}\n<Extension version="1.1">\n${binary ? "<binaryData>1</binaryData>\n" : ""}<channelId>${channel}</channelId>\n</Extension>\n`

export const body = (inner: string) => `${XML_DECL}\n<body>\n${inner}\n</body>\n`

export type Frame = {
	msgId: number
	channel: number
	msgNum: number
	code: number
	cls: number
	ext: Buffer
	payload: Buffer
}

export type Outgoing = {
	msgId: number
	msgNum: number
	channel: number
	code?: number
	cls?: number
	ext?: string
	/** XML is encrypted like the extension; a Buffer is sent as it is (binary data). */
	payload?: string | Buffer
}

export const encodeFrame = (enc: Encryption, m: Outgoing): Buffer => {
	const cls = m.cls ?? 0x6414
	const ext = m.ext ? encrypt(enc, m.channel, Buffer.from(m.ext)) : Buffer.alloc(0)
	const payload =
		m.payload === undefined ? Buffer.alloc(0) : typeof m.payload === "string" ? encrypt(enc, m.channel, Buffer.from(m.payload)) : m.payload
	const head = Buffer.alloc(hasOffset(cls) ? 24 : 20)
	head.writeUInt32LE(MAGIC, 0)
	head.writeUInt32LE(m.msgId, 4)
	head.writeUInt32LE(ext.length + payload.length, 8)
	head.writeUInt8(m.channel, 12)
	head.writeUInt8(0, 13)
	head.writeUInt16LE(m.msgNum, 14)
	head.writeUInt16LE(m.code ?? 0, 16)
	head.writeUInt16LE(cls, 18)
	if (hasOffset(cls)) head.writeUInt32LE(ext.length, 20)
	return Buffer.concat([head, ext, payload])
}

/** Splits whole frames off the front of `buf`; returns them and the bytes left over. */
export const decodeFrames = (buf: Buffer): { frames: Frame[]; rest: Buffer } => {
	const frames: Frame[] = []
	let at = 0
	while (buf.length - at >= 20) {
		const magic = buf.readUInt32LE(at)
		if (magic !== MAGIC && magic !== MAGIC_REV) throw new BaichuanError("The camera sent something that isn't a Baichuan message.")
		const cls = buf.readUInt16LE(at + 18)
		const headLen = hasOffset(cls) ? 24 : 20
		if (buf.length - at < headLen) break
		const bodyLen = buf.readUInt32LE(at + 8)
		if (buf.length - at < headLen + bodyLen) break
		const extLen = hasOffset(cls) ? buf.readUInt32LE(at + 20) : 0
		const start = at + headLen
		frames.push({
			msgId: buf.readUInt32LE(at + 4),
			channel: buf.readUInt8(at + 12),
			msgNum: buf.readUInt16LE(at + 14),
			code: buf.readUInt16LE(at + 16),
			cls,
			ext: buf.subarray(start, start + extLen),
			payload: buf.subarray(start + extLen, start + bodyLen)
		})
		at = start + bodyLen
	}
	return { frames, rest: buf.subarray(at) }
}

/** The text of the first `<tag>…</tag>` in `xml`, or null. Enough for the handful of flat fields read here. */
export const xmlField = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() ?? null

export class BaichuanError extends Error {
	/** The camera's response code, when it answered with one. */
	readonly code: number | null
	constructor(message: string, code: number | null = null) {
		super(message)
		this.code = code
	}
}

/** The camera refused the username or password. */
export class BaichuanAuthError extends BaichuanError {}

export type BaichuanOptions = {
	host: string
	port?: number
	username: string
	password: string
	channel?: number
	timeoutMs?: number
}

export type BaichuanSession = {
	readonly channel: number
	/** Sends one message and waits for the camera's answer to it (same id and number). */
	request(m: Omit<Outgoing, "msgNum" | "channel"> & { msgNum?: number }, timeoutMs?: number): Promise<{ code: number; xml: string | null }>
	/** Sends one message without waiting. */
	send(m: Omit<Outgoing, "channel">): void
	nextNum(): number
	/** Bytes written but not yet handed to the network. */
	readonly buffered: number
	close(): void
	/** Resolves when the connection ends, for any reason. */
	readonly closed: Promise<void>
}

/** Opens a connection and signs in. */
export const openBaichuan = async (o: BaichuanOptions): Promise<BaichuanSession> => {
	const channel = o.channel ?? 0
	const timeoutMs = o.timeoutMs ?? 8000
	const socket: Socket = connect({ host: o.host, port: o.port ?? 9000 })
	socket.setNoDelay(true)
	let enc: Encryption = { kind: "none" }
	let num = 0
	let pending: Buffer = Buffer.alloc(0)
	let failure: Error | null = null
	const waiters = new Map<string, { resolve: (f: Frame) => void; reject: (e: Error) => void }>()

	const fail = (e: Error) => {
		failure ??= e
		for (const w of waiters.values()) w.reject(failure)
		waiters.clear()
	}
	const closed = new Promise<void>(resolve => socket.once("close", () => resolve()))
	socket.on("close", () => fail(new BaichuanError("The camera closed the connection.")))
	socket.on("error", e => fail(new BaichuanError(`Couldn't reach the camera on port ${o.port ?? 9000}: ${(e as NodeJS.ErrnoException).code ?? e.message}`)))
	socket.on("data", (chunk: Buffer) => {
		pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
		try {
			const { frames, rest } = decodeFrames(pending)
			pending = Buffer.from(rest)
			for (const f of frames) {
				const key = `${f.msgId}:${f.msgNum}`
				const w = waiters.get(key)
				if (!w) continue
				waiters.delete(key)
				w.resolve(f)
			}
		} catch (e) {
			fail(e as Error)
			socket.destroy()
		}
	})

	await new Promise<void>((resolve, reject) => {
		const t = setTimeout(() => {
			socket.destroy()
			reject(new BaichuanError(`Nothing answered on ${o.host}:${o.port ?? 9000}.`))
		}, timeoutMs)
		socket.once("connect", () => (clearTimeout(t), resolve()))
		socket.once("error", e => (clearTimeout(t), reject(failure ?? e)))
	})

	const nextNum = () => (num = (num + 1) & 0xffff)

	const write = (m: Outgoing, e: Encryption = enc) => {
		if (failure) throw failure
		socket.write(encodeFrame(e, m))
	}

	const await_ = (msgId: number, msgNum: number, ms: number) =>
		new Promise<Frame>((resolve, reject) => {
			if (failure) return reject(failure)
			const key = `${msgId}:${msgNum}`
			const t = setTimeout(() => {
				waiters.delete(key)
				reject(new BaichuanError("The camera didn't answer."))
			}, ms)
			waiters.set(key, {
				resolve: f => (clearTimeout(t), resolve(f)),
				reject: e => (clearTimeout(t), reject(e))
			})
		})

	/** Payload XML as text, decrypted as the sign-in rules say (`signIn`: XOR at most). */
	const xmlOf = (f: Frame, e: Encryption) => (f.payload.length ? decrypt(e, f.channel, f.payload).toString("utf8") : null)

	try {
		// 0xdc12: we take full AES. The answer's code is 0xddXX, XX the encryption the camera chose.
		const n = nextNum()
		const first = await_(MSG.login, n, timeoutMs)
		write({ msgId: MSG.login, msgNum: n, channel, code: 0xdc12, cls: 0x6514 })
		const reply = await first
		if (reply.code >> 8 !== 0xdd) throw new BaichuanError(`The camera answered the sign-in with code ${reply.code}.`, reply.code)
		const chosen = reply.code & 0xff
		const xml = xmlOf(reply, chosen === 0 ? { kind: "none" } : { kind: "xor" })
		const nonce = xml && xmlField(xml, "nonce")
		if (!nonce) throw new BaichuanError("The camera's sign-in answer had no nonce.")
		const signIn: Encryption = chosen === 0 ? { kind: "none" } : { kind: "xor" }
		const login = body(
			`<LoginUser version="1.1">\n<userName>${md5_31(o.username + nonce)}</userName>\n<password>${md5_31(o.password + nonce)}</password>\n<userVer>1</userVer>\n</LoginUser>\n<LoginNet version="1.1">\n<type>LAN</type>\n<udpPort>0</udpPort>\n</LoginNet>`
		)
		const second = await_(MSG.login, n, timeoutMs)
		write({ msgId: MSG.login, msgNum: n, channel, cls: 0x6414, payload: login }, signIn)
		const done = await second
		if (done.code !== 200 || !done.payload.length) throw new BaichuanAuthError("The camera refused the username or password.", done.code)
		enc = chosen === 0 ? { kind: "none" } : chosen === 1 ? { kind: "xor" } : { kind: "aes", key: aesKey(nonce, o.password) }
	} catch (e) {
		socket.destroy()
		throw e
	}

	return {
		channel,
		nextNum,
		get buffered() {
			return socket.writableLength
		},
		closed,
		send: m => write({ ...m, channel }),
		request: async (m, ms = timeoutMs) => {
			const msgNum = m.msgNum ?? nextNum()
			const answer = await_(m.msgId, msgNum, ms)
			write({ ...m, msgNum, channel })
			const f = await answer
			return { code: f.code, xml: xmlOf(f, enc) }
		},
		close: () => {
			socket.end()
			setTimeout(() => socket.destroy(), 1000).unref()
		}
	}
}
