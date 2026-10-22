import { test } from "node:test"
import assert from "node:assert/strict"
import { gaveUpReason } from "../src/pipeline/process.ts"
import { modelLabel, readRetry } from "../web/src/format.ts"

// Reasons as the backend writes them: process.ts "failed at <stage>: <message>", plus the
// worker's " (retry n/3 at hh:mm)" while a retry is scheduled.
const busy = "claude CLI exited 1: overloaded"
const failed = (reason: string, error: string) => ({ status: "error", reason, droppedAt: null, error })

test("a scheduled judge retry reads as a calm wait, on the app's 12-hour clock", () => {
	const r = readRetry(failed(`failed at judge: ${busy} (retry 2/3 at 14:00)`, busy))
	assert.equal(r?.text, "The spotter was busy")
	assert.match(r?.at ?? "", /^2:00\sPM$/)
})

test("a judge retry the worker gave up on is an error, not a wait", () => {
	const reason = gaveUpReason(`failed at judge: ${busy} (retry 3/3 at 14:00)`, "after 7 days")
	assert.equal(readRetry(failed(reason, busy)), null)
})

test("a transient-sounding failure outside the judge is never retried, so it is not a wait", () => {
	assert.equal(readRetry(failed("failed at detect: timed out", "timed out")), null)
})

test("verdict tags, dated ids and detector weights all get their friendly names", () => {
	assert.deepEqual(
		["claude-code:haiku", "anthropic:claude-sonnet-5-5-20260101", "Xenova/owlvit-base-patch32:fp32", "detector-only"].map(id =>
			modelLabel(id)
		),
		["Claude Haiku 5.5 via Claude Code", "Claude Sonnet 5.5 via the Anthropic API", "OWL-ViT (local)", "The detector alone"]
	)
})
