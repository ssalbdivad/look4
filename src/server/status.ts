// Pipeline component health, shared by /api/stats and /api/setup.

import type { ComponentStatus, StatsResponse } from "../api-types.ts"
import type { AppContext } from "../context.ts"
import type { VisionLLM } from "../llm/types.ts"

const CHECK_TTL_MS = 30_000

export const createStatusChecks = (ctx: AppContext) => {
	/** The last check, for the backend it checked: saving an API key swaps `ctx.llm`, and the old answer must not stick. */
	let cached: { llm: VisionLLM; at: number; value: Promise<ComponentStatus> } | null = null

	const judgeCheck = (llm: VisionLLM): Promise<ComponentStatus> => {
		if (cached?.llm === llm && Date.now() - cached.at <= CHECK_TTL_MS) return cached.value
		const value = llm.check().catch((e: unknown) => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }))
		cached = { llm, at: Date.now(), value }
		return value
	}

	const judgeStatus = async (): Promise<StatsResponse["pipeline"]["judge"]> => {
		const llm = ctx.llm
		if (!llm) {
			// createLlm already said why there is no backend ("judge is off", "no API key and no claude CLI", …)
			return {
				ok: ctx.config.pipeline.judge.provider === "none",
				detail: ctx.judge.detail,
				provider: ctx.judge.provider,
				model: ctx.config.pipeline.judge.model
			}
		}
		const check = await judgeCheck(llm)
		return { ok: check.ok, detail: check.ok ? ctx.judge.detail : check.detail, provider: ctx.judge.provider, model: llm.model }
	}

	const detectorStatus = (): StatsResponse["pipeline"]["detector"] => {
		const det = ctx.detector.status()
		return { ok: !det.enabled || det.ready, detail: det.detail, enabled: det.enabled, model: det.model }
	}

	return { judgeStatus, detectorStatus }
}

export type StatusChecks = ReturnType<typeof createStatusChecks>
