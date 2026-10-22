// The live picture over HTTP: which sources can show live video, the video itself
// (fragmented MP4 for Media Source Extensions, with the camera's sound on request, or
// Motion JPEG for any <img>) and snapshots.

import { Hono } from "hono"
import type { LiveSourceDto } from "../api-types.ts"
import { FeedError } from "../live/feeds.ts"
import type { Live } from "../live/manager.ts"
import { MJPEG_TYPE, mjpegPart } from "../live/mjpeg.ts"
import { answer, streamParam } from "./live-http.ts"

/** How long a viewer waits for the first picture before getting the reason instead. */
const FIRST_FRAME_MS = 20_000

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")

export const liveMediaRoutes = (live: Live) => {
	const api = new Hono()

	api.get("/live", async c => {
		const body: LiveSourceDto[] = await live.list()
		return c.json(body)
	})

	api.get("/live/:name/snapshot", c =>
		answer(async () => {
			const name = c.req.param("name")
			const jpeg = await live.snapshot(name, streamParam(c.req.query("stream")), AbortSignal.timeout(20_000), { fast: c.req.query("fast") === "1" })
			const headers: Record<string, string> = { "Content-Type": "image/jpeg", "Cache-Control": "no-store" }
			if (c.req.query("download") === "1") headers["Content-Disposition"] = `attachment; filename="look4-${name}-${stamp()}.jpg"`
			return new Response(new Uint8Array(jpeg), { headers })
		})
	)

	api.get("/live/:name/mjpeg", c =>
		answer(async () => {
			const hub = await live.hubFor(c.req.param("name"), streamParam(c.req.query("stream")))
			let leave = () => {}
			const body = new ReadableStream<Uint8Array>(
				{
					start(ctrl) {
						const send = (jpeg: Buffer) => {
							// a slow viewer skips frames rather than queueing them
							if ((ctrl.desiredSize ?? 1) > 0) ctrl.enqueue(mjpegPart(jpeg))
						}
						leave = hub.join({
							frame: send,
							end: () => {
								try {
									ctrl.close()
								} catch {}
							}
						})
						const last = hub.latest()
						if (last) send(last)
					},
					cancel() {
						leave()
					}
				},
				{ highWaterMark: 2 }
			)
			c.req.raw.signal.addEventListener("abort", () => leave(), { once: true })
			try {
				await Promise.race([
					hub.ready,
					new Promise((_, reject) => setTimeout(() => reject(new FeedError("The camera sent no picture in time.")), FIRST_FRAME_MS).unref())
				])
			} catch (e) {
				leave()
				throw e
			}
			return new Response(body, { headers: { "Content-Type": MJPEG_TYPE, "Cache-Control": "no-store", "X-Accel-Buffering": "no" } })
		})
	)

	api.get("/live/:name/mp4", c =>
		answer(async () => {
			const session = await live.mp4(c.req.param("name"), streamParam(c.req.query("stream")), {
				hevc: c.req.query("hevc") === "1",
				audio: c.req.query("audio") === "1"
			})
			// a viewer that hung up while ffmpeg was starting fired its abort before this listener existed
			if (c.req.raw.signal.aborted) {
				session.kill()
				return new Response(null, { status: 499 })
			}
			c.req.raw.signal.addEventListener("abort", () => session.kill(), { once: true })
			return new Response(session.body, {
				headers: {
					"Content-Type": "video/mp4",
					"Cache-Control": "no-store",
					"X-Accel-Buffering": "no",
					// the whole stream's codecs for addSourceBuffer (`hvc1.1.6.L150,mp4a.40.2`), whether it carries sound, and how it was made
					"X-Codec": session.codec,
					"X-Audio": session.audio ? "1" : "0",
					"X-Live-Path": session.plan.kind
				}
			})
		})
	)

	return api
}
