// Judge backend that shells out to the Claude Code CLI, so look4 works with a Claude
// subscription login and no API key.
//
// One `claude -p` process per request, isolated from the user's own Claude Code setup:
// --safe-mode (no CLAUDE.md, hooks, plugins, skills, MCP, auto-memory), no settings
// files, an empty MCP config, no tools, no session on disk, our own system prompt.
// Images go inline as base64 blocks over `--input-format stream-json`, so the answer
// takes one model call; the alternative (write files, let the model call Read) costs
// a turn per image and needs a tool permission surface.

import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { accessSync, constants, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { estimateCostUsd, canonicalModel } from "../pricing.ts"
import { logger } from "../log.ts"
import type { Usage } from "../types.ts"
import type { LlmRequest, LlmResult, VisionLLM } from "./types.ts"
import { modelTraits } from "./models.ts"
import { LlmError } from "./errors.ts"

const log = logger("claude-code")

/** The native installer's location, which a service manager, tmux or desktop launcher often leaves off PATH. */
const INSTALLED_BIN = join(homedir(), ".local", "bin", "claude")

const executable = (p: string) => {
	try {
		accessSync(p, constants.X_OK)
		return true
	} catch {
		return false
	}
}

const onPath = (bin: string) => (process.env.PATH ?? "").split(delimiter).some(dir => dir && executable(join(dir, bin)))

export const CLAUDE_BIN = process.env.LOOK4_CLAUDE_BIN ?? (!onPath("claude") && executable(INSTALLED_BIN) ? INSTALLED_BIN : "claude")

/** Variables that would make the child think it is nested inside another Claude Code or ntwine session. */
const NESTED = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_.*|NTWINE_.*|AI_AGENT)$/
/** Auth and provider selection the child still needs. */
const KEEP = /^CLAUDE_CODE_(OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY|SKIP_.*_AUTH)$/

export const claudeCodeEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
	const out: NodeJS.ProcessEnv = {}
	for (const [k, v] of Object.entries(env)) if (!NESTED.test(k) || KEEP.test(k)) out[k] = v
	return out
}

/** CLI flags for one request. Aliases are resolved first: the CLI's own `haiku` still means Haiku 4.5. */
export const claudeCodeArgs = (req: LlmRequest, defaultModel: string): string[] => {
	const model = canonicalModel(req.model ?? defaultModel)
	const traits = modelTraits(model)
	return [
		"-p",
		"--safe-mode",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--verbose",
		"--model", model,
		"--tools", "",
		"--setting-sources", "",
		"--strict-mcp-config",
		"--mcp-config", '{"mcpServers":{}}',
		"--no-session-persistence",
		"--disable-slash-commands",
		"--system-prompt", req.system,
		"--json-schema", JSON.stringify(req.schema),
		// models that cannot stop thinking would 400 on a disabled-thinking request
		...(traits.thinksAnyway ? [] : ["--settings", '{"alwaysThinkingEnabled":false}']),
		...(traits.effort ? ["--effort", "low"] : [])
	]
}

/** The single stream-json user message: images first, then the text. */
export const claudeCodeInput = (req: LlmRequest) =>
	JSON.stringify({
		type: "user",
		message: {
			role: "user",
			content: [
				...req.images.map(img => ({
					type: "image",
					source: { type: "base64", media_type: img.mediaType, data: img.data.toString("base64") }
				})),
				{ type: "text", text: req.text }
			]
		}
	}) + "\n"

type ModelUsage = { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }
type ResultLine = {
	type: "result"
	is_error?: boolean
	subtype?: string
	result?: string
	structured_output?: unknown
	modelUsage?: Record<string, ModelUsage>
	usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
	total_cost_usd?: number
}

/** Reads the CLI's stream-json stdout. Exported for tests. */
export const parseClaudeCodeOutput = (stdout: string, req: LlmRequest, requestedModel: string): LlmResult => {
	let result: ResultLine | null = null
	for (const line of stdout.split("\n")) {
		if (!line.startsWith("{")) continue
		try {
			const obj = JSON.parse(line) as { type?: string }
			if (obj.type === "result") result = obj as ResultLine
		} catch {}
	}
	if (!result) throw new LlmError("Claude Code produced no result")
	const text = result.result ?? ""
	const usage = resultUsage(result, req, requestedModel)
	// a failed call that still consumed tokens was billed (or counted against the subscription)
	const billed = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens > 0 ? usage : null
	if (result.is_error) {
		if (/not logged in|\/login/i.test(text))
			throw new LlmError("Claude Code is not logged in: run `claude` once and sign in (or set ANTHROPIC_API_KEY)")
		throw new LlmError(`Claude Code error (${result.subtype ?? "unknown"}): ${text.slice(0, 300)}`, { usage: billed })
	}
	let json = result.structured_output
	if (json === undefined) {
		try {
			json = JSON.parse(text)
		} catch {
			throw new LlmError(`Claude Code did not return JSON: ${text.slice(0, 200)}`, { usage: billed })
		}
	}
	return { json, raw: text, usage }
}

