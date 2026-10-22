import { type } from "arktype"
import type { Context } from "hono"

/** Thrown from a handler to answer `{ error }` with a specific status. */
export class HttpError extends Error {
	readonly status: number
	constructor(status: number, message: string) {
		super(message)
		this.status = status
	}
}

export const JSON_LIMIT_BYTES = 1024 * 1024

/** Reads a JSON body, capped at ~1 MB even when the client omits Content-Length (chunked). */
export const readJson = async (c: Context, limit = JSON_LIMIT_BYTES): Promise<unknown> => {
	const declared = Number(c.req.header("content-length") ?? "")
	if (declared > limit) throw new HttpError(413, `request body over ${limit} bytes`)
	const body = c.req.raw.body
	if (!body) return {}
	const chunks: Uint8Array[] = []
	let size = 0
	for await (const chunk of body) {
		size += chunk.byteLength
		if (size > limit) throw new HttpError(413, `request body over ${limit} bytes`)
		chunks.push(chunk)
	}
	const text = Buffer.concat(chunks).toString("utf8").trim()
	if (!text) return {}
	try {
		return JSON.parse(text)
	} catch {
		throw new HttpError(400, "request body is not valid JSON")
	}
}

/** Validates `input` against an ArkType type, answering 400 with ArkType's summary on failure. */
export const validate = <t extends type.Any>(t: t, input: unknown): t["infer"] => {
	const out = t(input)
	if (out instanceof type.errors) throw new HttpError(400, out.summary)
	return out
}

export const readBody = async <t extends type.Any>(c: Context, t: t): Promise<t["infer"]> => validate(t, await readJson(c))

export const intParam = (raw: string | undefined, fallback: number, min: number, max: number) => {
	if (raw === undefined || raw === "") return fallback
	const n = Number(raw)
	if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `expected an integer from ${min} to ${max}, got "${raw}"`)
	return n
}
