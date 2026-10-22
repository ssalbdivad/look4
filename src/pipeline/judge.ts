// The paid stage: one vision-LLM request per clip that answers every candidate lookout.

import { type } from "arktype"
import type { Config } from "../config.ts"
import { logger } from "../log.ts"
import { LlmError, usageOf } from "../llm/errors.ts"
import type { JsonSchema, LlmImage, VisionLLM } from "../llm/types.ts"
import type { LifeListMode, Lookout, Usage, Verdict } from "../types.ts"
import type { JudgeCrop, JudgeInput, JudgeOutput } from "./types.ts"

const log = logger("judge")

/** Stable across every clip and lookout, so the API can cache it. Per-clip facts go in the user text. */
export const JUDGE_SYSTEM = `You are the final check in a wildlife and yard camera filter. A fixed camera records short clips when something moves. A local object detector has already found candidate objects; you decide, for each "lookout" (a person's description of what they want to see), whether this clip truly shows it.

What you receive:
- Up to several crops: zoomed views around the detector's candidates, from different moments of the SAME clip. The same animal may appear in several crops. Each crop's metadata gives the detector's label and score; treat those as hints, never as evidence. The detector is often wrong (a leaf, a feeder part, a shadow or a pinecone labeled "bird").
- One context image: the whole scene (or the watched zone) at lower resolution, for where things are (at the feeder, on the pole, on the ground).
- For each lookout: its id, the person's own words, and a rubric of the visible criteria that must hold.
- The life list: every bird species already seen at this camera, its regulars. It is evidence for identification and nothing else. No lookout asks you whether a bird is new to it: look4 compares your species with the list itself, so a lookout marked as a life-list lookout only needs the bird identified.

Identify first, then judge. Before any lookout, write "identification": what each relevant subject is, from the images alone, as if no lookout existed. For a bird, note its size against its surroundings (grass blades, feeder ports, a nearby bird), its shape (head size, neck, tail length, plumpness), its bill and its plumage, then name the species those best fit. Lookouts must not steer this: a lookout hoping for a new species is no reason to read a soft bird as one.
- The life list is this camera's regulars, so a soft or partial view consistent with a listed species is that species. Name an unlisted species only when a field mark you can actually see rules out every listed look-alike. Classic traps on a degraded image: a small-headed, plump grey bird on the ground with a long tapered tail is a Mourning Dove, not a Dark-eyed Junco (a junco is sparrow-sized, with a stubby pale pink bill and a sharply bordered dark hood); a streaky brown bird is usually a House Sparrow or House Finch.
- Every verdict's species must agree with this identification.

How to judge:
- Be skeptical. Answer match: true only when the rubric is satisfied by evidence you can actually SEE in the images. Do not infer from what is likely at a feeder, from the time of day, or from the detector's label.
- If the subject is too small, blurred, backlit or occluded to check the rubric's distinguishing features, the answer is match: false, or a low-confidence match, never a confident one.
- Different lookouts are independent: one clip may match several, one, or none.
- Night/IR footage is greyscale; color-based field marks cannot be confirmed in it.

Calibrate confidence (0 to 1) as the probability that your match answer is right:
- 0.9 or above only when the diagnostic features are clearly visible (for a species: the field marks that rule out its look-alikes).
- 0.6 to 0.9 when most criteria are visible and nothing contradicts them.
- Below 0.6 when you are guessing either way.
For match: false, confidence is how sure you are that the lookout is NOT satisfied.

For each lookout return:
- lookoutId: exactly as given.
- rationale: at most 2 short sentences of visible evidence for your answer.
- label: the most specific identification of the relevant subject you can support, in at most 4 words ("Northern Cardinal (male)", "Eastern Gray Squirrel", "small brown bird"), or null when nothing relevant to this lookout is visible.
- species: when the relevant subject is a bird, your best identification whenever one species is more likely than not, its standard English common name alone, as a field guide titles it ("Mourning Dove", "White-breasted Nuthatch"), with no sex, age or hedge. Name it whatever the match answer, and without needing certainty: the skepticism above governs match, not this field, and speciesConfidence carries the doubt. A bird filling a good part of a crop with its shape, bill and plumage pattern visible (a streaky brown sparrow at a feeder, a grey dove on the ground) almost always favors one species; null only when the bird is too small or blurred to favor any. Spell a species on the life list exactly as the list does.
- speciesConfidence: with a species, the probability (0 to 1) that it is that species; null without one. Weigh it against the regulars: a species not on the life list is rare here, so 0.75 or above for one needs a field mark you can actually see that rules out every listed look-alike, and a soft view that merely fits it stays below 0.6.
- match and confidence as above.
Answer every lookout id you were given, once.`

