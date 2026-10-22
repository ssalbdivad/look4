// Recording a camera's stream: one ffmpeg cutting it into short segments, the
// choice of which segments become clips, and saving a clip from the Live view.
//
// - `createSegmentRecorder` keeps ffmpeg running (restart with backoff, stall
//   detection) and says which segments are finished and when each one started.
// - `planCapture` is the pure part: segments plus motion samples (the camera's own
//   detection, look4's watch of its preview stream: src/sources/stream-motion.ts)
//   → clips (pre-/post-roll, merged, split at 2 min) and footage nobody flagged.
// - `createStreamCapture` runs both and owns the files: ingest, the `unchecked/`
//   folder (its floor sweep; age and size are src/retention.ts's), and Record (`LiveRecorder`).

import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { copyFile, open, readdir, rename, stat, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { LiveRecordSaved, LiveRecordStarted } from "../api-types.ts"
import type { IngestInput } from "../context.ts"
import type { Logger } from "../log.ts"
import { FFMPEG, FFPROBE, probe, run } from "../media/ffmpeg.ts"
import { localDate } from "../paths.ts"
import { pinKey } from "../pipeline/process.ts"
import { freeBytes, sweepUnchecked, UNCHECKED_HEADROOM_BYTES } from "../retention.ts"
import { errorMessage, type SourceContext } from "./common.ts"

/** Hides `user:pass@` in any URL inside `text`. */
export const maskUrl = (text: string) => text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, "$1***@")

/**
 * ffmpeg's words for an RTSP server refusing the login (rtsp.c's `method DESCRIBE failed: 401 Unauthorized`,
 * avformat's `Server returned 401 Unauthorized`). Test it on masked stderr, and nothing looser: a password
 * like `Bird!401` in an echoed URL, or a decoder line like `error while decoding MB 14 18, bytestream 401`,
 * would otherwise read as a wrong password and stop the source.
 */
export const RTSP_REFUSED = /method \w+ failed: 401\b|Server returned 401 Unauthorized/

/** Masks the URL's credentials, and also the bare password, which ffmpeg sometimes echoes on its own. */
export const maskWith = (url: string) => {
	let secrets: string[] = []
	try {
		const u = new URL(url)
		secrets = [u.password, decodeURIComponent(u.password)].filter(s => s.length >= 3)
	} catch {}
	return (text: string) => {
		let out = maskUrl(text)
		for (const s of secrets) out = out.split(s).join("***")
		return out
	}
}

