// Talking through a Reolink camera's speaker: the camera states its format
// (`TalkAbility`: IMA ADPCM, mono, usually 16 kHz in blocks of 1025 samples), we
// claim the speaker with `TalkConfig`, stream ADPCM blocks wrapped as Reolink
// media frames, and release it with a talk reset. Only one client talks at a
// time: a camera still held by a crashed client answers 422, and Reolink's own
// app resets and asks again, so this does too.

import { BaichuanError, body, extension, MSG, type BaichuanSession, xmlField } from "./baichuan.ts"

export type TalkFormat = {
	sampleRate: number
	/** Samples in one ADPCM block, the header's own sample included. */
	samplesPerBlock: number
	/** `<TalkConfig>` as the camera wants it back: its first duplex, stream mode and audio config. */
	config: string
}

/** Reads `TalkAbility`; null when the camera can't talk or offers something other than ADPCM. */
export const talkFormat = (xml: string, channel: number): TalkFormat | null => {
	const audioConfig = xml.match(/<audioConfig>[\s\S]*?<\/audioConfig>/)?.[0]
	const duplex = xmlField(xml, "duplex")
	const mode = xmlField(xml, "audioStreamMode")
	if (!audioConfig || !duplex || !mode) return null
	if (xmlField(audioConfig, "audioType")?.toLowerCase() !== "adpcm") return null
	const sampleRate = Number(xmlField(audioConfig, "sampleRate"))
	const lengthPerEncoder = Number(xmlField(audioConfig, "lengthPerEncoder"))
	if (!(sampleRate > 0) || !(lengthPerEncoder > 0) || lengthPerEncoder % 2) return null
	return {
		sampleRate,
		// lengthPerEncoder is the samples after the header's: two per byte of a block's data
		samplesPerBlock: lengthPerEncoder + 1,
		config: `<TalkConfig version="1.1">\n<channelId>${channel}</channelId>\n<duplex>${duplex}</duplex>\n<audioStreamMode>${mode}</audioStreamMode>\n${audioConfig}\n</TalkConfig>`
	}
}

const STEPS = [
	7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190,
	209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499,
	2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350,
	22385, 24623, 27086, 29794, 32767
]
const INDEX_STEP = [-1, -1, -1, -1, 2, 4, 6, 8]

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n)

/**
 * IMA ADPCM in DVI block layout (as WAV's IMA ADPCM, mono): a 4-byte header (the
 * first sample as-is, the step index, a zero), then two samples a byte, low
 * nibble first. The step index carries over from block to block.
 */
export const createImaEncoder = () => {
	let index = 0
	return (samples: Int16Array): Buffer => {
		const out = Buffer.alloc(4 + Math.ceil((samples.length - 1) / 2))
		let pred = samples[0] ?? 0
		out.writeInt16LE(pred, 0)
		out.writeUInt8(index, 2)
		for (let i = 1; i < samples.length; i++) {
			let step = STEPS[index]!
			let diff = samples[i]! - pred
			let nib = 0
			if (diff < 0) {
				nib = 8
				diff = -diff
			}
			let delta = step >> 3
			if (diff >= step) {
				nib |= 4
				diff -= step
				delta += step
			}
			step >>= 1
			if (diff >= step) {
				nib |= 2
				diff -= step
				delta += step
			}
			step >>= 1
			if (diff >= step) {
				nib |= 1
				delta += step
			}
			pred = clamp(nib & 8 ? pred - delta : pred + delta, -32768, 32767)
			index = clamp(index + INDEX_STEP[nib & 7]!, 0, 88)
			const at = 4 + ((i - 1) >> 1)
			out[at] = (i - 1) & 1 ? out[at]! | (nib << 4) : nib
		}
		return out
	}
}

/** One ADPCM block as a Reolink media frame: magic `10wb`, its length twice, `0x0100`, the half data length, the block, zero-padded to 8 bytes. */
export const adpcmFrame = (block: Buffer) => {
	const head = Buffer.alloc(12)
	head.writeUInt32LE(0x62773130, 0)
	head.writeUInt16LE(block.length + 4, 4)
	head.writeUInt16LE(block.length + 4, 6)
	head.writeUInt16LE(0x0100, 8)
	head.writeUInt16LE((block.length - 4) / 2, 10)
	const pad = (8 - (block.length % 8)) % 8
	return Buffer.concat([head, block, Buffer.alloc(pad)])
}

