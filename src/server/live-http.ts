// Helpers shared by the live-view route files: the stream query parameter and
// turning camera/feed failures into answers with a status and a sentence.

import type { LiveStream } from "../api-types.ts"
import { ControlError } from "../live/control.ts"
import { FeedError } from "../live/feeds.ts"
import { HttpError } from "./http.ts"

/** `main` unless the request asks for `sub`: Sharp is the default everywhere. */
export const streamParam = (raw: string | undefined): LiveStream => {
	if (raw === undefined || raw === "" || raw === "main") return "main"
	if (raw === "sub") return "sub"
	throw new HttpError(400, `stream must be "main" or "sub", got "${raw}"`)
}

/** Turns live-view failures into answers with a status and a sentence. */
export const answer = async <t>(fn: () => Promise<t>): Promise<t> => {
	try {
		return await fn()
	} catch (e) {
		if (e instanceof ControlError) throw new HttpError(e.status, e.message)
		if (e instanceof FeedError) throw new HttpError(502, e.message)
		throw e
	}
}
