import type { Usage } from "../types.ts"

/** A backend failed in a way worth showing the user verbatim ("Claude Code is not logged in"). */
export class LlmError extends Error {
	override name = "LlmError"
	/** Tokens the call was billed for before it failed (a truncated or malformed answer), so cost tracking still counts them. */
	usage: Usage | null
	constructor(message: string, opts: ErrorOptions & { usage?: Usage | null } = {}) {
		super(message, opts)
		this.usage = opts.usage ?? null
	}
}

/** The billed usage carried by `e` or anything in its `cause` chain; null when the call cost nothing. */
export const usageOf = (e: unknown): Usage | null => {
	for (let cur = e, depth = 0; cur && depth < 8; cur = (cur as Error).cause, depth++)
		if (cur instanceof LlmError && cur.usage) return cur.usage
	return null
}

// Classified from the message, not the error object, because the worker must make the same
// call after a restart from nothing but the `error` text stored on the clip.
const PERMANENT = /not logged in|not on PATH|rejected the credentials|permission denied|rejected the request|declined to answer|malformed output|did not return JSON|cut off at max_tokens/i
// Claude Code words its subscription limits "You've hit your session limit · resets 5pm" (also weekly / Opus
// limit, and a bare "hit your limit"); those pass when the window resets, so they are transient too.
const TRANSIENT =
	/timed out|timeout|rate.?limit|usage limit|hit your (?:\w+ )?limit|(?:session|weekly|opus) limit|out of (?:extra )?usage|too many requests|overloaded|\b(?:429|500|502|503|504|529)\b|could not reach|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|without a result|produced no result/i

/**
 * Whether a judge failure is worth retrying later (timeout, rate limit, 5xx, network)
 * rather than a fault that will repeat (no login, bad request, refusal).
 */
export const isTransientError = (message: string) => !PERMANENT.test(message) && TRANSIENT.test(message)
