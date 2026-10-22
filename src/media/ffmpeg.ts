import { spawn } from "node:child_process"
import type { NormBox } from "../types.ts"
import { clampBox } from "../geometry.ts"
import { logger } from "../log.ts"

const log = logger("ffmpeg")

export const FFMPEG = process.env.LOOK4_FFMPEG ?? "ffmpeg"
export const FFPROBE = process.env.LOOK4_FFPROBE ?? "ffprobe"

export class FfmpegError extends Error {
	readonly stderr: string
	constructor(message: string, stderr: string) {
		super(message)
		this.stderr = stderr
	}
}

/** Runs a binary to completion and returns stdout as a Buffer. Rejects with the stderr tail on non-zero exit. */
export const run = (bin: string, args: string[], opts: { signal?: AbortSignal } = {}): Promise<Buffer> =>
	new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], signal: opts.signal })
		const out: Buffer[] = []
		let err = ""
		child.stdout.on("data", (d: Buffer) => out.push(d))
		child.stderr.on("data", (d: Buffer) => {
			err += d.toString()
			if (err.length > 20_000) err = err.slice(-10_000)
		})
		child.on("error", reject)
		child.on("close", code => {
			if (code === 0) resolve(Buffer.concat(out))
			else reject(new FfmpegError(`${bin} exited ${code}: ${err.trim().split("\n").slice(-3).join(" | ")}`, err))
		})
	})

export type ProbeResult = {
	durationS: number
	/** Display dimensions: already swapped for clips with 90/270° rotation metadata, matching what ffmpeg decodes. */
	width: number
	height: number
	codec: string
	fps: number
	/** Rotation metadata in degrees (0, 90, 180, 270). Absent means none. */
	rotation?: number
}

export const probe = async (path: string): Promise<ProbeResult> => {
	const raw = await run(FFPROBE, [
		"-v", "error",
		"-select_streams", "v:0",
		"-show_entries", "stream=codec_name,width,height,avg_frame_rate,r_frame_rate,duration:stream_tags=rotate:format=duration",
		"-of", "json",
		path
	])
	const json = JSON.parse(raw.toString()) as {
		streams?: Array<{
			codec_name?: string
			width?: number
			height?: number
			avg_frame_rate?: string
			r_frame_rate?: string
			duration?: string
			tags?: { rotate?: string }
		}>
		format?: { duration?: string }
	}
	const s = json.streams?.[0]
	if (!s?.width || !s.height) throw new FfmpegError(`no video stream in ${path}`, raw.toString())
	const rate = (r?: string) => {
		const [n, d] = (r ?? "0/1").split("/").map(Number)
		return n && d ? n / d : 0
	}
	const rotation = (((Number(s.tags?.rotate ?? 0) || 0) % 360) + 360) % 360
	// ffmpeg autorotates on decode, so every consumer (crops, aspect ratios, the UI) sees display dimensions
	const sideways = rotation === 90 || rotation === 270
	return {
		durationS: Number(s.duration ?? json.format?.duration ?? 0) || 0,
		width: sideways ? s.height : s.width,
		height: sideways ? s.width : s.height,
		codec: s.codec_name ?? "unknown",
		fps: rate(s.avg_frame_rate) || rate(s.r_frame_rate),
		...(rotation ? { rotation } : {})
	}
}

/** ffmpeg crop filter for a normalized box, using the input's own dimensions. */
export const cropFilter = (box: NormBox) => {
	const b = clampBox(box)
	const f = (n: number) => n.toFixed(6)
	// trunc(.../2)*2 keeps dimensions even, which most encoders require
	return `crop=trunc(iw*${f(b.w)}/2)*2:trunc(ih*${f(b.h)}/2)*2:trunc(iw*${f(b.x)}):trunc(ih*${f(b.y)})`
}

export type PixelRect = { left: number; top: number; width: number; height: number }

/** One keyframe's regions: RGB, `tile`×`tile` each, in the order the rects were given. */
export type KeyframeRegions = { t: number; tiles: Buffer[] }