const VerdictAnswer = type({
	lookoutId: "string",
	match: "boolean",
	confidence: "number",
	label: "string | null",
	// required by the schema, but an answer without it is still a usable (and billed) verdict
	"species?": "string | null",
	"speciesConfidence?": "number | null",
	rationale: "string"
})
// optional on read: the identification only steers generation, nothing downstream stores it
const JudgeAnswer = type({ "identification?": "string", verdicts: VerdictAnswer.array() })

/**
 * Property order is generation order: evidence first, then the call. `identification` comes
 * before any verdict so the species is named before a lookout's wording can pull on it: asked
 * "is this a new species?" first, Sonnet read a degraded Mourning Dove as a Dark-eyed Junco.
 */
export const JUDGE_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		identification: { type: "string" },
		verdicts: {
			type: "array",
			items: {
				type: "object",
				properties: {
					lookoutId: { type: "string" },
					rationale: { type: "string" },
					label: { anyOf: [{ type: "string" }, { type: "null" }] },
					species: { anyOf: [{ type: "string" }, { type: "null" }] },
					speciesConfidence: { anyOf: [{ type: "number" }, { type: "null" }] },
					match: { type: "boolean" },
					confidence: { type: "number" }
				},
				required: ["lookoutId", "rationale", "label", "species", "speciesConfidence", "match", "confidence"],
				additionalProperties: false
			}
		}
	},
	required: ["identification", "verdicts"],
	additionalProperties: false
}

const fmt = (n: number) => Number(n.toFixed(3))
const boxText = (b: { x: number; y: number; w: number; h: number }) => `x=${fmt(b.x)} y=${fmt(b.y)} w=${fmt(b.w)} h=${fmt(b.h)}`

/**
 * The per-clip text. The `lookout id=` and `crop N:` lines are also what the mock
 * backend parses, so keep their format stable.
 */
export const judgeText = (input: Pick<JudgeInput, "clip" | "lookouts" | "crops" | "lifeList">) => {
	const { clip, lookouts, crops, lifeList = [] } = input
	const lines: string[] = []
	lines.push(`Clip ${clip.id}: recorded ${clip.recordedAt}${clip.durationS ? `, ${clip.durationS.toFixed(1)}s long` : ""}.`)
	lines.push("", `Images, in order (${crops.length} crop${crops.length === 1 ? "" : "s"}, then the context image):`)
	crops.forEach((c, i) =>
		lines.push(
			c.sheet
				? `crop ${i}: label=${JSON.stringify(c.label)} box=${boxText(c.box)}: this feeder at ${c.sheet.length} moments (${c.sheet.map(t => `${t.toFixed(1)}s`).join(", ")}), tiled left to right then down, each tile labeled with its time; a bird may be in only a few tiles`
				: `crop ${i}: label=${JSON.stringify(c.label)} score=${fmt(c.score)} t=${c.frameT.toFixed(1)}s box=${boxText(c.box)}`
		)
	)
	lines.push("context: the whole scene, downscaled")
	lines.push("", "Lookouts:")
	for (const l of lookouts) {
		lines.push(`lookout id=${l.id} queries=${JSON.stringify(l.compiled?.queries ?? [])}`)
		// The person's words ("a species not on my life list…, 50%+ is fine") are withheld from a life-list
		// lookout, and so is which species lack a clip: told both, Sonnet read five regulars in one morning
		// as lifers or clipless species at 0.5-0.6 (2026-10-22). The judge identifies; `lifeListVerdict` decides.
		if (l.compiled?.lifeList) lines.push("  life-list lookout: identify the bird; look4 decides whether it is new to the life list")
		else lines.push(`  prompt: ${JSON.stringify(l.prompt)}`)
		lines.push(`  rubric: ${l.compiled?.rubric ?? l.prompt}`)
	}
	lines.push("", lifeList.length ? `Life list, this camera's regulars (${lifeList.length} species): ${lifeList.join("; ")}.` : "Life list: empty, no species seen yet.")
	lines.push("", `Return one verdict for each of these lookout ids: ${lookouts.map(l => l.id).join(", ")}.`)
	return lines.join("\n")
}

