// Saving a clip from the live view: POST /api/live/:name/record (start, stop, cancel).
// Built on the source's own stream recorder (src/sources/recorder.ts).

import { type } from "arktype"
import { Hono } from "hono"
import type { LiveRecordSaved, LiveRecordStarted } from "../api-types.ts"
import type { AppContext } from "../context.ts"
import { RecordError } from "../sources/recorder.ts"
import { HttpError, readBody } from "./http.ts"

const RecordBody = type({ op: "'start'", "+": "delete" }).or({ op: "'stop' | 'cancel'", id: "string > 0", "+": "delete" })

/** Why this camera can't record, in one sentence. */
const noRecorder = (ctx: AppContext, name: string) => {
	const cfg = ctx.config.sources.find(s => s.name === name)
	if (!cfg || cfg.type === "watch") return new HttpError(404, `There's no camera called “${name}”.`)
	if (!cfg.enabled) return new HttpError(409, "This camera is paused in Settings → Sources, so look4 isn't recording it.")
	if (cfg.type === "reolink") {
		const status = ctx.sourceStatuses().find(s => s.name === name)
		if (cfg.capture === "sd" || (status && /SD card/.test(status.detail)))
			return new HttpError(
				409,
				"look4 gets this camera's clips from its SD card, so it isn't recording the live stream. Choose “Live stream” under Clips from in Settings → Sources to save clips from here."
			)
	}
	return new HttpError(409, "look4 isn't recording this camera's stream right now, so there's nothing to save. Check Settings → Sources.")
}

export const liveRecordRoutes = (ctx: AppContext) => {
	const api = new Hono()

	api.post("/live/:name/record", async c => {
		const name = c.req.param("name")
		const body = await readBody(c, RecordBody)
		const recorder = ctx.liveRecorder(name)
		if (!recorder) throw noRecorder(ctx, name)
		try {
			if (body.op === "start") return c.json(recorder.start() satisfies LiveRecordStarted)
			if (body.op === "cancel") {
				recorder.cancel(body.id)
				return c.json({ ok: true as const })
			}
			return c.json((await recorder.stop(body.id)) satisfies LiveRecordSaved)
		} catch (e) {
			if (e instanceof RecordError) throw new HttpError(e.status, e.message)
			throw e
		}
	})

	return api
}
