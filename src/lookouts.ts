// Lookout create/update/backfill/delete, shared by the HTTP API and the CLI so
// both behave identically.

import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import type { CreateLookoutBody, UpdateLookoutBody } from "./api-types.ts"
import type { AppContext } from "./context.ts"
import { verdictKeeps } from "./db.ts"
import { logger } from "./log.ts"
import { isPinned, NO_LOOKOUTS, redecideClips } from "./pipeline/process.ts"
import type { Lookout } from "./types.ts"

export { NO_LOOKOUTS }

const log = logger("lookouts")

export type LookoutCtx = Pick<AppContext, "store" | "bus" | "compile" | "kick" | "paths" | "config">

/** A user-facing failure; `status` is the HTTP status the server should answer with. */
export class LookoutError extends Error {
	readonly status: 400 | 404 | 409
	constructor(message: string, status: 400 | 404 | 409 = 400) {
		super(message)
		this.status = status
	}
}

export const DEFAULT_THRESHOLD = 0.6

/**
 * Clips that arrived while nothing was on watch were never looked at for
 * anything. On a first run that is every clip: the setup wizard connects the
 * camera, which starts pulling at once, a step before the first lookout exists.
 * The moment a lookout is on, those clips go back in the queue, so the first
 * sightings come from the footage already collected.
 */
const requeueUnwatched = (ctx: LookoutCtx) => {
	const clips = ctx.store
		.listClips({ status: "rejected", droppedAt: "detect", limit: Number.MAX_SAFE_INTEGER })
		.filter(c => c.reason === NO_LOOKOUTS && c.path && existsSync(c.path))
	if (!clips.length) return 0
	ctx.store.transaction(() => {
		for (const c of clips) ctx.store.updateClip(c.id, { status: "pending", pendingLookouts: null })
	})
	ctx.bus.emit("queue", ctx.store.queueDepth())
	ctx.kick()
	return clips.length
}

/** "Cardinal or Blue Jay!" → "cardinal-or-blue-jay" */
export const slugify = (s: string) =>
	s
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "")

