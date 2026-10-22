import Anthropic from "@anthropic-ai/sdk"
import { estimateCostUsd } from "../pricing.ts"
import type { Usage } from "../types.ts"
import type { LlmRequest, LlmResult, VisionLLM } from "./types.ts"
import { modelTraits } from "./models.ts"
import { LlmError } from "./errors.ts"

export const DEFAULT_MODEL = "claude-haiku-5-5"

/**
 * The exact Messages API body for one request. Pure, so tests can pin its shape:
 * images before the text, the system prompt marked cacheable, JSON-schema output,
 * thinking off (or as low as the model allows) and NO sampling params, which
 * current models reject at non-default values.
 */
export const buildAnthropicRequest = (req: LlmRequest, defaultModel = DEFAULT_MODEL): Anthropic.MessageCreateParamsNonStreaming => {
	const model = req.model ?? defaultModel
	const traits = modelTraits(model)
	const content: Anthropic.ContentBlockParam[] = [
		...req.images.map((img): Anthropic.ImageBlockParam => ({
			type: "image",
			source: { type: "base64", media_type: img.mediaType, data: img.data.toString("base64") }
		})),
		{ type: "text", text: req.text }
	]
	const body: Anthropic.MessageCreateParamsNonStreaming = {
		model,
		// a verdict is a few hundred tokens; models that cannot stop thinking need room on top
		max_tokens: traits.thinksAnyway ? Math.max(req.maxTokens ?? 0, 8192) : (req.maxTokens ?? 2048),
		system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
		messages: [{ role: "user", content }],
		output_config: {
			...(traits.effort ? { effort: "low" as const } : {}),
			format: { type: "json_schema", schema: req.schema }
		}
	}
	if (traits.thinking === "disabled") body.thinking = { type: "disabled" }
	else if (traits.thinking === "between_tools") body.thinking = { type: "between_tools" }
	return body
}

const describeApiError = (e: unknown): string => {
	// most specific first; the SDK has already retried 429/5xx twice by the time these surface
	if (e instanceof Anthropic.AuthenticationError) return "Anthropic API rejected the credentials (check ANTHROPIC_API_KEY)"
	if (e instanceof Anthropic.PermissionDeniedError) return `Anthropic API: permission denied: ${e.message}`
	if (e instanceof Anthropic.RateLimitError) return "Anthropic API rate limit hit (after retries); try again shortly"
	if (e instanceof Anthropic.BadRequestError) return `Anthropic API rejected the request: ${e.message}`
	if (e instanceof Anthropic.APIConnectionError) return `could not reach the Anthropic API: ${e.message}`
	if (e instanceof Anthropic.APIError) return `Anthropic API error ${e.status ?? ""}: ${e.message}`.replace("  ", " ")
	return e instanceof Error ? e.message : String(e)
}

const usageOfMessage = (msg: Anthropic.Message, req: LlmRequest): Usage => {
	const u = msg.usage
	const write = u.cache_creation_input_tokens ?? 0
	const counts = {
		inputTokens: u.input_tokens,
		outputTokens: u.output_tokens,
		cacheReadTokens: u.cache_read_input_tokens ?? 0,
		cacheWriteTokens: write
	}
	return {
		ts: new Date().toISOString(),
		clipId: req.clipId,
		purpose: req.purpose,
		backend: "anthropic",
		model: msg.model,
		// Usage.inputTokens counts every uncached prompt token, cache writes included
		inputTokens: u.input_tokens + write,
		outputTokens: u.output_tokens,
		cacheReadTokens: counts.cacheReadTokens,
		costUsd: estimateCostUsd(msg.model, counts)
	}
}

/**
 * Turns a Messages API response into the backend-neutral result. Exported for tests.
 * An answer that is unusable was still billed, so its error carries the usage.
 */
export const parseAnthropicResponse = (msg: Anthropic.Message, req: LlmRequest): LlmResult => {
	const usage = usageOfMessage(msg, req)
	if (msg.stop_reason === "refusal") throw new LlmError("the model declined to answer (refusal)", { usage })
	const raw = msg.content.flatMap(b => (b.type === "text" ? [b.text] : [])).join("")
	if (msg.stop_reason === "max_tokens") throw new LlmError(`answer cut off at max_tokens: ${raw.slice(0, 200)}`, { usage })
	let json: unknown
	try {
		json = JSON.parse(raw)
	} catch {
		throw new LlmError(`model did not return JSON: ${raw.slice(0, 200)}`, { usage })
	}
	return { json, raw, usage }
}

export const createAnthropicLlm = (opts: { model?: string } = {}): VisionLLM => {
	const model = opts.model ?? DEFAULT_MODEL
	let client: Anthropic | null = null
	return {
		backend: "anthropic",
		model,
		check: async () => {
			if (process.env.ANTHROPIC_API_KEY) return { ok: true, detail: "ANTHROPIC_API_KEY is set" }
			if (process.env.ANTHROPIC_AUTH_TOKEN) return { ok: true, detail: "ANTHROPIC_AUTH_TOKEN is set" }
			return { ok: false, detail: "no ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in the environment (an `ant auth login` profile may still work)" }
		},
		complete: async req => {
			// constructed lazily so a missing key only fails the call, not app startup
			client ??= new Anthropic({ maxRetries: 2, timeout: 120_000 })
			let msg: Anthropic.Message
			try {
				msg = await client.messages.create(buildAnthropicRequest(req, model))
			} catch (e) {
				throw new LlmError(describeApiError(e), { cause: e })
			}
			return parseAnthropicResponse(msg, req)
		}
	}
}