/**
 * Every keyframe of a clip, cut to `rects` (in the decoded frame's pixels) and each scaled to a
 * `tile`-pixel square, in one decode. Keyframes decode without their neighbours, so this sees a whole
 * clip cheaply: the camera's every-2 s keyframes of a 24 s 4K clip in ~3 s, where seeking to 12
 * arbitrary frames costs ~1.5 s each. Times come from the packet index.
 */
export const keyframeRegions = async (path: string, rects: PixelRect[], tile: number, signal?: AbortSignal): Promise<KeyframeRegions[]> => {
	if (!rects.length) return []
	const packets = await run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", path], { signal })
	const times = packets
		.toString()
		.split("\n")
		.flatMap(line => {
			const [pts, flags] = line.split(",")
			return flags?.includes("K") && pts && Number.isFinite(Number(pts)) ? [Number(pts)] : []
		})
		.sort((a, b) => a - b)
	// side by side in one output frame: [0:v] split → crop+scale each → hstack
	const cut = (r: PixelRect) => `crop=${r.width}:${r.height}:${r.left}:${r.top},scale=${tile}:${tile}`
	const graph =
		rects.length === 1
			? `[0:v]${cut(rects[0]!)},format=rgb24[out]`
			: `[0:v]split=${rects.length}${rects.map((_, i) => `[s${i}]`).join("")};` +
				rects.map((r, i) => `[s${i}]${cut(r)}[c${i}]`).join(";") +
				`;${rects.map((_, i) => `[c${i}]`).join("")}hstack=inputs=${rects.length},format=rgb24[out]`
	const raw = await run(
		FFMPEG,
		["-hide_banner", "-loglevel", "error", "-nostdin", "-skip_frame", "nokey", "-i", path, "-filter_complex", graph, "-map", "[out]", "-vsync", "0", "-f", "rawvideo", "pipe:1"],
		{ signal }
	)
	const row = tile * 3
	const frameBytes = row * tile * rects.length
	const n = Math.min(times.length, Math.floor(raw.length / frameBytes))
	return Array.from({ length: n }, (_, i) => {
		const frame = raw.subarray(i * frameBytes, (i + 1) * frameBytes)
		const tiles = rects.map((_, r) => {
			const out = Buffer.alloc(row * tile)
			for (let y = 0; y < tile; y++) frame.copy(out, y * row, (y * rects.length + r) * row, (y * rects.length + r + 1) * row)
			return out
		})
		return { t: times[i]!, tiles }
	})
}

/**
 * One frame at `t` seconds as a JPEG. `crop` is applied first (full-frame normalized
 * coords); `maxEdge` then bounds the long edge.
 */
export const extractFrame = (
	path: string,
	t: number,
	opts: { crop?: NormBox | null; maxEdge?: number; quality?: number } = {}
): Promise<Buffer> => {
	const filters: string[] = []
	if (opts.crop) filters.push(cropFilter(opts.crop))
	if (opts.maxEdge)
		filters.push(`scale='if(gt(iw,ih),min(${opts.maxEdge},iw),-2)':'if(gt(iw,ih),-2,min(${opts.maxEdge},ih))'`)
	return run(FFMPEG, [
		"-hide_banner", "-loglevel", "error",
		"-ss", Math.max(0, t).toFixed(3),
		"-i", path,
		"-frames:v", "1",
		...(filters.length ? ["-vf", filters.join(",")] : []),
		"-q:v", String(opts.quality ?? 3),
		"-f", "image2", "-c:v", "mjpeg",
		"pipe:1"
	])
}

/** A small H.264 MP4 every browser can play (camera clips are often H.265). */
export const makePreview = async (src: string, out: string, opts: { maxHeight?: number } = {}) => {
	const h = opts.maxHeight ?? 720
	await run(FFMPEG, [
		"-hide_banner", "-loglevel", "error", "-y",
		"-i", src,
		"-vf", `scale=-2:'min(${h},ih)'`,
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-b:a", "96k",
		"-movflags", "+faststart",
		out
	])
}