const uniqueName = (ctx: LookoutCtx, base: string, selfId?: string) => {
	const taken = (n: string) => {
		const l = ctx.store.getLookout(n)
		return !!l && l.id !== selfId
	}
	if (!taken(base)) return base
	for (let i = 2; ; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`
}

const checkThreshold = (t: number | undefined) => {
	if (t !== undefined && !(Number.isFinite(t) && t >= 0 && t <= 1))
		throw new LookoutError(`threshold must be between 0 and 1 (got ${t})`)
}

const checkPrompt = (p: string | undefined) => {
	const prompt = p?.trim() ?? ""
	if (!prompt) throw new LookoutError("describe what to look for (the prompt is empty)")
	if (prompt.length > 500) throw new LookoutError("keep the prompt under 500 characters")
	return prompt
}

const find = (ctx: Pick<LookoutCtx, "store">, idOrName: string) => {
	const l = ctx.store.getLookout(idOrName)
	if (!l) throw new LookoutError(`no lookout "${idOrName}"`, 404)
	return l
}

/** A name the user typed: refused when taken (409), since silently renaming it would surprise them. */
const typedName = (ctx: LookoutCtx, raw: string, selfId?: string) => {
	const slug = slugify(raw)
	if (!slug) throw new LookoutError("the name needs at least one letter or digit")
	const other = ctx.store.getLookout(slug)
	if (other && other.id !== selfId) throw new LookoutError(`a lookout named "${slug}" already exists`, 409)
	return slug
}

export const createLookout = async (ctx: LookoutCtx, body: CreateLookoutBody): Promise<Lookout> => {
	const prompt = checkPrompt(body.prompt)
	checkThreshold(body.threshold)
	// checked before compiling, so a taken name costs no LLM call
	const named = body.name?.trim() ? typedName(ctx, body.name) : null
	const compiled = await ctx.compile(prompt)
	// only generated names get a -2, -3 … suffix
	const name = named ?? uniqueName(ctx, slugify(compiled.summary) || slugify(prompt) || "lookout")
	if (named && ctx.store.getLookout(named)) throw new LookoutError(`a lookout named "${named}" already exists`, 409)
	const lookout = ctx.store.insertLookout({
		id: randomBytes(6).toString("hex"),
		name,
		prompt,
		enabled: body.enabled ?? true,
		threshold: body.threshold ?? DEFAULT_THRESHOLD,
		compiled
	})
	ctx.bus.emit("lookout", { lookoutId: lookout.id })
	if (lookout.enabled) requeueUnwatched(ctx)
	return lookout
}

export const updateLookout = async (ctx: LookoutCtx, idOrName: string, body: UpdateLookoutBody): Promise<Lookout> => {
	const cur = find(ctx, idOrName)
	checkThreshold(body.threshold)
	const patch: Parameters<LookoutCtx["store"]["updateLookout"]>[1] = {}
	if (body.name !== undefined) {
		const slug = typedName(ctx, body.name, cur.id)
		if (slug !== cur.name) patch.name = slug
	}
	let compiled = cur.compiled
	if (body.prompt !== undefined) {
		const prompt = checkPrompt(body.prompt)
		if (prompt !== cur.prompt || !compiled) {
			patch.prompt = prompt
			compiled = await ctx.compile(prompt)
			patch.compiled = compiled
		}
	}
	if (body.queries !== undefined) {
		const queries = [...new Set(body.queries.map(q => q.trim().toLowerCase()).filter(Boolean))]
		if (!queries.length) throw new LookoutError("give at least one detector noun")
		compiled ??= await ctx.compile(patch.prompt ?? cur.prompt)
		patch.compiled = { ...compiled, queries, compiler: "manual" }
	}
	if (body.threshold !== undefined) patch.threshold = body.threshold
	if (body.enabled !== undefined) patch.enabled = body.enabled
	const out = ctx.store.updateLookout(cur.id, patch)
	ctx.bus.emit("lookout", { lookoutId: out.id })
	if (out.enabled && !cur.enabled) requeueUnwatched(ctx)
	if (out.threshold !== cur.threshold) await rethreshold(ctx, out)
	return out
}

/**
 * Re-decisions per store, one at a time: the UI's slider saves on every pause, and two runs must
 * not move the same file. Only that phase is serialized. The previews it leaves to encode go on a
 * queue of their own, so the next slider save never waits on ffmpeg.
 */
const chains = new WeakMap<LookoutCtx["store"], { deciding: Promise<void>; encoding: Promise<void> }>()

/**
 * A new threshold applies to the clips already judged for this lookout, not just to new
 * ones: the near-misses it now clears become sightings before retention deletes them, and
 * sightings it no longer clears are rejected (and expire) instead of lingering in kept/.
 * Free: it reads stored verdicts. New sightings' previews are encoded in the background.
 */
const rethreshold = async (ctx: LookoutCtx, l: Lookout) => {
	const chain = chains.get(ctx.store) ?? { deciding: Promise.resolve(), encoding: Promise.resolve() }
	chains.set(ctx.store, chain)
	const run = chain.deciding.then(async () => {
		const ids = ctx.store.listClips({ status: ["kept", "rejected"], lookoutId: l.id, limit: Number.MAX_SAFE_INTEGER }).map(c => c.id)
		const r = await redecideClips(ctx, ids)
		if (r.kept || r.rejected) log.info(`threshold of ${l.name} is now ${l.threshold}: ${r.kept} more kept, ${r.rejected} no longer kept`)
		return r
	})
	chain.deciding = run.then(
		() => {},
		() => {}
	)
	chain.encoding = chain.encoding
		.then(() => run.then(r => r.previews(), () => {}))
		.catch(e => log.warn("encoding previews failed", e))
	await run
}

/** Settles once every threshold re-decision so far, previews included, is done. */
export const redecided = async (ctx: Pick<LookoutCtx, "store">) => {
	const chain = chains.get(ctx.store)
	if (chain) await Promise.all([chain.deciding, chain.encoding])
}

/**
 * Queues every clip still on disk (optionally only those recorded since `since`)
 * to be re-judged for one lookout. Clips the motion gate dropped are skipped:
 * that stage does not depend on the lookout, so the answer would not change.
 */
export const backfill = (ctx: LookoutCtx, idOrName: string, since?: string): number => {
	const l = find(ctx, idOrName)
	if (since !== undefined && Number.isNaN(Date.parse(since))) throw new LookoutError(`"${since}" is not a date`)
	const clips = ctx.store
		.listClips({ status: ["kept", "rejected", "error"], since, limit: Number.MAX_SAFE_INTEGER })
		.filter(c => c.path && c.droppedAt !== "motion" && c.droppedAt !== "probe" && existsSync(c.path))
	ctx.store.transaction(() => {
		for (const c of clips)
			ctx.store.updateClip(c.id, { status: "pending", pendingLookouts: [...new Set([...(c.pendingLookouts ?? []), l.id])] })
	})
	if (clips.length) {
		ctx.bus.emit("queue", ctx.store.queueDepth())
		ctx.kick()
	}
	return clips.length
}

/**
 * Deletes a lookout (its verdicts and labels cascade). Clips it alone was
 * keeping become rejected so retention can eventually reclaim them, except
 * clips someone labeled (for this lookout or another): those are never deleted.
 * A clip saved from Live is pinned and stays kept whatever its lookouts say.
 */
export const deleteLookout = (ctx: Pick<LookoutCtx, "store" | "bus" | "config">, idOrName: string) => {
	const l = find(ctx, idOrName)
	const kept = ctx.store.listClips({ status: "kept", lookoutId: l.id, limit: Number.MAX_SAFE_INTEGER })
	// read before the delete, which takes this lookout's labels with it
	const labeled = new Set(kept.filter(c => ctx.store.getLabels({ clipId: c.id }).length).map(c => c.id))
	ctx.store.deleteLookout(l.id)
	const lookouts = new Map(ctx.store.listLookouts().map(x => [x.id, x]))
	const days = ctx.config.retention.rejectedDays
	for (const c of kept) {
		const still = ctx.store.getVerdicts(c.id).some(v => {
			const other = lookouts.get(v.lookoutId)
			return !!other && verdictKeeps(v, other)
		})
		if (still || isPinned(ctx, c.id)) continue
		const isLabeled = labeled.has(c.id)
		ctx.store.updateClip(c.id, {
			status: "rejected",
			droppedAt: "judge",
			reason: `its lookout "${l.name}" was deleted`,
			expiresAt: isLabeled ? null : new Date(Date.now() + days * 86_400_000).toISOString()
		})
		ctx.bus.emit("clip", { clipId: c.id, status: "rejected" })
	}
	ctx.bus.emit("lookout", { lookoutId: l.id })
}
