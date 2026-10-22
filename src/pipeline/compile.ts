// Prompt compiler: the user's words → detector nouns + the judge's rubric. Runs once
// per lookout (and again when the prompt changes), so it can afford an LLM call.

import { createHash } from "node:crypto"
import { type } from "arktype"
import { logger } from "../log.ts"
import type { JsonSchema, VisionLLM } from "../llm/types.ts"
import type { CompiledLookout, LifeListMode, Lookout, Usage } from "../types.ts"

const log = logger("compile")

/** Bump when the compiler's prompt or rules change, so every lookout recompiles. */
export const COMPILER_VERSION = "4"

const normalize = (prompt: string) => prompt.trim().toLowerCase().replace(/\s+/g, " ")

export const promptHash = (prompt: string) =>
	createHash("sha256").update(`${COMPILER_VERSION}\n${normalize(prompt)}`).digest("hex")

export const isStale = (l: Lookout) => !l.compiled || l.compiled.promptHash !== promptHash(l.prompt)

const MAX_QUERIES = 4
const MAX_QUERY_CHARS = 40
const MAX_RUBRIC_CHARS = 1500
const MAX_SUMMARY_WORDS = 6

/** What a detector can find, by the words people use for it. Specific kinds map to the generic noun. */
const SYNONYMS: Record<string, string[]> = {
	bird: [
		"bird", "cardinal", "jay", "bluejay", "finch", "goldfinch", "sparrow", "hawk", "eagle", "owl", "woodpecker",
		"flicker", "sapsucker", "chickadee", "titmouse", "nuthatch", "hummingbird", "robin", "crow", "raven", "dove",
		"pigeon", "wren", "warbler", "oriole", "grackle", "starling", "junco", "bluebird", "heron", "egret", "blackbird",
		"cowbird", "towhee", "grosbeak", "bunting", "tanager", "siskin", "redpoll", "kinglet", "thrasher", "mockingbird",
		"catbird", "magpie", "falcon", "kestrel", "merlin", "vulture", "turkey", "duck", "goose", "gull", "songbird",
		"raptor"
	],
	squirrel: ["squirrel"],
	chipmunk: ["chipmunk"],
	cat: ["cat", "kitty", "kitten", "bobcat"],
	dog: ["dog", "puppy", "pup", "doggo"],
	person: ["person", "people", "human", "man", "woman", "kid", "child", "someone", "anyone", "intruder", "mailman", "courier"],
	deer: ["deer", "fawn", "doe", "buck"],
	raccoon: ["raccoon", "racoon"],
	fox: ["fox"],
	rabbit: ["rabbit", "bunny", "hare"],
	opossum: ["opossum", "possum"],
	bear: ["bear"],
	skunk: ["skunk"],
	groundhog: ["groundhog", "woodchuck"],
	mouse: ["mouse", "mice"],
	rat: ["rat"],
	coyote: ["coyote", "wolf"],
	car: ["car", "vehicle"],
	truck: ["truck", "van"],
	bicycle: ["bicycle", "bike"],
	package: ["package", "parcel", "delivery", "box"]
}

const WORD_TO_NOUN = new Map<string, string>()
for (const [noun, words] of Object.entries(SYNONYMS)) for (const w of words) WORD_TO_NOUN.set(w, noun)

const lookupWord = (w: string) =>
	WORD_TO_NOUN.get(w) ?? (w.endsWith("es") ? WORD_TO_NOUN.get(w.slice(0, -2)) : undefined) ?? (w.endsWith("s") ? WORD_TO_NOUN.get(w.slice(0, -1)) : undefined)

const LEADING_FILLER = new Set(["a", "an", "the", "any", "some", "show", "me", "find", "look", "for", "when", "there", "is", "are"])

const SMALL_WORDS = new Set(["a", "an", "the", "and", "or", "at", "on", "in", "of", "to", "by", "with", "for", "near"])

