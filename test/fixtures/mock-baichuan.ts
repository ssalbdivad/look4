// A fake Reolink camera's port 9000 (Baichuan), as much of it as talking uses:
// the two-step sign-in (XOR-encrypted, MD5s of user+nonce and password+nonce),
// AES-encrypted XML after it, TalkAbility (the real RLC-823S1's answer),
// TalkConfig, talk reset and the talk audio itself. `busy` makes the first
// TalkConfig answer 422, as a camera still held by another client does.
// The hashing and key derivation are written out here again rather than
// imported, so a mistake in src/live/baichuan.ts can't agree with itself.

import { createCipheriv, createDecipheriv, createHash } from "node:crypto"
import { type AddressInfo, createServer, type Socket } from "node:net"
import { decodeFrames, encodeFrame, type Frame } from "../../src/live/baichuan.ts"

const NONCE = "9E6D1FCB9E69846D"
const XOR_KEY = [0x1f, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0xff]

/** The real RLC-823S1's TalkAbility. */
export const RLC823S1_TALK_ABILITY = `<?xml version="1.0" encoding="UTF-8" ?>
<body>
<TalkAbility version="1.1">
<duplexList>
<duplex>FDX</duplex>
</duplexList>
<audioStreamModeList>
<audioStreamMode>followVideoStream</audioStreamMode>
</audioStreamModeList>
<audioConfigList>
<audioConfig>
<priority>0</priority>
<audioType>adpcm</audioType>
<sampleRate>16000</sampleRate>
<samplePrecision>16</samplePrecision>
<lengthPerEncoder>1024</lengthPerEncoder>
<soundTrack>mono</soundTrack>
</audioConfig>
</audioConfigList>
</TalkAbility>
</body>
`

const md5 = (s: string) => createHash("md5").update(s).digest("hex").toUpperCase()

const xor = (buf: Buffer) => Buffer.from(buf.map((b, i) => b ^ XOR_KEY[i % 8]!))

export type MockBaichuanEvent = { msgId: number; code: number; at: number }

export type MockBaichuan = {
	port: number
	/** Every message after sign-in, as answered. */
	events: MockBaichuanEvent[]
	/** The ADPCM blocks received, unwrapped from their media frames. */
	blocks: Buffer[]
	/** The TalkConfig XML received. */
	talkConfig: string | null
	close(): Promise<void>
}

export const startMockBaichuan = async (o: { username: string; password: string; busy?: boolean }): Promise<MockBaichuan> => {
	const key = Buffer.from(md5(`${NONCE}-${o.password}`).slice(0, 16), "latin1")
	const iv = Buffer.from("0123456789abcdef")
	const aesOut = (s: string) => {
		const c = createCipheriv("aes-128-cfb", key, iv)
		return Buffer.concat([c.update(s), c.final()])
	}
	const aesIn = (b: Buffer) => {
		const d = createDecipheriv("aes-128-cfb", key, iv)
		return Buffer.concat([d.update(b), d.final()]).toString("utf8")
	}
	let busy = !!o.busy
	const state: MockBaichuan = {
		port: 0,
		events: [],
		blocks: [],
		talkConfig: null,
		close: () => new Promise(r => server.close(() => r()))
	}
	const sockets = new Set<Socket>()

	const answer = (socket: Socket, f: Frame, code: number, payload?: Buffer, cls = 0x6414) => {
		// encodeFrame with no encryption only lays the header out; payloads arrive encrypted already
		socket.write(encodeFrame({ kind: "none" }, { msgId: f.msgId, msgNum: f.msgNum, channel: f.channel, code, cls, payload }))
	}

	const onFrame = (socket: Socket, f: Frame, conn: { signedIn: boolean }) => {
		if (f.msgId === 1 && f.cls === 0x6514) {
			if (f.code !== 0xdc12) return socket.destroy()
			const xml = `<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n<Encryption version="1.1">\n<type>md5</type>\n<nonce>${NONCE}</nonce>\n</Encryption>\n</body>\n`
			return answer(socket, f, 0xdd12, xor(Buffer.from(xml)), 0x6614)
		}
		if (f.msgId === 1) {
			const xml = xor(f.payload).toString("utf8")
			const ok =
				xml.includes(`<userName>${md5(o.username + NONCE).slice(0, 31)}</userName>`) && xml.includes(`<password>${md5(o.password + NONCE).slice(0, 31)}</password>`)
			if (!ok) return answer(socket, f, 400)
			conn.signedIn = true
			return answer(socket, f, 200, xor(Buffer.from(`<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n<DeviceInfo version="1.1">\n</DeviceInfo>\n</body>\n`)))
		}
		if (!conn.signedIn) return socket.destroy()
		const ext = f.ext.length ? aesIn(f.ext) : ""
		const reply = (code: number, payload?: Buffer) => {
			state.events.push({ msgId: f.msgId, code, at: Date.now() })
			answer(socket, f, code, payload)
		}
		if (!ext.includes("<channelId>0</channelId>")) return reply(400)
		if (f.msgId === 10) return reply(200, aesOut(RLC823S1_TALK_ABILITY))
		if (f.msgId === 201) {
			state.talkConfig = aesIn(f.payload)
			if (busy) return reply(422)
			return reply(200)
		}
		if (f.msgId === 11) {
			busy = false
			return reply(200)
		}
		if (f.msgId === 202) {
			if (!ext.includes("<binaryData>1</binaryData>")) return reply(400)
			for (let at = 0; at < f.payload.length; ) {
				const p = f.payload
				if (p.readUInt32LE(at) !== 0x62773130 || p.readUInt16LE(at + 8) !== 0x0100) return reply(400)
				const len = p.readUInt16LE(at + 4) - 4
				if (p.readUInt16LE(at + 6) !== len + 4 || p.readUInt16LE(at + 10) !== (len - 4) / 2) return reply(400)
				state.blocks.push(Buffer.from(p.subarray(at + 12, at + 12 + len)))
				at += 12 + len + ((8 - (len % 8)) % 8)
			}
			return reply(200)
		}
		reply(400)
	}

	const server = createServer(socket => {
		sockets.add(socket)
		socket.on("close", () => sockets.delete(socket))
		const conn = { signedIn: false }
		let pending: Buffer = Buffer.alloc(0)
		socket.on("data", (chunk: Buffer) => {
			pending = Buffer.concat([pending, chunk])
			const { frames, rest } = decodeFrames(pending)
			pending = Buffer.from(rest)
			for (const f of frames) onFrame(socket, f, conn)
		})
	})
	await new Promise<void>(r => server.listen(0, "127.0.0.1", r))
	state.port = (server.address() as AddressInfo).port
	const close = state.close
	state.close = () => {
		for (const s of sockets) s.destroy()
		return close()
	}
	return state
}
