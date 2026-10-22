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
- Up to several crops: zoomed views around the detector's candidates, from different moments of the SAME clip. The same animal may appear in several crops. Each crop's metadata gives the detector's label and score; treat those as hints, never as evidence. The detector is often wrong (a leaf, a feeder part, a shadow or a pinecone labeled "bird"). A crop labeled "feeder visitor" is not the detector's: something appeared on a feeder at that moment that most of the clip's other frames lack, usually a small bird the detector missed, sometimes a squirrel or the feeder itself.
- A "feeder timeline" crop: one feeder at many moments of the clip, tiled, each tile labeled with its time.
- One context image: the whole scene (or the watched zone) at lower resolution, for where things are (at the feeder, on the pole, on the ground).
- For each lookout: its id, the person's own words, and a rubric of the visible criteria that must hold.
- The life list: every bird species already seen at this camera, its regulars. It is evidence for identification and nothing else. No lookout asks you whether a bird is new to it: look4 compares your species with the list itself, so a lookout marked as a life-list lookout only needs the bird identified.

Identify first, then judge. Before any lookout, write "identification": what each relevant subject is, from the images alone, as if no lookout existed. For a bird, note its size against its surroundings (grass blades, feeder ports, a nearby bird), its shape (head size, neck, tail length, plumpness), its bill and its plumage, then name the species those best fit. Lookouts must not steer this: a lookout hoping for a new species is no reason to read a soft bird as one.
- The life list is this camera's regulars, so a soft or partial view consistent with a listed species is that species. Name an unlisted species only when a field mark you can actually see rules out every listed look-alike. Classic traps on a degraded image: a small-headed, plump grey bird on the ground with a long tapered tail is a Mourning Dove, not a Dark-eyed Junco (a junco is sparrow-sized, with a stubby pale pink bill and a sharply bordered dark hood); a streaky brown bird is usually a House Sparrow or House Finch.
- Feeders draw mixed flocks: identify EVERY bird in every crop and tile, not just the most obvious one. A chickadee in one tile and a nuthatch in another are two species.
- Black-capped Chickadee vs White-breasted Nuthatch, both black-capped, white-faced and grey-backed: the chickadee has a black bib under its bill, a tiny stubby bill, a round head and a longish tail, and perches upright or hangs from a port. The nuthatch has a clean white throat and face with NO bib, a long straight dagger-like bill, a very short tail, a flat-crowned head, often rust under the tail, and clings head-down or sideways with its body held horizontal along the feeder or post. A black-capped bird with a white throat, or one held horizontal or head-down, is a nuthatch.
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

Then return "birds": every distinct bird species in the clip, from any crop, tile or the context image, one entry each, whatever the lookouts ask about: species (named exactly as for a verdict below) and confidence (the probability it is that species). Leave out a bird too small or blurred to favor any species; an empty list when no bird is visible.

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
const BirdAnswer = type({ species: "string", confidence: "number" })
// optional on read: the identification only steers generation, nothing downstream stores it
const JudgeAnswer = type({ "identification?": "string", "birds?": BirdAnswer.array(), verdicts: VerdictAnswer.array() })

/** A species the judge saw anywhere in the clip, not only the subject a verdict was about. */
export type SeenBird = { species: string; confidence: number }

/**
 * Property order is generation order: evidence first, then the call. `identification` comes
 * before any verdict so the species is named before a lookout's wording can pull on it: asked
 * "is this a new species?" first, Sonnet read a degraded Mourning Dove as a Dark-eyed Junco.
 * `birds` lists every species in the clip: a verdict names only one, so on 2026-10-22 a nuthatch that
 * shared a clip with a chickadee was never checked against the life list.
 */