/** True when both binaries run. */
export const ffmpegAvailable = async () => {
	try {
		await run(FFMPEG, ["-version"])
		await run(FFPROBE, ["-version"])
		return true
	} catch {
		return false
	}
}

/** The exact pixel rectangle `cropFilter(box)` selects from a `width`×`height` frame. */
export const cropPixels = (box: NormBox, width: number, height: number) => {
	const b = clampBox(box)
	const x = Math.trunc(width * b.x)
	const y = Math.trunc(height * b.y)
	return {
		x,
		y,
		w: Math.max(2, Math.min(Math.trunc((width * b.w) / 2) * 2, (width - x) & ~1)),
		h: Math.max(2, Math.min(Math.trunc((height * b.h) / 2) * 2, (height - y) & ~1))
	}
}

export type GrayVideo = {
	width: number
	height: number
	/** Frames per second sampled. Frame `i` is the last source frame at or before `i / fps` seconds. */
	fps: number
	/** One 8-bit luma plane per sampled frame, `width * height` bytes each. */
	frames: Uint8Array[]
	/** The decoded region in full-frame normalized coords (the even-pixel crop actually applied). */
	region: NormBox
	decoder: "cpu" | "cuvid"
}

export type DecodeGrayOptions = {
	fps: number
	crop?: NormBox | null
	/** Long edge of the output frames; never upscales. */
	maxEdge: number
	/** Stop after this many frames. */
	maxFrames: number
	signal?: AbortSignal
}

const cuvidDecoders: Record<string, string> = { hevc: "hevc_cuvid", h264: "h264_cuvid" }
const HWDEC_MIN_PIXELS = 2560 * 1440

/**
 * Whether to try NVDEC on the next clip. One failure is weak evidence (an odd
 * bitstream, a CUDA out-of-memory while a game holds the GPU), so it takes
 * `limit` failures in a row to switch it off, and after `coolDownMs` one clip
 * tries it again; a success forgets past failures. On a machine without
 * working NVDEC that costs one failed GPU attempt per cool-down.
 */
export const createHwdecHealth = (opts: { limit?: number; coolDownMs?: number; now?: () => number } = {}) => {
	const limit = opts.limit ?? 3
	const coolDownMs = opts.coolDownMs ?? 30 * 60_000
	const now = opts.now ?? Date.now
	let failures = 0
	let offSince: number | null = null
	return {
		usable: () => offSince === null || now() - offSince >= coolDownMs,
		succeeded: () => {
			failures = 0
			offSince = null
		},
		/** Returns true when this failure switched NVDEC off. */
		failed: () => {
			failures++
			// a failed re-probe after a cool-down starts the next one straight away
			if (offSince === null && failures < limit) return false
			const wasOn = offSince === null
			offSince = now()
			return wasOn
		}
	}
}

const nvdec = createHwdecHealth()

const hwdecMode = () => {
	const v = (process.env.LOOK4_HWDEC ?? "auto").toLowerCase()
	return v === "0" || v === "off" || v === "none" || v === "cpu" ? "off" : "auto"
}

/**
 * Decodes a clip to small grayscale frames at `fps`, streamed straight off ffmpeg's stdout.
 *
 * Decoding dominates (a 20 s 4K HEVC clip is ~24 CPU-seconds on the software decoder), so H.264/HEVC
 * go through NVDEC (`*_cuvid`, cropping and resizing on the GPU) when it works, and fall back to the
 * CPU decoder otherwise. `LOOK4_HWDEC=off` forces the CPU path.
 */