/** "a cardinal or blue jay at the feeder" → "Cardinal or Blue Jay at the Feeder" → capped at 6 words, no dangling small words. */
const fallbackSummary = (prompt: string) => {
	const words = prompt
		.trim()
		.split(/\s+/)
		.map(w => w.replace(/[^\p{L}\p{N}'-]/gu, ""))
		.filter(Boolean)
	while (words.length > 1 && LEADING_FILLER.has(words[0]!.toLowerCase())) words.shift()
	const kept = words.slice(0, MAX_SUMMARY_WORDS)
	while (kept.length > 1 && SMALL_WORDS.has(kept.at(-1)!.toLowerCase())) kept.pop()
	const title = kept.map((w, i) => (i > 0 && SMALL_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
	return title.join(" ").slice(0, 60) || "Lookout"
}

/** "a species not on my life list", "a new bird", "a lifer"; "…or added by hand without a clip" widens it. */
const lifeListModeOf = (prompt: string): LifeListMode | null => {
	const p = normalize(prompt)
	if (!/\blife ?list\b|\blifers?\b|\bnew (bird|species)\b/.test(p)) return null
	return /without (a |any )?clip|added by hand|no clip/.test(p) ? "newOrClipless" : "new"
}

/** The no-LLM compiler: a synonyms table, else the prompt itself as the detector query. */
export const keywordCompile = (prompt: string): Omit<CompiledLookout, "promptHash" | "compiler"> => {
	const words = normalize(prompt).split(/[^\p{L}\p{N}]+/u).filter(Boolean)
	const queries: string[] = []
	let specific = false
	for (const w of words) {
		const noun = lookupWord(w)
		if (!noun) continue
		// naming a kind of bird ("cardinal", "hawks") means the judge must tell species apart
		if (noun === "bird" && !/^(bird|songbird)s?$/.test(w)) specific = true
		if (!queries.includes(noun)) queries.push(noun)
	}
	return {
		queries: queries.length ? queries.slice(0, MAX_QUERIES) : [prompt.trim().slice(0, 80)],
		rubric: prompt.trim(),
		summary: fallbackSummary(prompt),
		fineGrained: specific || lifeListModeOf(prompt) !== null,
		lifeList: lifeListModeOf(prompt)
	}
}

/** Where things happen in a yard camera's view. The summary names the lookout (and its slug), so it must not add one. */
const PLACES = new Set([
	"feeder", "pole", "yard", "backyard", "ground", "tree", "branch", "perch", "fence", "deck", "porch", "roof", "garden",
	"birdbath", "bath", "lawn", "patio", "driveway", "window", "nest", "suet", "tray", "platform", "hanger"
])

const words = (s: string) =>
	s
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean)
		.map(w => (w.endsWith("s") && PLACES.has(w.slice(0, -1)) ? w.slice(0, -1) : w))

/** "Squirrel at Feeder" for "a squirrel": the model borrowed the feeder from its own examples. */
const inventsPlace = (summary: string, prompt: string) => {
	const said = new Set(words(prompt))
	return words(summary).some(w => PLACES.has(w) && !said.has(w))
}

const CompileAnswer = type({
	"+": "reject",
	queries: "string[]",
	rubric: "string",
	summary: "string",
	fineGrained: "boolean",
	// optional on read: a model that leaves it out still compiled a usable lookout
	"lifeList?": "'new' | 'newOrClipless' | null"
})

/** JSON schema sent to the model. Property order is generation order: think in the rubric before committing. */
export const COMPILE_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		rubric: { type: "string" },
		queries: { type: "array", items: { type: "string" } },
		summary: { type: "string" },
		fineGrained: { type: "boolean" },
		lifeList: { anyOf: [{ type: "string", enum: ["new", "newOrClipless"] }, { type: "null" }] }
	},
	required: ["rubric", "queries", "summary", "fineGrained", "lifeList"],
	additionalProperties: false
}

export const COMPILE_SYSTEM = `You configure a camera-clip filter. A person describes, in their own words, the moments they want to find in short motion-triggered clips from a fixed camera (often a backyard bird feeder). You turn that description into two things the filter runs on.

1. "queries": 1 to 4 generic object nouns for an open-vocabulary object detector (OWL-ViT). The detector only recognizes broad categories, so ALWAYS use the generic noun, never a species or breed: "bird" (never "cardinal" or "hawk"), "squirrel", "chipmunk", "cat", "dog", "person", "deer", "raccoon", "fox", "rabbit", "opossum", "bear", "skunk", "groundhog", "mouse", "rat", "coyote", "car", "truck", "bicycle", "package". Use a noun outside this list only when nothing in it fits. Lowercase, singular, no adjectives. Include every kind of object the description could be satisfied by, and nothing else.

2. "rubric": explicit criteria a vision model will check on zoomed crops from the clip, to decide yes or no. Write it as short, checkable statements about what must be VISIBLE. For species or breed, list the field marks that separate the target from its look-alikes, for example:
- Northern Cardinal: male is bright red all over with a pointed crest and a black face mask around a thick orange-red conical bill; female is warm tan-brown with reddish tinges on the wings, tail and crest and the same thick orange-red bill. Not a cardinal: House Finch (red limited to head and breast, streaky brown body, no crest, small grey bill), Summer/Scarlet Tanager (no crest), Pyrrhuloxia (grey body, yellow bill).
- Blue Jay: blue crest, blue back and wings with white wing bars and black barring, white/grey underparts, black necklace across the throat. Not a blue jay: Steller's Jay (black head and front half, no white), Eastern/Western Bluebird (small, no crest, orange-rust breast), Indigo Bunting (small, all blue, no crest).
- Hawk vs other large birds: hooked bill, forward-facing eyes, strong talons; Cooper's/Sharp-shinned Hawks have long banded tails and red-barred breasts. Not a hawk: Mourning Dove, crow, pigeon.
When the description names a group rather than one species ("a sparrow", "a woodpecker", "a hawk", "a finch"), ANY member of the group qualifies: give the marks the whole group shares and how the group differs from look-alike groups, and never require a mark only some members have (many sparrows, the Chipping Sparrow among them, have plain unstreaked breasts). Only state field marks you are sure of.
The person keeps a life list, every bird species already seen at this camera. Whether a bird is new to that list is NOT the rubric's job: look4 compares the vision model's species against the list itself (see "lifeList"). So when the description refers to the list, the rubric never mentions the list, newness or how likely a species must be; it covers only what else the description asks for, and for a description that is only about the list it says that any clearly visible bird qualifies.
When the description includes a place or behavior ("at the feeder", "on the pole", "eating"), add it as a criterion. Never add a place, behavior or other condition the description does not state. When it is broad ("any bird"), say so: any clearly visible bird qualifies. End with what does NOT qualify when that is likely to be confused.

3. "summary": a display label of at most 6 words in Title Case, built only from what the description says, e.g. "Cardinal or Blue Jay at Feeder" for "a cardinal or blue jay at the feeder", but just "Squirrel" for "a squirrel" (never add a place it does not mention).

4. "fineGrained": true when the decision needs fine detail (species, sex, breed, a specific behavior, a small object, anything about the life list); false when the generic category alone decides it.

5. "lifeList": "new" when the description wants birds not on the life list ("a species not on my life list", "a new bird", "a lifer"); "newOrClipless" when it also wants species on the list that were added by hand without a clip; null when it does not refer to the list.

Write the rubric first, then the other fields.`

export const compileRequestText = (prompt: string) =>
	`Compile this description into the filter's settings.\nPrompt (JSON string): ${JSON.stringify(prompt.trim())}`

/** Applies the caps and normal forms whatever the model returned. */
const sanitize = (a: typeof CompileAnswer.infer, prompt: string): Omit<CompiledLookout, "promptHash" | "compiler"> => {
	const queries: string[] = []
	for (const q of a.queries) {
		const clean = q.trim().toLowerCase().replace(/\s+/g, " ").slice(0, MAX_QUERY_CHARS)
		if (clean && !queries.includes(clean)) queries.push(clean)
	}
	const summaryWords = a.summary.trim().split(/\s+/).filter(Boolean).slice(0, MAX_SUMMARY_WORDS)
	const faithful = summaryWords.length && !inventsPlace(summaryWords.join(" "), prompt)
	return {
		queries: queries.length ? queries.slice(0, MAX_QUERIES) : keywordCompile(prompt).queries,
		rubric: a.rubric.trim().slice(0, MAX_RUBRIC_CHARS) || prompt.trim(),
		summary: faithful ? summaryWords.join(" ").slice(0, 60) : fallbackSummary(prompt),
		fineGrained: a.fineGrained || !!a.lifeList,
		lifeList: a.lifeList ?? null
	}
}

export const compileLookout = async (
	prompt: string,
	llm: VisionLLM | null
): Promise<{ compiled: CompiledLookout; usage: Usage | null }> => {
	const hash = promptHash(prompt)
	if (llm) {
		try {
			const res = await llm.complete({
				purpose: "compile",
				clipId: null,
				system: COMPILE_SYSTEM,
				text: compileRequestText(prompt),
				images: [],
				schema: COMPILE_SCHEMA,
				maxTokens: 1500
			})
			const answer = CompileAnswer(res.json)
			if (answer instanceof type.errors) throw new Error(`compiler answer is malformed: ${answer.summary}`)
			return {
				compiled: { ...sanitize(answer, prompt), promptHash: hash, compiler: `${llm.backend}:${res.usage.model}` },
				usage: res.usage
			}
		} catch (e) {
			log.warn(`LLM compile failed, using keyword fallback: ${e instanceof Error ? e.message : String(e)}`)
		}
	}
	return { compiled: { ...keywordCompile(prompt), promptHash: hash, compiler: "fallback" }, usage: null }
}
