import { readdir, unlink } from "node:fs/promises"
import { basename, join } from "node:path"
import type { CameraProblem } from "../api-types.ts"
import type { ReolinkSourceConfig } from "../config.ts"
import { reolinkHostname, reolinkRtspUrl } from "../live/inputs.ts"
import { type Logger, logger } from "../log.ts"
import { localDate } from "../paths.ts"
import { freeBytes } from "../retention.ts"
import { probePort } from "../setup/discover.ts"
import type { NormBox } from "../types.ts"
import { createPoller, createStatus, errorMessage, type SourceAdapter, type SourceContext, type StatusHandle } from "./common.ts"
import { createSegmentRecorder, createStreamCapture, GATE, type GateOptions, type LiveRecorder, MOTION_KEEP_MS, type MotionSample, RTSP_REFUSED } from "./recorder.ts"
import { createStreamMotion, DEFAULT_OSD, osdBoxes } from "./stream-motion.ts"
import {
	createReolinkClient,
	lockoutSeconds,
	loginProblem,
	type ReolinkClient,
	type ReolinkDevInfo,
	ReolinkError,
	type ReolinkFile,
	splitByDay
} from "./reolink-api.ts"

/** Re-search this far behind the cursor: a recording still in progress at the last poll may not have been listed yet. */
const OVERLAP_MS = 30 * 60_000
/** A file whose EndTime is this recent may still be growing on the SD card. */
const RECORDING_GRACE_MS = 20_000
/**
 * How a refused login starts the source's status detail. Settings shows that
 * detail under "What's wrong", so it is written for a person; the snapshot
 * route and the Fix it form also key off it to avoid spending another login on
 * a refused camera.
 */
export const LOGIN_REFUSED = "The camera turned down look4's sign-in"

/** A refusal that is neither a wrong password nor a lockout (odd firmware) is retried after this long. */
const AUTH_BACKOFF_MS = 5 * 60_000
/** Lockout waits double with each lockout in a row, up to this. */
const MAX_LOCK_WAIT_MS = 6 * 3600_000
/**
 * A recording whose download fails is retried after each of these waits in
 * turn, holding the cursor so the retries survive a restart, then given up on
 * (~6.5 h in all): long enough to outlast the camera being busy with the
 * Reolink app or a flaky Wi-Fi evening, short enough that a truly broken file
 * does not pin the search window forever.
 */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 4 * 3600_000]
/** How often the camera's clock is compared with this machine's. */
const CLOCK_CHECK_MS = 3600_000
/** Smaller disagreements are ordinary drift, which OVERLAP_MS and the recording grace already absorb. */
const CLOCK_NOISE_MS = 60_000
/** Worth telling the user about: their camera's recordings are stamped with the wrong time. */
const CLOCK_WARN_MS = 2 * 60_000

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000))

const refusedDetail = (problem: CameraProblem, e: ReolinkError, waitMs: number) =>
	problem === "locked-out"
		? `${LOGIN_REFUSED}: after too many wrong tries it is refusing sign-ins for a while. look4 tries once more in ${minutes(waitMs)} min; if the password changed, use Fix it.`
		: problem === "bad-credentials"
			? `${LOGIN_REFUSED}: the username or password is wrong (was the camera's password changed?). Use Fix it to enter the current one. Until then look4 won't try again, so the camera doesn't lock the account${e.attemptsLeft !== null ? ` (it allows ${e.attemptsLeft} more wrong ${e.attemptsLeft === 1 ? "try" : "tries"})` : ""}.`
			: `${LOGIN_REFUSED}: ${e.message}. look4 tries again in ${minutes(waitMs)} min.`

const shortFirmware = (fw: string) => fw.replace(/_\d{6,}$/, "")

const describe = (info: ReolinkDevInfo | null) => (info ? `${info.model} · fw ${shortFirmware(info.firmware)}` : null)

const clientFor = (cfg: ReolinkSourceConfig) =>
	createReolinkClient({
		host: cfg.host,
		username: cfg.username,
		password: () => process.env[cfg.passwordEnv],
		protocol: cfg.protocol,
		channel: cfg.channel
	})

// Only an undefined variable is missing: `REOLINK_PASSWORD=` (empty) means the camera has no password.
const hasPassword = (cfg: ReolinkSourceConfig) => process.env[cfg.passwordEnv] !== undefined

const missingPassword = (cfg: ReolinkSourceConfig) =>
	`set ${cfg.passwordEnv} in .env (\`${cfg.passwordEnv}=\` with nothing after it if the camera has no password)`