export const decodeGray = async (path: string, info: ProbeResult, opts: DecodeGrayOptions): Promise<GrayVideo> => {
	const px = cropPixels(opts.crop ?? { x: 0, y: 0, w: 1, h: 1 }, info.width, info.height)
	const scale = Math.min(1, opts.maxEdge / Math.max(px.w, px.h))
	const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
	const width = even(px.w * scale)
	const height = even(px.h * scale)
	const region: NormBox = { x: px.x / info.width, y: px.y / info.height, w: px.w / info.width, h: px.h / info.height }
	const base = { width, height, fps: opts.fps, region }

	const cuvid = cuvidDecoders[info.codec]
	// NVDEC costs ~1 s of setup per clip, which only pays off on big frames (the camera's 4K HEVC).
	const big = info.width * info.height >= HWDEC_MIN_PIXELS
	if (cuvid && big && nvdec.usable() && !info.rotation && hwdecMode() === "auto") {
		// NVDEC crops in coded pixels and resizes on the GPU; it resizes to 2x so the CPU's area
		// filter does the final averaging (NVDEC's own downscale aliases sensor noise into "motion").
		const gw = Math.min(px.w, width * 2) & ~1
		const gh = Math.min(px.h, height * 2) & ~1
		const args = [
			"-hide_banner", "-loglevel", "error", "-nostdin",
			"-c:v", cuvid,
			"-crop", `${px.y}x${info.height - px.y - px.h}x${px.x}x${info.width - px.x - px.w}`,
			"-resize", `${gw}x${gh}`,
			"-i", path,
			"-an", "-sn",
			"-vf", `fps=${opts.fps}:round=up,scale=${width}:${height}:flags=area,format=gray`,
			"-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"
		]
		try {
			const frames = await streamFrames(args, width * height, opts)
			nvdec.succeeded()
			return { ...base, frames, decoder: "cuvid" }
		} catch (e) {
			if (opts.signal?.aborted) throw e
			const frames = await streamFrames(cpuArgs(path, px, width, height, opts.fps), width * height, opts)
			// only once the CPU managed the same clip is it NVDEC's fault, not a broken file's
			if (nvdec.failed()) log.warn(`NVDEC decode keeps failing, using the CPU decoder for the next 30 min: ${(e as Error).message}`)
			else log.debug(`NVDEC decode failed on this clip, the CPU decoded it: ${(e as Error).message}`)
			return { ...base, frames, decoder: "cpu" }
		}
	}
	return { ...base, frames: await streamFrames(cpuArgs(path, px, width, height, opts.fps), width * height, opts), decoder: "cpu" }
}

const cpuArgs = (path: string, px: { x: number; y: number; w: number; h: number }, width: number, height: number, fps: number) => [
	"-hide_banner", "-loglevel", "error", "-nostdin",
	"-i", path,
	"-an", "-sn",
	// fps first so crop/scale only touch sampled frames; area scaling averages away sensor noise
	"-vf", `fps=${fps}:round=up,crop=${px.w}:${px.h}:${px.x}:${px.y},scale=${width}:${height}:flags=area,format=gray`,
	"-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"
]

/** Runs ffmpeg and slices its raw stdout into fixed-size frames as they arrive. Stops early at `maxFrames`. */
const streamFrames = (args: string[], frameSize: number, opts: { maxFrames: number; signal?: AbortSignal }) =>
	new Promise<Uint8Array[]>((resolve, reject) => {
		const child = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"], signal: opts.signal })
		const frames: Uint8Array[] = []
		let cur = new Uint8Array(frameSize)
		let filled = 0
		let enough = false
		let err = ""
		child.stdout.on("data", (d: Buffer) => {
			if (enough) return
			for (let i = 0; i < d.length; ) {
				const n = Math.min(frameSize - filled, d.length - i)
				cur.set(d.subarray(i, i + n), filled)
				filled += n
				i += n
				if (filled === frameSize) {
					frames.push(cur)
					cur = new Uint8Array(frameSize)
					filled = 0
					if (frames.length >= opts.maxFrames) {
						enough = true
						child.kill("SIGKILL")
						return
					}
				}
			}
		})
		child.stderr.on("data", (d: Buffer) => {
			err += d.toString()
			if (err.length > 20_000) err = err.slice(-10_000)
		})
		child.on("error", reject)
		child.on("close", code => {
			if (code === 0 || enough) resolve(frames)
			else reject(new FfmpegError(`${FFMPEG} exited ${code}: ${err.trim().split("\n").slice(-3).join(" | ")}`, err))
		})
	})
