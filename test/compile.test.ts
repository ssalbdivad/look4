import { test } from "node:test"
import assert from "node:assert/strict"
import { compileLookout, isStale, promptHash } from "../src/pipeline/compile.ts"
import { createMockLlm } from "../src/llm/mock.ts"
import type { LlmRequest, VisionLLM } from "../src/llm/types.ts"
import type { Lookout } from "../src/types.ts"

const fakeLlm = (respond: (req: LlmRequest) => unknown): VisionLLM => ({
	backend: "anthropic",
	model: "claude-haiku-5-5",
	check: async () => ({ ok: true, detail: "" }),
	complete: async req => {
		const json = respond(req)
		return {
			json,
			raw: JSON.stringify(json),
			usage: { ts: "", clipId: null, purpose: req.purpose, backend: "anthropic", model: "claude-haiku-5-5", inputTokens: 900, outputTokens: 120, cacheReadTokens: 0, costUsd: 0.00015 }
		}
	}
})

test("keyword fallback: a species maps to its generic noun and marks the lookout fine-grained", async () => {
	const { compiled, usage } = await compileLookout("a cardinal or blue jay at the feeder", null)
	assert.equal(usage, null)
	assert.deepEqual(compiled, {
		queries: ["bird"],
		rubric: "a cardinal or blue jay at the feeder",
		summary: "Cardinal or Blue Jay",
		fineGrained: true,
		lifeList: null,
		promptHash: promptHash("a cardinal or blue jay at the feeder"),
		compiler: "fallback"
	})
})

test("keyword fallback: a prompt about the life list gets its mode, widened by birds added without a clip, and is fine-grained", async () => {
	const mode = async (prompt: string) => {
		const { compiled } = await compileLookout(prompt, null)
		return [compiled.lifeList, compiled.fineGrained]
	}
	assert.deepEqual(await mode("any bird not on my life list"), ["new", true])
	assert.deepEqual(await mode("a new species, or one on my lifelist I added by hand without a clip"), ["newOrClipless", true])
	assert.deepEqual(await mode("any bird"), [null, false])
})

test("keyword fallback: generic nouns, plurals, and first-mention order", async () => {
	const pole = (await compileLookout("any squirrel on the feeder pole", null)).compiled
	assert.deepEqual([pole.queries, pole.fineGrained], [["squirrel"], false])
	assert.deepEqual((await compileLookout("Raccoons or SQUIRRELS raiding it", null)).compiled.queries, ["raccoon", "squirrel"])
	assert.deepEqual((await compileLookout("finches", null)).compiled.queries, ["bird"])
})

test("keyword fallback: no known word → the prompt itself is the detector query", async () => {
	assert.deepEqual((await compileLookout("  the gate left open ", null)).compiled.queries, ["the gate left open"])
})

test("isStale: a real prompt edit is stale, case/whitespace-only edits are not", async () => {
	const { compiled } = await compileLookout("a hawk", null)
	const l = (prompt: string, c = compiled): Lookout => ({
		id: "l1", name: "hawk", prompt, enabled: true, threshold: 0.6, compiled: c, createdAt: "", updatedAt: ""
	})
	assert.equal(isStale(l("a hawk")), false)
	assert.equal(isStale(l("  A  Hawk ")), false)
	assert.equal(isStale(l("a hawk on the fence")), true)
	assert.equal(isStale(l("a hawk", null as never)), true)
})

test("LLM compile: answers are normalized and capped (lowercase, deduped, ≤4 queries, ≤6-word summary)", async () => {
	const llm = fakeLlm(() => ({
		rubric: "  Bright red bird with crest.  ",
		queries: ["Bird", " bird ", "Squirrel", "cat", "dog", "fox"],
		summary: "Red Cardinal At The Backyard Feeder Today",
		fineGrained: true
	}))
	const { compiled, usage } = await compileLookout("a red cardinal at the backyard feeder today", llm)
	assert.deepEqual(
		{ ...compiled, promptHash: undefined },
		{
			queries: ["bird", "squirrel", "cat", "dog"],
			rubric: "Bright red bird with crest.",
			summary: "Red Cardinal At The Backyard Feeder",
			fineGrained: true,
			lifeList: null,
			promptHash: undefined,
			compiler: "anthropic:claude-haiku-5-5"
		}
	)
	assert.equal(usage?.purpose, "compile")
})

test("LLM compile: a malformed answer or a failing backend falls back to keywords", async () => {
	const malformed = await compileLookout("a blue jay", fakeLlm(() => ({ queries: "bird" })))
	assert.deepEqual([malformed.compiled.compiler, malformed.compiled.queries, malformed.usage], ["fallback", ["bird"], null])
	const failing = fakeLlm(() => {
		throw new Error("Claude Code is not logged in")
	})
	assert.equal((await compileLookout("a blue jay", failing)).compiled.compiler, "fallback")
})

test("mock backend compiles through the same request text the real backends get", async () => {
	const { compiled } = await compileLookout('a "red" cardinal\nat the feeder', createMockLlm())
	assert.deepEqual([compiled.compiler, compiled.queries, compiled.fineGrained], ["mock:mock", ["bird"], true])
})

test("LLM compile: a summary that adds a place the prompt never mentioned is replaced by the prompt's own words", async () => {
	const answer = (summary: string) => fakeLlm(() => ({ rubric: "r", queries: ["squirrel"], summary, fineGrained: false }))
	assert.equal((await compileLookout("a squirrel", answer("Squirrel at Feeder"))).compiled.summary, "Squirrel")
	assert.equal((await compileLookout("any squirrel on the feeder poles", answer("Squirrel on Feeder Pole"))).compiled.summary, "Squirrel on Feeder Pole")
})