export const JUDGE_SCHEMA: JsonSchema = {
	type: "object",
	properties: {
		identification: { type: "string" },
		birds: {
			type: "array",
			items: {
				type: "object",
				properties: { species: { type: "string" }, confidence: { type: "number" } },
				required: ["species", "confidence"],
				additionalProperties: false
			}
		},
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
	required: ["identification", "birds", "verdicts"],
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
): Promise<{ verdicts: Verdict[]; birds: SeenBird[]; answered: Set<string>; usage: Usage }> => {
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
	const birds = (parsed.birds ?? []).flatMap(b => {
		const species = b.species.trim()
		const confidence = clamp01(b.confidence)
		return species && confidence >= 0.5 ? [{ species, confidence }] : []
	})
	return { verdicts, birds, answered: new Set(lookouts.filter(l => byId.has(l.id)).map(l => l.id)), usage: res.usage }
}

/**
 * How sure the judge must be of a species before a life-list lookout keeps a clip for it. Above the
 * 50% a species is named at: almost every bird here is a regular, so a coin-flip ID of a wanted
 * species is far likelier a misread regular. On 2026-10-22 Sonnet offered five regulars as lifers, all
 * at 0.5-0.6 (Mourning Doves as a Junco and a Collared-Dove, a cardinal as a House Finch); the real
 * lifers before them came in at 0.88-0.9. The same holds for a listed species still owed a clip: let
 * through at 50% that afternoon, a female cardinal and a House Sparrow became "House Finch" sightings
 * at 0.50 and 0.55.
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
 * (the judge's match) and any bird in the clip new for its mode, named sure enough: the verdict's own
 * species or any of `birds`, so a nuthatch behind a chickadee still counts. The verdict then carries
 * the species that made it, which is the one offered for the life list.
 */
export const lifeListVerdict = (v: Verdict, mode: LifeListMode, lifeList: string[], withoutClip: string[], birds: SeenBird[] = []): Verdict => {
	if (!v.match) return v
	const named: SeenBird[] = [...(v.species ? [{ species: v.species, confidence: v.speciesConfidence ?? 0 }] : []), ...birds]
	const hit = named.find(b => isNewSpecies(b.species, mode, lifeList, withoutClip) && b.confidence >= NEW_SPECIES_CONFIDENCE)
	if (hit) return { ...v, species: hit.species, speciesConfidence: hit.confidence, confidence: Math.min(v.confidence, hit.confidence) }
	const sure = v.speciesConfidence ?? 0
	const why = !v.species
		? named.length
			? `${named.map(b => b.species).join(", ")}: none new to the life list`
			: "no species named"
		: !isNewSpecies(v.species, mode, lifeList, withoutClip)
			? `${v.species} is already on the life list${mode === "newOrClipless" ? " with a clip" : ""}`
			: `${v.species} at ${Math.round(sure * 100)}% is under the ${Math.round(NEW_SPECIES_CONFIDENCE * 100)}% a sighting needs`
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
	let birds = first.birds
	const escalateModel = cfg.escalateModel
	const unsure = escalateModel ? verdicts.filter(v => uncertain(v, cfg.escalateBelow)).map(v => v.lookoutId) : []
	if (escalateModel && unsure.length) {
		try {
			const again = await ask(input, input.lookouts.filter(l => unsure.includes(l.id)), llm, escalateModel)
			usage.push(again.usage)
			birds = [...again.birds, ...birds]
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
	const decide = (v: Verdict, seen: SeenBird[]) => {
		const mode = modes.get(v.lookoutId)
		return mode ? lifeListVerdict(v, mode, input.lifeList ?? [], input.lifeListWithoutClip ?? [], seen) : v
	}
	verdicts = verdicts.map(v => decide(v, birds))
	const keeping = verdicts.filter(v => v.match && modes.has(v.lookoutId))
	if (cfg.confirmModel && keeping.length) {
		try {
			const again = await ask(input, input.lookouts.filter(l => keeping.some(v => v.lookoutId === l.id)), llm, cfg.confirmModel)
			usage.push(again.usage)
			verdicts = verdicts.map(v => (keeping.includes(v) ? confirmed(v, again.verdicts.find(x => x.lookoutId === v.lookoutId), again.birds, decide, cfg.confirmModel!) : v))
		} catch (e) {
			const spent = usageOf(e)
			if (spent) usage.push(spent)
			if (input.signal?.aborted) throw e
			// a confirmation that could not be had is no "no": the first answer stands
			log.warn(`confirming ${input.clip.id} with ${cfg.confirmModel} failed: ${e instanceof Error ? e.message : String(e)}`)
		}
	}
	return { verdicts, usage }
}

/**
 * A life-list sighting stands only when a second model, asked the same question on its own, keeps the
 * clip for the same species: a sighting puts a bird on the person's list, so two opinions are worth
 * one more call on the few clips that get this far. Otherwise it is a "no", saying who named what.
 */
const confirmed = (v: Verdict, again: Verdict | undefined, seen: SeenBird[], decide: (v: Verdict, seen: SeenBird[]) => Verdict, model: string): Verdict => {
	const second = again && decide(again, seen)
	const same = (s: string | null | undefined) => !!s && s.toLowerCase() === v.species?.toLowerCase()
	if (second?.match && same(second.species)) return { ...v, confidence: Math.min(v.confidence, second.confidence), speciesConfidence: Math.min(v.speciesConfidence ?? 1, second.speciesConfidence ?? 1) }
	const named = again?.species ? `${again.species}${typeof again.speciesConfidence === "number" ? ` at ${Math.round(again.speciesConfidence * 100)}%` : ""}` : "no species"
	return { ...v, match: false, confidence: Math.max(0.5, second?.confidence ?? 0.5), rationale: `${model} did not confirm ${v.species} (it named ${named}). ${v.rationale}`.slice(0, 400) }
}
