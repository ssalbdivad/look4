// look4's own motion watch on a camera's preview (sub) stream. The camera's motion detection
// almost never fires for a small bird at a feeder (docs/decisions.md §12), so a Reolink source
// recording its stream also decodes the small preview stream and looks for movement itself.
//
// - `createMotionWatch` is the pure part: one grey frame in, a verdict out. No I/O, deterministic,
//   so it is unit-tested on synthetic frames and was tuned offline on real footage.
// - `createStreamMotion` runs ffmpeg on the stream (restart with backoff, stall detection, a
//   refused password stops it for good) and turns the verdicts into one `MotionSample` a second on
//   the recorder's timeline, which `planCapture` joins with the camera's own readings.

import { type ChildProcess, spawn } from "node:child_process"
import type { Readable } from "node:stream"
import type { Logger } from "../log.ts"
import { FFMPEG } from "../media/ffmpeg.ts"
import type { NormBox } from "../types.ts"
import { HEALTHY_RUN_MS, MAX_BACKOFF_MS, MIN_BACKOFF_MS, maskWith, MOTION_KEEP_MS, type MotionSample, RTSP_REFUSED } from "./recorder.ts"

// ---------------------------------------------------------------------------
// The watch (pure)
//
// Every number below was picked on 23 labelled bird pieces and 15 wind-only ones from a real
// RLC-823S1 (docs/decisions.md §12 has the grids). There is deliberately no sensitivity knob:
// every setting that cut wind further lost birds.

/** Frames a second the stream is decoded at: a flyby crossing the frame in 1 s still gives 4 frames for the 2-of-3 rule. */
export const WATCH_FPS = 4
/** The preview stream's 640×360, area-halved: the same recall as full size at a quarter of the cost. */
export const WATCH_WIDTH = 320
export const WATCH_HEIGHT = 180

/** A pixel changed when |frame − background| exceeds max(MIN_DIFF, K × its own noise). */
const MIN_DIFF = 8
const K = 2
/** Noise (mean absolute deviation) a pixel starts with, and its learning rate per frame (≈12 s). */
const NOISE_INIT = 3
const NOISE_RATE = 0.02
/** One frame's difference counts toward the noise at most this many times the pixel's threshold, so a bird doesn't teach its perch to ignore birds. */
const NOISE_CAP = 2
/** Background learning per frame: ≈5 s where nothing changed, 4× slower (≈20 s) where something did, so a sitting bird stays foreground a while. */
const BG_RATE = 0.05
const FG_RATE = BG_RATE * 0.25
/** More than this share of the frame changed: a whole-frame change (a cloud the gain fit missed, a starved keyframe), never motion. */
const GLOBAL_AREA = 0.12
/** Whole-frame changes in a row that mean the camera is moving, and a share that means a new scene on its own (IR day/night switch). */
const RESTART_AFTER = 3
const RESTART_SHARE = 0.5
/** 3×3 majority clean-up: a changed pixel stays when at least this many of its 9 neighbourhood pixels changed. */
const MAJORITY = 5
/** Flicker mask: an EMA (≈25 s) of each pixel toggling between changed and unchanged; above the cut-off it doesn't count. */
const FLICKER_RATE = 0.01
const FLICKER_MAX = 0.05
/** Blob size bounds as a share of the frame: 6 px at 320×180 (a sparrow at the feeders is 6–30 px), up to a quarter of the view. */
const MIN_AREA = 6 / (WATCH_WIDTH * WATCH_HEIGHT)
const MAX_AREA = 0.25
/** Motion is a qualifying blob in PERSIST of the last WINDOW frames: one-frame sparkle never counts. */
const PERSIST = 2
const WINDOW = 3
/** Frames a fresh start learns the scene's noise for before it may report (15 s). */
const WARMUP_FRAMES = 15 * WATCH_FPS

/**
 * Where Reolink draws its clock (top centre) and camera name (lower right) by default. The clock
 * ticks every second; these never count.
 */
export const DEFAULT_OSD: NormBox[] = [
	{ x: 0.26, y: 0, w: 0.48, h: 0.085 },
	{ x: 0.84, y: 0.91, w: 0.16, h: 0.09 }
]

