// Builds the API's response shapes (src/api-types.ts) from store rows.

import { existsSync } from "node:fs"
import { join } from "node:path"
import type { ClipDetail, ClipMatch, ClipSummary, LookoutDto, LookoutStats, MediaUrls, SettingsDto } from "../api-types.ts"
import type { LoadedConfig, SourceConfig } from "../config.ts"
import { KEEPS_SQL, type Store, verdictKeeps } from "../db.ts"
import { clipMediaDir, closeUpName, type DataPaths, MAX_CLOSEUPS } from "../paths.ts"
import { isNewSpecies, NEW_SPECIES_CONFIDENCE } from "../pipeline/judge.ts"
import type { Clip, Lookout, Verdict } from "../types.ts"

// ingest lengthens the hash suffix (6, 10, 16, 64) when two clips share a second and a prefix
export const CLIP_ID = /^\d{8}-\d{6}-[0-9a-f]{6,64}$/

type Deps = { store: Store; paths: DataPaths }

/**
 * Media URLs carry `?v=<processedAt>` so posters and crops can be cached
 * forever: reprocessing rewrites them under the same file names.
 */
export const mediaUrls = (paths: DataPaths, clip: Clip): MediaUrls => {
	const dir = clipMediaDir(paths, clip.id)
	const v = clip.processedAt ? `?v=${Date.parse(clip.processedAt) || 0}` : ""
	const url = (file: string | null) => (file && existsSync(join(dir, file)) ? `/media/${clip.id}/${file}${v}` : null)
	// close-ups are numbered in the order they were taken and never renamed, so the first gap ends them
	const closeUps: string[] = []
	for (let n = 0; n < MAX_CLOSEUPS; n++) {
		const u = url(closeUpName(n))
		if (!u) break
		closeUps.push(u)
	}
	return {
		poster: url(clip.media.poster),
		preview: url(clip.media.preview),
		original: clip.path && existsSync(clip.path) ? `/media/${clip.id}/original` : null,
		crops: clip.media.crops.map(url).filter((u): u is string => u !== null),
		closeUps
	}
}

const isKeeping = (v: Verdict, l: Lookout | undefined): l is Lookout => !!l && verdictKeeps(v, l)

export const clipMatches = (verdicts: Verdict[], lookouts: Map<string, Lookout>): ClipMatch[] =>
	verdicts
		.flatMap(v => {
			const l = lookouts.get(v.lookoutId)
			return isKeeping(v, l) ? [{ lookoutId: l.id, lookoutName: l.name, label: v.label, species: v.species ?? null, speciesConfidence: v.speciesConfidence ?? null, confidence: v.confidence }] : []
		})
		.sort((a, b) => b.confidence - a.confidence)

export const lookoutMap = (store: Store) => new Map(store.listLookouts().map(l => [l.id, l]))

export const clipSummary = (
	{ store, paths }: Deps,
	clip: Clip,
	lookouts: Map<string, Lookout>,
	verdicts: Verdict[] = store.getVerdicts(clip.id)
): ClipSummary => {
	const matches = clipMatches(verdicts, lookouts)
	return {
		id: clip.id,
		source: clip.source,
		recordedAt: clip.recordedAt,
		durationS: clip.durationS,
		status: clip.status,
		droppedAt: clip.droppedAt,
		reason: clip.reason,
		media: mediaUrls(paths, clip),
		matches,
		newSpecies: newSpecies(store, matches),
		confirmed: store.getLabels({ clipId: clip.id }).some(l => l.truth)
	}
}

/**
 * The first species a keeping verdict named, sure enough to call new (`NEW_SPECIES_CONFIDENCE`), that is
 * not on the life list or is on it without a clip.
 */
const newSpecies = (store: Store, matches: ClipMatch[]) => {
	const named = matches.flatMap(m => (m.species && (m.speciesConfidence ?? 0) >= NEW_SPECIES_CONFIDENCE ? [m.species] : []))
	if (!named.length) return null
	const lifeList = store.lifeListSpecies()
	const withoutClip = store.lifeListWithoutClip()
	return named.find(s => isNewSpecies(s, "newOrClipless", lifeList, withoutClip)) ?? null
}

export const clipDetail = (deps: Deps, clip: Clip): ClipDetail => {
	const lookouts = lookoutMap(deps.store)
	const verdicts = deps.store.getVerdicts(clip.id)
	const usage = deps.store.getUsage(clip.id)
	return {
		...clipSummary(deps, clip, lookouts, verdicts),
		clip,
		verdicts: verdicts.flatMap(v => {
			const l = lookouts.get(v.lookoutId)
			return l ? [{ ...v, lookoutName: l.name, threshold: l.threshold }] : []
		}),
		detections: deps.store.getDetections(clip.id),
		labels: deps.store.getLabels({ clipId: clip.id }),
		usage: {
			calls: usage.length,
			inputTokens: usage.reduce((n, u) => n + u.inputTokens, 0),
			outputTokens: usage.reduce((n, u) => n + u.outputTokens, 0),
			costUsd: usage.reduce((n, u) => n + u.costUsd, 0)
		}
	}
}