// Cost is what the same tokens would bill on the API. A subscription does not bill per
// call; we still show it so the UI's cost view means the same thing on every backend.
// Claude Code writes its prompt cache with the 1-hour TTL, hence cacheWrite1hTokens.
const resultUsage = (result: ResultLine, req: LlmRequest, requestedModel: string): Usage => {
	const per = Object.entries(result.modelUsage ?? {})
	const entries: Array<[string, ModelUsage]> = per.length
		? per
		: [[requestedModel, {
				inputTokens: result.usage?.input_tokens,
				outputTokens: result.usage?.output_tokens,
				cacheReadInputTokens: result.usage?.cache_read_input_tokens,
				cacheCreationInputTokens: result.usage?.cache_creation_input_tokens
			}]]
	let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, costUsd = 0
	for (const [m, u] of entries) {
		const counts = {
			inputTokens: u.inputTokens ?? 0,
			outputTokens: u.outputTokens ?? 0,
			cacheReadTokens: u.cacheReadInputTokens ?? 0,
			cacheWrite1hTokens: u.cacheCreationInputTokens ?? 0
		}
		inputTokens += counts.inputTokens + counts.cacheWrite1hTokens
		outputTokens += counts.outputTokens
		cacheReadTokens += counts.cacheReadTokens
		costUsd += estimateCostUsd(m, counts)
	}
	return {
		ts: new Date().toISOString(),
		clipId: req.clipId,
		purpose: req.purpose,
		backend: "claude-code",
		model: canonicalModel(entries[0]![0]),
		inputTokens,
		outputTokens,
		cacheReadTokens,
		costUsd
	}
}

type Exec = { code: number | null; stdout: string; stderr: string }

const exec = (bin: string, args: string[], opts: { input?: string; cwd?: string; timeoutMs: number }): Promise<Exec> =>
	new Promise((resolve, reject) => {
		const child = spawn(bin, args, {
			cwd: opts.cwd,
			env: claudeCodeEnv(process.env),
			stdio: ["pipe", "pipe", "pipe"],
			signal: AbortSignal.timeout(opts.timeoutMs)
		})
		let stdout = ""
		let stderr = ""
		child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d))
		child.stderr.setEncoding("utf8").on("data", (d: string) => {
			stderr += d
			if (stderr.length > 20_000) stderr = stderr.slice(-10_000)
		})
		child.on("error", (e: NodeJS.ErrnoException) => {
			if (e.code === "ENOENT") reject(new LlmError(`Claude Code CLI (\`${bin}\`) is not on PATH; install it or set ANTHROPIC_API_KEY`))
			else if (e.name === "AbortError") reject(new LlmError(`Claude Code timed out after ${opts.timeoutMs / 1000}s`))
			else reject(e)
		})
		child.on("close", code => resolve({ code, stdout, stderr }))
		child.stdin.on("error", () => {}) // the CLI may exit before reading everything; close reports it
		child.stdin.end(opts.input ?? "")
	})

/** A tiny FIFO semaphore: the CLI is heavy (a Node process per call) and a subscription has rate limits. */
const limiter = (max: number) => {
	let active = 0
	const waiting: Array<() => void> = []
	return async <t>(fn: () => Promise<t>): Promise<t> => {
		if (active >= max) await new Promise<void>(r => waiting.push(r))
		active++
		try {
			return await fn()
		} finally {
			active--
			waiting.shift()?.()
		}
	}
}

export const createClaudeCodeLlm = (opts: {
	model: string
	tmpDir: string
	bin?: string
	timeoutMs?: number
	concurrency?: number
}): VisionLLM => {
	const bin = opts.bin ?? CLAUDE_BIN
	const timeoutMs = opts.timeoutMs ?? 120_000
	const limit = limiter(opts.concurrency ?? 2)
	return {
		backend: "claude-code",
		model: canonicalModel(opts.model),
		check: async () => {
			try {
				const r = await exec(bin, ["auth", "status"], { timeoutMs: 15_000 })
				const status = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string }
				return status.loggedIn
					? { ok: true, detail: `Claude Code is logged in (${status.authMethod ?? "unknown method"})` }
					: { ok: false, detail: "Claude Code is installed but not logged in: run `claude` and sign in" }
			} catch (e) {
				return { ok: false, detail: e instanceof Error ? e.message : String(e) }
			}
		},
		complete: req =>
			limit(async () => {
				mkdirSync(opts.tmpDir, { recursive: true })
				// an empty per-call cwd, so nothing project-specific (CLAUDE.md, .mcp.json) is in reach
				const cwd = await mkdtemp(join(opts.tmpDir, "claude-"))
				const started = Date.now()
				try {
					const r = await exec(bin, claudeCodeArgs(req, opts.model), { input: claudeCodeInput(req), cwd, timeoutMs })
					try {
						const out = parseClaudeCodeOutput(r.stdout, req, canonicalModel(req.model ?? opts.model))
						log.debug(`${req.purpose} ${out.usage.model} in ${Date.now() - started}ms`, {
							in: out.usage.inputTokens,
							out: out.usage.outputTokens,
							cached: out.usage.cacheReadTokens
						})
						return out
					} catch (e) {
						if (e instanceof LlmError && e.message === "Claude Code produced no result") {
							const tail = r.stderr.trim().split("\n").slice(-3).join(" | ")
							throw new LlmError(`Claude Code exited ${r.code} without a result${tail ? `: ${tail}` : ""}`)
						}
						throw e
					}
				} finally {
					await rm(cwd, { recursive: true, force: true })
				}
			})
	}
}
