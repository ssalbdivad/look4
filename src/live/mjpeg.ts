// Motion JPEG over HTTP: ffmpeg's `mpjpeg` output split back into frames, and
// the multipart/x-mixed-replace parts look4 sends on (one frame per part), which
// any browser shows in a plain <img>.

export const BOUNDARY = "look4frame"
export const MJPEG_TYPE = `multipart/x-mixed-replace; boundary=${BOUNDARY}`

const CRLF2 = Buffer.from("\r\n\r\n")

/** One part: boundary, headers, the JPEG, CRLF. */
export const mjpegPart = (jpeg: Uint8Array) =>
	Buffer.concat([
		Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`),
		jpeg,
		Buffer.from("\r\n")
	])

/**
 * Splits a multipart JPEG stream into frames, whatever the chunk boundaries.
 * Each part must carry a Content-Length (ffmpeg's mpjpeg muxer and look4 both send one).
 */
export const createMjpegParser = (maxFrameBytes = 32 * 1024 * 1024) => {
	let buf = Buffer.alloc(0)
	let need: number | null = null
	return (chunk: Uint8Array): Buffer[] => {
		buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk)
		const frames: Buffer[] = []
		for (;;) {
			if (need === null) {
				const end = buf.indexOf(CRLF2)
				if (end < 0) {
					if (buf.length > 64 * 1024) throw new Error("no part header in the MJPEG stream")
					break
				}
				const head = buf.subarray(0, end).toString("latin1")
				const len = /content-length:\s*(\d+)/i.exec(head)
				if (!len) throw new Error("an MJPEG part without Content-Length")
				need = Number(len[1])
				if (need > maxFrameBytes) throw new Error(`an MJPEG frame of ${need} bytes`)
				buf = buf.subarray(end + 4)
			}
			if (buf.length < need) break
			frames.push(Buffer.from(buf.subarray(0, need)))
			// the CRLF after the JPEG becomes part of the next header, which only needs its Content-Length
			buf = buf.subarray(need)
			need = null
		}
		return frames
	}
}
