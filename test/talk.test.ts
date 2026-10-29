import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { after, before, describe, test } from "node:test"
import { WebSocket } from "ws"
import type { TalkServerMessage } from "../src/api-types.ts"
import { BaichuanAuthError, MSG, openBaichuan } from "../src/live/baichuan.ts"
import type { CameraControl } from "../src/live/control.ts"
import type { Live } from "../src/live/manager.ts"
import { createImaEncoder, startTalk, type TalkStream } from "../src/live/talk.ts"
import { FFMPEG } from "../src/media/ffmpeg.ts"
import { attachTalk } from "../src/server/live-talk.ts"
import { type MockBaichuan, startMockBaichuan } from "./fixtures/mock-baichuan.ts"

const sine = (n: number, freq: number, rate = 16000, amp = 12000) => Int16Array.from({ length: n }, (_, i) => Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amp))

describe("IMA ADPCM", () => {
	test("blocks decode with ffmpeg's IMA WAV decoder back to the input", () => {
		const perBlock = 1025
		const blocks = 8
		// a sweep, so every step size gets used, and a jump to full scale the step index has to chase
		const input = Int16Array.from({ length: perBlock * blocks }, (_, i) =>
			i > perBlock * 6 ? 30000 : Math.round(Math.sin(2 * Math.PI * (200 + i / 4) * (i / 16000)) * 14000)
		)
		const encode = createImaEncoder()
		const data = Buffer.concat(Array.from({ length: blocks }, (_, b) => encode(input.subarray(b * perBlock, (b + 1) * perBlock))))
		const blockAlign = data.length / blocks
		assert.equal(blockAlign, 516)
		const fmt = Buffer.alloc(20)
		fmt.writeUInt16LE(0x11, 0) // IMA ADPCM
		fmt.writeUInt16LE(1, 2)
		fmt.writeUInt32LE(16000, 4)
		fmt.writeUInt32LE(Math.round((16000 * blockAlign) / perBlock), 8)
		fmt.writeUInt16LE(blockAlign, 12)
		fmt.writeUInt16LE(4, 14)
		fmt.writeUInt16LE(2, 16)
		fmt.writeUInt16LE(perBlock, 18)
		const chunk = (id: string, body: Buffer) => {
			const h = Buffer.alloc(8)
			h.write(id, 0)
			h.writeUInt32LE(body.length, 4)
			return Buffer.concat([h, body])
		}
		const wav = chunk("RIFF", Buffer.concat([Buffer.from("WAVE"), chunk("fmt ", fmt), chunk("data", data)]))
		const pcm = execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "pipe:1"], { input: wav })
		const out = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2)
		assert.equal(out.length, input.length)
		let signal = 0
		let noise = 0
		for (let i = 0; i < input.length; i++) {
			signal += input[i]! ** 2
			noise += (input[i]! - out[i]!) ** 2
		}
		const snr = 10 * Math.log10(signal / noise)
		assert.ok(snr > 25, `SNR ${snr.toFixed(1)} dB`)
	})
})

describe("talking to a camera on port 9000", () => {
	let cam: MockBaichuan
	before(async () => {
		cam = await startMockBaichuan({ username: "admin", password: "hunter2", busy: true })
	})
	after(() => cam.close())

	test("a wrong password is refused at sign-in", async () => {
		await assert.rejects(openBaichuan({ host: "127.0.0.1", port: cam.port, username: "admin", password: "nope" }), BaichuanAuthError)
	})

	test("a camera held by another client is reset and claimed; sound goes out in whole blocks after a prebuffer, and the speaker is released once it has played", async () => {
		const s = await openBaichuan({ host: "127.0.0.1", port: cam.port, username: "admin", password: "hunter2" })
		const talk = await startTalk(s)
		assert.deepEqual(
			cam.events.map(e => [e.msgId, e.code]),
			[
				[MSG.talkAbility, 200],
				[MSG.talkConfig, 422],
				[MSG.talkReset, 200],
				[MSG.talkConfig, 200]
			]
		)
		assert.match(cam.talkConfig!, /<lengthPerEncoder>1024<\/lengthPerEncoder>/)
		const pcm = sine(1025 * 3 + 500, 440)
		// one block is held back
		talk.write(pcm.subarray(0, 1100))
		await new Promise(r => setTimeout(r, 50))
		assert.equal(cam.blocks.length, 0)
		// in odd pieces: blocks don't follow the writes
		for (let i = 1100; i < pcm.length; i += 777) talk.write(pcm.subarray(i, i + 777))
		const ending = Date.now()
		await talk.end()
		// three whole blocks and the rest padded with silence
		assert.equal(cam.blocks.length, 4)
		assert.ok(cam.blocks.every(b => b.length === 516))
		assert.equal(cam.blocks[0]!.readInt16LE(0), pcm[0])
		assert.equal(cam.blocks[1]!.readInt16LE(0), pcm[1025])
		const reset = cam.events.at(-1)!
		assert.equal(reset.msgId, MSG.talkReset)
		// four blocks of 1025 samples at 16 kHz take 256 ms to play; the reset waits for them
		assert.ok(reset.at - ending >= 250, `released ${reset.at - ending} ms after the end`)
		await talk.closed
	})
})

