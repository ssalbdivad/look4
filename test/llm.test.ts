import { test } from "node:test"
import assert from "node:assert/strict"
import type Anthropic from "@anthropic-ai/sdk"
import { buildAnthropicRequest, parseAnthropicResponse } from "../src/llm/anthropic.ts"
import { claudeCodeArgs, claudeCodeEnv, parseClaudeCodeOutput } from "../src/llm/claude-code.ts"
import { createLlm } from "../src/llm/index.ts"
import { LlmError, usageOf } from "../src/llm/errors.ts"
import type { LlmRequest } from "../src/llm/types.ts"
import { estimateCostUsd } from "../src/pricing.ts"

const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false }

const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
	purpose: "judge",
	clipId: "20261014-153012-a1b2c3",
	system: "SYSTEM",
	text: "TEXT",
	images: [
		{ mediaType: "image/jpeg", data: Buffer.from("crop0"), name: "crop-0.jpg" },
		{ mediaType: "image/png", data: Buffer.from("ctx"), name: "context.png" }
	],
	schema,
	...over
})

test("anthropic request: images before text, cached system, JSON schema, thinking off at low effort, no sampling params", () => {
	const body = buildAnthropicRequest(req())
	assert.deepEqual(body, {
		model: "claude-haiku-5-5",
		max_tokens: 2048,
		system: [{ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } }],
		messages: [
			{
				role: "user",
				content: [
					{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from("crop0").toString("base64") } },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("ctx").toString("base64") } },
					{ type: "text", text: "TEXT" }
				]
			}
		],
		output_config: { effort: "low", format: { type: "json_schema", schema } },
		thinking: { type: "disabled" }
	})
})

test("anthropic request: escalation models get the thinking setting each one accepts", () => {
	// Sonnet 5.5 400s on `disabled`; Opus 5.5 400s on any explicit off switch and needs room to think
	assert.deepEqual(buildAnthropicRequest(req({ model: "claude-sonnet-5-5" })).thinking, { type: "between_tools" })
	const opus = buildAnthropicRequest(req({ model: "claude-opus-5-5", maxTokens: 800 }))
	assert.equal("thinking" in opus, false)
	assert.equal(opus.max_tokens, 8192)
	// Haiku 4.5 rejects `effort`
	assert.deepEqual(buildAnthropicRequest(req({ model: "claude-haiku-4-5" })).output_config, { format: { type: "json_schema", schema } })
})