/** The default boxes' sizes: measured on the RLC-823S1's preview stream. */
const OSD_TIME = { w: 0.48, h: 0.085 }
const OSD_NAME = { w: 0.16, h: 0.09 }

/**
 * Where a camera's `GetOsd` answer says its clock and name are, as boxes the watch skips. The
 * camera only names a corner or edge centre, so each box is the default's measured size there;
 * a name longer than the default's widens at ~2% of the frame a character (a guess, generous on
 * purpose: a missed letter would tick into motion less often than the clock, but still would).
 * Null when the answer isn't one this understands; the caller keeps `DEFAULT_OSD`.
 */
export const osdBoxes = (answer: unknown): NormBox[] | null => {
	const osd = (answer as { Osd?: Record<string, { enable?: unknown; pos?: unknown; name?: unknown } | undefined> } | null)?.Osd
	if (!osd || typeof osd !== "object") return null
	const place = (pos: unknown, size: { w: number; h: number }): NormBox | null => {
		const p = String(pos ?? "").toLowerCase()
		const top = /^(upper|top)/.test(p)
		const bottom = /^(lower|bottom)/.test(p)
		if (!top && !bottom) return null
		const x = /left$/.test(p) ? 0 : /right$/.test(p) ? 1 - size.w : /center$/.test(p) ? (1 - size.w) / 2 : null
		if (x === null) return null
		return { x: Math.round(x * 1e4) / 1e4, y: top ? 0 : Math.round((1 - size.h) * 1e4) / 1e4, ...size }
	}
	const out: NormBox[] = []
	for (const [key, base] of [["osdTime", OSD_TIME], ["osdChannel", OSD_NAME]] as const) {
		const item = osd[key]
		if (!item) return null
		if (Number(item.enable) !== 1) continue
		const size = key === "osdChannel" ? { ...base, w: Math.min(0.5, Math.max(base.w, 0.02 * String(item.name ?? "").length)) } : base
		const box = place(item.pos, size)
		if (!box) return null
		out.push(box)
	}
	return out
}

export type MotionWatchOptions = {
	width: number
	height: number
	/** Never analysed, in normalized coordinates: the camera's on-screen clock and name. */
	exclude: NormBox[]
}

export type WatchVerdict = {
	/** This frame counts as motion (a qualifying blob, and one in at least 2 of the last 3 frames). */
	motion: boolean
	/** A whole-frame change: nothing in this frame counts. */
	global: boolean
	/** Still learning the scene after a (re)start: nothing is reported. */
	warming: boolean
	/** The qualifying blobs, largest first. */
	blobs: NormBox[]
}

/**
 * A per-pixel background-subtraction motion detector for small movers in a wide, windy view.
 * Per frame: map the frame onto the background for brightness (gain + offset), mark pixels whose
 * difference exceeds their own noise, drop pixels that keep flickering (leaves, grass), clean up
 * speckle, and look for a blob of bird size that persists. Whole-frame changes never count.
 */