describe("the talk WebSocket", () => {
	let server: Server
	let base: string
	let host: string
	/** What each fake talk did, in order. */
	const log: string[] = []
	let n = 0
	const fakeTalk = async (): Promise<TalkStream> => {
		const id = ++n
		// signing in takes a moment, as on the camera
		await new Promise(r => setTimeout(r, 30))
		log.push(`claim ${id}`)
		let release!: () => void
		const closed = new Promise<void>(r => (release = r))
		return {
			format: { sampleRate: 16000, samplesPerBlock: 1025, config: "" },
			write: pcm => log.push(`write ${id} ${pcm.length}`),
			end: async () => (log.push(`end ${id}`), release()),
			abort: async () => (log.push(`abort ${id}`), release()),
			closed
		}
	}
	const live = { controlFor: (name: string) => (name === "cam" ? ({ talk: fakeTalk } as Partial<CameraControl> as CameraControl) : null) } as Partial<Live> as Live
	let talk: ReturnType<typeof attachTalk>

	before(async () => {
		server = createServer((_, res) => res.end())
		talk = attachTalk(server, { live, hostAllowed: h => h === "127.0.0.1" })
		await new Promise<void>(r => server.listen(0, "127.0.0.1", r))
		host = `127.0.0.1:${(server.address() as AddressInfo).port}`
		base = `ws://${host}/api/live`
	})
	after(async () => {
		talk.close()
		await new Promise(r => server.close(r))
	})

	/** `origin` null sends none. */
	const connect = (name: string, origin: string | null = `http://${host}`) => {
		const ws = new WebSocket(`${base}/${name}/talk`, { headers: origin === null ? {} : { origin } })
		const messages: TalkServerMessage[] = []
		const next = () =>
			new Promise<TalkServerMessage>((resolve, reject) => {
				ws.once("message", d => resolve(JSON.parse(String(d))))
				ws.once("close", () => reject(new Error("closed")))
			})
		ws.on("message", d => messages.push(JSON.parse(String(d))))
		const closed = new Promise<void>(r => ws.once("close", () => r()))
		return { ws, next, messages, closed }
	}

	test("a page from another site, or with no Origin, is refused before anything reaches the camera", async () => {
		for (const origin of ["http://evil.example", null]) {
			const c = connect("cam", origin)
			const status = await new Promise<number>(r => c.ws.once("unexpected-response", (_, res) => r(res.statusCode!)))
			assert.equal(status, 403)
		}
		assert.deepEqual(log, [])
	})

	test("after ready, the page's PCM reaches the camera, and 'end' lets it play out", async () => {
		log.length = 0
		const c = connect("cam")
		assert.deepEqual(await c.next(), { type: "ready", sampleRate: 16000 })
		c.ws.send(Buffer.from(new Int16Array(640).buffer))
		c.ws.send("end")
		await c.closed
		await new Promise(r => setTimeout(r, 20))
		assert.deepEqual(log, [`claim ${n}`, `write ${n} 640`, `end ${n}`])
	})

	test("a second window takes the speaker over: the first is told and released before the second claims", async () => {
		log.length = 0
		const first = connect("cam")
		await first.next()
		const second = connect("cam")
		assert.deepEqual(await first.next(), { type: "error", message: "Another window started talking through this camera." })
		assert.deepEqual(await second.next(), { type: "ready", sampleRate: 16000 })
		assert.deepEqual(log, [`claim ${n - 1}`, `abort ${n - 1}`, `claim ${n}`])
		second.ws.close()
		await second.closed
	})

	test("a camera look4 can't talk through says so", async () => {
		const c = connect("other")
		assert.deepEqual(await c.next(), { type: "error", message: "look4 can't talk through this camera." })
	})
})
