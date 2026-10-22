// API list prices, USD per million tokens. Used to show what each call costs (or, for
// the claude-code backend, what it would cost on the API).

type Tier = { input: number; output: number }
type Price = Tier & {
	/** Prompts above this many tokens (input + cache reads + cache writes) bill the whole request at `long`. */
	long?: Tier & { above: number }
}

const PRICES: Record<string, Price> = {
	"claude-haiku-5-5": { input: 0.1, output: 0.5, long: { above: 100_000, input: 0.5, output: 2.5 } },
	"claude-sonnet-5-5": { input: 2, output: 10 },
	"claude-opus-5-5": { input: 4, output: 20 },
	"claude-fable-5-1": { input: 10, output: 50 },
	"claude-fable-5": { input: 10, output: 50 },
	"claude-opus-5": { input: 5, output: 25 },
	"claude-sonnet-5": { input: 2, output: 10 },
	"claude-opus-4-8": { input: 5, output: 25 },
	"claude-opus-4-7": { input: 5, output: 25 },
	"claude-opus-4-6": { input: 5, output: 25 },
	"claude-sonnet-4-6": { input: 3, output: 15 },
	"claude-opus-4-5": { input: 5, output: 25 },
	"claude-sonnet-4-5": { input: 3, output: 15 },
	"claude-haiku-4-5": { input: 1, output: 5 }
}

/** Short names people type (and Claude Code accepts), pinned to the current generation. */
const ALIASES: Record<string, string> = {
	haiku: "claude-haiku-5-5",
	sonnet: "claude-sonnet-5-5",
	opus: "claude-opus-5-5",
	fable: "claude-fable-5-1"
}

/**
 * Canonical model id: resolves aliases and drops a backend prefix ("anthropic:") and a
 * date suffix ("claude-haiku-4-5-20251001" → "claude-haiku-4-5").
 */
export const canonicalModel = (model: string) => {
	const bare = model.trim().replace(/^[a-z-]+:/, "").toLowerCase()
	return ALIASES[bare] ?? bare.replace(/-\d{8}$/, "")
}

export const priceFor = (model: string): Price | null => PRICES[canonicalModel(model)] ?? null

export type TokenCounts = {
	/** Uncached input tokens, NOT including cache writes. */
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	/** Tokens written to the 5-minute cache (billed at 1.25x input). */
	cacheWriteTokens?: number
	/** Tokens written to the 1-hour cache (billed at 2x input). Claude Code writes these. */
	cacheWrite1hTokens?: number
}

/** Estimated USD for one request. Unknown models cost 0 (we would rather show nothing than a wrong number). */
export const estimateCostUsd = (model: string, u: TokenCounts): number => {
	const price = priceFor(model)
	if (!price) return 0
	const write5m = u.cacheWriteTokens ?? 0
	const write1h = u.cacheWrite1hTokens ?? 0
	const prompt = u.inputTokens + u.cacheReadTokens + write5m + write1h
	const tier = price.long && prompt > price.long.above ? price.long : price
	const inputEquivalent = u.inputTokens + u.cacheReadTokens * 0.1 + write5m * 1.25 + write1h * 2
	// rounded to a billionth of a dollar so stored sums do not carry float noise
	return Math.round((inputEquivalent * tier.input + u.outputTokens * tier.output) * 1000) / 1e9
}