export const createMotionWatch = (o: MotionWatchOptions) => {
	const W = o.width
	const H = o.height
	const N = W * H
	const valid = new Uint8Array(N).fill(1)
	for (const b of o.exclude) {
		const x0 = Math.max(0, Math.floor(b.x * W))
		const x1 = Math.min(W, Math.ceil((b.x + b.w) * W))
		const y0 = Math.max(0, Math.floor(b.y * H))
		const y1 = Math.min(H, Math.ceil((b.y + b.h) * H))
		for (let y = y0; y < y1; y++) valid.fill(0, y * W + x0, y * W + x1)
	}
	let validCount = 0
	for (let p = 0; p < N; p++) validCount += valid[p]!
	const bg = new Float32Array(N)
	const noise = new Float32Array(N)
	const flicker = new Float32Array(N)
	const cur = new Uint8Array(N)
	const fg = new Uint8Array(N)
	/** Last frame's changed pixels, before the flicker mask: what a toggle is measured against. */
	const prevFg = new Uint8Array(N)
	const cleaned = new Uint8Array(N)
	const linked = new Uint8Array(N)
	const seen = new Uint8Array(N)
	const stack = new Int32Array(N)
	const tmp = new Uint8Array(N)
	const recent: boolean[] = []
	let started = false
	let warm = 0
	/** Whole-frame changes in a row. */
	let globalRun = 0

	const restart = (frame: Uint8Array) => {
		for (let p = 0; p < N; p++) bg[p] = frame[p]!
		noise.fill(NOISE_INIT)
		flicker.fill(0)
		prevFg.fill(0)
		recent.length = 0
		globalRun = 0
		warm = WARMUP_FRAMES
	}

	const threshold = (n: number) => (K * n > MIN_DIFF ? K * n : MIN_DIFF)

	/**
	 * Gain + offset mapping `frame`'s brightness onto the background's: per 16-level bin of the frame,
	 * the median background value of those pixels, then a weighted line fit with one inlier refit.
	 * Like `lightingLut` in src/pipeline/motion.ts (a mover is a minority in every bin, so the medians
	 * trace the scene's transfer curve), but over the valid pixels and a float background.
	 */
	const lightingLut = (frame: Uint8Array) => {
		const BINS = 16
		const joint = new Uint32Array(BINS * 256)
		const sum = new Float64Array(BINS)
		const counts = new Uint32Array(BINS)
		let samples = 0
		for (let p = 0; p < N; p += 3) {
			if (!valid[p]) continue
			const b = frame[p]! >> 4
			joint[b * 256 + (bg[p]! | 0)]!++
			sum[b]! += frame[p]!
			counts[b]!++
			samples++
		}
		const pts: { x: number; y: number; w: number }[] = []
		for (let b = 0; b < BINS; b++) {
			const c = counts[b]!
			if (c < samples * 0.005 || c < 8) continue
			let acc = 0
			let y = 0
			for (; y < 256; y++) {
				acc += joint[b * 256 + y]!
				if (acc * 2 >= c) break
			}
			pts.push({ x: sum[b]! / c, y, w: c })
		}
		let gain = 1
		let offset = 0
		const fit = (use: typeof pts) => {
			let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0
			for (const q of use) {
				sw += q.w
				sx += q.w * q.x
				sy += q.w * q.y
				sxx += q.w * q.x * q.x
				sxy += q.w * q.x * q.y
			}
			const den = sw * sxx - sx * sx
			// a flat scene (one populated bin) only supports an offset
			if (use.length < 2 || den <= sw * sw * 4) {
				gain = 1
				offset = (sy - sx) / sw
			} else {
				gain = Math.min(4, Math.max(0.25, (sw * sxy - sx * sy) / den))
				offset = (sy - gain * sx) / sw
			}
		}
		if (pts.length) {
			fit(pts)
			const inliers = pts.filter(q => Math.abs(gain * q.x + offset - q.y) <= MIN_DIFF)
			if (inliers.length && inliers.length < pts.length) fit(inliers)
		}
		const lut = new Uint8Array(256)
		for (let v = 0; v < 256; v++) lut[v] = Math.min(255, Math.max(0, Math.round(gain * v + offset)))
		return lut
	}

	/** Keeps a set pixel when at least `min` of its 3×3 neighbourhood is set (separable box sum). */
	const majority = (src: Uint8Array, out: Uint8Array, min: number) => {
		for (let row = 0; row < N; row += W) {
			tmp[row] = src[row]! + src[row + 1]!
			for (let p = row + 1, end = row + W - 1; p < end; p++) tmp[p] = src[p - 1]! + src[p]! + src[p + 1]!
			tmp[row + W - 1] = src[row + W - 2]! + src[row + W - 1]!
		}
		for (let p = 0; p < N; p++) {
			const s = tmp[p]! + (p >= W ? tmp[p - W]! : 0) + (p + W < N ? tmp[p + W]! : 0)
			out[p] = src[p]! && s >= min ? 1 : 0
		}
	}

	const dilate = (src: Uint8Array, out: Uint8Array) => {
		for (let row = 0; row < N; row += W) {
			tmp[row] = src[row]! | src[row + 1]!
			for (let p = row + 1, end = row + W - 1; p < end; p++) tmp[p] = src[p - 1]! | src[p]! | src[p + 1]!
			tmp[row + W - 1] = src[row + W - 2]! | src[row + W - 1]!
		}
		for (let p = 0; p < W; p++) out[p] = tmp[p]! | tmp[p + W]!
		for (let p = W, end = N - W; p < end; p++) out[p] = tmp[p - W]! | tmp[p]! | tmp[p + W]!
		for (let p = N - W; p < N; p++) out[p] = tmp[p - W]! | tmp[p]!
	}

	/**
	 * 8-connected components of the dilated mask (a bird split by a perch stays one blob), each
	 * sized and boxed by its cleaned pixels only. Keeps those of qualifying size, largest first.
	 */
	const blobs = (): Array<{ area: number; box: NormBox }> => {
		const out: Array<{ area: number; box: NormBox }> = []
		seen.fill(0)
		for (let s = 0; s < N; s++) {
			if (!linked[s] || seen[s]) continue
			let top = 0
			stack[top++] = s
			seen[s] = 1
			let count = 0
			let x0 = W, y0 = H, x1 = -1, y1 = -1
			while (top) {
				const p = stack[--top]!
				const x = p % W
				const y = (p - x) / W
				if (cleaned[p]) {
					count++
					if (x < x0) x0 = x
					if (x > x1) x1 = x
					if (y < y0) y0 = y
					if (y > y1) y1 = y
				}
				for (let dy = -1; dy <= 1; dy++) {
					const yy = y + dy
					if (yy < 0 || yy >= H) continue
					for (let dx = -1; dx <= 1; dx++) {
						const xx = x + dx
						if (xx < 0 || xx >= W) continue
						const q = yy * W + xx
						if (linked[q] && !seen[q]) {
							seen[q] = 1
							stack[top++] = q
						}
					}
				}
			}
			const area = count / N
			if (count && area >= MIN_AREA && area <= MAX_AREA)
				out.push({ area, box: { x: x0 / W, y: y0 / H, w: (x1 - x0 + 1) / W, h: (y1 - y0 + 1) / H } })
		}
		return out.sort((a, b) => b.area - a.area)
	}

	const quiet = (global: boolean, warming: boolean): WatchVerdict => ({ motion: false, global, warming, blobs: [] })

	const push = (frame: Uint8Array): WatchVerdict => {
		if (frame.length !== N) throw new Error(`motion watch: a frame of ${frame.length} bytes, expected ${W}×${H}`)
		if (!started) {
			started = true
			restart(frame)
			return quiet(false, true)
		}
		const lut = lightingLut(frame)
		for (let p = 0; p < N; p++) cur[p] = lut[frame[p]!]!
		// where the mapped frame clipped at black or white the truth lies beyond: compare only within what it can show
		const lo = lut[0]!
		const hi = lut[255]!
		let changed = 0
		for (let p = 0; p < N; p++) {
			if (!valid[p]) {
				fg[p] = 0
				continue
			}
			const raw = bg[p]!
			const b = raw < lo ? lo : raw > hi ? hi : raw
			const f = Math.abs(cur[p]! - b) > threshold(noise[p]!) ? 1 : 0
			fg[p] = f
			changed += f
		}
		const share = changed / validCount

		// A whole-frame change for a frame or two (a keyframe of a starved encoder in dim light, a
		// cloud the gain fit missed) is taken into the background at once and nothing in that frame
		// counts: freezing on each one instead blinded the watch 9–21% of the time at dawn. One that
		// keeps going (the camera moving) or swaps most of the picture (IR switch) is a new scene.
		if (share > GLOBAL_AREA) {
			globalRun++
			if (globalRun >= RESTART_AFTER || share > RESTART_SHARE) {
				restart(cur)
				return quiet(true, true)
			}
			for (let p = 0; p < N; p++) {
				// the change itself is texture the noise model should know about
				const d = Math.abs(cur[p]! - bg[p]!)
				const n = noise[p]!
				const cap = threshold(n) * NOISE_CAP
				noise[p] = n + NOISE_RATE * ((d < cap ? d : cap) - n)
				bg[p] = cur[p]!
			}
			recent.length = 0
			return quiet(true, warm > 0)
		}
		globalRun = 0

		for (let p = 0; p < N; p++) {
			const c = cur[p]!
			const b = bg[p]!
			const d = Math.abs(c - b)
			bg[p] = b + (fg[p] ? FG_RATE : BG_RATE) * (c - b)
			const n = noise[p]!
			const cap = threshold(n) * NOISE_CAP
			noise[p] = n + NOISE_RATE * ((d < cap ? d : cap) - n)
		}

		// Wind makes a leaf's pixels toggle every few frames; a bird that lands and sits toggles its
		// pixels twice (arrive, leave), so it never masks its own perch. The rate is from before this
		// frame, so something that just arrived on a calm pixel counts at once.
		for (let p = 0; p < N; p++) {
			const f = fg[p]!
			if (f && flicker[p]! > FLICKER_MAX) fg[p] = 0
			flicker[p] = flicker[p]! + FLICKER_RATE * ((f ^ prevFg[p]!) - flicker[p]!)
			prevFg[p] = f
		}
		if (warm > 0) {
			warm--
			return quiet(false, true)
		}

		let found: Array<{ area: number; box: NormBox }> = []
		if (changed) {
			majority(fg, cleaned, MAJORITY)
			dilate(cleaned, linked)
			found = blobs()
		}
		const hit = found.length > 0
		recent.push(hit)
		if (recent.length > WINDOW) recent.shift()
		const motion = hit && recent.filter(Boolean).length >= PERSIST
		return { motion, global: false, warming: false, blobs: found.map(b => b.box) }
	}

	return {
		push,
		/** Forgets the scene: the next frame starts over with a warm-up (a new ffmpeg run, the camera moved). */
		reset: () => {
			started = false
		}
	}
}