const pad = (n: number) => String(n).padStart(2, "0")
/** `20261014_093012` in local time: the stamp ingest reads back as the recording time. */
export const stampOf = (d: Date) =>
	`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

// ---------------------------------------------------------------------------
// The segment recorder

export const MIN_BACKOFF_MS = 2000
export const MAX_BACKOFF_MS = 5 * 60_000
/** ffmpeg that has run this long counts as healthy, so the next failure restarts quickly. */
export const HEALTHY_RUN_MS = 60_000
/** ffmpeg can't put this audio track in an MP4 (G.711 and friends): record video only. */
const AUDIO_UNSUPPORTED = /Could not find tag for codec|not currently supported in container/i

/** A finished segment on disk. `start`/`end` are wall-clock ms. */
export type Segment = { file: string; path: string; start: number; end: number; size: number }

export type SegmentRecorderOptions = {
	/** File prefix (the source's name). */
	name: string
	dir: string
	/** The input; null when it isn't configured (`missing()` says what to do). */
	url: () => string | null
	missing: () => string
	segmentSeconds: number
	/** Keep the input's first audio track (copied). Drops to video only when MP4 can't hold it. */
	audio: boolean
	ffmpeg?: string
	log: Logger
	/** ffmpeg started (`ok`, with what it records) or stopped working (`error`, with why). */
	onState: (state: "ok" | "error", detail: string) => void
	/** Whether to start ffmpeg again after it exited with this stderr; false waits for `resume()`. Default: always. */
	retry?: (stderr: string) => boolean
	/**
	 * Each run's first frame arrived: the input opened and the password was taken. Whatever else
	 * opens the same camera waits for this, so a wrong password costs one try, not one per reader.
	 */
	onFlowing?: () => void
}

/**
 * ffmpeg's CSV segment list of one run: `file,start,end` per finished segment
 * (seconds into the run), flushed as each closes. Read from where the last read
 * stopped: a week-long run lists 100,000 segments, and parsing all of them every
 * cycle took most of a second. `entries` only holds segments still on disk
 * (`prune`); `count` is every line ever read, for stall detection. Reads are
 * chained on `reading`: Record's save and the capture cycle both read, and two
 * reads from the same offset would advance it twice and skip what lay between.
 */
type SegmentList = {
	read: number
	rest: string
	count: number
	entries: Map<string, { start: number; end: number }>
	reading: Promise<void>
}

const readMore = (path: string, list: SegmentList, ended: boolean) => {
	const next = list.reading.then(() => readFrom(path, list, ended))
	list.reading = next.catch(() => {})
	return next
}

const readFrom = async (path: string, list: SegmentList, ended: boolean) => {
	const fh = await open(path, "r").catch(() => null)
	if (!fh) return
	try {
		const { size } = await fh.stat()
		if (size <= list.read) return
		const buf = Buffer.alloc(size - list.read)
		const { bytesRead } = await fh.read(buf, 0, buf.length, list.read)
		list.read += bytesRead
		const lines = (list.rest + buf.toString("utf8", 0, bytesRead)).split("\n")
		// a line ffmpeg is still writing would give the segment a wrong end, fixed for good in `times`
		list.rest = ended ? "" : (lines.pop() ?? "")
		for (const line of lines) {
			const [file, start, end] = line.split(",")
			if (!file || start === undefined || start === "" || !Number.isFinite(Number(start))) continue
			list.entries.set(file, { start: Number(start), end: Number(end) })
			list.count++
		}
	} finally {
		await fh.close()
	}
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

/**
 * Records any ffmpeg-readable stream as fixed-length segments. Segments are
 * numbered per ffmpeg run (`<name>_<launch epoch ms>_<seq>.mp4`) and ffmpeg's
 * segment list says which are finished and where each starts in the run.
 * Wall-clock (strftime) names would collide whenever segments close faster than
 * once a second, e.g. a non-live input.
 *
 * The wall time of a run's 0 s comes from `-progress`: now minus the output
 * time, which for a live camera is when the first frame arrived rather than when
 * ffmpeg launched (the RTSP handshake takes a second or two). A file input runs
 * faster than real time, so the launch time is the floor.
 */
export const createSegmentRecorder = (o: SegmentRecorderOptions) => {
	const bin = o.ffmpeg ?? FFMPEG
	// %05d is a minimum: a run past 99,999 segments (a week of 6 s ones) writes `_100000`
	const segmentRe = new RegExp(`^${o.name}_(\\d{13})_(\\d{5,})\\.mp4$`)
	const listRe = new RegExp(`^${o.name}_(\\d{13})\\.csv$`)
	const listPath = (epoch: number) => join(o.dir, `${o.name}_${epoch}.csv`)
	const stallMs = Math.max(30_000, o.segmentSeconds * 2000)

	let child: ChildProcess | null = null
	let childExited: Promise<void> = Promise.resolve()
	/** Launch time of the running ffmpeg; also the id in its file names. */
	let liveEpoch: number | null = null
	let backoffMs = MIN_BACKOFF_MS
	let restartTimer: NodeJS.Timeout | null = null
	let stopping = true
	/** Stopped after an error `retry` turned down, until `resume()`. */
	let parked = false
	let audio = o.audio
	let progress = { sig: "", since: 0 }
	/** Wall-clock ms of each run's 0 s; runs from before this process fall back to their launch time. */
	const anchors = new Map<number, { at: number; recent: number[] }>()
	/** Wall times fixed the first time a segment is seen finished, so a clip's time never drifts between polls. */
	const times = new Map<string, { start: number; end: number }>()
	const lists = new Map<number, SegmentList>()
	const listOf = (epoch: number) => {
		let l = lists.get(epoch)
		if (!l) lists.set(epoch, (l = { read: 0, rest: "", count: 0, entries: new Map(), reading: Promise.resolve() }))
		return l
	}

	const scheduleRestart = (wait = backoffMs) => {
		if (stopping || restartTimer) return
		backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
		if (wait > 0) o.log.info(`restarting ffmpeg in ${Math.round(wait / 1000)} s`)
		restartTimer = setTimeout(() => {
			restartTimer = null
			launch()
		}, wait)
	}

	const launch = () => {
		if (stopping || child) return
		const url = o.url()
		if (!url) {
			o.onState("error", o.missing())
			return
		}
		parked = false
		const mask = maskWith(url)
		mkdirSync(o.dir, { recursive: true })
		const epoch = Date.now()
		const args = [
			"-hide_banner", "-loglevel", "error", "-nostdin", "-progress", "pipe:1",
			...(/^rtsps?:/i.test(url) ? ["-rtsp_transport", "tcp"] : []),
			"-i", url,
			"-map", "0:v:0", ...(audio ? ["-map", "0:a:0?"] : ["-an"]), "-c", "copy",
			"-f", "segment", "-segment_time", String(o.segmentSeconds), "-reset_timestamps", "1",
			"-segment_list", listPath(epoch), "-segment_list_type", "csv",
			join(o.dir, `${o.name}_${epoch}_%05d.mp4`)
		]
		const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] })
		child = proc
		liveEpoch = epoch
		progress = { sig: "", since: epoch }
		const anchor = { at: epoch, recent: [] as number[] }
		anchors.set(epoch, anchor)
		let stderr = ""
		let stdout = ""
		let spawnError: string | null = null
		let flowing = false
		proc.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString()
			const lines = stdout.split("\n")
			stdout = lines.pop() ?? ""
			for (const line of lines) {
				const m = /^out_time_us=(\d+)/.exec(line)
				if (!m || Number(m[1]) <= 0) continue
				// a median of recent readings shrugs off the burst a camera sends on connect and brief lag
				anchor.recent = [...anchor.recent.slice(-19), Date.now() - Number(m[1]) / 1000]
				anchor.at = Math.max(epoch, median(anchor.recent))
				if (!flowing && child === proc) {
					flowing = true
					o.onFlowing?.()
				}
			}
		})
		proc.stderr?.on("data", (d: Buffer) => {
			stderr = (stderr + d.toString()).slice(-4000)
		})
		childExited = new Promise(resolve => {
			proc.on("error", e => {
				spawnError = (e as NodeJS.ErrnoException).code === "ENOENT" ? `${bin} not found` : mask(e.message)
			})
			proc.on("close", code => {
				if (child === proc) {
					child = null
					liveEpoch = null
				}
				resolve()
				if (stopping || parked) return
				if (audio && AUDIO_UNSUPPORTED.test(stderr)) {
					o.log.info("the stream's sound can't go in an MP4; recording video only")
					audio = false
					scheduleRestart(0)
					return
				}
				const tail = spawnError ?? (mask(stderr.trim().split("\n").slice(-2).join(" | ")) || "stream ended")
				o.log.warn(`ffmpeg exited (${code}): ${tail}`)
				if (Date.now() - epoch >= HEALTHY_RUN_MS) backoffMs = MIN_BACKOFF_MS
				o.onState("error", `ffmpeg exited: ${tail}`)
				if (o.retry && !o.retry(mask(stderr))) {
					parked = true
					return
				}
				scheduleRestart()
			})
		})
		o.log.info(`recording ${o.segmentSeconds} s segments from ${mask(url)}`)
		o.onState("ok", `recording ${o.segmentSeconds} s segments from ${mask(url)}`)
	}

	const kill = async () => {
		const proc = child
		if (!proc) return
		// SIGINT lets ffmpeg finish the current segment's MP4 index and list it, so it is playable
		proc.kill("SIGINT")
		const timeout = new Promise<"timeout">(r => setTimeout(() => r("timeout"), 5000).unref())
		if ((await Promise.race([childExited, timeout])) === "timeout") {
			proc.kill("SIGKILL")
			await childExited
		}
	}

	/**
	 * Every finished segment on disk, oldest first: listed by its run, or left by a
	 * run that has ended. Also restarts an ffmpeg that has stopped producing anything.
	 */
	const finished = async (): Promise<Segment[]> => {
		const names = await readdir(o.dir).catch(() => [] as string[])
		const live = liveEpoch
		const found = names
			.map(file => {
				const m = segmentRe.exec(file)
				return m ? { file, epoch: Number(m[1]), seq: Number(m[2]) } : null
			})
			.filter(s => s !== null)
			.sort((a, b) => a.epoch - b.epoch || a.seq - b.seq)
		const epochs = new Set(found.map(s => s.epoch))
		for (const e of epochs) await readMore(listPath(e), listOf(e), e !== live)

		// A camera that drops off the network can leave ffmpeg hung with no error;
		// no new finished segment and no growth of the open one is the only sign.
		if (live !== null) {
			const open = found.filter(s => s.epoch === live && !lists.get(live)?.entries.has(s.file)).at(-1)
			const size = open ? await stat(join(o.dir, open.file)).then(s => s.size, () => 0) : 0
			const sig = `${lists.get(live)?.count ?? 0}:${open?.file}:${size}`
			if (sig !== progress.sig) progress = { sig, since: Date.now() }
			else if (Date.now() - progress.since > stallMs) {
				o.log.warn(`no data for ${Math.round(stallMs / 1000)} s; restarting ffmpeg`)
				child?.kill("SIGKILL")
			}
		}

		const out: Segment[] = []
		for (const s of found) {
			const listed = lists.get(s.epoch)?.entries.get(s.file)
			// the running ffmpeg is still writing anything it has not listed yet
			if (s.epoch === live && !listed) continue
			const path = join(o.dir, s.file)
			const size = await stat(path).then(x => x.size, () => -1)
			if (size < 0) continue
			let t = times.get(s.file)
			if (!t) {
				const zero = anchors.get(s.epoch)?.at ?? s.epoch
				const start = listed?.start ?? s.seq * o.segmentSeconds
				const end = listed && Number.isFinite(listed.end) && listed.end > start ? listed.end : start + o.segmentSeconds
				t = { start: zero + start * 1000, end: zero + end * 1000 }
				times.set(s.file, t)
			}
			out.push({ file: s.file, path, size, ...t })
		}
		return out
	}

	/** Forgets segments that are gone and deletes the lists of ended runs with nothing left. */
	const tidy = async () => {
		const names = new Set(await readdir(o.dir).catch(() => [] as string[]))
		for (const f of times.keys()) if (!names.has(f)) times.delete(f)
		// ffmpeg lists a segment only once its file is complete, so a listed one missing here is gone for good
		for (const l of lists.values()) for (const f of l.entries.keys()) if (!names.has(f)) l.entries.delete(f)
		for (const n of names) {
			const m = listRe.exec(n)
			if (!m) continue
			const e = Number(m[1])
			if (e === liveEpoch || [...names].some(f => f.startsWith(`${o.name}_${e}_`))) continue
			await unlink(join(o.dir, n)).catch(() => {})
			anchors.delete(e)
			lists.delete(e)
		}
	}

	return {
		start: () => {
			if (!stopping) return
			stopping = false
			launch()
		},
		stop: async () => {
			stopping = true
			if (restartTimer) clearTimeout(restartTimer)
			restartTimer = null
			await kill()
		},
		/** Stops ffmpeg until `resume()`, e.g. while the camera refuses the password. */
		pause: async () => {
			parked = true
			if (restartTimer) clearTimeout(restartTimer)
			restartTimer = null
			await kill()
		},
		/** Starts ffmpeg now if it is waiting (backoff, or parked after a refusal). */
		resume: () => {
			if (stopping || child) return
			if (restartTimer) clearTimeout(restartTimer)
			restartTimer = null
			backoffMs = MIN_BACKOFF_MS
			launch()
		},
		/** ffmpeg is running right now. */
		running: () => child !== null,
		/** Waiting for `resume()` after an error `retry` turned down. */
		parked: () => parked,
		finished,
		tidy,
		/** Real footage is flowing, so the next failure deserves a fast retry. */
		healthy: () => {
			backoffMs = MIN_BACKOFF_MS
		}
	}
}

export type SegmentRecorder = ReturnType<typeof createSegmentRecorder>

// ---------------------------------------------------------------------------
// Camera-motion gating (pure)

/** One motion reading (the camera's, or look4's own watch): `null` when it couldn't tell. */
export type MotionSample = { t: number; motion: boolean | null }

/** Motion readings older than this are dropped; pending footage is always newer (clips split at 2 min). */
export const MOTION_KEEP_MS = 15 * 60_000

export type GateOptions = {
	/** Footage kept before motion starts and after it ends. */
	preMs: number
	postMs: number
	/** A clip is split once it reaches this length. */
	maxMs: number
	/** How far apart samples are; a motion sample covers this much time before it. */
	sampleMs: number
	/** Samples further apart than this leave a hole nobody knows about, which counts as motion. */
	staleMs: number
	/** Segments further apart than this belong to different ffmpeg runs and never share a clip. */
	gapMs: number
	/**
	 * Quiet footage up to this long between two flagged stretches joins them into one clip, gap
	 * included. The detector's cost is per clip, not per second, and a busy feeder flickers in and
	 * out of motion: joining runs up to two 6 s segments apart (with room for their jitter) took the
	 * measured clip rate from 37 to 30 an hour for 2–6 points more footage checked (decisions §12).
	 */
	joinMs: number
}

export const GATE: GateOptions = { preMs: 4000, postMs: 8000, maxMs: 120_000, sampleMs: 1000, staleMs: 5000, gapMs: 2000, joinMs: 13_000 }

type Span = { start: number; end: number }

/** A window of footage to check: `by` is the source whose motion made it, null for time no source could tell about. */
type Window = Span & { by: number | null }

/** One source's readings: its motion (with the rolls), the time it can't tell about, and how far it has read. */
const readSource = (samples: MotionSample[], now: number, g: GateOptions) => {
	const unknown: Span[] = []
	const motion: Span[] = []
	if (!samples.length) return { motion, unknown: [{ start: -Infinity, end: Infinity }], last: -Infinity, stale: true }
	const first = samples[0]!
	const last = samples.at(-1)!
	unknown.push({ start: -Infinity, end: first.t - g.staleMs })
	for (let i = 1; i < samples.length; i++) if (samples[i]!.t - samples[i - 1]!.t > g.staleMs) unknown.push({ start: samples[i - 1]!.t, end: samples[i]!.t })
	const stale = now - last.t > g.staleMs
	if (stale) unknown.push({ start: last.t, end: Infinity })

	// runs of motion samples, merged across quiet gaps shorter than the post-roll
	const runs: Span[] = []
	for (const s of samples) {
		if (s.motion === false) continue
		const from = s.t - g.sampleMs
		if (s.motion === null) {
			unknown.push({ start: from, end: s.t })
			continue
		}
		const prev = runs.at(-1)
		if (prev && from - prev.end < g.postMs) prev.end = s.t
		else runs.push({ start: from, end: s.t })
	}
	for (const m of runs) {
		// motion in the newest sample hasn't ended: no one knows where its post-roll stops. A source
		// that went stale on a motion reading says nothing about after it (that's `unknown`), so its
		// last run ends with the post-roll like any other: else a dead watch flags footage forever
		const ongoing = !stale && m.end === last.t && last.motion === true
		motion.push({ start: m.start - g.preMs, end: ongoing ? Infinity : m.end + g.postMs })
	}
	return { motion, unknown: merge(unknown), last: last.t, stale }
}

/** Sorted, with overlapping and touching spans joined. */
const merge = (spans: Span[]) => {
	const out: Span[] = []
	for (const s of [...spans].sort((a, b) => a.start - b.start)) {
		if (!(s.end > s.start)) continue
		const prev = out.at(-1)
		if (prev && s.start <= prev.end) prev.end = Math.max(prev.end, s.end)
		else out.push({ ...s })
	}
	return out
}

/** Time in both of two merged span lists. */
const intersect = (a: Span[], b: Span[]) => {
	const out: Span[] = []
	for (let i = 0, j = 0; i < a.length && j < b.length; ) {
		const start = Math.max(a[i]!.start, b[j]!.start)
		const end = Math.min(a[i]!.end, b[j]!.end)
		if (end > start) out.push({ start, end })
		if (a[i]!.end < b[j]!.end) i++
		else j++
	}
	return out
}

/**
 * The windows whose footage must be checked, and how far the readings reach, from one list of
 * readings per motion source (the camera's own detection, look4's watch of its preview stream).
 * Footage is checked when ANY source saw motion there, with the pre- and post-roll: the camera
 * misses most small birds and the watch can miss what the camera's AI catches. Time NO source can
 * tell about (failed reads, a source that stopped, before its first reading) counts as motion
 * without any roll: only then does the gate fail open. So a watch that is down leaves the camera
 * to decide alone, and the other way round.
 *
 * The horizon is the oldest newest reading among the sources still reading: a source a few seconds
 * behind holds footage until it has had its say. A stale source holds nothing.
 */
export const motionWindows = (sources: MotionSample[][], now: number, g: GateOptions = GATE) => {
	const windows: Window[] = []
	let unknown: Span[] = [{ start: -Infinity, end: Infinity }]
	let horizon = Infinity
	for (const [by, samples] of sources.entries()) {
		const own = readSource(samples, now, g)
		for (const m of own.motion) windows.push({ ...m, by })
		unknown = intersect(unknown, own.unknown)
		if (!own.stale) horizon = Math.min(horizon, own.last)
	}
	for (const u of unknown) windows.push({ ...u, by: null })
	return { windows, horizon }
}

export type CapturePlan<s extends Span> = {
	/** Each a clip: consecutive segments, oldest first. */
	clips: s[][]
	/** Per clip, the motion sources (indices into `sources`) whose motion it holds; empty when only failing open made it. */
	by: number[][]
	/** Segments no motion window touches and none can any more. */
	unchecked: s[]
}

/**
 * Decides what the undecided `segments` (oldest first) become, given each motion
 * source's `samples` (see `motionWindows`): consecutive segments touched by a motion window are one clip,
 * finished once the footage after it is known to be quiet; segments no window
 * can reach are unchecked. Clips split at `maxMs`. Anything not returned waits
 * for more samples or segments. `flush` (the source is stopping) decides everything.
 */
export const planCapture = <s extends Span>(
	segments: s[],
	sources: MotionSample[][],
	now: number,
	g: GateOptions = GATE,
	flush = false
): CapturePlan<s> => {
	const { windows, horizon } = motionWindows(sources, now, g)
	const touches = (seg: s, w: Span) => seg.start < w.end && seg.end > w.start
	const flagged = (seg: s) => windows.some(w => touches(seg, w))
	const byOf = (clip: s[]) => [...new Set(windows.filter(w => w.by !== null && clip.some(seg => touches(seg, w))).map(w => w.by!))].sort((a, b) => a - b)
	// future motion reaches back `preMs`, so a quiet segment is only settled once that much after it is known
	const settled = (seg: s) => flush || horizon >= seg.end + g.preMs
	const plan: CapturePlan<s> = { clips: [], by: [], unchecked: [] }
	let run: s[] = []

	const split = (complete: boolean) => {
		while (run.length) {
			const first = run[0]!
			let n = 0
			while (n < run.length && (n === 0 || run[n]!.end - first.start <= g.maxMs)) n++
			// an unfinished run gives up only full-length pieces
			if (n === run.length && !complete) return
			plan.clips.push(run.slice(0, n))
			plan.by.push(byOf(run.slice(0, n)))
			run = run.slice(n)
		}
	}

	// settled quiet segments after a run that the next flagged one may still pull into it (`joinMs`)
	let gap: s[] = []
	const closeRun = () => {
		split(true)
		run = []
		plan.unchecked.push(...gap)
		gap = []
	}

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]!
		const prev = segments[i - 1]
		if (run.length && prev && seg.start - prev.end > g.gapMs) closeRun()
		if (flagged(seg)) {
			run.push(...gap, seg)
			gap = []
			continue
		}
		if (!settled(seg)) {
			// it may still join the run, so neither it nor anything after it is decided yet
			split(false)
			return plan
		}
		if (!run.length) {
			plan.unchecked.push(seg)
			continue
		}
		gap.push(seg)
		if (seg.end - gap[0]!.start > g.joinMs) closeRun()
	}
	// a run still flagged at the end may go on, and a short gap after one may still be joined: both
	// wait (giving up only full-length pieces) unless the source is stopping
	if (!flush) {
		split(false)
		return plan
	}
	closeRun()
	return plan
}

// ---------------------------------------------------------------------------
// Files: concat, the unchecked folder

/**
 * Joins consecutive segments into one MP4 without re-encoding: index up front
 * (`+faststart`) and HEVC tagged `hvc1`, which Safari and QuickTime need.
 * `inpoint` (a keyframe's time in the first file) and `outpoint` (a time in the
 * last) trim the ends, in each file's own timestamps.
 */
export const concatSegments = async (
	paths: string[],
	dest: string,
	opts: { ffmpeg?: string; inpoint?: number; outpoint?: number } = {}
) => {
	const list = `${dest}.txt`
	const lines = paths.map((p, i) => [
		// the concat demuxer's own quoting: a single quote becomes '\''
		`file '${p.replaceAll("'", "'\\''")}'`,
		...(i === 0 && opts.inpoint !== undefined ? [`inpoint ${opts.inpoint}`] : []),
		...(i === paths.length - 1 && opts.outpoint !== undefined ? [`outpoint ${opts.outpoint}`] : [])
	])
	await writeFile(list, lines.flat().join("\n") + "\n")
	const hevc = await probe(paths[0]!).then(p => p.codec === "hevc", () => false)
	const args = (map: string[]) => [
		"-hide_banner", "-loglevel", "error", "-nostdin", "-y",
		"-f", "concat", "-safe", "0", "-i", list,
		...map, "-c", "copy", ...(hevc ? ["-tag:v", "hvc1"] : []), "-movflags", "+faststart",
		"-f", "mp4", dest
	]
	try {
		await run(opts.ffmpeg ?? FFMPEG, args(["-map", "0:v:0", "-map", "0:a:0?"]))
	} catch {
		// pieces from two ffmpeg runs can disagree on the sound track; the picture is what matters
		await run(opts.ffmpeg ?? FFMPEG, args(["-map", "0:v:0"]))
	} finally {
		await unlink(list).catch(() => {})
	}
}

/**
 * Times (s, the file's own timestamps) of the keyframes in a file's video, in
 * order, rounded up to the microsecond: the concat demuxer reads `inpoint` in
 * microseconds and seeks to the keyframe at or before it, so one rounded down
 * (ffprobe's `pts_time`) would land a whole GOP early.
 */
export const keyframeTimes = async (path: string) => {
	const out = await run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts,flags:stream=time_base", "-of", "json", path])
	const j = JSON.parse(out.toString()) as { packets?: Array<{ pts?: number; flags?: string }>; streams?: Array<{ time_base?: string }> }
	const [num, den] = (j.streams?.[0]?.time_base ?? "").split("/").map(Number)
	if (!num || !den) return []
	return (j.packets ?? [])
		.flatMap(p => (p.flags?.startsWith("K") && typeof p.pts === "number" ? [Math.ceil((p.pts * num * 1e6) / den) / 1e6] : []))
		.sort((a, b) => a - b)
}

/**
 * Where to cut `segs` (oldest first) so the join covers [from, to] (wall-clock ms)
 * and no more: the first file from its last keyframe at or before `from` (a stream
 * copy can only start on one), the last up to `to`. A segment starts on a keyframe,
 * so its first keyframe is its wall-clock start. `start` is the cut's wall time.
 */
export const trimPoints = async (segs: Segment[], from: number, to: number) => {
	const first = segs[0]!
	const last = segs.at(-1)!
	const keys = await keyframeTimes(first.path)
	const k0 = keys[0]
	if (k0 === undefined) return { start: first.start }
	const wall = (k: number) => first.start + (k - k0) * 1000
	const k = keys.filter(k => wall(k) <= from).at(-1) ?? k0
	let outpoint: number | undefined
	if (to < last.end) {
		const l0 = last === first ? k0 : (await keyframeTimes(last.path))[0]
		if (l0 !== undefined) outpoint = l0 + (to - last.start) / 1000
	}
	return { start: wall(k), inpoint: k === k0 ? undefined : k, outpoint }
}

/** rename, falling back to copy + unlink across filesystems. */
const moveFile = async (from: string, to: string) => {
	try {
		await rename(from, to)
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e
		await copyFile(from, to)
		await unlink(from)
	}
}

// ---------------------------------------------------------------------------
// The capture loop and Record

/** How far before the press a Live recording starts. */
export const PRE_RECORD_MS = 10_000
/** A Live recording stops and saves by itself after this long. */
export const MAX_RECORD_MS = 5 * 60_000
/** Segments smaller than this are a stream that died at once; not worth a clip. */
const MIN_SEGMENT_BYTES = 1024
const MAX_INGEST_ATTEMPTS = 3
/** A saved recording's answer is kept this long, so a second Stop (another device, a retry) gets it too. */
const SAVED_KEEP_MS = 10 * 60_000

/** Record failed: an HTTP status and one sentence for the person who pressed it. */
export class RecordError extends Error {
	readonly status: number
	constructor(status: number, message: string) {
		super(message)
		this.status = status
	}
}

/** Saving clips of a camera from Live, on top of the stream a source already records. */
export type LiveRecorder = {
	/** The source whose recorder this is (clips are saved under its name). */
	source: string
	/** Starts a recording that reaches PRE_RECORD_MS back; while one runs, answers that one. */
	start(): LiveRecordStarted
	/** Ends it and waits for the clip: ingested, pinned, queued. */
	stop(id: string): Promise<LiveRecordSaved>
	cancel(id: string): void
}

type Recording = {
	id: string
	from: number
	to: number | null
	timer: NodeJS.Timeout | null
	saving: Promise<LiveRecordSaved> | null
	/** Saved or failed: no longer holds footage. */
	done: boolean
}

/** What happens to a segment once it is decided; it waits while Record may still need it. `gate`: which motion made it a clip. */
type Fate = { kind: "drop" | "unchecked" | "ingest"; seg: Segment; tries: number; gate?: ClipGate }

/** Which motion made a clip, as ingest records it (kv `gate:<id>`): the camera's own detection, look4's watch, or both. */
export type ClipGate = NonNullable<IngestInput["gate"]>

export type StreamCaptureOptions = {
	/** The source's name: clips are ingested under it. */
	name: string
	ctx: SourceContext
	recorder: SegmentRecorder
	segmentSeconds: number
	/**
	 * Motion samples, oldest first, one list per source (see `motionWindows`). Absent: every
	 * segment is its own clip (motionGate `all`, rtsp sources).
	 */
	motion?: () => MotionSample[][]
	/** Who each list in `motion` comes from, so a clip says which gate made it. Default: the camera. */
	motionSources?: Array<"camera" | "look4">
	gate?: GateOptions
	/** Finished footage is kept this long, so Record can reach back PRE_RECORD_MS. */
	holdMs?: number
	now?: () => number
	ffmpeg?: string
	log: Logger
	/** A new clip went in (for the status count). */
	onClip?: () => void
}

export const createStreamCapture = (o: StreamCaptureOptions) => {
	const { ctx, recorder, log, name } = o
	const now = o.now ?? Date.now
	const gate = o.gate ?? GATE
	const holdMs = o.holdMs ?? PRE_RECORD_MS + 2000
	const uncheckedDir = join(ctx.paths.root, "unchecked")
	const fates = new Map<string, Fate>()
	const clipTries = new Map<string, number>()
	const recordings = new Map<string, Recording>()
	const saved = new Map<string, { at: number; result: LiveRecordSaved }>()
	/** End of the newest footage on disk: what a later switch to the SD card needn't pull again. */
	let capturedUntil = -Infinity

	const held = (seg: Segment, t: number) => {
		if (holdMs > 0 && seg.end > t - holdMs) return true
		for (const r of recordings.values()) if (!r.done && seg.end > r.from && (r.to === null || seg.start < r.to)) return true
		return false
	}

	/** The gate a clip holding these sources' motion came through; none when only failing open made it. */
	const gateOf = (by: number[]): ClipGate | undefined => {
		const who = new Set(by.map(i => o.motionSources?.[i] ?? "camera"))
		return who.size === 2 ? "both" : [...who][0]
	}

	const ingestFile = async (file: string, start: number, end: number, originalName: string, gate?: ClipGate) => {
		const r = await ctx.ingest({ file, source: name, sourceRef: null, originalName, recordedAt: new Date(start).toISOString(), mode: "move", gate })
		recorder.healthy()
		if (!r.duplicate) {
			o.onClip?.()
			ctx.kick()
		}
		// a close-up taken in this stretch belongs to this clip (src/live/closeup.ts)
		ctx.bus.emit("captured", { source: name, clipId: r.clip.id, start, end })
		return r
	}

	/** Joins `segs` into one clip and ingests it; falls back to one clip per segment if that keeps failing. */
	const buildClip = async (segs: Segment[], gate: ClipGate | undefined) => {
		const first = segs[0]!
		const tmp = join(ctx.paths.partial, `clip_${name}_${first.file}`)
		try {
			await concatSegments(segs.map(s => s.path), tmp, { ffmpeg: o.ffmpeg })
			await ingestFile(tmp, first.start, segs.at(-1)!.end, `${name}_${stampOf(new Date(first.start))}.mp4`, gate)
			clipTries.delete(first.file)
			for (const s of segs) fates.set(s.file, { kind: "drop", seg: s, tries: 0 })
		} catch (e) {
			await unlink(tmp).catch(() => {})
			const tries = (clipTries.get(first.file) ?? 0) + 1
			clipTries.set(first.file, tries)
			log.warn(`clip from ${segs.length} segment${segs.length === 1 ? "" : "s"} failed (try ${tries}): ${errorMessage(e)}`)
			// fail open: each piece on its own is still footage the gate flagged
			if (tries >= MAX_INGEST_ATTEMPTS) for (const s of segs) fates.set(s.file, { kind: "ingest", seg: s, tries: 0, gate })
		}
	}

	const toUnchecked = async (seg: Segment) => {
		if ((ctx.uncheckedDays?.() ?? 2) <= 0 || (ctx.uncheckedGb?.() ?? 10) <= 0) return unlink(seg.path)
		const iso = new Date(seg.start).toISOString()
		const dir = join(uncheckedDir, localDate(iso))
		mkdirSync(dir, { recursive: true })
		const base = `${name}_${stampOf(new Date(seg.start))}`
		let dest = join(dir, `${base}.mp4`)
		for (let i = 2; existsSync(dest); i++) dest = join(dir, `${base}_${i}.mp4`)
		await moveFile(seg.path, dest)
	}

	const dispose = async (f: Fate) => {
		if (f.kind === "drop") return unlink(f.seg.path).catch(() => {})
		if (f.kind === "unchecked") return toUnchecked(f.seg)
		return ingestFile(f.seg.path, f.seg.start, f.seg.end, `${name}_${stampOf(new Date(f.seg.start))}.mp4`, f.gate)
	}

	/**
	 * Makes room above the disk floor for this cycle's clips and a Record save, out of
	 * unchecked footage. The hourly retention sweep owns age and size; ffmpeg writes
	 * gigabytes between those, so the floor can't wait for it.
	 */
	const sweepForSpace = (t: number, segs: Segment[]) => {
		const floor = ctx.minFreeBytes?.() ?? 0
		if (floor <= 0) return
		const ms = segs.reduce((n, s) => n + (s.end - s.start), 0)
		const rate = ms > 0 ? segs.reduce((n, s) => n + s.size, 0) / ms : 0
		const r = sweepUnchecked(uncheckedDir, {
			now: t,
			maxAgeMs: null,
			maxBytes: null,
			floorBytes: floor,
			headroomBytes: Math.max(UNCHECKED_HEADROOM_BYTES, rate * MAX_RECORD_MS),
			freeBytes: ctx.freeBytes ?? freeBytes
		})
		if (r.deleted) log.info(`disk nearly full: deleted ${r.deleted} unchecked segment${r.deleted === 1 ? "" : "s"}`)
	}

	/** Clips half-joined when the process died would otherwise sit in .partial forever (`_` can't be in a source name, so the prefix is this source's alone). */
	let leftovers = true
	const sweepLeftovers = async () => {
		leftovers = false
		const names = await readdir(ctx.paths.partial).catch(() => [] as string[])
		for (const n of names) if (n.startsWith(`clip_${name}_`) || n.startsWith(`record_${name}_`)) await unlink(join(ctx.paths.partial, n)).catch(() => {})
	}

	/** One pass: decide what new segments become, then carry out what Record no longer holds back. */
	const cycle = async (signal: AbortSignal, flush = false) => {
		if (leftovers) await sweepLeftovers()
		const t = now()
		const segs: Segment[] = []
		for (const s of await recorder.finished()) {
			if (s.size >= MIN_SEGMENT_BYTES) segs.push(s)
			else if (!fates.has(s.file)) await unlink(s.path).catch(() => {})
		}
		for (const s of segs) capturedUntil = Math.max(capturedUntil, s.end)
		try {
			sweepForSpace(t, segs)
		} catch (e) {
			log.warn(`sweeping unchecked footage failed: ${errorMessage(e)}`)
		}
		const pending = segs.filter(s => !fates.has(s.file))
		if (!o.motion) for (const s of pending) fates.set(s.file, { kind: "ingest", seg: s, tries: 0 })
		else {
			const plan = planCapture(pending, o.motion(), t, gate, flush)
			for (const [i, clip] of plan.clips.entries()) {
				if (signal.aborted) return
				await buildClip(clip, gateOf(plan.by[i]!))
			}
			for (const s of plan.unchecked) fates.set(s.file, { kind: "unchecked", seg: s, tries: 0 })
		}

		const present = new Set(segs.map(s => s.file))
		for (const [file, f] of fates) {
			if (signal.aborted) return
			if (!present.has(file) && !existsSync(f.seg.path)) {
				fates.delete(file)
				continue
			}
			if (!flush && held(f.seg, t)) continue
			try {
				await dispose(f)
				fates.delete(file)
			} catch (e) {
				f.tries++
				log.warn(`${f.kind === "ingest" ? "ingest" : "moving"} ${file} failed (try ${f.tries}): ${errorMessage(e)}`)
				// whatever couldn't become a clip still shouldn't be lost before retention says so
				if (f.tries >= MAX_INGEST_ATTEMPTS) {
					if (f.kind === "ingest") fates.set(file, { kind: "unchecked", seg: f.seg, tries: 0 })
					else fates.delete(file)
				}
			}
		}
		await recorder.tidy()
		for (const [id, s] of saved) if (t - s.at > SAVED_KEEP_MS) saved.delete(id)
	}

	/** Waits until the recorder has closed a segment reaching `to` (or can't any more), then joins and keeps the range. */
	const save = async (rec: Recording): Promise<LiveRecordSaved> => {
		const to = rec.to!
		const deadline = Date.now() + o.segmentSeconds * 1000 + 15_000
		let segs: Segment[] = []
		for (;;) {
			const all = await recorder.finished()
			segs = all.filter(s => s.size >= MIN_SEGMENT_BYTES && s.end > rec.from && s.start < to)
			if (all.some(s => s.end >= to) || !recorder.running() || Date.now() > deadline) break
			await new Promise(r => setTimeout(r, 500))
		}
		if (!segs.length) throw new RecordError(502, "look4 didn't get any video from the camera while recording.")
		const tmp = join(ctx.paths.partial, `record_${name}_${rec.id}.mp4`)
		try {
			// whole segments would pad the press by up to a segment at each end (6 s by default)
			const cut = await trimPoints(segs, rec.from, to).catch(e => {
				log.warn(`couldn't find where to cut the recording, keeping whole segments: ${errorMessage(e)}`)
				return { start: segs[0]!.start, inpoint: undefined, outpoint: undefined }
			})
			await concatSegments(segs.map(s => s.path), tmp, { ffmpeg: o.ffmpeg, inpoint: cut.inpoint, outpoint: cut.outpoint })
			const r = await ctx.ingest({
				file: tmp,
				source: name,
				sourceRef: null,
				originalName: `${name}_live_${stampOf(new Date(cut.start))}.mp4`,
				recordedAt: new Date(cut.start).toISOString(),
				mode: "move"
			})
			// before the worker can see it: a pinned clip is kept whatever the verdicts say
			ctx.store.setKv(pinKey(r.clip.id), "live")
			if (!r.duplicate) o.onClip?.()
			ctx.kick()
			log.info(`saved a ${Math.round((Math.min(to, segs.at(-1)!.end) - cut.start) / 1000)} s clip from Live as ${r.clip.id}`)
			return { clipId: r.clip.id }
		} catch (e) {
			await unlink(tmp).catch(() => {})
			if (e instanceof RecordError) throw e
			throw new RecordError(500, `look4 couldn't save the recording: ${errorMessage(e)}`)
		}
	}

	const finish = (rec: Recording) => {
		if (rec.saving) return rec.saving
		rec.to = now()
		if (rec.timer) clearTimeout(rec.timer)
		rec.saving = save(rec).then(
			result => {
				saved.set(rec.id, { at: now(), result })
				return result
			},
			e => {
				log.warn(`saving recording ${rec.id} failed: ${errorMessage(e)}`)
				throw e
			}
		)
		rec.saving
			.finally(() => {
				rec.done = true
				recordings.delete(rec.id)
			})
			.catch(() => {})
		return rec.saving
	}

	const live: LiveRecorder = {
		source: name,
		start: () => {
			const running = [...recordings.values()].find(r => r.to === null)
			const rec: Recording = running ?? { id: randomUUID().slice(0, 8), from: now() - PRE_RECORD_MS, to: null, timer: null, saving: null, done: false }
			if (!running) {
				rec.timer = setTimeout(() => void finish(rec).catch(() => {}), MAX_RECORD_MS)
				rec.timer.unref?.()
				recordings.set(rec.id, rec)
				log.info(`recording from Live (${rec.id})`)
			}
			return { id: rec.id, from: new Date(rec.from).toISOString(), maxSeconds: MAX_RECORD_MS / 1000 }
		},
		stop: async id => {
			const done = saved.get(id)
			if (done) return done.result
			const rec = recordings.get(id)
			if (!rec) throw new RecordError(404, "That recording isn't running any more.")
			return finish(rec)
		},
		cancel: id => {
			const rec = recordings.get(id)
			if (!rec || rec.saving) return
			if (rec.timer) clearTimeout(rec.timer)
			recordings.delete(id)
			log.info(`recording ${id} cancelled`)
		}
	}

	return {
		cycle: (signal: AbortSignal) => cycle(signal),
		/** After the recorder has stopped: saves running recordings and decides every segment left. */
		flush: async () => {
			await Promise.allSettled([...recordings.values()].map(finish))
			await cycle(new AbortController().signal, true)
		},
		live,
		/** Wall-clock ms the newest footage recorded so far ends at; -Infinity before the first segment. */
		capturedUntil: () => capturedUntil
	}
}