const images = (crops: JudgeCrop[], context: Buffer): LlmImage[] => [
	...crops.map((c, i): LlmImage => ({ mediaType: "image/jpeg", data: c.jpeg, name: `crop-${i}.jpg` })),
	{ mediaType: "image/jpeg", data: context, name: "context.jpg" }
]

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)

/**
 * A species is only named when it is more likely than not: the life list and "new species" are matched
 * on it, so a 25% guess would offer a wrong bird to confirm. The label still says what it looked like.
 */
const namedSpecies = (v: typeof VerdictAnswer.infer): Pick<Verdict, "species" | "speciesConfidence"> => {
	const species = v.species?.trim() || null
	const sure = typeof v.speciesConfidence === "number" ? clamp01(v.speciesConfidence) : null
	return species && (sure === null || sure >= 0.5) ? { species, speciesConfidence: sure } : { species: null, speciesConfidence: null }
}

const ask = async (
	input: JudgeInput,
	lookouts: Lookout[],
	llm: VisionLLM,
	model: string | undefined
): Promise<{ verdicts: Verdict[]; answered: Set<string>; usage: Usage }> => {
	input.signal?.throwIfAborted()
	const res = await llm.complete({
		purpose: "judge",
		clipId: input.clip.id,
		system: JUDGE_SYSTEM,
		text: judgeText({ ...input, lookouts }),
		images: images(input.crops, input.context),
		schema: JUDGE_SCHEMA,
		model,
		maxTokens: 450 + 250 * lookouts.length
	})
	const parsed = JudgeAnswer(res.json)
	if (parsed instanceof type.errors)
		// the answer was billed even though it is unusable
		throw new LlmError(`judge returned malformed output (${parsed.summary.split("\n")[0]}): ${res.raw.slice(0, 200)}`, { usage: res.usage })
	const byId = new Map(parsed.verdicts.map(v => [v.lookoutId, v]))
	const now = new Date().toISOString()
	const tag = `${llm.backend}:${res.usage.model}`
	const verdicts = lookouts.map((l): Verdict => {
		const v = byId.get(l.id)
		if (!v)
			return { clipId: input.clip.id, lookoutId: l.id, match: false, confidence: 0, label: null, species: null, speciesConfidence: null, rationale: "judge gave no answer", model: tag, createdAt: now }
		return {
			clipId: input.clip.id,
			lookoutId: l.id,
			match: v.match,
			confidence: clamp01(v.confidence),
			label: v.label?.trim() || null,
			...namedSpecies(v),
			rationale: v.rationale.trim().slice(0, 400),
			model: tag,
			createdAt: now
		}
	})
	return { verdicts, answered: new Set(lookouts.filter(l => byId.has(l.id)).map(l => l.id)), usage: res.usage }
}

