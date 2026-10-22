// Close-ups: when look4's motion watch sees something move on a camera that has them switched on
// (`closeUps` on a Reolink source) and the detector finds a bird there, the camera zooms in on it
// optically, the sharpest of a few full-resolution stills is kept, and the camera goes back Home.
// The still waits in `data/closeups/` until the stream capture makes the clip holding that moment,
// then becomes the clip's `closeup-N.jpg`, which the clip page and the Sightings card show first.
//
// - `frameBox`, `skipReason`, `cameraBlocker` and `sharpness`/`sharpest` are the pure parts.
// - `createCloseUps` listens on the bus for the watch's motion (`motion`) and the capture's clips
//   (`captured`), and drives the camera through Live's control driver, so it shares the driver's
//   one sign-in with the Live page.
//
// It never fights the person at the controls: it holds off while someone has steered the camera
// from Live in the last two minutes, while the camera moves, tracks on its own or isn't at Home,
// and it gives the camera up to them the moment they steer it mid-close-up. Otherwise the camera
// always goes back Home, also after an error, a timeout, or look4 shutting down.

import { existsSync } from "node:fs"
import { copyFile, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import sharp from "sharp"
import type { CameraState } from "../api-types.ts"
import type { LoadedConfig } from "../config.ts"
import type { Bus, Look4Events } from "../events.ts"
import { logger } from "../log.ts"
import { closeUpName, MAX_CLOSEUPS } from "../paths.ts"
import type { StillHit } from "../pipeline/detect.ts"
import { zoomView } from "../pipeline/detect-views.ts"
import type { NormBox } from "../types.ts"
import type { CameraControl } from "./control.ts"

const log = logger("closeup")

/** What the detector is asked to find before the camera turns. */
export const CLOSE_UP_NOUN = "bird"

/**
 * Space around the bird on every side, in bird sizes: the frame is 3× the bird. Birds hop and turn
 * between the still the detector saw and the lens arriving 2–4 s later; a tight box loses them.
 */
export const FRAME_MARGIN = 1
/**
 * The frame is never smaller than this share of the wide view: a smaller box only gives up margin the lens
 * can't use. The RLC-823S1's lens goes to 2.53× (src/live/zoom-curve.ts), so from wide open anything under
 * about two fifths already gets its limit.
 */
export const MIN_FRAME_SHARE = 0.2
/** A bird already filling this much of the picture gains under 1.7× from zooming: not worth moving the camera. */
export const MAX_FRAME_SHARE = 0.6

/**
 * At most one look (a camera still and up to `CONFIRM_VIEWS` detector views) per camera this often.
 * Movement on a windy day is nearly constant, and every view shares the detector with the clips it
 * is already behind on: at 0.5–1.3 s a view, this caps close-ups at 13–33% of its time.
 */
export const CHECK_EVERY_MS = 8000
/** Moving areas the detector looks at per check, largest first. */
export const CONFIRM_VIEWS = 2
/** After a close-up, the camera stays Home at least this long: the watch needs 15 s to learn the scene again anyway. */
export const COOLDOWN_MS = 60_000
/** Someone steered the camera from Live this recently: they are using it, so no close-ups. */
export const STEER_QUIET_MS = 2 * 60_000

/** Stills taken once the lens has settled; the sharpest is kept. */
const SHOTS = 3
/** Close-ups kept waiting for a clip this long at most (a clip that failed to build never claims them). */
const PENDING_MAX_MS = 3600_000
/** A close-up this close to a clip's ends still belongs to it: the stream's timeline runs a second or two behind the camera's stills. */
const SPAN_SLACK_MS = 3000
/** Clip spans remembered for close-ups still being taken. */
const SPAN_KEEP_MS = 30 * 60_000
/** The camera's capabilities and Home are read again after this (or after someone steers it). */
const CAPS_MAX_AGE_MS = 10 * 60_000
/** Any one request to the camera. */
const CALL_TIMEOUT_MS = 8000
/** How long shutting down waits for a close-up in progress to send the camera Home. */
const CLOSE_WAIT_MS = 6000

export const TIMING = {
	/** The camera answers Set3DPos before it starts moving: don't believe "still" before this. */
	settleFirstMs: 800,
	/** Between state reads while the lens moves and focuses. */
	settlePollMs: 400,
	/** Shoot anyway after this: a lens still hunting gives softer stills, and the sharpest of them is kept. */
	settleMaxMs: 8000,
	shotGapMs: 300,
	/** A Home that failed is tried once more after this. */
	homeRetryMs: 2000
}

/**
 * The part of the picture to frame around a bird (normalized, full frame), or null when the bird
 * is big enough already. A normalized box with w = h has the picture's own shape, so the frame is
 * square in these coordinates: the bird's larger side times (1 + 2 × FRAME_MARGIN), at least
 * MIN_FRAME_SHARE, centred on the bird and shifted (not shrunk) to stay inside the picture.
 */
export const frameBox = (bird: NormBox): NormBox | null => {
	const side = Math.max(MIN_FRAME_SHARE, Math.max(bird.w, bird.h) * (1 + 2 * FRAME_MARGIN))
	if (side >= MAX_FRAME_SHARE) return null
	const at = (centre: number) => Math.min(1 - side, Math.max(0, centre - side / 2))
	return { x: at(bird.x + bird.w / 2), y: at(bird.y + bird.h / 2), w: side, h: side }
}

/** A camera's close-up bookkeeping, as far as deciding whether to look at all. */
export type CloseUpClock = {
	now: number
	/** A check or close-up is running. */
	busy: boolean
	/** No check before this: the cadence after a check, the cooldown after a close-up. */
	nextAt: number
	/** When someone last steered the camera from Live. */
	steeredAt: number
}

/** Why a motion event can't start a check right now, or null when it may. Cheap: no camera calls. */
export const skipReason = (c: CloseUpClock): string | null => {
	if (c.busy) return "a check is already running"
	if (c.now < c.nextAt) return "too soon after the last one"
	if (c.now - c.steeredAt < STEER_QUIET_MS) return "someone is steering the camera"
	return null
}

/** What a close-up needs from the camera, read from its controls. */
export type CloseUpCaps = { box: boolean; zoom: boolean; home: boolean; tracking: boolean }

/** Why the camera can't take a close-up now, or null when it can. */
export const cameraBlocker = (caps: CloseUpCaps, state: CameraState): string | null => {
	if (!caps.box || !caps.zoom) return "this camera can't zoom in on a part of the picture"
	if (!caps.home) return "the camera has no Home view to come back to"
	if (caps.tracking) return "the camera's own auto-tracking is on"
	if (state.moving) return "the camera is moving"
	if (state.atHome === false) return "the camera isn't at its Home view"
	return null
}

/** Long edge the middle of a still is scored at: enough detail to tell focus apart, a few ms of work. */
const SHARPNESS_WIDTH = 960

/**
 * How sharp a still is: the variance of the Laplacian of its middle half (where the framed bird
 * is), in grey. Blur from a lens still focusing or a moving bird flattens edges and lowers it.
 * Only comparable between stills of the same scene.
 */
export const sharpness = async (jpeg: Buffer): Promise<number> => {
	const { width, height } = await sharp(jpeg).metadata()
	if (!width || !height) return 0
	const middle = { left: Math.floor(width / 4), top: Math.floor(height / 4), width: Math.max(1, Math.floor(width / 2)), height: Math.max(1, Math.floor(height / 2)) }
	const { data, info } = await sharp(jpeg)
		.extract(middle)
		.greyscale()
		.resize({ width: SHARPNESS_WIDTH, withoutEnlargement: true })
		.raw()
		.toBuffer({ resolveWithObject: true })
	const W = info.width
	const H = info.height
	const step = info.channels
	let n = 0
	let sum = 0
	let sq = 0
	for (let y = 1; y < H - 1; y++)
		for (let x = 1; x < W - 1; x++) {
			const p = (y * W + x) * step
			const l = 4 * data[p]! - data[p - step]! - data[p + step]! - data[p - W * step]! - data[p + W * step]!
			n++
			sum += l
			sq += l * l
		}
	return n ? sq / n - (sum / n) ** 2 : 0
}

/** The index of the sharpest of several stills of the same scene (the first on a tie). */
export const sharpest = async (jpegs: Buffer[]): Promise<number> => {
	const scores = await Promise.all(jpegs.map(sharpness))
	return scores.reduce((best, s, i) => (s > scores[best]! ? i : best), 0)
}

type Span = Look4Events["captured"][0]

/** The clip holding a moment: the one whose footage covers it, else the nearest within SPAN_SLACK_MS. */
const spanFor = (spans: Span[], t: number) => {
	let best: Span | null = null
	let gap = Infinity
	for (const s of spans) {
		const d = t < s.start ? s.start - t : t > s.end ? t - s.end : 0
		if (d < gap) {
			gap = d
			best = s
		}
	}
	return gap <= SPAN_SLACK_MS ? best : null
}

export type CloseUpDeps = {
	bus: Bus
	config: () => LoadedConfig
	/** Live's control drivers, shared with the Live page; `find` resolves a name Live folds into another camera. */
	live: { controlFor(name: string): CameraControl | null; find(name: string): { name: string } }
	/** The detector on one region of a still; null while the detector is switched off. */
	detect: (input: { jpeg: Buffer; box: NormBox; nouns: string[] }) => Promise<StillHit[] | null>
	/** Where close-ups wait for their clip. */
	dir: string
	/** A clip's media folder, where its close-ups end up. */
	mediaDir: (clipId: string) => string
	/** The clip's status for the `clip` event that tells open pages to look again; null once the clip is gone. */
	clipStatus: (clipId: string) => string | null
	now?: () => number
	timing?: Partial<typeof TIMING>
}

type Camera = {
	busy: boolean
	nextAt: number
	steeredAt: number
	caps: { at: number; value: CloseUpCaps } | null
	/** The last reason this camera couldn't take a close-up, so each is logged once. */
	note: string | null
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms).unref())

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export const createCloseUps = (deps: CloseUpDeps) => {
	const now = deps.now ?? Date.now
	const t = { ...TIMING, ...deps.timing }
	const cameras = new Map<string, Camera>()
	const spans = new Map<string, Span[]>()
	const running = new Set<Promise<void>>()
	const abort = new AbortController()
	let closed = false
	/** File moves run one at a time: a clip arriving and a close-up being saved may both claim the same file. */
	let filing: Promise<void> = Promise.resolve()

	const cameraOf = (name: string) => {
		let c = cameras.get(name)
		if (!c) cameras.set(name, (c = { busy: false, nextAt: 0, steeredAt: -Infinity, caps: null, note: null }))
		return c
	}

	const timed = () => AbortSignal.any([abort.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)])

	const note = (name: string, cam: Camera, why: string) => {
		if (cam.note === why) return
		cam.note = why
		log.info(`${name}: no close-ups for now: ${why}`)
	}

	const capabilities = async (cam: Camera, control: CameraControl): Promise<CloseUpCaps> => {
		if (cam.caps && now() - cam.caps.at < CAPS_MAX_AGE_MS) return cam.caps.value
		const ptz = (await control.controls(timed())).ptz
		const value = { box: !!ptz?.box, zoom: !!ptz?.zoom, home: !!ptz?.guard?.set, tracking: !!ptz?.tracking?.on }
		cam.caps = { at: now(), value }
		return value
	}

	// ---- filing close-ups with their clips ----

	const fileWith = async (file: string, clipId: string) => {
		if (deps.clipStatus(clipId) === null) return rm(file, { force: true })
		const dir = deps.mediaDir(clipId)
		await mkdir(dir, { recursive: true })
		let n = 0
		while (n < MAX_CLOSEUPS && existsSync(join(dir, closeUpName(n)))) n++
		if (n >= MAX_CLOSEUPS) return rm(file, { force: true })
		const dest = join(dir, closeUpName(n))
		try {
			await rename(file, dest)
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e
			await copyFile(file, dest)
			await rm(file, { force: true })
		}
		log.info(`close-up filed with clip ${clipId}`)
		const status = deps.clipStatus(clipId)
		if (status) deps.bus.emit("clip", { clipId, status })
	}

	/** Files each waiting close-up of `source` with the clip covering it; drops the ones too old for any clip to claim. */
	const sweep = (source: string | null) =>
		(filing = filing.then(async () => {
			const names = await readdir(deps.dir).catch(() => [] as string[])
			const t0 = now()
			for (const n of names) {
				const m = /^([a-z0-9][a-z0-9-]*)_(\d+)\.jpg$/.exec(n)
				const file = join(deps.dir, n)
				if (!m) continue
				const at = Number(m[2])
				try {
					if (t0 - at > PENDING_MAX_MS) await rm(file, { force: true })
					else if (source === null || m[1] === source) {
						const span = spanFor(spans.get(m[1]!) ?? [], at)
						if (span) await fileWith(file, span.clipId)
					}
				} catch (e) {
					log.warn(`couldn't file close-up ${n}: ${message(e)}`)
				}
			}
		}))

	const onCaptured = (e: Span) => {
		if (closed) return
		const list = (spans.get(e.source) ?? []).filter(s => s.end > now() - SPAN_KEEP_MS)
		list.push(e)
		spans.set(e.source, list)
		void sweep(e.source)
	}

	const keep = async (source: string, at: number, jpeg: Buffer) => {
		await mkdir(deps.dir, { recursive: true })
		await writeFile(join(deps.dir, `${source}_${at}.jpg`), jpeg)
		await sweep(source)
	}

	// ---- the camera ----

	/** Back Home, once more after a pause if the camera didn't take it. Never throws, and never waits on an aborted signal. */
	const goHome = async (name: string, control: CameraControl) => {
		for (let i = 0; ; i++) {
			try {
				await control.ptz({ op: "home" })
				return
			} catch (e) {
				if (i > 0) return log.warn(`${name}: couldn't send the camera back Home after a close-up: ${message(e)}`)
				await sleep(t.homeRetryMs)
			}
		}
	}

	/** Waits until the lens stands still and focus stops changing (two reads in a row), or settleMaxMs. */
	const settle = async (control: CameraControl, tookOver: () => boolean) => {
		await sleep(t.settleFirstMs)
		const end = now() + t.settleMaxMs
		let prev: CameraState | null = null
		while (now() < end && !tookOver()) {
			abort.signal.throwIfAborted()
			const st = await control.state(timed())
			if (prev && !prev.moving && !st.moving && st.zoom === prev.zoom && st.focus === prev.focus) return
			prev = st
			await sleep(t.settlePollMs)
		}
	}

	/** The moving areas the detector looks at for a bird, largest first; undefined when the detector is off. */
	const findBird = async (still: Buffer, blobs: NormBox[]): Promise<StillHit | null | undefined> => {
		const { width, height } = await sharp(still).metadata()
		if (!width || !height) return null
		const seen: NormBox[] = []
		for (const blob of blobs) {
			if (seen.length >= CONFIRM_VIEWS) break
			const cx = blob.x + blob.w / 2
			const cy = blob.y + blob.h / 2
			// another blob of the same bird (a wing, a tail) is already in an earlier view
			if (seen.some(v => cx >= v.x && cx <= v.x + v.w && cy >= v.y && cy <= v.y + v.h)) continue
			// null: big enough that the wide view shows it well already
			const view = zoomView(blob, null, { width, height })
			if (!view) continue
			seen.push(view)
			const hits = await deps.detect({ jpeg: still, box: view, nouns: [CLOSE_UP_NOUN] })
			if (hits === null) return undefined
			const bird = hits.find(h => h.label === CLOSE_UP_NOUN)
			if (bird) return bird
		}
		return null
	}

	const closeUp = async (name: string, cam: Camera, control: CameraControl, frame: NormBox, started: number) => {
		const tookOver = () => cam.steeredAt >= started
		const shots: Array<{ at: number; jpeg: Buffer }> = []
		try {
			await control.ptz({ op: "box", ...frame })
			await settle(control, tookOver)
			for (let i = 0; i < SHOTS && !tookOver(); i++) {
				if (i) await sleep(t.shotGapMs)
				const at = now()
				try {
					shots.push({ at, jpeg: await control.snapshot(timed()) })
				} catch (e) {
					if (abort.signal.aborted) break
					log.warn(`${name}: a close-up still failed: ${message(e)}`)
					break
				}
			}
		} finally {
			// whoever steered mid-close-up has the camera now; otherwise it goes back, error or not
			if (!tookOver()) await goHome(name, control)
			cam.nextAt = Math.max(cam.nextAt, now() + COOLDOWN_MS)
		}
		if (!shots.length) return
		const best = shots[await sharpest(shots.map(s => s.jpeg))]!
		await keep(name, best.at, best.jpeg)
		cam.note = null
		log.info(`${name}: took a close-up of a bird`)
	}

	const check = async (name: string, cam: Camera, blobs: NormBox[]) => {
		const control = deps.live.controlFor(name)
		if (!control) return note(name, cam, "look4 can't steer this camera")
		const caps = await capabilities(cam, control)
		const state = await control.state(timed())
		const blocked = cameraBlocker(caps, state)
		if (blocked) return note(name, cam, blocked)
		const started = now()
		const still = await control.snapshot(timed())
		const bird = await findBird(still, blobs)
		if (bird === undefined) return note(name, cam, "the detector is switched off in Settings")
		if (!bird) return
		const frame = frameBox(bird.box)
		if (!frame || closed || cam.steeredAt >= started) return
		log.debug(`${name}: a bird (${bird.score.toFixed(2)}) at ${JSON.stringify(bird.box)}; framing ${JSON.stringify(frame)}`)
		await closeUp(name, cam, control, frame, started)
	}

	const onMotion = (e: Look4Events["motion"][0]) => {
		if (closed || !e.blobs.length) return
		const cfg = deps.config().sources.find(s => s.name === e.source)
		if (cfg?.type !== "reolink" || !cfg.enabled || !cfg.closeUps) return
		const cam = cameraOf(e.source)
		const at = now()
		if (skipReason({ now: at, busy: cam.busy, nextAt: cam.nextAt, steeredAt: cam.steeredAt })) return
		cam.busy = true
		cam.nextAt = at + CHECK_EVERY_MS
		const run: Promise<void> = check(e.source, cam, e.blobs)
			.catch(err => {
				if (!abort.signal.aborted) log.warn(`${e.source}: close-up check failed: ${message(err)}`)
			})
			.finally(() => {
				cam.busy = false
				running.delete(run)
			})
		running.add(run)
	}

	deps.bus.on("motion", onMotion)
	deps.bus.on("captured", onCaptured)
	// close-ups left from a run that ended before their clip was made
	void sweep(null)
	const sweeper = setInterval(() => void sweep(null), 10 * 60_000)
	sweeper.unref()

	return {
		/** Someone steered this camera from Live (moved it, chose a view, changed Home): close-ups wait, and one in progress gives way. */
		steered: (name: string) => {
			let owner = name
			try {
				owner = deps.live.find(name).name
			} catch {}
			const cam = cameraOf(owner)
			cam.steeredAt = now()
			// they may have saved a new Home or switched tracking
			cam.caps = null
		},
		/** Stops listening; a close-up in progress sends the camera Home before this resolves (or gives up after a few seconds). */
		close: async () => {
			if (closed) return
			closed = true
			deps.bus.off("motion", onMotion)
			deps.bus.off("captured", onCaptured)
			clearInterval(sweeper)
			abort.abort()
			await Promise.race([Promise.allSettled([...running]), sleep(CLOSE_WAIT_MS)])
			await filing.catch(() => {})
		}
	}
}

export type CloseUps = ReturnType<typeof createCloseUps>
