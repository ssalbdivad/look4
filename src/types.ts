// Shared domain types. Every module codes against these; change them only in
// the orchestrating pass, never from inside one module.

/** A rectangle in normalized coordinates (0..1) of the FULL video frame. */
export type NormBox = { x: number; y: number; w: number; h: number }

export type ClipStatus = "pending" | "processing" | "kept" | "rejected" | "error"

/** The cascade, cheapest first. A rejected clip records the stage that dropped it. */
export type Stage = "probe" | "motion" | "detect" | "judge"

export type Clip = {
	/** Time-sortable and human-readable: `20261014-153012-a1b2c3`. */
	id: string
	/** Name of the source that produced it: a configured source's `name`, or `inbox`, `upload`, `scan`. */
	source: string
	/** Adapter-specific unique reference (Reolink file path, watched file path). Used to skip re-downloads. */
	sourceRef: string | null
	originalName: string
	/** Absolute path to the stored clip, or null once retention has deleted it. */
	path: string | null
	sizeBytes: number
	sha256: string
	/** Best guess at when the event happened (from the camera's filename, metadata, or mtime). ISO 8601. */
	recordedAt: string
	ingestedAt: string
	durationS: number | null
	width: number | null
	height: number | null
	status: ClipStatus
	/** Stage that rejected the clip; null unless status is `rejected`. */
	droppedAt: Stage | null
	/** One-line, human-readable reason for the current status ("no motion", "no bird detected", "judge: a sparrow, not a cardinal"). */
	reason: string | null
	motion: MotionResult | null
	/** Wall-clock milliseconds spent per stage on the last run. */
	timings: Partial<Record<Stage, number>>
	error: string | null
	processedAt: string | null
	/** When retention deletes the file. Null = never (kept, labeled, or pending). */
	expiresAt: string | null
	/** Restricts the next processing run to these lookouts (a backfill). Null = every enabled lookout. */
	pendingLookouts: string[] | null
	/** Artifacts under `<dataDir>/media/<id>/`, as file names relative to that directory. */
	media: ClipMedia
}

export type MotionFrame = {
	/** Seconds from the start of the clip. */
	t: number
	/** Fraction of ROI pixels that changed in this frame, after lighting compensation. */
	score: number
	/** Bounding box of the changed region, in full-frame normalized coordinates. */
	box: NormBox | null
	/** Other significant changed regions in this frame, largest first (excludes `box`). */
	boxes?: NormBox[]
}

export type MotionResult = {
	/** Peak per-frame changed fraction across the clip. */
	score: number
	passed: boolean
	/** Human-readable explanation, e.g. "peak 0.4% of the zone changed" or "global light change". */
	reason: string
	/** Candidate frames for the detector, best first, at most `motion.maxFrames`, or one per 10 s of a longer clip. */
	frames: MotionFrame[]
	sampledFrames: number
}

export type LifeListMode = "new" | "newOrClipless"

export type CompiledLookout = {
	/** Generic object nouns the open-vocabulary detector should look for: ["bird"], ["squirrel"], ["person", "dog"]. */
	queries: string[]
	/** What the judge must confirm, written as explicit criteria. */
	rubric: string
	/** Short display label, e.g. "Cardinal or blue jay at the feeder". */
	summary: string
	/** Whether the call needs fine detail (species, behavior) — the judge then gets bigger crops. */
	fineGrained: boolean
	/**
	 * Set when the lookout wants birds new to the life list: `new` for a species not on it,
	 * `newOrClipless` also for one on it by hand without a clip. look4 then decides newness itself
	 * from the judge's species (`judge.ts`); the judge only identifies. Absent on older compiles.
	 */
	lifeList?: LifeListMode | null
	/** sha256 of the prompt + compiler version; recompile when it no longer matches. */
	promptHash: string
	/** "anthropic:claude-haiku-5-5", "claude-code:haiku", "manual", or "fallback". */
	compiler: string
}

export type Lookout = {
	id: string
	name: string
	/** The user's own words: "a cardinal or blue jay at the feeder". */
	prompt: string
	enabled: boolean
	/** Judge confidence (0..1) needed to keep a clip for this lookout. */
	threshold: number
	compiled: CompiledLookout | null
	createdAt: string
	updatedAt: string
}

export type Detection = {
	clipId: string
	/** Seconds into the clip of the frame it was found on. */
	frameT: number
	/** The detector query that matched ("bird"). */
	label: string
	score: number
	box: NormBox
	/** `full` = found on the whole ROI frame; `zoom` = found on a crop around the motion region. */
	via: "full" | "zoom"
}

export type Verdict = {
	clipId: string
	lookoutId: string
	match: boolean
	confidence: number
	/** What the judge saw, as specifically as it can say ("Northern Cardinal (male)"). */
	label: string | null
	/**
	 * The bird's species by its plain common name ("Mourning Dove"), when the judge thinks one is more
	 * likely than not; what the life list is matched on. Absent on detector-only and older verdicts.
	 */
	species?: string | null
	/** How sure the judge is of `species`, 0 to 1; absent without one and on older verdicts. */
	speciesConfidence?: number | null
	rationale: string
	/** "anthropic:claude-haiku-5-5" etc. */
	model: string
	createdAt: string
}

/** A species on the life list: every bird seen at the camera at least once. */
export type LifeListEntry = {
	species: string
	/** When it was first seen: the confirmed clip's time, or the date given by hand; null when unknown. */
	firstSeenAt: string | null
	/** The clip it was confirmed from; null when added by hand (or that clip was since deleted). */
	clipId: string | null
	addedAt: string
}

/** Human ground truth from the UI, for eval and threshold tuning. */
export type Label = {
	clipId: string
	lookoutId: string
	truth: boolean
	createdAt: string
}

export type UsagePurpose = "judge" | "compile"

export type Usage = {
	ts: string
	clipId: string | null
	purpose: UsagePurpose
	/** "anthropic" | "claude-code" | "mock" */
	backend: string
	model: string
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	/** Estimated USD. For the claude-code backend this is the notional API price, not a bill. */
	costUsd: number
}

/** Files the pipeline writes for a clip, under `<dataDir>/media/<clipId>/`, as bare file names. */
export type ClipMedia = {
	/** Best frame (whole frame, ROI outlined or not), JPEG: "poster.jpg". */
	poster: string | null
	/** H.264 MP4 any browser plays, kept clips only: "preview.mp4". */
	preview: string | null
	/** Crops the judge saw, JPEG, best first: ["crop-0.jpg", ...]. */
	crops: string[]
}

export type SourceState = "starting" | "ok" | "idle" | "error" | "stopped"

export type SourceStatus = {
	name: string
	type: string
	state: SourceState
	detail: string
	lastPollAt: string | null
	lastClipAt: string | null
	clipsIngested: number
}
