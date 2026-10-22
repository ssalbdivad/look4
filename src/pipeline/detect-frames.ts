// Decoding the detector's candidate frames at full resolution. On a 4K H.265 clip
// decoding, not inference, is the expensive part: every `-ss` seek decodes from the
// previous keyframe, and cameras often use long GOPs. So we read where the keyframes
// are (a demux-only ffprobe, ~0.1 s) and pick whichever costs fewer decoded frames:
// one seek per frame, or a single pass over the span that selects every frame at once.

import { extractFrame, FFMPEG, FFPROBE, run } from "../media/ffmpeg.ts"

/** ffmpeg start-up plus decoder init, in decoded-frame equivalents (measured: ~0.5 s ≈ 25 4K HEVC frames). */
const SPAWN_COST_FRAMES = 25

/** Presentation times of the video stream's keyframes, sorted. Empty when they can't be read. */
export const keyframeTimes = async (path: string, signal?: AbortSignal): Promise<number[]> => {
	try {
		const out = await run(
			FFPROBE,
			["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", path],
			{ signal }
		)
		const times: number[] = []
		for (const line of out.toString().split("\n")) {
			const [t, flags] = line.split(",")
			if (flags?.includes("K") && t && Number.isFinite(Number(t))) times.push(Number(t))
		}
		return times.sort((a, b) => a - b)
	} catch {
		return []
	}
}

const keyframeAtOrBefore = (keyframes: number[], t: number) => {
	let kf = 0
	for (const k of keyframes) {
		if (k > t + 1e-6) break
		kf = k
	}
	return kf
}

export type FramePlan = { mode: "seek" } | { mode: "batch"; start: number; indices: number[] }

/**
 * Seek per frame, or one pass from the keyframe before the earliest time? Costs are
 * decoded frames plus a fixed per-process overhead. With no keyframe info we assume
 * one at t=0 only (the worst case for seeking), which favors a single pass.
 */
export const planFrames = (times: number[], keyframes: number[], fps: number): FramePlan => {
	if (times.length < 2 || !(fps > 0)) return { mode: "seek" }
	const kfs = keyframes.length ? keyframes : [0]
	const seekCost = times.reduce((sum, t) => sum + (t - keyframeAtOrBefore(kfs, t)) * fps + 1 + SPAWN_COST_FRAMES, 0)
	const sorted = [...times].sort((a, b) => a - b)
	const start = keyframeAtOrBefore(kfs, sorted[0]!)
	const batchCost = (sorted.at(-1)! - start) * fps + 1 + SPAWN_COST_FRAMES
	if (batchCost >= seekCost) return { mode: "seek" }
	// frame indices counted from `start`, which is where select's `n` restarts after the input seek
	return { mode: "batch", start, indices: [...new Set(sorted.map(t => Math.max(0, Math.round((t - start) * fps))))] }
}

/** Splits ffmpeg's image2pipe MJPEG stream into individual JPEGs (each ends with the EOI marker FFD9). */
export const splitJpegs = (buf: Buffer): Buffer[] => {
	const out: Buffer[] = []
	let start = buf.indexOf(Buffer.from([0xff, 0xd8]))
	while (start >= 0) {
		const end = buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2)
		if (end < 0) break
		out.push(buf.subarray(start, end + 2))
		start = buf.indexOf(Buffer.from([0xff, 0xd8]), end + 2)
	}
	return out
}

/** One decode pass returning the frames at `indices` (counted from `start`), in index order. */
const batchExtract = async (path: string, start: number, indices: number[], signal?: AbortSignal) => {
	const select = indices.map(n => `eq(n\\,${n})`).join("+")
	const out = await run(
		FFMPEG,
		[
			"-hide_banner", "-loglevel", "error",
			...(start > 0 ? ["-ss", start.toFixed(3)] : []),
			"-i", path,
			"-vf", `select='${select}'`,
			"-vsync", "0",
			// stop decoding as soon as the last wanted frame is out
			"-frames:v", String(indices.length),
			"-q:v", "3",
			"-f", "image2pipe", "-c:v", "mjpeg",
			"pipe:1"
		],
		{ signal }
	)
	return splitJpegs(out)
}

/**
 * Full-resolution JPEGs for `times`, decoded the cheapest way. Returns a function that
 * yields one frame on demand: in seek mode frames are decoded lazily, so a caller that
 * stops early (the detector, once it is sure) never pays for the rest.
 */
export const frameSource = async (
	path: string,
	times: number[],
	fps: number,
	signal?: AbortSignal
): Promise<{ mode: FramePlan["mode"]; get: (t: number) => Promise<Buffer> }> => {
	const plan = times.length > 1 ? planFrames(times, await keyframeTimes(path, signal), fps) : ({ mode: "seek" } as const)
	if (plan.mode === "batch") {
		try {
			const jpegs = await batchExtract(path, plan.start, plan.indices, signal)
			const byIndex = new Map(plan.indices.map((n, i) => [n, jpegs[i]]))
			return {
				mode: "batch",
				get: async t => byIndex.get(Math.max(0, Math.round((t - plan.start) * fps))) ?? extractFrame(path, t)
			}
		} catch {
			signal?.throwIfAborted()
			// a select pass can trip over odd streams; per-frame seeks are slower but forgiving
		}
	}
	return { mode: "seek", get: t => extractFrame(path, t) }
}