/**
 * Logs in and reads the model and firmware: the "is the camera reachable and is
 * the password right" check behind `look4 doctor` and `look4 init`.
 */
export const reolinkCheck = async (
	cfg: ReolinkSourceConfig
): Promise<{ ok: boolean; detail: string; model?: string; firmware?: string }> => {
	if (!hasPassword(cfg)) return { ok: false, detail: missingPassword(cfg) }
	const client = clientFor(cfg)
	try {
		await client.login()
		const info = await client.devInfo()
		return { ok: true, detail: `${describe(info)} · ${client.protocol()}`, model: info.model, firmware: info.firmware }
	} catch (e) {
		return { ok: false, detail: e instanceof ReolinkError && e.cmd === "Login" ? `login failed: ${e.message}` : errorMessage(e) }
	} finally {
		await client.close()
	}
}

export type ReolinkSourceOptions = {
	/** Clock override for tests. */
	now?: () => number
	recordingGraceMs?: number
	/** Abort a download after this much silence from the camera. */
	downloadIdleMs?: number
	/** Whether a TCP port answers (`capture: "auto"` asks about RTSP); tests stub it. */
	probe?: (host: string, port: number) => Promise<boolean>
	/** Stream capture: the camera's motion readings, instead of polling GetMdState/GetAiState (tests). */
	motion?: () => MotionSample[]
	/** How often the camera's motion state is read. */
	motionIntervalMs?: number
	ffmpeg?: string
	/** Stream capture: finished footage kept for Record (see createStreamCapture). */
	holdMs?: number
	/** Stream capture: pre-/post-roll and the rest (tests shorten them). */
	gate?: GateOptions
}

/** A recording whose download failed: how often, why, and not to be tried again before `nextAt`. */
type Retry = { failures: number; nextAt: number; error: string }

/**
 * What a refused sign-in means for the next automatic one, shared by both ways
 * of capturing: a lockout waits it out, an unexplained refusal waits a while.
 */
const createLoginGuard = (cfg: ReolinkSourceConfig, status: StatusHandle, now: () => number, log: Logger) => {
	/** No automatic login before this (a lockout, or an unexplained refusal). */
	let authRetryAt = 0
	let lockouts = 0
	/**
	 * The password the camera called wrong. Retrying it only feeds the camera's
	 * lockout counter, so automatic attempts wait until it changes (Fix it saves a
	 * new one, which restarts this source) or the user presses Check now.
	 */
	let refusedPassword: string | null = null
	return {
		/** Automatic sign-ins hold off. */
		waiting: () => now() < authRetryAt || (refusedPassword !== null && process.env[cfg.passwordEnv] === refusedPassword),
		ok: () => {
			refusedPassword = null
			authRetryAt = 0
			lockouts = 0
		},
		refused: (e: ReolinkError) => {
			const problem = loginProblem(e)
			let wait = AUTH_BACKOFF_MS
			if (problem === "locked-out") {
				lockouts++
				wait = Math.min((lockoutSeconds(e.message) ?? 300) * 1000 * 2 ** (lockouts - 1), MAX_LOCK_WAIT_MS)
				authRetryAt = now() + wait
			} else if (problem === "bad-credentials") refusedPassword = process.env[cfg.passwordEnv] ?? ""
			else authRetryAt = now() + wait
			status.state("error", refusedDetail(problem, e, wait))
			log.warn(`login refused: ${e.message}`)
		}
	}
}

type LoginGuard = ReturnType<typeof createLoginGuard>

/** One way of capturing; the source picks it at start. */
type Capture = { start(): void; stop(): Promise<void>; pollNow(): Promise<void>; liveRecorder(): LiveRecorder | null }

const cursorKeyOf = (cfg: ReolinkSourceConfig) => `reolink:${cfg.name}:cursor`

/**
 * Pulls motion recordings off the camera's SD card: Search each local day from
 * the cursor to now, download what is new (one at a time; the camera is slow),
 * ingest it. No camera reconfiguration needed. `why` says why `auto` chose this.
 */