// ---------------------------------------------------------------------------
// The stream

/** No frame for this long: the stream is hung (a camera that dropped off the network leaves ffmpeg waiting). */
const STALL_MS = 15_000
/** The last frame is older than this: the watch can't say anything about now. */
const FRESH_MS = 5000

export type StreamMotionOptions = {
	/** The preview stream's URL; null when it can't be built (no password). */
	url: () => string | null
	/** The camera's on-screen text, read at each start. Default: Reolink's default places. */
	exclude?: () => NormBox[]
	ffmpeg?: string
	log: Logger
	now?: () => number
	/**
	 * Whether ffmpeg may open the stream now: the source says yes only while its recorder's current run
	 * has had a frame, which proves the password. A restart that isn't allowed waits for `kick()`.
	 */
	allowed: () => boolean
	/** ffmpeg said 401: the camera refused the password. The watch has stopped and is never retried here; the source decides. */
	onRefused: () => void
	/** A frame with motion: its wall-clock time on the recorder's timeline and the moving areas, largest first (close-ups aim with them). */
	onMotion?: (at: number, blobs: NormBox[]) => void
}

/**
 * Runs `createMotionWatch` on a camera's preview stream: ffmpeg decodes it to 320×180 grey at
 * 4 fps on stdout. Readings are one `MotionSample` per wall second (`motion` if any frame in it
 * had motion, `null` while the watch warms up), stamped on the same timeline as the recorder's
 * segments: a run's 0 s is the median of now minus ffmpeg's `out_time`, i.e. when its first frame
 * arrived, and frame i is `i / 4` s after that.
 *
 * ffmpeg restarts with the recorder's backoff (2 s doubling to 5 min, back to 2 s after a minute of
 * frames), and is killed and restarted when no frame has come for 15 s. A 401 stops it for good:
 * every RTSP try with a wrong password counts toward the camera's lockout.
 */
