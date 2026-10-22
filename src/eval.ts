// Precision/recall per lookout against human labels. With `rerun`, the cascade
// is dry-run on every labeled clip with the CURRENT config (no DB writes, no
// file moves), so a threshold or model change can be measured before it ships.

import { existsSync } from "node:fs"
import type { AppContext } from "./context.ts"
import { ensureCompiled, keepingVerdicts, runCascade, StageError } from "./pipeline/process.ts"
import type { Clip, Label, Lookout, Stage, Verdict } from "./types.ts"

export type EvalMiss = {
	clipId: string
	/** The stage that dropped it ("error" when the cascade failed on it). */
	droppedAt: Stage | "error" | null
	reason: string | null
}

export type EvalLookoutReport = {
	lookoutId: string
	name: string
	/** Labeled clips evaluated (files missing are skipped when re-running). */
	labeled: number
	tp: number
	fp: number
	fn: number
	tn: number
	/** Null when nothing was predicted positive. */
	precision: number | null
	/** Null when no clip is labeled positive. */
	recall: number | null
	/** Null when precision or recall is undefined. */
	f1: number | null
	/** Judge spend attributed to this lookout (a shared call is split evenly). */
	costUsd: number
	falseNegatives: EvalMiss[]
	falsePositives: EvalMiss[]
	/** Labeled clips whose file no longer exists (re-run only). */
	skipped: number
}

export type EvalReport = {
	rerun: boolean
	generatedAt: string
	clips: number
	costUsd: number
	lookouts: EvalLookoutReport[]
}

type Prediction = { positive: boolean; droppedAt: EvalMiss["droppedAt"]; reason: string | null; costUsd: number }

const ratio = (num: number, den: number) => (den === 0 ? null : num / den)

export const metrics = (c: { tp: number; fp: number; fn: number }) => {
	const precision = ratio(c.tp, c.tp + c.fp)
	const recall = ratio(c.tp, c.tp + c.fn)
	const f1 = precision === null || recall === null ? null : precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
	return { precision, recall, f1 }
}

const describe = (v: Verdict | undefined, l: Lookout) =>
	v ? `${v.match ? "match" : "no match"} ${v.confidence.toFixed(2)} (threshold ${l.threshold.toFixed(2)}): ${v.rationale}` : null

/** Predictions from what the pipeline already recorded. */
const storedPredictions = (ctx: AppContext, clip: Clip, lookouts: Lookout[]) => {
	const verdicts = ctx.store.getVerdicts(clip.id)
	const byId = new Map(lookouts.map(l => [l.id, l]))
	const keeping = new Set(keepingVerdicts(verdicts, byId).map(v => v.lookoutId))
	const judgeCost = ctx.store.getUsage(clip.id).filter(u => u.purpose === "judge").reduce((s, u) => s + u.costUsd, 0)
	const share = judgeCost / Math.max(1, verdicts.length)
	const out = new Map<string, Prediction>()
	for (const l of lookouts) {
		const v = verdicts.find(x => x.lookoutId === l.id)
		out.set(l.id, {
			positive: keeping.has(l.id),
			droppedAt: v ? "judge" : clip.status === "error" ? "error" : clip.droppedAt,
			reason: describe(v, l) ?? clip.reason,
			costUsd: v ? share : 0
		})
	}
	return out
}

/** Predictions from a fresh dry run of the cascade. */
const rerunPredictions = async (ctx: AppContext, clip: Clip, lookouts: Lookout[]) => {
	const out = new Map<string, Prediction>()
	try {
		const run = await runCascade(ctx, clip, lookouts)
		const byId = new Map(lookouts.map(l => [l.id, l]))
		const keeping = new Set(keepingVerdicts(run.verdicts, byId).map(v => v.lookoutId))
		const cost = run.usage.reduce((s, u) => s + u.costUsd, 0)
		for (const l of lookouts) {
			const v = run.verdicts.find(x => x.lookoutId === l.id)
			out.set(l.id, {
				positive: keeping.has(l.id),
				droppedAt: v ? "judge" : (run.droppedAt ?? "detect"),
				reason: describe(v, l) ?? run.dropReason,
				costUsd: v ? cost / Math.max(1, run.verdicts.length) : 0
			})
		}
	} catch (e) {
		const reason = e instanceof StageError ? `failed at ${e.stage}: ${e.message}` : String(e)
		for (const l of lookouts) out.set(l.id, { positive: false, droppedAt: "error", reason, costUsd: 0 })
	}
	return out
}

export const runEval = async (
	ctx: AppContext,
	opts: { lookout?: string; rerun: boolean; onProgress?: (done: number, total: number) => void }
): Promise<EvalReport> => {
	let lookouts = ctx.store.listLookouts()
	if (opts.lookout) {
		const l = ctx.store.getLookout(opts.lookout)
		if (!l) throw new Error(`no lookout "${opts.lookout}"`)
		lookouts = [l]
	}
	// the current prompt's compiled form is what a re-run should measure; it is cached for real runs too
	if (opts.rerun) lookouts = await ensureCompiled(ctx, lookouts, true)
	const byId = new Map(lookouts.map(l => [l.id, l]))

	const labelsByClip = new Map<string, Label[]>()
	for (const label of ctx.store.getLabels()) {
		if (!byId.has(label.lookoutId)) continue
		const list = labelsByClip.get(label.clipId) ?? []
		list.push(label)
		labelsByClip.set(label.clipId, list)
	}

	const reports = new Map<string, EvalLookoutReport>(
		lookouts.map(l => [
			l.id,
			{ lookoutId: l.id, name: l.name, labeled: 0, tp: 0, fp: 0, fn: 0, tn: 0, precision: null, recall: null, f1: null, costUsd: 0, falseNegatives: [], falsePositives: [], skipped: 0 }
		])
	)

	let done = 0
	let evaluated = 0
	for (const [clipId, labels] of labelsByClip) {
		const clip = ctx.store.getClip(clipId)
		const inPlay = labels.map(x => byId.get(x.lookoutId)!)
		if (!clip || (opts.rerun && !(clip.path && existsSync(clip.path)))) {
			for (const l of inPlay) reports.get(l.id)!.skipped++
		} else {
			evaluated++
			const preds = opts.rerun ? await rerunPredictions(ctx, clip, inPlay) : storedPredictions(ctx, clip, inPlay)
			for (const label of labels) {
				const r = reports.get(label.lookoutId)!
				const p = preds.get(label.lookoutId)!
				r.labeled++
				r.costUsd += p.costUsd
				const miss = { clipId, droppedAt: p.droppedAt, reason: p.reason }
				if (label.truth && p.positive) r.tp++
				else if (label.truth) {
					r.fn++
					r.falseNegatives.push(miss)
				} else if (p.positive) {
					r.fp++
					r.falsePositives.push({ ...miss, droppedAt: null })
				} else r.tn++
			}
		}
		opts.onProgress?.(++done, labelsByClip.size)
	}

	const out = [...reports.values()].map(r => ({ ...r, ...metrics(r) }))
	return {
		rerun: opts.rerun,
		generatedAt: new Date().toISOString(),
		clips: evaluated,
		costUsd: out.reduce((s, r) => s + r.costUsd, 0),
		lookouts: out
	}
}