const createSdPull = (
	cfg: ReolinkSourceConfig,
	ctx: SourceContext,
	opts: ReolinkSourceOptions,
	status: StatusHandle,
	guard: LoginGuard,
	log: Logger,
	why: string | null
): Capture => {
	const now = opts.now ?? Date.now
	const grace = opts.recordingGraceMs ?? RECORDING_GRACE_MS
	const cursorKey = cursorKeyOf(cfg)
	const partialPrefix = `reolink-${cfg.name}-`

	let client: ReolinkClient | null = null
	let info: ReolinkDevInfo | null = null
	let manual = false
	/** Camera clock minus this machine's, in ms; 0 when they agree to within CLOCK_NOISE_MS. */
	let clockOffset = 0
	let clockCheckedAt = -Infinity
	/** File names handled in this process (ingested, duplicate, or given up on). */
	const done = new Set<string>()
	const retries = new Map<string, Retry>()
	/** Pulling is paused for a nearly full disk; logged once per pause, not every poll. */
	let paused = false

	const todayCount = () => {
		const d = new Date(now())
		const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString()
		return ctx.store.countClips({ source: cfg.name, since: midnight })
	}

	const clockNote = () =>
		Math.abs(clockOffset) < CLOCK_WARN_MS
			? null
			: `camera clock is ${minutes(Math.abs(clockOffset))} min ${clockOffset < 0 ? "behind" : "ahead of"} this computer: check its time zone and DST in the Reolink app`

	const okDetail = (extra?: string) => {
		const n = todayCount()
		return [describe(info) ?? cfg.host, `${n} clip${n === 1 ? "" : "s"} today`, clockNote(), why && `from its SD card: ${why}`, extra]
			.filter(Boolean)
			.join(" · ")
	}

	const loginRefused = guard.refused

	const isLoginError = (e: unknown): e is ReolinkError => e instanceof ReolinkError && e.cmd === "Login"

	/** Re-reads the camera's clock now and then; a camera that cannot say keeps the last answer. */
	const checkClock = async (t: number, signal: AbortSignal) => {
		if (t - clockCheckedAt < CLOCK_CHECK_MS) return
		clockCheckedAt = t
		let raw: number
		try {
			raw = await client!.clockOffset(now, signal)
		} catch (e) {
			if (signal.aborted || isLoginError(e)) throw e
			log.debug(`could not read the camera's clock: ${errorMessage(e)}`)
			return
		}
		const next = Math.abs(raw) < CLOCK_NOISE_MS ? 0 : Math.round(raw / 1000) * 1000
		const changed = next !== clockOffset
		clockOffset = next
		const note = clockNote()
		if (note && changed) log.warn(note)
	}

	const download = async (f: ReolinkFile, signal: AbortSignal) => {
		const dest = join(ctx.paths.partial, `${partialPrefix}${basename(f.name)}`)
		await client!.download(f.name, dest, { signal, idleMs: opts.downloadIdleMs })
		return dest
	}

	/** Free bytes when downloading `f` would take the data disk below `retention.minFreeGb`, else null. */
	const diskBelowFloor = (f: ReolinkFile): number | null => {
		const floor = ctx.minFreeBytes?.() ?? 0
		if (floor <= 0) return null
		const free = (ctx.freeBytes ?? freeBytes)(ctx.paths.root)
		return free - (f.size ?? 0) < floor ? free : null
	}

	const ingest = (f: ReolinkFile, dest: string) =>
		ctx.ingest({
			file: dest,
			source: cfg.name,
			sourceRef: f.name,
			originalName: basename(f.name),
			recordedAt: f.start.toISOString(),
			mode: "move"
		})

	const cycle = async (signal: AbortSignal) => {
		const wasManual = manual
		manual = false
		status.polled()
		if (!hasPassword(cfg)) {
			status.state("error", missingPassword(cfg))
			return
		}
		if (!wasManual && guard.waiting()) return
		client ??= clientFor(cfg)

		const t = now()
		let files: ReolinkFile[] = []
		try {
			// one login per token lease, not per poll: each login holds one of the camera's few sessions
			await client.ensureLogin(signal)
			guard.ok()
			info ??= await client.devInfo(signal).catch(() => null)
			await checkClock(t, signal)
			const stored = ctx.store.getKv<string>(cursorKey)
			const cursor = stored ? Date.parse(stored) : t - cfg.lookbackHours * 3600_000
			const from = Math.min(cursor, t) - (stored ? OVERLAP_MS : 0)
			// the cursor is in this machine's time; Search and the file stamps are in the camera's
			for (const [s, e] of splitByDay(new Date(from + clockOffset), new Date(t + clockOffset)))
				for (const f of await client.search(s, e, cfg.stream, signal))
					files.push({ ...f, start: new Date(f.start.getTime() - clockOffset), end: new Date(f.end.getTime() - clockOffset) })
		} catch (e) {
			if (signal.aborted) return
			if (isLoginError(e)) loginRefused(e)
			else {
				status.state("error", errorMessage(e))
				log.warn(`poll failed: ${errorMessage(e)}`)
			}
			return
		}

		status.state("ok", okDetail())
		const byName = new Map(files.map(f => [f.name, f]))
		// the cursor holds at the oldest owed file, so one missing from the listing is gone from the SD card
		for (const name of retries.keys()) if (!byName.has(name)) retries.delete(name)
		const todo = [...byName.values()]
			.filter(f => !done.has(f.name))
			.filter(f => {
				if (!ctx.store.findClipBySourceRef(cfg.name, f.name)) return true
				done.add(f.name)
				retries.delete(f.name)
				return false
			})
			.sort((a, b) => a.start.getTime() - b.start.getTime())

		/** The cursor may not pass a file we still owe a download. */
		let holdAt = t
		const hold = (f: ReolinkFile) => (holdAt = Math.min(holdAt, f.start.getTime()))
		let lastError: string | null = null
		let localError: string | null = null
		let fetched = 0
		const ready = todo.filter(f => {
			if (f.end.getTime() <= t - grace) return true
			hold(f)
			return false
		})
		for (const [i, f] of ready.entries()) {
			if (signal.aborted) return
			const retry = retries.get(f.name)
			if (retry && now() < retry.nextAt) {
				hold(f)
				continue
			}
			// Ingest would refuse the file anyway; checking first spares the camera a download that
			// is then thrown away on every poll. The cursor holds, so nothing is skipped once space frees up.
			const free = diskBelowFloor(f)
			if (free !== null) {
				hold(f)
				localError = `disk nearly full: ${(free / 1e9).toFixed(1)} GB free, pulling paused`
				if (!paused) log.warn(`${localError} (below retention.minFreeGb)`)
				paused = true
				break
			}
			paused = false
			if (ready.length > 1) status.state("ok", okDetail(`downloading ${i + 1} of ${ready.length}`))
			let dest: string
			try {
				dest = await download(f, signal)
			} catch (e) {
				if (signal.aborted) return
				if (isLoginError(e)) {
					// the camera stopped taking the password mid-poll: another file would only be another refused login
					hold(f)
					ctx.store.setKv(cursorKey, new Date(holdAt).toISOString())
					loginRefused(e)
					return
				}
				const failures = (retry?.failures ?? 0) + 1
				lastError = `${basename(f.name)}: ${errorMessage(e)}`
				const delay = RETRY_DELAYS_MS[failures - 1]
				if (delay === undefined) {
					log.warn(`download failed ${failures} times, giving up on it: ${lastError}`)
					retries.delete(f.name)
					done.add(f.name)
				} else {
					log.warn(`download failed (try ${failures}, next in ${minutes(delay)} min) ${lastError}`)
					retries.set(f.name, { failures, nextAt: now() + delay, error: lastError })
					hold(f)
				}
				continue
			}
			try {
				const r = await ingest(f, dest)
				done.add(f.name)
				retries.delete(f.name)
				fetched++
				if (!r.duplicate) {
					status.ingested()
					ctx.kick()
				}
			} catch (e) {
				// a full disk or an unwritable data folder is not this file's fault, nor the camera's:
				// keep the cursor here and stop pulling until the next poll, without counting it as a try
				await unlink(dest).catch(() => {})
				hold(f)
				localError = `couldn't save ${basename(f.name)}: ${errorMessage(e)}`
				log.warn(localError)
				break
			}
		}
		ctx.store.setKv(cursorKey, new Date(holdAt).toISOString())
		if (fetched) log.info(`pulled ${fetched} clip${fetched === 1 ? "" : "s"}`)
		const owed = [...retries.values()]
		if (localError) status.state("error", okDetail(localError))
		else if (owed.length)
			status.state("ok", okDetail(`${owed.length} recording${owed.length === 1 ? "" : "s"} to retry: ${owed.at(-1)!.error}`))
		else status.state("ok", okDetail(lastError ? `last error: ${lastError}` : undefined))
	}
	const poller = createPoller({
		intervalMs: () => cfg.pollSeconds * 1000,
		cycle,
		onError: e => {
			log.error("poll failed", e)
			status.state("error", errorMessage(e))
		}
	})

	/** Downloads interrupted by a crash or shutdown would otherwise sit in .partial forever. */
	const sweepPartials = async () => {
		const names = await readdir(ctx.paths.partial).catch(() => [] as string[])
		await Promise.all(names.filter(n => n.startsWith(partialPrefix)).map(n => unlink(join(ctx.paths.partial, n)).catch(() => {})))
	}

	let started: Promise<void> = Promise.resolve()
	return {
		start: () => {
			if (poller.isRunning()) return
			started = sweepPartials().then(() => poller.start())
		},
		stop: async () => {
			await started
			await poller.stop()
			// free the session: the camera only allows a handful at once
			await client?.close()
			client = null
		},
		pollNow: async () => {
			manual = true
			await poller.pollNow()
		},
		liveRecorder: () => null
	}
}


