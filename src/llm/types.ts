import type { Usage, UsagePurpose } from "../types.ts"

export type LlmImage = {
	mediaType: "image/jpeg" | "image/png"
	data: Buffer
	/** Short file-safe name ("crop-0.jpg"); backends that read files from disk use it. */
	name: string
}

/** A JSON Schema whose root is an object. */
export type JsonSchema = Record<string, unknown>

export type LlmRequest = {
	purpose: UsagePurpose
	clipId: string | null
	/** Stable across calls, so it caches. Never put per-clip data here. */
	system: string
	/** The per-call part of the prompt. */
	text: string
	images: LlmImage[]
	/** The response must be JSON matching this schema. */
	schema: JsonSchema
	/** Overrides the backend's default model (used for escalation). */
	model?: string
	maxTokens?: number
}

export type LlmResult = {
	/** Parsed JSON. Callers still validate it with ArkType. */
	json: unknown
	usage: Usage
	/** Raw text, for logging when validation fails. */
	raw: string
}

export type LlmBackend = "anthropic" | "claude-code" | "mock"

export type VisionLLM = {
	backend: LlmBackend
	/** Default model id for this backend ("claude-haiku-5-5"). */
	model: string
	/** Cheap readiness check (credentials present, binary on PATH). Never spends tokens. */
	check(): Promise<{ ok: boolean; detail: string }>
	complete(req: LlmRequest): Promise<LlmResult>
}
