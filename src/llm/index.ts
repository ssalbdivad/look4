import { accessSync, constants } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"
import type { Config } from "../config.ts"
import type { VisionLLM } from "./types.ts"
import { createAnthropicLlm } from "./anthropic.ts"
import { CLAUDE_BIN, createClaudeCodeLlm } from "./claude-code.ts"
import { createMockLlm } from "./mock.ts"
import { displayName } from "./models.ts"

export { isTransientError, LlmError } from "./errors.ts"
export type { LlmBackend, LlmImage, LlmRequest, LlmResult, VisionLLM } from "./types.ts"

/** Whether `bin` resolves to an executable, the way a shell would find it. */
export const onPath = (bin: string, path = process.env.PATH ?? ""): boolean => {
	const executable = (p: string) => {
		try {
			accessSync(p, constants.X_OK)
			return true
		} catch {
			return false
		}
	}
	if (isAbsolute(bin)) return executable(bin)
	return path.split(delimiter).some(dir => dir && executable(join(dir, bin)))
}

const hasApiKey = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)

export const createLlm = async (
	cfg: Config["pipeline"]["judge"],
	opts: { tmpDir: string }
): Promise<{ llm: VisionLLM | null; provider: string; detail: string }> => {
	const name = displayName(cfg.model)
	const anthropic = () => ({
		llm: createAnthropicLlm({ model: cfg.model }),
		provider: "anthropic",
		detail: hasApiKey() ? `${name} via API key` : `${name} via the Anthropic API (no ANTHROPIC_API_KEY set; relies on an \`ant auth login\` profile)`
	})
	const claudeCode = () => ({
		llm: createClaudeCodeLlm({ model: cfg.model, tmpDir: opts.tmpDir }),
		provider: "claude-code",
		detail: `${name} via your Claude Code login (no API key set)`
	})
	switch (cfg.provider) {
		case "none":
			return { llm: null, provider: "none", detail: "Spotter off: sightings come from the detector alone" }
		case "mock":
			return { llm: createMockLlm(), provider: "mock", detail: "Mock spotter (offline, for tests)" }
		case "anthropic":
			return anthropic()
		case "claude-code":
			return claudeCode()
		case "auto":
			if (hasApiKey()) return anthropic()
			if (onPath(CLAUDE_BIN)) return claudeCode()
			return { llm: null, provider: "none", detail: "No spotter: set ANTHROPIC_API_KEY or install Claude Code" }
	}
}