/**
 * Reads the camera's own motion state about once a second: `GetMdState` (pixel
 * motion) and, while that is quiet, `GetAiState` (people, vehicles, animals).
 * One login for the whole run; a refused one stops the poller (never retried
 * here: the source decides when, see `createLoginGuard`). A failed read is a
 * `null` sample, which the gate treats as motion.
 */
export const createReolinkMotion = (
	client: ReolinkClient,
	o: { channel: number; intervalMs?: number; now?: () => number; log: Logger; onRefused: (e: ReolinkError) => void }
) => {
	const now = o.now ?? Date.now
	const interval = o.intervalMs ?? 1000
	const samples: MotionSample[] = []
	let running = false
	let abort = new AbortController()
	let timer: NodeJS.Timeout | null = null
	let loop: Promise<void> = Promise.resolve()
	/** Firmware without AI detection answers GetAiState with an error; motion detection alone still works. */
	let ai = true
	let failing = 0

	const read = async (signal: AbortSignal): Promise<boolean> => {
		const md = await client.command("GetMdState", { channel: o.channel }, signal)
		if (Number(md?.state) === 1) return true
		if (!ai) return false
		try {
			const v = await client.command("GetAiState", { channel: o.channel }, signal)
			return Object.values(v ?? {}).some(x => Number((x as { alarm_state?: unknown } | null)?.alarm_state) === 1)
		} catch (e) {
			if (!(e instanceof ReolinkError) || e.cmd === "Login") throw e
			ai = false
			o.log.info(`the camera has no AI detection state (${e.message}); using its motion detection alone`)
			return false
		}
	}

	const tick = async () => {
		const signal = abort.signal
		let motion: boolean | null = null
		try {
			motion = await read(signal)
			failing = 0
		} catch (e) {
			if (signal.aborted) return
			if (e instanceof ReolinkError && e.cmd === "Login") {
				running = false
				o.onRefused(e)
				return
			}
			if (failing++ % 60 === 0) o.log.warn(`can't read the camera's motion state, so everything counts as motion: ${errorMessage(e)}`)
		}
		const t = now()
		samples.push({ t, motion })
		while (samples.length && samples[0]!.t < t - MOTION_KEEP_MS) samples.shift()
	}

	const next = () => {
		if (!running) return
		timer = setTimeout(() => {
			timer = null
			loop = tick().then(next)
		}, interval)
	}

	return {
		start: () => {
			if (running) return
			running = true
			abort = new AbortController()
			loop = tick().then(next)
		},
		stop: async () => {
			running = false
			if (timer) clearTimeout(timer)
			timer = null
			abort.abort()
			await loop
		},
		samples: () => samples,
		/** The last read worked. */
		healthy: () => failing === 0,
		running: () => running
	}
}