test("anthropic response: refusal and truncation are errors; cache writes count as input at the write premium", () => {
	const msg = (over: Partial<Anthropic.Message>) =>
		({
			model: "claude-haiku-5-5",
			stop_reason: "end_turn",
			content: [{ type: "text", text: '{"ok":true}' }],
			usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 4000 },
			...over
		}) as Anthropic.Message
	const out = parseAnthropicResponse(msg({}), req())
	assert.deepEqual(out.json, { ok: true })
	assert.equal(out.usage.inputTokens, 5000)
	assert.equal(out.usage.cacheReadTokens, 2000)
	// (1000 + 2000*0.1 + 4000*1.25) * 0.10/M + 100 * 0.50/M
	assert.equal(out.usage.costUsd, 0.00067)
	assert.throws(() => parseAnthropicResponse(msg({ stop_reason: "refusal" }), req()), /declined/)
	assert.throws(
		() => parseAnthropicResponse(msg({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"ok":' }] as never }), req()),
		// a truncated answer was still billed: the error carries what it cost
		(e: unknown) => /max_tokens/.test((e as Error).message) && usageOf(e)?.costUsd === 0.00067
	)
})

test("pricing: Haiku 5.5 base and >100K tiers, cache reads at 10%, aliases and dated ids", () => {
	assert.equal(estimateCostUsd("claude-haiku-5-5", { inputTokens: 100_000, outputTokens: 1_000_000, cacheReadTokens: 0 }), 0.51)
	assert.equal(estimateCostUsd("claude-haiku-5-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 50_000 }), 0.0005)
	// the whole request moves to the long-context tier once the prompt passes 100K
	assert.equal(estimateCostUsd("claude-haiku-5-5", { inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 0 }), 0.01)
	assert.equal(estimateCostUsd("claude-haiku-5-5", { inputTokens: 100_001, outputTokens: 0, cacheReadTokens: 0 }), 0.0500005)
	assert.equal(estimateCostUsd("sonnet", { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }), 2)
	assert.equal(estimateCostUsd("claude-haiku-4-5-20251001", { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0 }), 5)
	assert.equal(estimateCostUsd("gpt-9", { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0 }), 0)
})

test("claude-code args: resolves the `haiku` alias itself (the CLI maps it to Haiku 4.5) and runs isolated with no tools", () => {
	const args = claudeCodeArgs(req({ model: "haiku" }), "claude-haiku-5-5")
	const after = (flag: string) => args[args.indexOf(flag) + 1]
	assert.equal(after("--model"), "claude-haiku-5-5")
	assert.equal(after("--tools"), "")
	assert.equal(after("--setting-sources"), "")
	assert.equal(after("--json-schema"), JSON.stringify(schema))
	assert.equal(after("--system-prompt"), "SYSTEM")
	assert.equal(after("--settings"), '{"alwaysThinkingEnabled":false}')
	for (const flag of ["-p", "--safe-mode", "--strict-mcp-config", "--no-session-persistence"]) assert.ok(args.includes(flag), flag)
	// Opus 5.5 cannot turn thinking off, so the setting must not be sent
	assert.equal(claudeCodeArgs(req({ model: "opus" }), "claude-haiku-5-5").includes("--settings"), false)
})

test("claude-code env: drops nested-session and ntwine markers, keeps auth", () => {
	const env = claudeCodeEnv({
		PATH: "/usr/bin",
		HOME: "/home/x",
		CLAUDECODE: "1",
		CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
		CLAUDE_CODE_SESSION_ID: "abc",
		CLAUDE_CODE_OAUTH_TOKEN: "tok",
		CLAUDE_CONFIG_DIR: "/cfg",
		NTWINE_THREAD: "t",
		ANTHROPIC_API_KEY: "k"
	})
	assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/x", CLAUDE_CODE_OAUTH_TOKEN: "tok", CLAUDE_CONFIG_DIR: "/cfg", ANTHROPIC_API_KEY: "k" })
})

test("claude-code output: structured output with API-equivalent cost; not-logged-in becomes a clear error", () => {
	const ok = [
		'{"type":"system","subtype":"init"}',
		JSON.stringify({
			type: "result",
			is_error: false,
			result: '{"ok":true}',
			structured_output: { ok: true },
			modelUsage: { "claude-haiku-5-5": { inputTokens: 2, outputTokens: 80, cacheReadInputTokens: 0, cacheCreationInputTokens: 1536 } }
		})
	].join("\n")
	const out = parseClaudeCodeOutput(ok, req(), "claude-haiku-5-5")
	assert.deepEqual(out.json, { ok: true })
	assert.deepEqual(
		{ ...out.usage, ts: "" },
		{
			ts: "",
			clipId: "20261014-153012-a1b2c3",
			purpose: "judge",
			backend: "claude-code",
			model: "claude-haiku-5-5",
			inputTokens: 1538,
			outputTokens: 80,
			cacheReadTokens: 0,
			// (2 + 1536 * 2) * 0.10/M + 80 * 0.50/M: Claude Code writes the 1-hour cache
			costUsd: 0.0003474
		}
	)
	const notLoggedIn = JSON.stringify({ type: "result", is_error: true, subtype: "success", result: "Not logged in · Please run /login" })
	assert.throws(() => parseClaudeCodeOutput(notLoggedIn, req(), "claude-haiku-5-5"), (e: unknown) => e instanceof LlmError && /not logged in: run `claude`/.test(e.message))
	assert.throws(() => parseClaudeCodeOutput('{"type":"system"}', req(), "claude-haiku-5-5"), /no result/)
})

test("createLlm auto: API key wins, else Claude Code on PATH, else no judge", async () => {
	const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN, path: process.env.PATH }
	const cfg = { provider: "auto", model: "claude-haiku-5-5", escalateModel: null, escalateBelow: 0.6, confirmModel: null, maxCrops: 4, cropSize: 512 } as const
	try {
		delete process.env.ANTHROPIC_AUTH_TOKEN
		process.env.ANTHROPIC_API_KEY = "sk-test"
		const withKey = await createLlm(cfg, { tmpDir: "/tmp" })
		assert.deepEqual([withKey.provider, withKey.llm?.backend, withKey.detail], ["anthropic", "anthropic", "Claude Haiku 5.5 via API key"])
		delete process.env.ANTHROPIC_API_KEY
		process.env.PATH = ""
		const none = await createLlm(cfg, { tmpDir: "/tmp" })
		assert.deepEqual([none.provider, none.llm, none.detail], ["none", null, "No spotter: set ANTHROPIC_API_KEY or install Claude Code"])
	} finally {
		for (const [k, v] of [["ANTHROPIC_API_KEY", saved.key], ["ANTHROPIC_AUTH_TOKEN", saved.token], ["PATH", saved.path]] as const) {
			if (v === undefined) delete process.env[k]
			else process.env[k] = v
		}
	}
})

test("claude-code process failures: missing binary and a hung CLI become clear errors", async () => {
	const { mkdirSync, writeFileSync } = await import("node:fs")
	const { createClaudeCodeLlm } = await import("../src/llm/claude-code.ts")
	const dir = new URL("./.tmp/llm-test/", import.meta.url).pathname
	mkdirSync(dir, { recursive: true })
	const missing = createClaudeCodeLlm({ model: "haiku", tmpDir: dir, bin: "look4-no-such-claude" })
	await assert.rejects(missing.complete(req()), /`look4-no-such-claude`\) is not on PATH/)
	assert.deepEqual(await missing.check(), { ok: false, detail: "Claude Code CLI (`look4-no-such-claude`) is not on PATH; install it or set ANTHROPIC_API_KEY" })
	const slow = `${dir}slow-claude.sh`
	writeFileSync(slow, "#!/bin/sh\nexec sleep 5\n", { mode: 0o755 })
	const hung = createClaudeCodeLlm({ model: "haiku", tmpDir: dir, bin: slow, timeoutMs: 200 })
	await assert.rejects(hung.complete(req()), /timed out after 0.2s/)
})
