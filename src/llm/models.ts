import { canonicalModel } from "../pricing.ts"

export type ThinkingMode =
	/** `thinking: { type: "disabled" }` is accepted (Haiku 5.5, Opus 5, Sonnet 5, Opus 4.7/4.8 — at effort high or below). */
	| "disabled"
	/** Sonnet 5.5 rejects `disabled`; `between_tools` is its thinking-off switch. */
	| "between_tools"
	/** Leave `thinking` out: Opus 5.5 / Fable cannot turn it off, and pre-4.6 models do not think unless asked. */
	| "omit"

export type ModelTraits = {
	thinking: ThinkingMode
	/** Accepts `output_config.effort` (Haiku 4.5 and Sonnet 4.5 reject it). */
	effort: boolean
	/** Thinking stays on, so the answer needs headroom beyond the JSON itself. */
	thinksAnyway: boolean
}

const TRAITS: Record<string, ModelTraits> = {
	"claude-haiku-5-5": { thinking: "disabled", effort: true, thinksAnyway: false },
	"claude-sonnet-5-5": { thinking: "between_tools", effort: true, thinksAnyway: false },
	"claude-opus-5-5": { thinking: "omit", effort: true, thinksAnyway: true },
	"claude-fable-5-1": { thinking: "omit", effort: true, thinksAnyway: true },
	"claude-fable-5": { thinking: "omit", effort: true, thinksAnyway: true },
	"claude-opus-5": { thinking: "disabled", effort: true, thinksAnyway: false },
	"claude-sonnet-5": { thinking: "disabled", effort: true, thinksAnyway: false },
	"claude-opus-4-8": { thinking: "disabled", effort: true, thinksAnyway: false },
	"claude-opus-4-7": { thinking: "disabled", effort: true, thinksAnyway: false },
	"claude-opus-4-6": { thinking: "omit", effort: true, thinksAnyway: false },
	"claude-sonnet-4-6": { thinking: "omit", effort: true, thinksAnyway: false },
	"claude-opus-4-5": { thinking: "omit", effort: true, thinksAnyway: false },
	"claude-sonnet-4-5": { thinking: "omit", effort: false, thinksAnyway: false },
	"claude-haiku-4-5": { thinking: "omit", effort: false, thinksAnyway: false }
}

/** Unknown (newer) models get the API defaults: nothing that could 400. */
const UNKNOWN: ModelTraits = { thinking: "omit", effort: false, thinksAnyway: true }

export const modelTraits = (model: string): ModelTraits => TRAITS[canonicalModel(model)] ?? UNKNOWN

/** "claude-haiku-5-5" → "Claude Haiku 5.5". */
export const displayName = (model: string) => {
	const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(canonicalModel(model))
	if (!m) return model
	const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1)
	return `Claude ${family} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}`
}