/** Counts motion events per local day from one source's samples as they come in: a new event once motion has been quiet for the post-roll. */
const createMotionCounter = (postMs: number) => {
	let seenUpTo = -Infinity
	let lastMotion = -Infinity
	let today = { day: "", n: 0 }
	return (samples: MotionSample[], t: number) => {
		for (const s of samples) {
			if (s.t <= seenUpTo) continue
			seenUpTo = s.t
			if (s.motion !== true) continue
			const day = localDate(new Date(s.t).toISOString())
			if (day !== today.day) today = { day, n: 0 }
			if (s.t - lastMotion > postMs) today.n++
			lastMotion = s.t
		}
		const day = localDate(new Date(t).toISOString())
		if (day !== today.day) today = { day, n: 0 }
		return today.n
	}
}

/** RTSP needs a password on Reolink cameras; a blank one is refused outright (and would count as a failed login). */
const STREAM_NEEDS_PASSWORD =
	"Reolink cameras only share their live stream once the camera has a password. Set one in the Reolink app, then type it in Settings → Sources → Edit, or choose SD card under Clips from."

const times = (n: number) => `${n} time${n === 1 ? "" : "s"}`

/**
 * Records the camera's live stream in short segments and keeps the footage around
 * motion: seen by look4's own watch of the camera's preview stream or by the
 * camera's own detection (`motionGate: "both"`), by the camera alone (`"camera"`),
 * or every segment (`"all"`). The stream keeps its sound track, for clips saved from Live.
 */
