// Command dispatch for `look4`. Exit codes: 0 ok, 1 failure, 2 usage error.

import { parseArgs, type ParseArgsConfig } from "node:util"
import { createContext } from "../app.ts"
import { ConfigError, loadConfig } from "../config.ts"
import type { AppContext } from "../context.ts"
import { runEval } from "../eval.ts"
import { backfill, createLookout, deleteLookout, LookoutError, updateLookout } from "../lookouts.ts"
import { sweep } from "../retention.ts"
import { bytes, c, cmd, err, out, parseSince, pct, table, usd } from "./ui.ts"

export class UsageError extends Error {}

const USAGE = [
	'init [--reolink <host>] [--user admin] [--watch <dir>] [--rtsp <url>] [--lookout "<prompt>"]',
	"start [--no-sources] [--port N] [--no-open]   sources + worker + web UI",
	'scan <files|dirs|globs…> [--prompt "<text>"] [--json]',
	"lookout list",
	'lookout add "<prompt>" [--name n] [--threshold 0.6]',
	"lookout rm|enable|disable <name>",
	"lookout backfill <name> [--since 7d]",
	'compile "<prompt>" [--json]           show detector nouns + spotter checklist',
	"eval [--lookout name] [--no-rerun] [--json]",
	"doctor                                check ffmpeg, detector, spotter, sources, disk",
	"clean                                 run retention now"
]

/** Spelled the way look4 was invoked (`pnpm look4 …` from a package script), so each line works when pasted. */
export const help = () => `${c.bold("look4")} — keeps the camera clips you describe in plain English

${c.bold("Usage")}
${USAGE.map(u => `  ${cmd(u)}`).join("\n")}

Config: ./look4.config.json (or LOOK4_CONFIG); secrets in ./.env`

/** parseArgs with usage errors turned into `UsageError`. */
export const args = <o extends NonNullable<ParseArgsConfig["options"]>>(argv: string[], options: o, positionals = true) => {
	try {
		return parseArgs({ args: argv, options, allowPositionals: positionals, strict: true })
	} catch (e) {
		throw new UsageError(e instanceof Error ? e.message : String(e))
	}
}

export const openContext = async () => createContext(loadConfig())

export const withContext = async <t>(fn: (ctx: AppContext) => Promise<t>): Promise<t> => {
	const ctx = await openContext()
	try {
		return await fn(ctx)
	} finally {
		ctx.store.close()
	}
}

const threshold = (raw: string | undefined) => {
	if (raw === undefined) return undefined
	const n = Number(raw)
	if (!Number.isFinite(n) || n < 0 || n > 1) throw new UsageError(`--threshold must be a number from 0 to 1 (got "${raw}")`)
	return n
}

const compileCmd = async (argv: string[]) => {
	const { values, positionals } = args(argv, { json: { type: "boolean" } })
	const prompt = positionals.join(" ").trim()
	if (!prompt) throw new UsageError(cmd('compile "<prompt>"'))
	return withContext(async ctx => {
		const compiled = await ctx.compile(prompt)
		if (values.json) {
			out(JSON.stringify(compiled, null, "\t"))
			return 0
		}
		out(c.bold(compiled.summary))
		out(`  detector looks for  ${c.cyan(compiled.queries.join(", "))}`)
		out(`  fine-grained        ${compiled.fineGrained ? "yes (the spotter gets bigger close-ups)" : "no"}`)
		out(`  compiled by         ${compiled.compiler}`)
		out(`  spotter checks`)
		for (const line of compiled.rubric.split("\n")) out(`    ${line}`)
		return 0
	})
}

const lookoutCmd = async (argv: string[]) => {
	const [sub, ...rest] = argv
	const one = (list: string[], usage: string) => {
		const [name, extra] = list
		if (!name || extra !== undefined) throw new UsageError(usage)
		return name
	}
	switch (sub) {
		case "list":
		case "ls":
		case undefined: {
			args(rest, {}, false)
			return withContext(async ctx => {
				const list = ctx.store.listLookouts()
				if (!list.length) {
					out(`No lookouts yet. Add one: ${c.cyan(cmd('lookout add "a cardinal at the feeder"'))}`)
					return 0
				}
				table(
					["name", "on", "threshold", "looks for", "prompt"],
					list.map(l => [
						c.bold(l.name),
						l.enabled ? c.green("yes") : c.dim("no"),
						l.threshold.toFixed(2),
						l.compiled?.queries.join(", ") ?? c.dim("(not compiled)"),
						l.prompt
					]),
					{ 4: 60 }
				)
				return 0
			})
		}
		case "add": {
			const { values, positionals } = args(rest, { name: { type: "string" }, threshold: { type: "string" } })
			const prompt = positionals.join(" ").trim()
			if (!prompt) throw new UsageError(cmd('lookout add "<prompt>" [--name n] [--threshold 0.6]'))
			const t = threshold(values.threshold)
			return withContext(async ctx => {
				const l = await createLookout(ctx, { prompt, name: values.name, threshold: t })
				out(`${c.green("✓")} added ${c.bold(l.name)}: ${l.compiled?.summary ?? prompt}`)
				out(`  looks for ${c.cyan(l.compiled?.queries.join(", ") ?? "?")}, keeps at confidence ≥ ${l.threshold}`)
				out(c.dim(`  re-check clips already on disk: ${cmd(`lookout backfill ${l.name}`)}`))
				return 0
			})
		}
		case "rm":
		case "remove": {
			const name = one(args(rest, {}).positionals, cmd("lookout rm <name>"))
			return withContext(async ctx => {
				deleteLookout(ctx, name)
				out(`${c.green("✓")} removed ${name}`)
				return 0
			})
		}
		case "enable":
		case "disable": {
			const name = one(args(rest, {}).positionals, cmd(`lookout ${sub} <name>`))
			return withContext(async ctx => {
				const l = await updateLookout(ctx, name, { enabled: sub === "enable" })
				out(`${c.green("✓")} ${l.name} ${l.enabled ? "enabled" : "disabled"}`)
				return 0
			})
		}
		case "backfill": {
			const { values, positionals } = args(rest, { since: { type: "string" } })
			const name = one(positionals, cmd("lookout backfill <name> [--since 7d]"))
			const since = values.since === undefined ? undefined : parseSince(values.since)
			if (since === null) throw new UsageError(`--since takes 30m, 12h, 7d, 2w or a date (got "${values.since}")`)
			return withContext(async ctx => {
				const n = backfill(ctx, name, since)
				out(`${c.green("✓")} queued ${n} clip${n === 1 ? "" : "s"} for ${name}`)
				if (n) out(c.dim(`  a running \`${cmd("start")}\` works through them; check the web UI`))
				return 0
			})
		}
		default:
			throw new UsageError(`unknown lookout command "${sub}"`)
	}
}