/**
 * How sure the judge must be of a species before look4 calls it new to the life list. Above the 50%
 * a species is named at: almost every bird here is a regular, so a coin-flip ID of an unlisted species
 * is far likelier a misread regular. On 2026-10-22 Sonnet offered five regulars as lifers, all at
 * 0.5-0.6 (Mourning Doves as a Junco and a Collared-Dove, a cardinal as a House Finch); the real lifers
 * before them came in at 0.88-0.9, but a Downy Woodpecker at 0.6 would also have been missed.
 */
export const NEW_SPECIES_CONFIDENCE = 0.75

/** Whether `species` counts as new to the life list for a lookout of this mode. */
export const isNewSpecies = (species: string, mode: LifeListMode, lifeList: string[], withoutClip: string[]) => {
	const s = species.toLowerCase()
	const has = (list: string[]) => list.some(x => x.toLowerCase() === s)
	return !has(lifeList) || (mode === "newOrClipless" && has(withoutClip))
}

/**
 * A life-list lookout's verdict, decided here rather than by the judge: its rubric's other criteria
 * (the judge's match) and a species named at `NEW_SPECIES_CONFIDENCE` or more that is new for its mode.
 */
export const lifeListVerdict = (v: Verdict, mode: LifeListMode, lifeList: string[], withoutClip: string[]): Verdict => {
	if (!v.match) return v
	const sure = v.speciesConfidence ?? 0
	const why = !v.species
		? "no species named"
		: !isNewSpecies(v.species, mode, lifeList, withoutClip)
			? `${v.species} is already on the life list${mode === "newOrClipless" ? " with a clip" : ""}`
			: sure < NEW_SPECIES_CONFIDENCE
				? `${v.species} at ${Math.round(sure * 100)}% is under the ${Math.round(NEW_SPECIES_CONFIDENCE * 100)}% a new species needs`
				: null
	if (!why) return { ...v, confidence: Math.min(v.confidence, sure) }
	// a "no" is as sure as the species call it rests on
	return { ...v, match: false, confidence: v.species ? Math.max(sure, 1 - sure) : v.confidence, rationale: `${why}. ${v.rationale}`.slice(0, 400) }
}

/** In the escalation band: unsure enough to be worth a second, stronger opinion. */
const uncertain = (v: Verdict, below: number) => v.confidence >= below - 0.3 && v.confidence < below

export const judgeClip = async (input: JudgeInput, llm: VisionLLM, cfg: Config["pipeline"]["judge"]): Promise<JudgeOutput> => {
	if (input.lookouts.length === 0) return { verdicts: [], usage: [] }
	const first = await ask(input, input.lookouts, llm, undefined)
	const usage = [first.usage]
	let verdicts = first.verdicts
	const escalateModel = cfg.escalateModel
	const unsure = escalateModel ? verdicts.filter(v => uncertain(v, cfg.escalateBelow)).map(v => v.lookoutId) : []
	if (escalateModel && unsure.length) {
		try {
			const again = await ask(input, input.lookouts.filter(l => unsure.includes(l.id)), llm, escalateModel)
			usage.push(again.usage)
			const better = new Map(again.verdicts.filter(v => again.answered.has(v.lookoutId)).map(v => [v.lookoutId, v]))
			verdicts = verdicts.map(v => better.get(v.lookoutId) ?? v)
		} catch (e) {
			const spent = usageOf(e)
			if (spent) usage.push(spent)
			if (input.signal?.aborted) throw e
			// the first answer stands; escalation is a refinement, not a requirement
			log.warn(`escalation to ${escalateModel} failed for ${input.clip.id}: ${e instanceof Error ? e.message : String(e)}`)
		}
	}
	const modes = new Map(input.lookouts.flatMap(l => (l.compiled?.lifeList ? [[l.id, l.compiled.lifeList] as const] : [])))
	verdicts = verdicts.map(v => {
		const mode = modes.get(v.lookoutId)
		return mode ? lifeListVerdict(v, mode, input.lifeList ?? [], input.lifeListWithoutClip ?? []) : v
	})
	return { verdicts, usage }
}
