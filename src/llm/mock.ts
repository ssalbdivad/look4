// Deterministic offline backend for tests and `provider: "mock"`. Spends nothing.
//
// It reads the machine-parseable lines the real prompts already carry:
// - compile: `Prompt (JSON string): "<prompt>"` → the keyword fallback compiler's answer.
// - judge: `lookout id=<id> queries=["bird","squirrel"]` per lookout and
//   `crop <n>: label="bird" score=0.41` per crop. A lookout matches, at confidence 0.9,
//   when any crop's detector label is one of its queries; otherwise no match at 0.9.

import type { LlmRequest, LlmResult, VisionLLM } from "./types.ts"
import { keywordCompile } from "../pipeline/compile.ts"

const answer = (req: LlmRequest): unknown => {
	if (req.purpose === "compile") {
		const m = /^Prompt \(JSON string\): (.+)$/m.exec(req.text)
		const prompt = m ? (JSON.parse(m[1]!) as string) : req.text
		const { queries, rubric, summary, fineGrained, lifeList } = keywordCompile(prompt)
		return { rubric, queries, summary, fineGrained, lifeList }
	}
	const labels = new Set([...req.text.matchAll(/^crop \d+: label=("(?:[^"\\]|\\.)*")/gm)].map(m => JSON.parse(m[1]!) as string))
	const verdicts = [...req.text.matchAll(/^lookout id=(\S+) queries=(\[.*\])$/gm)].map(m => {
		const queries = JSON.parse(m[2]!) as string[]
		const hit = queries.find(q => labels.has(q))
		return {
			lookoutId: m[1]!,
			rationale: hit ? `mock: a crop was detected as "${hit}"` : "mock: no crop matches this lookout's detector nouns",
			label: hit ?? null,
			species: null,
			speciesConfidence: null,
			match: Boolean(hit),
			confidence: 0.9
		}
	})
	return { verdicts }
}

export const createMockLlm = (model = "mock"): VisionLLM => ({
	backend: "mock",
	model,
	check: async () => ({ ok: true, detail: "mock spotter (offline, deterministic)" }),
	complete: async (req): Promise<LlmResult> => {
		const json = answer(req)
		return {
			json,
			raw: JSON.stringify(json),
			usage: {
				ts: new Date().toISOString(),
				clipId: req.clipId,
				purpose: req.purpose,
				backend: "mock",
				model: req.model ?? model,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				costUsd: 0
			}
		}
	}
})