const createStreamPull = (
	cfg: ReolinkSourceConfig,
	ctx: SourceContext,
	opts: ReolinkSourceOptions,
	status: StatusHandle,
	guard: LoginGuard,
	log: Logger
): Capture => {
	const now = opts.now ?? Date.now
	const password = () => process.env[cfg.passwordEnv]
	let stopping = true
	let manual = false
	/** The camera refused the password (API or RTSP): nothing runs until the guard allows another try. */
	let refused = false
	let recorderOk = false
	/** The recorder's current ffmpeg run has had a frame: the camera is up and took the password, so the watch may open it too. */
	let recorderFlowing = false
	let cursorAt = -Infinity
	let cursorWritten = -Infinity
	/** The motion poller's sign-in was turned down for a reason RTSP doesn't share: no new try before this. */
	let feedRetryAt = 0
	let client: ReolinkClient | null = null
	const postMs = (opts.gate ?? GATE).postMs
	const countCamera = createMotionCounter(postMs)
	const countWatch = createMotionCounter(postMs)

	const refuse = (e: ReolinkError) => {
		refused = true
		guard.refused(e)
		void feed?.stop()
		void watch?.stop()
		void recorder.pause()
	}

	/**
	 * The motion poller's sign-in was turned down. A wrong password or a lockout is
	 * the same account RTSP uses, and every try feeds the lockout: stop everything.
	 * Anything else (the camera's sessions are full, logins too frequent) costs
	 * only the motion readings: their samples go stale, and the gate falls back on
	 * look4's watch, or fails open without it, while the stream keeps recording.
	 */
	const feedRefused = (e: ReolinkError) => {
		const problem = loginProblem(e)
		if (problem === "bad-credentials" || problem === "locked-out") return refuse(e)
		feedRetryAt = now() + AUTH_BACKOFF_MS
		log.warn(
			`can't read the camera's motion (${e.message}), so ${watch ? "only look4's own watch counts" : "everything counts as motion"}; trying again in ${AUTH_BACKOFF_MS / 60_000} min`
		)
	}

	const recorder = createSegmentRecorder({
		name: cfg.name,
		dir: join(ctx.paths.partial, `capture-${cfg.name}`),
		url: () => {
			const p = password()
			return p ? reolinkRtspUrl(cfg, p, cfg.stream) : null
		},
		missing: () => (password() === undefined ? missingPassword(cfg) : STREAM_NEEDS_PASSWORD),
		segmentSeconds: cfg.segmentSeconds,
		audio: true,
		ffmpeg: opts.ffmpeg,
		log,
		onState: (state, detail) => {
			recorderOk = state === "ok"
			if (state === "error") recorderFlowing = false
			if (refused) return
			if (state === "ok") status.state("ok", streamDetail())
			else status.state("error", detail)
		},
		retry: stderr => {
			// every RTSP attempt with a wrong password counts toward the camera's lockout
			if (!RTSP_REFUSED.test(stderr)) return true
			refuse(new ReolinkError("Login", -7, "the live stream (RTSP) turned down the password"))
			return false
		},
		// the watch opens the camera with the same password: only once the recorder has proved it
		onFlowing: () => {
			recorderFlowing = true
			void startWatch()
		}
	})

	const feed =
		cfg.motionGate !== "all" && !opts.motion
			? createReolinkMotion((client = clientFor(cfg)), { channel: cfg.channel, intervalMs: opts.motionIntervalMs, now, log, onRefused: feedRefused })
			: null
	const cameraSamples = opts.motion ?? feed?.samples ?? (() => [])

	/** Where the camera draws its clock and name (GetOsd, read-only, once), so the watch skips them wherever they are. */
	let osd: Promise<NormBox[]> | null = null
	const readOsd = async (): Promise<NormBox[]> => {
		if (!client) return DEFAULT_OSD
		try {
			return osdBoxes(await client.command("GetOsd", { channel: cfg.channel }, AbortSignal.timeout(10_000))) ?? DEFAULT_OSD
		} catch (e) {
			if (e instanceof ReolinkError && e.cmd === "Login") feedRefused(e)
			else log.debug(`couldn't read where the camera draws its clock, assuming the default: ${errorMessage(e)}`)
			return DEFAULT_OSD
		}
	}
	let exclude = DEFAULT_OSD

	const watch =
		cfg.motionGate === "both"
			? createStreamMotion({
					url: () => {
						const p = password()
						return p ? reolinkRtspUrl(cfg, p, "sub") : null
					},
					exclude: () => exclude,
					ffmpeg: opts.ffmpeg,
					log,
					now,
					allowed: () => recorderFlowing && !refused && !stopping,
					onRefused: () => refuse(new ReolinkError("Login", -7, "the camera's preview stream (RTSP) turned down the password")),
					// for close-ups (src/live/closeup.ts), which decide for themselves whether they're wanted
					onMotion: (at, blobs) => ctx.bus.emit("motion", { source: cfg.name, at, blobs })
				})
			: null

	const startWatch = async () => {
		if (!watch || refused || stopping) return
		// a watch waiting out its own backoff (it failed while the camera was away) comes back with the recording
		if (watch.running()) return watch.kick()
		exclude = await (osd ??= readOsd())
		if (!refused && !stopping) watch.start()
	}

	const capture = createStreamCapture({
		name: cfg.name,
		ctx,
		recorder,
		segmentSeconds: cfg.segmentSeconds,
		motion: cfg.motionGate === "all" ? undefined : watch ? () => [cameraSamples(), watch.samples()] : () => [cameraSamples()],
		motionSources: watch ? ["camera", "look4"] : ["camera"],
		gate: opts.gate,
		holdMs: opts.holdMs,
		now,
		ffmpeg: opts.ffmpeg,
		log,
		onClip: () => status.ingested()
	})

	function streamDetail() {
		const parts = ["Recording the camera's stream"]
		const t = now()
		const cameraOk = !feed || (feed.running() && feed.healthy())
		const camera = cameraOk ? countCamera(cameraSamples(), t) : 0
		if (cfg.motionGate === "all") parts.push("look4 checks all of it")
		else if (!watch) parts.push(cameraOk ? `camera saw motion ${times(camera)} today` : "can't read the camera's motion right now, so look4 checks everything")
		else {
			const seen = countWatch(watch.samples(), t)
			if (cameraOk && watch.healthy()) parts.push(`motion today: look4 saw it ${times(seen)}, the camera ${camera}`)
			else if (cameraOk && watch.warming()) parts.push("look4's motion watch is starting, so only the camera's motion counts for now", `camera saw motion ${times(camera)} today`)
			else if (cameraOk) parts.push(`look4's motion watch isn't running (${watch.detail() ?? "starting"}), so only the camera's motion counts`, `camera saw motion ${times(camera)} today`)
			else if (watch.healthy()) parts.push("can't read the camera's motion right now; look4's own watch still sees motion", `look4 saw motion ${times(seen)} today`)
			else parts.push("can't read any motion right now, so look4 checks everything")
		}
		return parts.join(" · ")
	}

	const resume = () => {
		refused = false
		feedRetryAt = 0
		// the watch follows once the recorder's first frame shows the password is taken again
		recorder.resume()
		feed?.start()
	}

	/**
	 * Were capture switched to the SD card later, it should start from here, not
	 * re-pull everything since. Only as far as footage actually recorded: an
	 * outage (RTSP off, refused, ffmpeg failing) stays for the SD card to fill.
	 */
	const saveCursor = () => {
		const until = capture.capturedUntil()
		if (until <= cursorWritten) return
		ctx.store.setKv(cursorKeyOf(cfg), new Date(until).toISOString())
		cursorWritten = until
	}

	const poller = createPoller({
		intervalMs: () => Math.min(5000, Math.max(1000, (cfg.segmentSeconds * 1000) / 3)),
		cycle: async signal => {
			const wasManual = manual
			manual = false
			status.polled()
			if (refused && (wasManual || !guard.waiting())) resume()
			else if (!refused && feed && !feed.running() && (wasManual || now() >= feedRetryAt)) feed.start()
			await capture.cycle(signal)
			// the camera is answering again after a lockout: the next one starts from the shortest wait
			if (!refused && feed?.running() && feed.healthy()) guard.ok()
			if (!refused && recorderOk) status.state("ok", streamDetail())
			const t = now()
			if (t - cursorAt >= 60_000) {
				saveCursor()
				cursorAt = t
			}
		},
		onError: e => log.error("capture failed", e)
	})

	return {
		start: () => {
			if (!stopping) return
			stopping = false
			const p = password()
			if (p === undefined || p === "") {
				status.state("error", p === undefined ? missingPassword(cfg) : STREAM_NEEDS_PASSWORD)
				return
			}
			recorder.start()
			feed?.start()
			poller.start()
		},
		stop: async () => {
			stopping = true
			await poller.stop()
			await feed?.stop()
			await watch?.stop()
			await recorder.stop()
			// ffmpeg is gone, so every segment on disk is final
			await capture.flush()
			saveCursor()
			await client?.close()
		},
		pollNow: async () => {
			manual = true
			await poller.pollNow()
		},
		liveRecorder: () => (stopping || refused ? null : capture.live)
	}
}

