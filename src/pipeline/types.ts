// Contracts between the cascade's stages. Each stage module implements one of these.

import type { Config } from "../config.ts"
import type { ProbeResult } from "../media/ffmpeg.ts"
import type { Clip, Detection, Lookout, MotionResult, NormBox, Usage, Verdict } from "../types.ts"
import type { SeenBird } from "./judge.ts"

export type MotionOptions = Config["pipeline"]["motion"] & { roi: NormBox | null }

/** src/pipeline/motion.ts exports `runMotionGate: MotionGate`. */
export type MotionGate = (clipPath: string, probe: ProbeResult, opts: MotionOptions, signal?: AbortSignal) => Promise<MotionResult>

export type DetectorStatus = { enabled: boolean; model: string; ready: boolean; detail: string }

export type DetectInput = {
	clipId: string
	clipPath: string
	probe: ProbeResult
	motion: MotionResult
	/** Union of the candidate lookouts' detector queries ("bird", "squirrel"). */
	queries: string[]
	roi: NormBox | null
	/** Always zoomed on, motion or not (`pipeline.feeders`). */
	feeders: NormBox[]
	signal?: AbortSignal
}

export type DetectOutput = {
	/** Everything at/above the threshold, after NMS, best first. */
	detections: Detection[]
	/** Full-resolution frames (JPEG) the detector decoded, keyed by `t`, so crops need no second decode. */
	frames: Map<number, Buffer>
}

/** src/pipeline/detect.ts exports `createDetector(cfg, modelsDir): Detector`. */
export type Detector = {
	status(): DetectorStatus
	/** Downloads (first run) and loads the model. Safe to call repeatedly. */
	warmup(): Promise<void>
	detectClip(input: DetectInput): Promise<DetectOutput>
}

export type JudgeCrop = {
	jpeg: Buffer
	frameT: number
	/** Detector label, or "motion" when the detector is off. */
	label: string
	score: number
	box: NormBox
	/** A feeder sheet's tile times, in tile order: the crop is this box at each, not one moment. */
	sheet?: number[]
}

export type JudgeInput = {
	clip: Clip
	/** Lookouts with candidate detections, each compiled. */
	lookouts: Lookout[]
	crops: JudgeCrop[]
	/** One downscaled whole-frame (or ROI) image for context. */
	context: Buffer
	/** The species on the life list, which a lookout may refer to ("a bird not on my life list"). */
	lifeList?: string[]
	/** The life-list species added by hand with no clip yet: a lookout may want to capture one. */
	lifeListWithoutClip?: string[]
	signal?: AbortSignal
}

export type JudgeOutput = {
	/** One per input lookout. `match` is the judge's raw yes/no; the lookout threshold is applied by the caller. */
	verdicts: Verdict[]
	/** Every species the judge saw, with the crop that shows each best. */
	birds: SeenBird[]
	usage: Usage[]
}
