// Just enough ISO-BMFF to start a fragmented-MP4 live stream in the browser:
// where the init segment (ftyp + moov) ends, and the RFC 6381 codecs string
// Media Source Extensions needs for the whole stream (`avc1.64001f,mp4a.40.2`),
// read per track from moov → trak → mdia → minf → stbl → stsd.

/** Byte length of the init segment at the start of `buf` once `moov` is complete, else null. */
export const initSegmentEnd = (buf: Uint8Array): number | null => {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
	let at = 0
	while (at + 8 <= buf.length) {
		let size = view.getUint32(at)
		const type = String.fromCharCode(buf[at + 4]!, buf[at + 5]!, buf[at + 6]!, buf[at + 7]!)
		if (size === 1) {
			if (at + 16 > buf.length) return null
			size = Number(view.getBigUint64(at + 8))
		}
		// a size of 0 ("to end of file") never appears in a fragmented stream's init segment
		if (size < 8) return null
		if (at + size > buf.length) return null
		at += size
		if (type === "moov") return at
	}
	return null
}

type Box = { type: string; body: number; end: number }

/** The boxes laid end to end in `buf[from, to)`; stops at the first one that doesn't fit. */
const children = (buf: Uint8Array, from: number, to: number): Box[] => {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
	const out: Box[] = []
	let at = from
	while (at + 8 <= to) {
		let size = view.getUint32(at)
		let body = at + 8
		if (size === 1) {
			if (at + 16 > to) break
			size = Number(view.getBigUint64(at + 8))
			body = at + 16
		} else if (size === 0) size = to - at
		if (size < body - at || at + size > to) break
		out.push({ type: String.fromCharCode(buf[at + 4]!, buf[at + 5]!, buf[at + 6]!, buf[at + 7]!), body, end: at + size })
		at += size
	}
	return out
}

/** Follows box types down from `box`. */
const path = (buf: Uint8Array, box: Box, ...types: string[]): Box | undefined => {
	let at: Box | undefined = box
	for (const type of types) at = at && children(buf, at.body, at.end).find(b => b.type === type)
	return at
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0")

/** Reverses the 32 bits of `n` (HEVC's compatibility flags are written most significant bit first). */
const reverse32 = (n: number) => {
	let r = 0
	for (let i = 0; i < 32; i++) r = (r << 1) | ((n >>> i) & 1)
	return r >>> 0
}

const avcCodec = (entry: string, b: Uint8Array) => `${entry}.${hex2(b[1]!)}${hex2(b[2]!)}${hex2(b[3]!)}`

const hevcCodec = (entry: string, b: Uint8Array) => {
	const space = ["", "A", "B", "C"][b[1]! >> 6]!
	const tier = (b[1]! >> 5) & 1 ? "H" : "L"
	const compat = reverse32(((b[2]! << 24) | (b[3]! << 16) | (b[4]! << 8) | b[5]!) >>> 0)
	const constraints = [...b.subarray(6, 12)]
	while (constraints.length && constraints.at(-1) === 0) constraints.pop()
	return [entry, `${space}${b[1]! & 0x1f}`, compat.toString(16), `${tier}${b[12]}`, ...constraints.map(c => c.toString(16))].join(".")
}

/** `mp4a.40.2` from an `esds` box: the decoder config's object type, plus the AAC audio object type. */
const esdsCodec = (buf: Uint8Array, esds: Box): string | null => {
	let at = esds.body + 4 // FullBox version + flags
	const descriptor = () => {
		const tag = buf[at++]
		let len = 0
		for (let i = 0; i < 4; i++) {
			const b = buf[at++] ?? 0
			len = (len << 7) | (b & 0x7f)
			if (!(b & 0x80)) break
		}
		return { tag, len }
	}
	if (descriptor().tag !== 0x03) return null
	const flags = buf[at + 2] ?? 0
	at += 3 // ES_ID + flags
	if (flags & 0x80) at += 2 // dependsOn_ES_ID
	if (flags & 0x40) at += 1 + (buf[at] ?? 0) // URL
	if (flags & 0x20) at += 2 // OCR_ES_Id
	if (descriptor().tag !== 0x04) return null
	const objectType = buf[at]
	if (objectType === undefined) return null
	at += 13
	if (objectType !== 0x40) return `mp4a.${hex2(objectType)}`
	const dsi = descriptor()
	if (dsi.tag !== 0x05 || dsi.len < 1 || at >= esds.end) return "mp4a.40.2"
	let aot = buf[at]! >> 3
	if (aot === 31) aot = 32 + (((buf[at]! & 0x07) << 3) | ((buf[at + 1] ?? 0) >> 5))
	return `mp4a.40.${aot}`
}

export type Track = { kind: "video" | "audio" | "other"; codec: string | null }

/** Each track's kind and codec string, in track order. */
export const tracks = (init: Uint8Array): Track[] => {
	const moov = children(init, 0, init.length).find(b => b.type === "moov")
	if (!moov) return []
	return children(init, moov.body, moov.end)
		.filter(b => b.type === "trak")
		.map((trak): Track => {
			const hdlr = path(init, trak, "mdia", "hdlr")
			const handler = hdlr ? String.fromCharCode(...init.subarray(hdlr.body + 8, hdlr.body + 12)) : ""
			const kind = handler === "vide" ? "video" : handler === "soun" ? "audio" : "other"
			// stsd: FullBox header + entry_count, then the sample entries
			const stsd = path(init, trak, "mdia", "minf", "stbl", "stsd")
			const entry = stsd && children(init, stsd.body + 8, stsd.end)[0]
			if (!entry) return { kind, codec: null }
			const sub = (type: string, skip: number) => children(init, entry.body + skip, entry.end).find(b => b.type === type)
			if (entry.type === "avc1" || entry.type === "avc3") {
				const c = sub("avcC", 78) // VisualSampleEntry fields
				return { kind, codec: c && c.end - c.body >= 4 ? avcCodec(entry.type, init.subarray(c.body, c.end)) : null }
			}
			if (entry.type === "hvc1" || entry.type === "hev1") {
				const c = sub("hvcC", 78)
				return { kind, codec: c && c.end - c.body >= 13 ? hevcCodec(entry.type, init.subarray(c.body, c.end)) : null }
			}
			if (entry.type === "mp4a") {
				// AudioSampleEntry fields: 28 bytes, or 44/64 for QuickTime sound versions 1/2
				const version = (init[entry.body + 8]! << 8) | init[entry.body + 9]!
				const c = sub("esds", [28, 44, 64][version] ?? 28)
				return { kind, codec: c ? esdsCodec(init, c) : null }
			}
			if (entry.type === "Opus") return { kind, codec: "opus" }
			if (entry.type === "fLaC") return { kind, codec: "flac" }
			return { kind, codec: null }
		})
}

export type Codecs = {
	/** For `addSourceBuffer`: video first, then the audio track when there is one (`hvc1.1.6.L150,mp4a.40.2`). */
	codecs: string
	video: string
	audio: string | null
}

/** The stream's codecs, or null when its video codec is unknown (parameter sets not known yet). */
export const codecsOf = (init: Uint8Array): Codecs | null => {
	const all = tracks(init)
	const video = all.find(t => t.kind === "video")?.codec
	if (!video) return null
	const audio = all.find(t => t.kind === "audio" && t.codec)?.codec ?? null
	return { codecs: audio ? `${video},${audio}` : video, video, audio }
}