/**
 * `capture: "auto"` → the stream when the camera's RTSP port answers and a
 * non-blank password is saved (Reolink's RTSP refuses a blank one), else the SD
 * card, with the reason for the status line.
 */
export const chooseCapture = async (
	cfg: ReolinkSourceConfig,
	probe: (host: string, port: number) => Promise<boolean> = (host, port) => probePort(host, port, 1500)
): Promise<{ capture: "stream" | "sd"; why: string | null }> => {
	if (cfg.capture !== "auto") return { capture: cfg.capture, why: null }
	const password = process.env[cfg.passwordEnv]
	if (password === undefined) return { capture: "sd", why: null }
	if (password === "") return { capture: "sd", why: "the camera has no password, and its live stream needs one" }
	const host = reolinkHostname(cfg)
	if (!host || !(await probe(host.replace(/^\[|\]$/g, ""), cfg.rtspPort))) return { capture: "sd", why: "its live stream (RTSP) is off" }
	return { capture: "stream", why: null }
}

/** While `auto` has fallen back to the SD card, how often look4 checks whether the live stream answers now. */
const AUTO_RECHECK_MS = 10 * 60_000

/**
 * A Reolink camera as a source of clips: its live stream gated by its own motion
 * detection, or its SD-card recordings (`capture`, decided at start). `auto` on
 * the SD card moves to the stream once the camera's RTSP switch is turned on.
 */