/** The camera has no speaker, or none it lets clients use. */
export class TalkUnsupportedError extends BaichuanError {}

export type TalkStream = {
	readonly format: TalkFormat
	/** Queues mono 16-bit PCM at `format.sampleRate`; whole blocks go out at once. */
	write(pcm: Int16Array): void
	/** Sends what is left, waits for the camera to play it, and releases the speaker. */
	end(): Promise<void>
	/** Releases the speaker now, dropping what hasn't played. */
	abort(): Promise<void>
	/** Resolves when the connection to the camera ends, whoever ended it. */
	readonly closed: Promise<void>
}

export const readTalkFormat = async (s: BaichuanSession): Promise<TalkFormat> => {
	const ability = await s.request({ msgId: MSG.talkAbility, ext: extension(s.channel) })
	const format = ability.code === 200 && ability.xml ? talkFormat(ability.xml, s.channel) : null
	if (!format) throw new TalkUnsupportedError("This camera has no speaker look4 can talk through.", ability.code)
	return format
}

/** The camera's speaker is held by this many blocks of sound before the first goes out, so a late packet doesn't leave a gap. */
const PREBUFFER_BLOCKS = 2

/**
 * Claims the camera's speaker on a signed-in session, which the stream then owns: ending or
 * aborting it closes the session.
 */
export const startTalk = async (s: BaichuanSession, format?: TalkFormat): Promise<TalkStream> => {
	const reset = () => s.request({ msgId: MSG.talkReset, ext: extension(s.channel) }).catch(() => undefined)
	let f: TalkFormat
	try {
		f = format ?? (await readTalkFormat(s))
		const claim = () => s.request({ msgId: MSG.talkConfig, ext: extension(s.channel), payload: body(f.config) })
		let answer = await claim()
		if (answer.code === 422) {
			await reset()
			answer = await claim()
		}
		if (answer.code !== 200) throw new BaichuanError(`The camera wouldn't take the talk format (code ${answer.code}).`, answer.code)
	} catch (e) {
		s.close()
		throw e
	}

	const encode = createImaEncoder()
	const msgNum = s.nextNum()
	const ext = extension(s.channel, true)
	const block = new Int16Array(f.samplesPerBlock)
	const blockMs = (f.samplesPerBlock / f.sampleRate) * 1000
	let filled = 0
	/** Blocks held back until the prebuffer fills; null once sound is flowing. */
	let held: Buffer[] | null = []
	// when the camera should finish playing what it has been sent
	let playsUntil = 0
	let finished = false

	const send = (frame: Buffer) => {
		s.send({ msgId: MSG.talk, msgNum, ext, payload: frame })
		playsUntil = Math.max(playsUntil, Date.now()) + blockMs
	}

	const flush = () => {
		const frame = adpcmFrame(encode(block))
		filled = 0
		if (!held) return send(frame)
		held.push(frame)
		if (held.length < PREBUFFER_BLOCKS) return
		for (const h of held) send(h)
		held = null
	}

	const release = async () => {
		if (finished) return
		finished = true
		await reset()
		s.close()
	}

	return {
		format: f,
		write: pcm => {
			if (finished) return
			for (let i = 0; i < pcm.length; ) {
				const n = Math.min(pcm.length - i, block.length - filled)
				block.set(pcm.subarray(i, i + n), filled)
				filled += n
				i += n
				if (filled === block.length) flush()
			}
		},
		end: async () => {
			if (finished) return
			if (filled) {
				block.fill(0, filled)
				flush()
			}
			for (const h of held ?? []) send(h)
			held = null
			// a reset cuts off whatever the camera is still playing
			const wait = playsUntil - Date.now() + 150
			if (wait > 0) await new Promise(r => setTimeout(r, wait))
			await release()
		},
		abort: release,
		closed: s.closed
	}
}
