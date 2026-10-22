// `look4 scan`: ingest (copy) files, run the cascade in this process, print what happened.

import { existsSync, statSync } from "node:fs"
import { glob, readdir } from "node:fs/promises"
import { basename, extname, join, resolve } from "node:path"
import type { AppContext } from "../context.ts"
import { verdictKeeps } from "../db.ts"
import { createLookout } from "../lookouts.ts"
import { processClip } from "../pipeline/process.ts"
import { VIDEO_EXTENSIONS } from "../sources/index.ts"
import type { Clip, Lookout, Verdict } from "../types.ts"
import { args, UsageError, withContext } from "./cli.ts"
import { c, cmd, err, out, table, usd } from "./ui.ts"

const VIDEO = new Set(VIDEO_EXTENSIONS)

const isVideo = (p: string) => VIDEO.has(extname(p).toLowerCase())

const walk = async (dir: string): Promise<string[]> => {
	const found: string[] = []
	for (const e of await readdir(dir, { withFileTypes: true })) {
		if (e.name.startsWith(".")) continue
		const p = join(dir, e.name)
		if (e.isDirectory()) found.push(...(await walk(p)))
		else if (e.isFile() && isVideo(p)) found.push(p)
	}
	return found
}

/** Files, directories (recursive, video extensions) and globs → absolute file paths, de-duplicated, in order. */
export const expandInputs = async (inputs: string[]): Promise<{ files: string[]; missing: string[] }> => {
	const files: string[] = []
	const missing: string[] = []
	for (const input of inputs) {
		const abs = resolve(input)
		if (existsSync(abs)) {
			if (statSync(abs).isDirectory()) files.push(...(await walk(abs)).sort())
			else files.push(abs)
			continue
		}
		const matched: string[] = []
		for await (const m of glob(input)) {
			const p = resolve(m)
			if (statSync(p).isFile() && isVideo(p)) matched.push(p)
		}
		if (matched.length) files.push(...matched.sort())
		else missing.push(input)
	}
	return { files: [...new Set(files)], missing }
}

/** Waits for the process working on `id`, and takes the clip over if that process dies meanwhile. */
const waitForOther = async (ctx: AppContext, id: string, pendingLookouts: string[] | null, timeoutMs = 600_000): Promise<Clip> => {
	const end = Date.now() + timeoutMs
	for (;;) {
		const clip = ctx.store.getClip(id)!
		if ((clip.status !== "pending" && clip.status !== "processing") || Date.now() > end) return clip
		const claimed = clip.status === "processing" ? ctx.store.claimClip(id, pendingLookouts) : null
		if (claimed) return processClip(ctx, claimed)
		await new Promise(r => setTimeout(r, 1000))
	}
}

type ScanRow = {
	file: string
	clipId: string | null
	status: string
	droppedAt: string | null
	duplicate: boolean
	matches: Array<{ lookout: string; label: string | null; confidence: number }>
	/** The best verdict when nothing matched (what the judge thought it was). */
	best: { lookout: string; label: string | null; confidence: number } | null
	reason: string | null
	costUsd: number
	timings: Record<string, number>
}