export const createReolinkSource = (cfg: ReolinkSourceConfig, ctx: SourceContext, opts: ReolinkSourceOptions = {}): SourceAdapter => {
	const log = logger(`source:${cfg.name}`)
	const status = createStatus(ctx, cfg.name, "reolink")
	const guard = createLoginGuard(cfg, status, opts.now ?? Date.now, log)
	let capture: Promise<Capture> | null = null
	let chosen: { kind: "stream" | "sd"; capture: Capture } | null = null
	let running = false
	let recheck: NodeJS.Timeout | null = null

	const build = (kind: "stream" | "sd", why: string | null) =>
		(chosen = { kind, capture: kind === "stream" ? createStreamPull(cfg, ctx, opts, status, guard, log) : createSdPull(cfg, ctx, opts, status, guard, log, why) })

	const pick = () =>
		(capture ??= chooseCapture(cfg, opts.probe).then(({ capture: kind, why }) => {
			log.info(kind === "stream" ? `recording the camera's stream (motion: ${cfg.motionGate})` : `pulling SD-card recordings${why ? `: ${why}` : ""}`)
			return build(kind, why).capture
		}))

	/** `auto` on the SD card: switch to the stream if it answers now. */
	const upgrade = async () => {
		if (!running || cfg.capture !== "auto" || chosen?.kind !== "sd") return
		if ((await chooseCapture(cfg, opts.probe)).capture !== "stream" || !running) return
		log.info("the camera's live stream answers now: recording it instead of pulling the SD card")
		await chosen.capture.stop()
		const next = build("stream", null).capture
		capture = Promise.resolve(next)
		next.start()
	}

	let started: Promise<void> = Promise.resolve()
	const queue = (fn: () => Promise<void>) => (started = started.then(fn).catch(e => log.warn(`switching capture failed: ${errorMessage(e)}`)))
	return {
		name: cfg.name,
		type: "reolink",
		start: () => {
			if (running) return
			running = true
			started = pick().then(
				c => c.start(),
				e => status.state("error", errorMessage(e))
			)
			if (cfg.capture === "auto") {
				recheck = setInterval(() => void queue(upgrade), AUTO_RECHECK_MS)
				recheck.unref()
			}
		},
		stop: async () => {
			running = false
			if (recheck) clearInterval(recheck)
			recheck = null
			await started
			await chosen?.capture.stop()
			status.state("stopped", "stopped")
		},
		status: status.get,
		pollNow: async () => {
			// "Check now" right after turning RTSP on shouldn't have to wait for the next recheck
			await queue(upgrade)
			await (await pick()).pollNow()
		},
		liveRecorder: () => (running ? (chosen?.capture.liveRecorder() ?? null) : null)
	}
}