export const createStreamMotion = (o: StreamMotionOptions) => {
	const bin = o.ffmpeg ?? FFMPEG
	const now = o.now ?? Date.now
	const N = WATCH_WIDTH * WATCH_HEIGHT
	const samples: MotionSample[] = []
	let child: ChildProcess | null = null
	let exited: Promise<void> = Promise.resolve()
	let on = false
	let refused = false
	let backoffMs = MIN_BACKOFF_MS
	let restartTimer: NodeJS.Timeout | null = null
	let stallTimer: NodeJS.Timeout | null = null
	/** Wall time of the newest frame, of this run's first frame, and whether the watch is still warming up. */
	let lastFrameAt = -Infinity
	let launchedAt = 0
	let warming = true
	/** Why the watch isn't working, for the status line; null while it is. */
	let why: string | null = "waiting for the recording to start"

	/** Records the second just finished. Several frames share a second: motion in any wins, warm-up in any is unknown. */
	let second: { sec: number; motion: boolean; warming: boolean } | null = null
	const close = () => {
		if (!second) return
		samples.push({ t: (second.sec + 1) * 1000, motion: second.motion ? true : second.warming ? null : false })
		second = null
		const t = now()
		while (samples.length && samples[0]!.t < t - MOTION_KEEP_MS) samples.shift()
	}

	const scheduleRestart = () => {
		if (!on || refused || restartTimer) return
		const wait = backoffMs
		backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
		o.log.info(`restarting the motion watch in ${Math.round(wait / 1000)} s`)
		restartTimer = setTimeout(() => {
			restartTimer = null
			launch()
		}, wait)
	}

	const launch = () => {
		if (!on || refused || child) return
		if (!o.allowed()) {
			why = "waiting for the recording to start"
			return
		}
		const url = o.url()
		if (!url) {
			why = "no password to open the preview stream with"
			return
		}
		const mask = maskWith(url)
		const watch = createMotionWatch({ width: WATCH_WIDTH, height: WATCH_HEIGHT, exclude: o.exclude?.() ?? DEFAULT_OSD })
		const args = [
			"-hide_banner", "-loglevel", "error", "-nostdin", "-progress", "pipe:3",
			...(/^rtsps?:/i.test(url) ? ["-rtsp_transport", "tcp"] : []),
			"-i", url,
			"-map", "0:v:0", "-an",
			"-vf", `fps=${WATCH_FPS},scale=${WATCH_WIDTH}:${WATCH_HEIGHT}:flags=area,format=gray`,
			"-f", "rawvideo", "pipe:1"
		]
		const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe", "pipe"] })
		child = proc
		const launched = now()
		launchedAt = launched
		lastFrameAt = -Infinity
		warming = true
		why = "starting"
		second = null
		/** The run's 0 s on the wall clock: see createSegmentRecorder, which stamps segments the same way. */
		let anchor: number | null = null
		let recent: number[] = []
		let firstFrameAt: number | null = null
		let frames = 0
		let pending: Buffer[] = []
		let pendingBytes = 0
		let stderr = ""
		let spawnError: string | null = null

		const progress = proc.stdio[3] as Readable | null
		let progressText = ""
		progress?.on("data", (d: Buffer) => {
			progressText += d.toString()
			const lines = progressText.split("\n")
			progressText = lines.pop() ?? ""
			for (const line of lines) {
				const m = /^out_time_us=(\d+)/.exec(line)
				if (!m || Number(m[1]) <= 0) continue
				// a median of recent readings shrugs off the burst a camera sends on connect and brief lag
				recent = [...recent.slice(-19), now() - Number(m[1]) / 1000]
				const sorted = [...recent].sort((a, b) => a - b)
				anchor = Math.max(launched, sorted[Math.floor(sorted.length / 2)]!)
			}
		})
		progress?.on("error", () => {})

		const onFrame = (frame: Uint8Array) => {
			const t0 = now()
			lastFrameAt = t0
			firstFrameAt ??= t0
			const at = (anchor ?? firstFrameAt) + (frames * 1000) / WATCH_FPS
			frames++
			const v = watch.push(frame)
			warming = v.warming
			if (!v.warming) why = null
			const sec = Math.floor(at / 1000)
			if (second && sec > second.sec) close()
			if (!second) second = { sec, motion: false, warming: false }
			if (v.motion) second.motion = true
			if (v.warming) second.warming = true
			if (v.motion) o.onMotion?.(at, v.blobs)
		}

		proc.stdout?.on("data", (d: Buffer) => {
			pending.push(d)
			pendingBytes += d.length
			if (pendingBytes < N) return
			let buf = pending.length === 1 ? pending[0]! : Buffer.concat(pending)
			let at = 0
			for (; buf.length - at >= N; at += N) onFrame(new Uint8Array(buf.buffer, buf.byteOffset + at, N))
			buf = buf.subarray(at)
			pending = buf.length ? [buf] : []
			pendingBytes = buf.length
		})
		proc.stderr?.on("data", (d: Buffer) => {
			stderr = (stderr + d.toString()).slice(-4000)
			if (!refused && RTSP_REFUSED.test(mask(stderr))) {
				// every RTSP attempt with a wrong password counts toward the camera's lockout: stop now
				refused = true
				why = "the camera's preview stream (RTSP) turned down the password"
				o.log.warn(`the preview stream turned down the password; the motion watch stops`)
				proc.kill("SIGKILL")
				o.onRefused()
			}
		})
		exited = new Promise(resolve => {
			proc.on("error", e => {
				spawnError = (e as NodeJS.ErrnoException).code === "ENOENT" ? `${bin} not found` : mask(e.message)
			})
			proc.on("close", code => {
				if (child === proc) child = null
				close()
				resolve()
				if (!on || refused) return
				const tail = spawnError ?? (mask(stderr.trim().split("\n").slice(-2).join(" | ")) || "stream ended")
				why = `ffmpeg exited: ${tail}`
				o.log.warn(`motion watch: ffmpeg exited (${code}): ${tail}`)
				if (firstFrameAt !== null && now() - firstFrameAt >= HEALTHY_RUN_MS) backoffMs = MIN_BACKOFF_MS
				scheduleRestart()
			})
		})
		o.log.info(`watching ${mask(url)} for motion`)
	}

	const kill = async () => {
		child?.kill("SIGKILL")
		await exited
	}

	return {
		/** Starts watching; a no-op while it runs or after a refusal until `stop()`. */
		start: () => {
			if (on) return
			on = true
			refused = false
			backoffMs = MIN_BACKOFF_MS
			launch()
			stallTimer = setInterval(() => {
				if (!child) return
				const since = Math.max(lastFrameAt, launchedAt)
				if (now() - since <= STALL_MS) return
				why = `no picture for ${STALL_MS / 1000} s`
				o.log.warn(`motion watch: ${why}; restarting ffmpeg`)
				child.kill("SIGKILL")
			}, 1000)
			stallTimer.unref()
		},
		stop: async () => {
			on = false
			if (restartTimer) clearTimeout(restartTimer)
			restartTimer = null
			if (stallTimer) clearInterval(stallTimer)
			stallTimer = null
			await kill()
			if (!refused) why = "stopped"
		},
		/** One reading per second, oldest first, the last 15 minutes. */
		samples: () => samples,
		/**
		 * Starts ffmpeg now if the watch is meant to run but has no ffmpeg (waiting out a backoff that
		 * grew while the camera was away, or not allowed then): the recorder's new run just proved the
		 * camera is back and takes the password.
		 */
		kick: () => {
			if (!on || refused || child) return
			if (restartTimer) clearTimeout(restartTimer)
			restartTimer = null
			backoffMs = MIN_BACKOFF_MS
			launch()
		},
		/** Meant to be running: started, not stopped or refused (it may be waiting to restart). */
		running: () => on && !refused,
		/** Frames are coming and the watch has learned the scene: its readings say something about now. */
		healthy: () => child !== null && !warming && now() - lastFrameAt <= FRESH_MS,
		/** Frames are coming but the watch is still learning the scene (15 s after each start). */
		warming: () => child !== null && warming && now() - lastFrameAt <= FRESH_MS,
		/** Why the watch can't say anything right now; null while it is healthy. */
		detail: (): string | null => {
			if (child !== null && !warming && now() - lastFrameAt <= FRESH_MS) return null
			return why ?? "starting"
		}
	}
}

export type StreamMotion = ReturnType<typeof createStreamMotion>