export const scanCmd = async (argv: string[]) => {
	const { values, positionals } = args(argv, { prompt: { type: "string" }, json: { type: "boolean" } })
	if (!positionals.length) throw new UsageError('look4 scan <files|dirs|globs…> [--prompt "<text>"] [--json]')
	const { files, missing } = await expandInputs(positionals)
	for (const m of missing) err(`${c.yellow("!")} nothing matched ${m}`)
	if (!files.length) {
		err(`${c.red("✗")} no video files to scan`)
		return 1
	}

	return withContext(async ctx => {
		let adhoc: Lookout | null = null
		if (values.prompt !== undefined) {
			const prompt = values.prompt.trim()
			if (!prompt) throw new UsageError("--prompt needs some text")
			// an ad-hoc lookout needs a row (verdicts reference it); reuse one with the same words, else save it disabled
			adhoc =
				ctx.store.listLookouts().find(l => l.prompt.toLowerCase() === prompt.toLowerCase()) ??
				(await createLookout(ctx, { prompt, enabled: false }))
		} else if (!ctx.store.listLookouts().some(l => l.enabled))
			throw new UsageError('no lookouts are enabled: add one (look4 lookout add "…") or pass --prompt "…"')

		const lookoutName = (id: string) => ctx.store.getLookout(id)?.name ?? id
		const started = new Date().toISOString()
		const rows: ScanRow[] = []
		const queue = [...files]
		const work = async () => {
			for (let file = queue.shift(); file; file = queue.shift()) {
				const row: ScanRow = { file, clipId: null, status: "error", droppedAt: null, duplicate: false, matches: [], best: null, reason: null, costUsd: 0, timings: {} }
				rows.push(row)
				try {
					const { clip, duplicate } = await ctx.ingest({ file, source: "scan", mode: "copy" })
					row.clipId = clip.id
					row.duplicate = duplicate
					if (!clip.path) throw new Error("already ingested once and its file has since been deleted by retention")
					// one conditional claim: a clip some live process (the server's worker, another scan loop
					// on the same bytes) is processing right now is waited for, never processed twice
					const wanted = adhoc ? [adhoc.id] : null
					const claimed = ctx.store.claimClip(clip.id, wanted)
					const done = claimed ? await processClip(ctx, claimed) : await waitForOther(ctx, clip.id, wanted)
					const verdicts = ctx.store.getVerdicts(done.id).filter(v => !adhoc || v.lookoutId === adhoc.id)
					const lookouts = new Map(ctx.store.listLookouts().map(l => [l.id, l]))
					const keeps = (v: Verdict) => {
						const l = lookouts.get(v.lookoutId)
						return !!l && verdictKeeps(v, l)
					}
					const view = (v: Verdict) => ({ lookout: lookoutName(v.lookoutId), label: v.label, confidence: v.confidence })
					row.status = adhoc ? (verdicts.some(keeps) ? "kept" : done.status === "error" ? "error" : "rejected") : done.status
					row.droppedAt = row.status === "rejected" ? (adhoc && !verdicts.length ? (done.droppedAt ?? "detect") : (done.droppedAt ?? "judge")) : null
					row.matches = verdicts.filter(keeps).map(view)
					row.best = verdicts[0] ? view(verdicts[0]) : null
					const own = adhoc ? verdicts[0] : undefined
					row.reason = own ? `${own.match ? "judge: yes" : "judge: no"}, ${own.rationale} (${own.confidence.toFixed(2)})` : done.reason
					row.timings = done.timings
					row.costUsd = ctx.store
						.getUsage(done.id)
						.filter(u => u.ts >= started)
						.reduce((s, u) => s + u.costUsd, 0)
				} catch (e) {
					row.reason = e instanceof Error ? e.message : String(e)
				}
				if (!values.json && process.stderr.isTTY) process.stderr.write(`\r  scanned ${rows.length}/${files.length}…`)
			}
		}
		await Promise.all(Array.from({ length: Math.min(ctx.config.pipeline.concurrency, files.length) }, work))
		if (!values.json && process.stderr.isTTY) process.stderr.write("\r\x1b[K")
		rows.sort((a, b) => files.indexOf(a.file) - files.indexOf(b.file))

		if (values.json) out(JSON.stringify(rows, null, "\t"))
		else {
			const colored = (s: string) => (s === "kept" ? c.green(s) : s === "error" ? c.red(s) : c.dim(s))
			table(
				["file", "result", "lookout", "label", "confidence", "reason", "cost"],
				rows.map(r => {
					const top = r.matches[0] ?? r.best
					return [
						basename(r.file),
						colored(r.droppedAt ? `${r.status} @${r.droppedAt}` : r.status) + (r.duplicate ? c.dim(" (dup)") : ""),
						r.matches.map(m => m.lookout).join(", ") || (top ? c.dim(top.lookout) : ""),
						top?.label ?? "",
						top ? top.confidence.toFixed(2) : "",
						r.reason ?? "",
						usd(r.costUsd)
					]
				}),
				{ 0: 36, 5: 70 }
			)
			const kept = rows.filter(r => r.status === "kept").length
			out(c.dim(`\n${kept} of ${rows.length} kept · ${usd(rows.reduce((s, r) => s + r.costUsd, 0))} spotter spend`))
			if (adhoc && !adhoc.enabled)
				out(c.dim(`saved as disabled lookout "${adhoc.name}"; watch for it from now on with: ${cmd(`lookout enable ${adhoc.name}`)}`))
		}
		return rows.some(r => r.status === "error") ? 1 : 0
	})
}