// "Kept for this lookout" = the clip is kept AND this lookout's verdict keeps it (the shared rule in
// src/db.ts). A kept clip queued again by a backfill or reprocess still counts on its previous
// verdicts, as in the Sightings feed, so a backfill does not zero every lookout's numbers. Unlike
// the feed, "not this" labels are not dropped here: precision is exactly how often those happen.
const KEPT = /* sql */ `c.status IN ('kept', 'pending', 'processing') AND ${KEEPS_SQL}`
const STATS_SQL = /* sql */ `
SELECT
	(SELECT COUNT(*) FROM verdicts v JOIN clips c ON c.id = v.clip_id
		WHERE v.lookout_id = l.id AND ${KEPT}) AS kept,
	(SELECT COUNT(*) FROM verdicts v WHERE v.lookout_id = l.id) AS judged,
	(SELECT COUNT(*) FROM labels b WHERE b.lookout_id = l.id) AS labeled,
	(SELECT COUNT(*) FROM labels b JOIN clips c ON c.id = b.clip_id JOIN verdicts v ON v.clip_id = b.clip_id AND v.lookout_id = l.id
		WHERE b.lookout_id = l.id AND ${KEPT}) AS kept_labeled,
	(SELECT COUNT(*) FROM labels b JOIN clips c ON c.id = b.clip_id JOIN verdicts v ON v.clip_id = b.clip_id AND v.lookout_id = l.id
		WHERE b.lookout_id = l.id AND b.truth = 1 AND ${KEPT}) AS kept_true,
	(SELECT COUNT(*) FROM labels b WHERE b.lookout_id = l.id AND b.truth = 1) AS positives,
	(SELECT MAX(c.recorded_at) FROM verdicts v JOIN clips c ON c.id = v.clip_id
		WHERE v.lookout_id = l.id AND ${KEPT}) AS last_seen
FROM lookouts l WHERE l.id = ?`

export const lookoutStats = (store: Store, lookoutId: string): LookoutStats => {
	const r = store.db.prepare(STATS_SQL).get(lookoutId) as Record<string, number | string | null> | undefined
	const n = (k: string) => Number(r?.[k] ?? 0)
	const keptLabeled = n("kept_labeled")
	const positives = n("positives")
	return {
		kept: n("kept"),
		judged: n("judged"),
		labeled: n("labeled"),
		precision: keptLabeled ? n("kept_true") / keptLabeled : null,
		// every positive label that was kept is also a kept, labeled-true clip
		recall: positives ? n("kept_true") / positives : null,
		lastSeenAt: (r?.last_seen as string | null) ?? null
	}
}

export const lookoutDto = (store: Store, l: Lookout): LookoutDto => ({ ...l, stats: lookoutStats(store, l.id) })

/** `rtsp://user:secret@host/…` → `rtsp://user:•••@host/…`. */
export const maskUrl = (url: string) => url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^:@/?#]*):[^@/?#]*@/i, "$1:•••@")

/**
 * Whitelists each source's known fields: the config schema keeps undeclared
 * keys, so a `password` someone typed into look4.config.json must not leak.
 */
export const publicSource = (s: SourceConfig): SourceConfig => {
	switch (s.type) {
		case "reolink":
			return {
				type: s.type,
				name: s.name,
				enabled: s.enabled,
				host: s.host,
				username: s.username,
				passwordEnv: s.passwordEnv,
				channel: s.channel,
				stream: s.stream,
				protocol: s.protocol,
				rtspPort: s.rtspPort,
				pollSeconds: s.pollSeconds,
				lookbackHours: s.lookbackHours,
				capture: s.capture,
				segmentSeconds: s.segmentSeconds,
				motionGate: s.motionGate,
				closeUps: s.closeUps
			}
		case "watch":
			return {
				type: s.type,
				name: s.name,
				enabled: s.enabled,
				dir: s.dir,
				extensions: [...s.extensions],
				pollSeconds: s.pollSeconds,
				stableSeconds: s.stableSeconds,
				move: s.move
			}
		case "rtsp":
			return {
				type: s.type,
				name: s.name,
				enabled: s.enabled,
				...(s.url ? { url: maskUrl(s.url) } : {}),
				...(s.urlEnv ? { urlEnv: s.urlEnv } : {}),
				segmentSeconds: s.segmentSeconds
			}
	}
}

export const settingsDto = (config: LoadedConfig): SettingsDto => {
	const { motion, detector, judge, roi } = config.pipeline
	return {
		configPath: config.configPath,
		dataDir: config.dataDir,
		server: { host: config.server.host, port: config.server.port },
		roi,
		motion: {
			sampleFps: motion.sampleFps,
			pixelThreshold: motion.pixelThreshold,
			minArea: motion.minArea,
			maxArea: motion.maxArea,
			maxFrames: motion.maxFrames
		},
		detector: { enabled: detector.enabled, model: detector.model, threshold: detector.threshold, zoom: detector.zoom },
		judge: {
			provider: judge.provider,
			model: judge.model,
			escalateModel: judge.escalateModel,
			escalateBelow: judge.escalateBelow,
			maxCrops: judge.maxCrops,
			cropSize: judge.cropSize
		},
		retention: {
			rejectedDays: config.retention.rejectedDays,
			motionlessDays: config.retention.motionlessDays,
			minFreeGb: config.retention.minFreeGb,
			uncheckedGb: config.retention.uncheckedGb
		},
		alerts: { desktop: config.alerts.desktop },
		sources: config.sources.map(publicSource)
	}
}