const evalCmd = async (argv: string[]) => {
	const { values } = args(argv, { lookout: { type: "string" }, "no-rerun": { type: "boolean" }, json: { type: "boolean" } }, false)
	return withContext(async ctx => {
		const rerun = !values["no-rerun"]
		const tty = process.stderr.isTTY && !values.json
		const report = await runEval(ctx, {
			lookout: values.lookout,
			rerun,
			onProgress: tty ? (d, n) => process.stderr.write(`\r  re-running the cascade ${d}/${n}…`) : undefined
		})
		if (tty) process.stderr.write("\r\x1b[K")
		if (values.json) {
			out(JSON.stringify(report, null, "\t"))
			return 0
		}
		const withLabels = report.lookouts.filter(r => r.labeled || r.skipped)
		if (!withLabels.length) {
			out("No labeled clips yet. Thumb sightings up or down in the web UI, or mark rejects as “should have matched”.")
			return 0
		}
		out(c.dim(`${rerun ? "re-ran every check with the current config" : "from stored verdicts"} on ${report.clips} labeled clip${report.clips === 1 ? "" : "s"}`))
		table(
			["lookout", "labeled", "tp", "fp", "fn", "tn", "precision", "recall", "f1", "cost"],
			withLabels.map(r => [c.bold(r.name), String(r.labeled), String(r.tp), String(r.fp), String(r.fn), String(r.tn), pct(r.precision), pct(r.recall), pct(r.f1), usd(r.costUsd)])
		)
		for (const r of withLabels) {
			for (const m of r.falseNegatives) out(`  ${c.red("missed")} ${r.name} ${m.clipId} at ${m.droppedAt ?? "?"}: ${c.dim(m.reason ?? "")}`)
			for (const m of r.falsePositives) out(`  ${c.yellow("false hit")} ${r.name} ${m.clipId}: ${c.dim(m.reason ?? "")}`)
			if (r.skipped) out(c.dim(`  ${r.name}: ${r.skipped} labeled clip${r.skipped === 1 ? "" : "s"} skipped (file gone)`))
		}
		return 0
	})
}

const cleanCmd = async (argv: string[]) => {
	args(argv, {}, false)
	return withContext(async ctx => {
		const { deleted, freedBytes } = sweep(ctx)
		out(`${c.green("✓")} deleted ${deleted} expired clip${deleted === 1 ? "" : "s"}, freed ${bytes(freedBytes)}`)
		return 0
	})
}

export const main = async (argv: string[]): Promise<number> => {
	const [cmd, ...rest] = argv
	// one-shot commands print their own results; per-clip info logs would just repeat them
	if (cmd !== "start") process.env.LOOK4_LOG ??= "warn"
	try {
		switch (cmd) {
			case "init":
				return await (await import("./init.ts")).initCmd(rest)
			case "start":
				return await (await import("./start.ts")).startCmd(rest)
			case "scan":
				return await (await import("./scan.ts")).scanCmd(rest)
			case "lookout":
			case "lookouts":
				return await lookoutCmd(rest)
			case "compile":
				return await compileCmd(rest)
			case "eval":
				return await evalCmd(rest)
			case "doctor":
				return await (await import("./doctor.ts")).doctorCmd(rest)
			case "clean":
				return await cleanCmd(rest)
			case undefined:
			case "help":
			case "-h":
			case "--help":
				out(help())
				return cmd === undefined ? 2 : 0
			case "-v":
			case "--version":
				out((await import("../../package.json", { with: { type: "json" } })).default.version)
				return 0
			default:
				throw new UsageError(`unknown command "${cmd}"`)
		}
	} catch (e) {
		if (e instanceof UsageError) {
			err(`${c.red("usage:")} ${e.message}\n`)
			err(help())
			return 2
		}
		// Ctrl-C / Ctrl-D at an interactive prompt
		if (e instanceof Error && (e.name === "AbortError" || e.message === "cancelled")) {
			err(c.dim("cancelled"))
			return 1
		}
		if (e instanceof ConfigError || e instanceof LookoutError) {
			err(`${c.red("✗")} ${e.message}`)
			return 1
		}
		err(`${c.red("✗")} ${e instanceof Error ? (process.env.LOOK4_LOG === "debug" ? (e.stack ?? e.message) : e.message) : String(e)}`)
		return 1
	}
}
