// Reolink's HTTP API as a CameraControl: what the camera can do comes from
// `GetAbility` (the same reading reolink_aio does), the current settings from one
// batched POST of `Get*` commands, PTZ from `PtzCtrl` / `StartZoomFocus` /
// `Set3DPos` (a point only: given a box, this camera zooms out; see `aimAndZoom`),
// Home from the camera's guard point (`Get/SetPtzGuard`), saved views
// from `Get/SetPtzPreset` with their thumbnails (`ExportImg` / `ImportImg`), and
// lights, picture, tracking, microphone and siren from their own commands. Command
// shapes follow what the camera's own web UI sends to this firmware.
//
// A refused sign-in is final for this driver: Reolink locks the account after
// ten wrong passwords, so once the camera says no, nothing here asks again until
// the saved password changes (which builds a new driver).

import { join } from "node:path"
import type {
	CameraControls,
	CameraLight,
	CameraPreset,
	CameraSettingBody,
	CameraState,
	DayNightMode,
	LightBody,
	PositionRange,
	PresetBody,
	PtzBody,
	PtzDirection
} from "../api-types.ts"
import type { ReolinkSourceConfig } from "../config.ts"
import { logger } from "../log.ts"
import { createReolinkClient, loginProblem, type ReolinkCall, ReolinkError, ReolinkNetworkError, type ReolinkResult } from "../sources/reolink-api.ts"
import { type CameraControl, ControlError, type ControlDriver } from "./control.ts"
import { createDigitalStore } from "./digital.ts"
import { createHomeStore, type PtzPosition, samePosition } from "./home.ts"
import { createPresetStore, isJpeg, makeThumbnail } from "./presets.ts"
import { lensFactor, lensPosition } from "./zoom-curve.ts"

const log = logger("live")

const ver = (o: any, key: string) => Number(o?.[key]?.ver ?? 0) || 0

export type ReolinkCapabilities = {
	pan: boolean
	tilt: boolean
	zoom: boolean
	presets: boolean
	ir: boolean
	spotlight: boolean
	snap: boolean
}

/**
 * Reads `GetAbility`'s answer for one channel. `ptzType` is the camera's PTZ
 * kind (1 zoom only, 2 full PTZ, 3 pan/tilt, 5 PTZ with auto-tracking, 6 pan
 * only); newer firmware also states `supportPt`/`supportZoom` directly.
 */
export const reolinkCapabilities = (ability: unknown, channel: number): ReolinkCapabilities => {
	const a = (ability as any)?.Ability ?? ability
	const chn = a?.abilityChn?.[channel] ?? {}
	const type = ver(chn, "ptzType")
	const hasPtz = type > 0 || ver(chn, "ptzCtrl") > 0
	const pt = ver(chn, "supportPt") > 0
	return {
		pan: hasPtz && (pt || [2, 3, 5, 6].includes(type)),
		tilt: hasPtz && (pt || [2, 3, 5].includes(type)),
		zoom: hasPtz && (ver(chn, "supportZoom") > 0 || [1, 2, 5].includes(type)),
		presets: hasPtz && ver(chn, "ptzPreset") > 0,
		ir: ver(chn, "ledControl") > 0,
		spotlight: ver(chn, "supportFLswitch") > 0 || ver(chn, "floodLight") > 0,
		// every Reolink camera with an HTTP API answers Snap; firmware that lists abilities says so
		snap: chn.snap === undefined || ver(chn, "snap") > 0
	}
}

/** Everything else look4 drives, from the channel's and the device's abilities and `GetDevInfo`. */
export type ReolinkFeatures = ReolinkCapabilities & {
	focus: boolean
	autofocus: boolean
	/** `Set3DPos`: centre a point of the picture (look4's `box` op adds the zoom). */
	box: boolean
	speed: boolean
	/** Preset thumbnails stored on the camera (`ExportImg` / `ImportImg`). */
	presetImages: boolean
	dayNight: boolean
	siren: boolean
	tracking: boolean
	microphone: boolean
	brightness: boolean
}

export const reolinkFeatures = (ability: unknown, channel: number, devInfo: unknown = null): ReolinkFeatures => {
	const a = (ability as any)?.Ability ?? ability
	const chn = a?.abilityChn?.[channel] ?? {}
	const base = reolinkCapabilities(ability, channel)
	const ptz = base.pan || base.tilt || base.zoom
	const audioNum = Number((devInfo as any)?.DevInfo?.audioNum)
	return {
		...base,
		focus: ptz && ver(chn, "supportFocus") > 0,
		autofocus: ptz && (ver(chn, "disableAutoFocus") > 0 || ver(a, "disableAutoFocus") > 0),
		box: ptz && ver(chn, "supportPtz3DLocation") > 0,
		speed: ptz && ver(chn, "supportPtzSpeed") > 0,
		presetImages: base.presets && ver(chn, "supportPtzPresetImage") > 0 && ver(chn, "supportImportExportImage") > 0,
		dayNight: ver(chn, "ispDayNight") > 0,
		siren: ver(a, "supportAudioAlarm") > 0 || ver(chn, "alarmAudio") > 0,
		tracking: ver(chn, "aiTrack") > 0,
		// `Enc.audio` exists on cameras without a microphone too; DevInfo's audioNum says whether one is fitted
		microphone: (chn.enc === undefined || ver(chn, "enc") > 0) && audioNum !== 0,
		brightness: base.spotlight && ver(chn, "supportFLBrightness") > 0
	}
}

const OPS: Record<PtzDirection, string> = {
	up: "Up",
	down: "Down",
	left: "Left",
	right: "Right",
	upLeft: "LeftUp",
	upRight: "RightUp",
	downLeft: "LeftDown",
	downRight: "RightDown"
}

const DAY_NIGHT: Record<DayNightMode, string> = { auto: "Auto", color: "Color", bw: "Black&White" }

/**
 * A held arrow whose release never arrived (a closed tab, a dropped connection) stops by itself this long
 * after its last request; the page resends a held move well inside it.
 */
export const PTZ_AUTO_STOP_MS = 8000

/** A spotlight look4 switched on goes off by itself after this, so a forgotten tab can't leave it burning all night. */
export const SPOTLIGHT_OFF_MS = 10 * 60_000

type ZoomRange = { min: number; max: number; pos: number }
type Span = { min: number; max: number }

/**
 * Pan/tilt speed (1–64): `speed` when given, else from the zoom, slower when zoomed in so one tap
 * doesn't throw a tight view far off target (32 wide open, about 6 at full zoom). `slow` halves it.
 */
export const ptzSpeed = (o: { speed?: number; slow?: boolean; zoom: ZoomRange | null }) => {
	const z = o.zoom
	let s =
		o.speed !== undefined
			? Math.min(64, Math.max(1, Math.round(o.speed)))
			: Math.min(64, Math.max(4, Math.round(32 * (1 - (z && z.max > z.min ? (0.8 * (z.pos - z.min)) / (z.max - z.min) : 0)))))
	if (o.slow) s = Math.max(1, Math.round(s / 2))
	return s
}

/**
 * A normalized box on the full frame as `Set3DPos` pixels in a `width`×`height` frame: the box's
 * TOP-LEFT corner and size (what the camera's own web UI sends, whatever reolink_aio's docstring
 * says), moved inside the frame, rounded down. A 0×0 box is a point to centre on.
 */
export const boxPixels = (b: { x: number; y: number; w: number; h: number }, frame: { width: number; height: number }) => {
	const unit = (n: number) => Math.min(1, Math.max(0, n))
	const w = unit(b.w)
	const h = unit(b.h)
	const x = Math.max(0, Math.min(unit(b.x), 1 - w))
	const y = Math.max(0, Math.min(unit(b.y), 1 - h))
	return {
		posX: Math.min(frame.width - 1, Math.floor(frame.width * x)),
		posY: Math.min(frame.height - 1, Math.floor(frame.height * y)),
		posWidth: Math.floor(frame.width * w),
		posHeight: Math.floor(frame.height * h)
	}
}

/** The camera turned down the password (or has locked sign-ins): the answer this driver never asks for twice. */
const isRefusal = (e: unknown): e is ReolinkError => {
	if (!(e instanceof ReolinkError) || e.cmd !== "Login") return false
	const p = loginProblem(e)
	return p === "bad-credentials" || p === "locked-out"
}

const refusal = (e: ReolinkError) => {
	const left = e.attemptsLeft
	if (loginProblem(e) === "locked-out")
		return "The camera is refusing sign-ins for a while after too many wrong passwords. Wait a few minutes, then fix the password in Settings."
	return `The camera turned down the saved password, so look4 won't try it again${left !== null ? ` (the camera allows ${left} more wrong ${left === 1 ? "try" : "tries"} before it locks)` : ""}. Fix the password in Settings → Sources.`
}

export type ReolinkControlOptions = {
	/** A reason not to sign in at all (the source adapter's own login was refused), checked before each call. */
	blocked?: () => string | null
	timeoutMs?: number
	/** Default PTZ_AUTO_STOP_MS. */
	autoStopMs?: number
	/** look4's data directory, for view thumbnails and the Home position (`<dataDir>/live/`). */
	dataDir?: string
	/** Default SPOTLIGHT_OFF_MS. */
	spotlightOffMs?: number
	/**
	 * How often to read the position while waiting for a view or Home move to finish (it has when the position
	 * holds across two reads). Default 1 s, as the camera's web UI polls.
	 */
	settlePollMs?: number
	/** The same for `zoomTo`'s `settle`, which someone is waiting on. Default 150 ms (a read takes 0.2–0.8 s on the camera). */
	arrivePollMs?: number
	/** `settle` answers after this at the latest, still or not. Default 3 s. */
	arriveMaxMs?: number
	/** Default CAMERA_PICTURE_MAX_AGE_MS: how long a view picture fetched from the camera is served before it's fetched again. */
	viewPictureMaxAgeMs?: number
}

type Slot = { id: number; enable: boolean; name: string; imgName: string }

const slotsOf = (value: any): Slot[] =>
	(Array.isArray(value?.PtzPreset) ? value.PtzPreset : [])
		.filter((p: any) => Number.isInteger(Number(p?.id)))
		.map((p: any) => ({ id: Number(p.id), enable: Number(p.enable) === 1, name: String(p.name ?? ""), imgName: String(p.imgName ?? "") }))

const rangeOf = (range: any, pos: any): PositionRange | null => {
	const min = Number(range?.min)
	const max = Number(range?.max)
	const p = Number(pos)
	return Number.isFinite(min) && Number.isFinite(max) && Number.isFinite(p) && max > min ? { min, max, pos: p } : null
}

/** The centre of a normalized box, kept inside the frame as `boxPixels` keeps the box. */
const boxCentre = (b: { x: number; y: number; w: number; h: number }) => {
	const unit = (n: number) => Math.min(1, Math.max(0, n))
	const w = unit(b.w)
	const h = unit(b.h)
	return { x: Math.max(0, Math.min(unit(b.x), 1 - w)) + w / 2, y: Math.max(0, Math.min(unit(b.y), 1 - h)) + h / 2 }
}

const positionOf = (value: any): PtzPosition | null => {
	const c = value?.PtzCurPos
	const pos = { pan: Number(c?.Ppos), tilt: Number(c?.Tpos), zoom: Number(c?.Zpos) }
	return c && Object.values(pos).every(Number.isFinite) ? pos : null
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms).unref())

const safeName = (name: string) => name.replace(/[^\w.-]+/g, "_")

export const createReolinkControl = (cfg: ReolinkSourceConfig, env: NodeJS.ProcessEnv, opts: ReolinkControlOptions = {}): CameraControl => {
	const client = createReolinkClient({
		host: cfg.host,
		username: cfg.username,
		password: () => env[cfg.passwordEnv],
		protocol: cfg.protocol,
		channel: cfg.channel,
		timeoutMs: opts.timeoutMs ?? 10_000
	})
	const ch = cfg.channel
	const dir = opts.dataDir ? join(opts.dataDir, "live", safeName(cfg.name)) : null
	const home = createHomeStore(dir)
	const views = createPresetStore(dir, { maxAgeMs: opts.viewPictureMaxAgeMs })
	const digital = createDigitalStore(dir)
	const settlePollMs = opts.settlePollMs ?? 1000
	const arrivePollMs = opts.arrivePollMs ?? 150
	const arriveMaxMs = opts.arriveMaxMs ?? 3000

	let refused: string | null = null
	let feats: ReolinkFeatures | null = null
	let model: string | null = null
	let autoStop: NodeJS.Timeout | null = null
	/** The PtzCtrl of the held move the camera is running (as sent), while the auto-stop guards it. */
	let holding: string | null = null
	let spotOff: { timer: NodeJS.Timeout; at: number } | null = null
	/** The last zoom read, for the automatic speed; `stale` after anything that may have zoomed. */
	let zoom: (ZoomRange & { stale: boolean }) | null = null
	/** The main stream's size, the frame `Set3DPos` points are measured in. */
	let frame: { width: number; height: number } | null = null
	/** The zoom and focus sliders' ends, which never change: read once, then `zoomTo` is one round trip. */
	let spans: { zoom: Span | null; focus: Span | null } | null = null
	let slots: Slot[] | null = null
	/** The field that switches tracking on this firmware, once read. */
	let trackKey: "bSmartTrack" | "aiTrack" | null = null
	/** Bumped by every move: a wait for the previous one to finish gives up. */
	let moveGen = 0
	let closed = false

	const blockedReason = () => refused ?? opts.blocked?.() ?? null

	const call = async <t>(fn: () => Promise<t>): Promise<t> => {
		const block = blockedReason()
		if (block) throw new ControlError(409, block)
		if (env[cfg.passwordEnv] === undefined) throw new ControlError(409, `The camera's password isn't saved yet (${cfg.passwordEnv}).`)
		try {
			return await fn()
		} catch (e) {
			if (isRefusal(e)) {
				refused = refusal(e)
				throw new ControlError(409, refused)
			}
			if (e instanceof ReolinkError) throw new ControlError(502, `The camera said no: ${e.message}`)
			if (e instanceof ReolinkNetworkError) throw new ControlError(502, `Couldn't reach the camera: ${e.message}`)
			throw e
		}
	}

	/**
	 * Work after a request has answered (waiting for a move to finish, timers): never signs in against a refusal, never throws.
	 * A refusal it meets is recorded like call()'s, so the next request reports it instead of trying the password again.
	 */
	const background = (what: string, fn: () => Promise<unknown>) => {
		if (closed || blockedReason() || env[cfg.passwordEnv] === undefined) return
		void fn().catch(e => {
			if (isRefusal(e)) refused = refusal(e)
			log.warn(`${cfg.name}: ${what} failed: ${e instanceof Error ? e.message : String(e)}`)
		})
	}

	const features = async (signal?: AbortSignal): Promise<ReolinkFeatures> => {
		if (feats) return feats
		const [ability, dev] = await client.batch(
			[
				{ cmd: "GetAbility", param: { User: { userName: cfg.username } } },
				{ cmd: "GetDevInfo", param: { channel: ch } }
			],
			signal
		)
		if (ability!.error) throw ability!.error
		const d = dev!.error ? null : dev!.value
		model = d?.DevInfo?.model ? String(d.DevInfo.model) : null
		return (feats = reolinkFeatures(ability!.value, ch, d))
	}

	const hasPtz = (f: ReolinkFeatures) => f.pan || f.tilt || f.zoom

	/** The commands whose `when` holds, in one POST, by name. */
	const ask = async (calls: Array<(ReolinkCall & { when: boolean }) | null>, signal?: AbortSignal) => {
		const wanted = calls.filter((c): c is ReolinkCall & { when: boolean } => !!c?.when).map(({ when: _, ...c }) => c)
		const results = await client.batch(wanted, signal)
		const by = new Map<string, ReolinkResult>(results.map(r => [r.cmd, r]))
		return (cmd: string) => {
			const r = by.get(cmd)
			return r && !r.error ? r : null
		}
	}

	const learnZoom = (range: PositionRange | null) => {
		if (range) zoom = { ...range, stale: false }
	}

	/** The main stream's size from a `Get3DPos` answer, kept once known. */
	const learnFrame = (v: any) => {
		const main = v?.["3d_pos"]?.mainStream
		if (Number(main?.width) > 0 && Number(main?.height) > 0) frame = { width: Number(main.width), height: Number(main.height) }
		return frame
	}

	const spanOf = (r: PositionRange | null): Span | null => (r ? { min: r.min, max: r.max } : null)

	/** Both sliders' ends (and the zoom's position), from one `GetZoomFocus` the first time. */
	const sliders = async () => {
		if (spans) return spans
		const r = await client.commandFull("GetZoomFocus", { channel: ch })
		const z = rangeOf(r.range?.ZoomFocus?.zoom?.pos, r.value?.ZoomFocus?.zoom?.pos)
		learnZoom(z)
		return (spans = { zoom: spanOf(z), focus: spanOf(rangeOf(r.range?.ZoomFocus?.focus?.pos, r.value?.ZoomFocus?.focus?.pos)) })
	}

	/** Views whose picture is being fetched again in the background. */
	const refetching = new Set<number>()

	const presetImageUrl = async (s: Slot, f: ReolinkFeatures) => {
		const v = await views.version(s.id, s.imgName)
		const stored = views.has(s.id, v)
		// the view list is being read: fetch an old camera picture again now, so a picture re-saved in the
		// Reolink app gets its new URL by the next read instead of waiting out a browser's day-long cache
		if (stored && f.presetImages && s.imgName !== "" && !refetching.has(s.id) && (await views.due(s.id)))
			background("view picture refresh", async () => {
				refetching.add(s.id)
				try {
					await presetImage(s.id)
				} finally {
					refetching.delete(s.id)
				}
			})
		const available = stored || (f.presetImages && s.imgName !== "" && !views.isMissing(s.id, v))
		return available ? `/api/live/${encodeURIComponent(cfg.name)}/presets/${s.id}/image?v=${v}` : null
	}

	const spotlightDetail = (on: boolean) => {
		if (!on) return "The white light is off."
		if (!spotOff) return "The white light is on."
		const min = Math.max(1, Math.ceil((spotOff.at - Date.now()) / 60_000))
		return `The white light is on. look4 switches it off by itself in ${min} min.`
	}

	const read = async (signal?: AbortSignal): Promise<CameraControls> => {
		const f = await features(signal)
		const ptz = hasPtz(f)
		const got = await ask(
			[
				{ cmd: "GetPtzPreset", action: 1, param: { channel: ch }, when: f.presets },
				{ cmd: "GetZoomFocus", action: 1, param: { channel: ch }, when: f.zoom || f.focus },
				{ cmd: "GetAutoFocus", param: { channel: ch }, when: f.autofocus },
				{ cmd: "GetPtzGuard", action: 1, param: { channel: ch }, when: ptz },
				{ cmd: "GetAiCfg", param: { channel: ch }, when: f.tracking },
				{ cmd: "GetIrLights", param: { channel: ch }, when: f.ir },
				{ cmd: "GetWhiteLed", action: 1, param: { channel: ch }, when: f.spotlight },
				{ cmd: "GetIsp", param: { channel: ch }, when: f.dayNight },
				{ cmd: "GetEnc", param: { channel: ch }, when: f.microphone },
				// the frame a wheel step's point is measured in, so the first step needs no round trip of its own
				{ cmd: "Get3DPos", param: { channel: ch }, when: f.box && !frame }
			],
			signal
		)
		learnFrame(got("Get3DPos")?.value)

		const lights: CameraLight[] = []
		const ir = got("GetIrLights")?.value?.IrLights
		if (f.ir && ir) {
			const on = String(ir.state) !== "Off"
			lights.push({
				id: "ir",
				label: "Night vision",
				on,
				detail: on ? "The infrared lights come on by themselves when it gets dark." : "Off: the picture stays dark at night."
			})
		}
		const white = got("GetWhiteLed")?.value?.WhiteLed
		if (f.spotlight && white) {
			const on = Number(white.state) === 1
			if (!on && spotOff) clearSpotOff()
			const light: CameraLight = { id: "spotlight", label: "Spotlight", on, detail: spotlightDetail(on) }
			if (f.brightness && Number.isFinite(Number(white.bright))) light.brightness = Number(white.bright)
			lights.push(light)
		}

		const isp = got("GetIsp")?.value?.Isp
		const dayNight = (Object.entries(DAY_NIGHT).find(([, v]) => v === isp?.dayNight)?.[0] ?? null) as DayNightMode | null
		const enc = got("GetEnc")?.value?.Enc
		const microphone = enc && "audio" in enc ? Number(enc.audio) === 1 : null

		let controlsPtz: CameraControls["ptz"] = null
		if (ptz) {
			const zf = got("GetZoomFocus")
			const zoomRange = f.zoom ? rangeOf(zf?.range?.ZoomFocus?.zoom?.pos, zf?.value?.ZoomFocus?.zoom?.pos) : null
			const focusRange = f.focus ? rangeOf(zf?.range?.ZoomFocus?.focus?.pos, zf?.value?.ZoomFocus?.focus?.pos) : null
			learnZoom(zoomRange)
			if (zf) spans = { zoom: spanOf(zoomRange), focus: spanOf(focusRange) }

			const presetsAnswer = got("GetPtzPreset")
			if (presetsAnswer) slots = slotsOf(presetsAnswer.value)
			const list = f.presets ? (slots ?? []) : []
			const presets: CameraPreset[] = await Promise.all(
				list
					.filter(s => s.enable)
					.map(async s => ({ id: s.id, name: s.name || `View ${s.id + 1}`, image: await presetImageUrl(s, f), digital: await digital.view(s.id) }))
			)

			const g = got("GetPtzGuard")
			const gv = g?.value?.PtzGuard
			const guard = gv
				? {
						set: Number(gv.bexistPos) === 1,
						autoReturn: Number(gv.benable) === 1,
						timeoutS: Number(gv.timeout) || 60,
						minS: Number(g!.range?.PtzGuard?.timeout?.min) || 10,
						maxS: Number(g!.range?.PtzGuard?.timeout?.max) || 300,
						digital: await digital.home()
					}
				: null

			const ai = got("GetAiCfg")?.value
			let tracking: { on: boolean } | null = null
			if (ai && "bSmartTrack" in ai) {
				trackKey = "bSmartTrack"
				tracking = { on: Number(ai.bSmartTrack) === 1 }
			} else if (ai && "aiTrack" in ai) {
				// firmware before bSmartTrack switched tracking with aiTrack itself
				trackKey = "aiTrack"
				tracking = { on: Number(ai.aiTrack) === 1 }
			}

			const af = got("GetAutoFocus")?.value?.AutoFocus
			controlsPtz = {
				pan: f.pan,
				tilt: f.tilt,
				zoom: f.zoom,
				focus: f.focus,
				zoomRange,
				focusRange,
				autofocus: af ? Number(af.disable) !== 1 : null,
				box: f.box,
				speed: f.speed,
				presets,
				maxPresets: f.presets ? list.length : 0,
				guard,
				tracking
			}
		}

		return { ptz: controlsPtz, lights, dayNight: f.dayNight ? dayNight : null, siren: f.siren, microphone: f.microphone ? microphone : null, snapshot: f.snap, model }
	}

	const ptzCtrl = (param: Record<string, unknown>) => client.command("PtzCtrl", { channel: ch, ...param })

	const clearAutoStop = () => {
		if (autoStop) clearTimeout(autoStop)
		autoStop = null
	}

	const armAutoStop = () => {
		clearAutoStop()
		autoStop = setTimeout(() => {
			autoStop = null
			background("auto-stop", () => ptzCtrl({ op: "Stop" }))
		}, opts.autoStopMs ?? PTZ_AUTO_STOP_MS)
		autoStop.unref()
	}

	/**
	 * Starts a held move (pan/tilt, zoom, focus); `held` is the one running when the request came in.
	 * The page resends a move every few seconds while it's held, to keep the auto-stop from ending it;
	 * a resend of exactly what's already running only re-arms the auto-stop. The camera never hears
	 * it, so a long pan can't stutter on however this firmware takes a repeated PtzCtrl, and Shift
	 * (a new speed) or a new direction still goes straight through.
	 */
	const hold = async (held: string | null, param: Record<string, unknown>) => {
		const key = JSON.stringify(param)
		if (key !== held) await ptzCtrl(param)
		holding = key
		armAutoStop()
	}

	const clearSpotOff = () => {
		if (spotOff) clearTimeout(spotOff.timer)
		spotOff = null
	}

	const armSpotOff = () => {
		clearSpotOff()
		const ms = opts.spotlightOffMs ?? SPOTLIGHT_OFF_MS
		const timer = setTimeout(() => {
			spotOff = null
			background("spotlight auto-off", () => client.command("SetWhiteLed", { WhiteLed: { channel: ch, state: 0 } }))
		}, ms)
		timer.unref()
		spotOff = { timer, at: Date.now() + ms }
	}

	/** The zoom for the automatic speed: the last one read, refreshed in the background when a move may have changed it. */
	const zoomForSpeed = async (f: ReolinkFeatures) => {
		if (!f.zoom) return null
		const refresh = async () => {
			const r = await client.commandFull("GetZoomFocus", { channel: ch })
			learnZoom(rangeOf(r.range?.ZoomFocus?.zoom?.pos, r.value?.ZoomFocus?.zoom?.pos))
			return zoom
		}
		if (zoom && !zoom.stale) return zoom
		if (zoom) {
			background("zoom read", refresh)
			return zoom
		}
		return refresh().catch(e => {
			// the move's own PtzCtrl would only sign in with the same password again
			if (isRefusal(e)) throw e
			return null
		})
	}

	const markZoomStale = () => {
		if (zoom) zoom.stale = true
	}

	/** Where the lens is now, for a zoom relative to it: the last position known, or read when a move may have changed it. */
	const zoomNow = async () => {
		if (zoom && !zoom.stale) return zoom
		const r = await client.commandFull("GetZoomFocus", { channel: ch })
		learnZoom(rangeOf(r.range?.ZoomFocus?.zoom?.pos, r.value?.ZoomFocus?.zoom?.pos))
		return zoom
	}

	const currentPosition = async () => positionOf(await client.command("GetPtzCurPos", { PtzCurPos: { channel: ch } }))

	/**
	 * Pan, tilt and the lens's position in one round trip; null when the camera didn't say. `lens` is null
	 * when `GetZoomFocus` failed in the batch (it has answered NaN mid-move): `Zpos` is another unit, so
	 * it can't stand in for it. The caller decides whether the reading may go into the zoom cache.
	 */
	const where = async (signal?: AbortSignal) => {
		const [cur, zf] = await client.batch(
			[
				{ cmd: "GetPtzCurPos", param: { PtzCurPos: { channel: ch } } },
				{ cmd: "GetZoomFocus", param: { channel: ch } }
			],
			signal
		)
		const pos = cur!.error ? null : positionOf(cur!.value)
		const z = Number(zf!.error ? NaN : zf!.value?.ZoomFocus?.zoom?.pos)
		return pos && { ...pos, lens: Number.isFinite(z) ? z : null }
	}

	/**
	 * Waits until the camera stands still: the same pan, tilt and zoom on two reads in a row, and the lens
	 * within a step of `zoomTo` when given (a read without the lens's position can't say, so only the rest
	 * must hold). `GetPtzStat` can't say: this camera answers 0 even mid-move. False when it gave up: another
	 * move came (`gen`), look4 closed, a refusal, or `maxMs` went by. The cap is a deadline, not a count of
	 * reads: a read takes 0.2–0.8 s on the camera while it moves, so twenty of them could be 19 s, and one
	 * still out at the deadline is cut off.
	 */
	const still = async (gen: number, o: { pollMs: number; maxMs: number; zoomTo?: number }) => {
		const end = Date.now() + o.maxMs
		let prev: string | null = null
		// each read signs in again if the session died, so a refusal (met here or by any other request
		// meanwhile) ends the wait: a wait can't go on to the camera's ten tries before it locks
		while (gen === moveGen && !closed && !blockedReason()) {
			await sleep(Math.min(o.pollMs, Math.max(0, end - Date.now())))
			if (gen !== moveGen || closed || Date.now() >= end) return false
			const p = await where(AbortSignal.timeout(Math.max(1, end - Date.now()))).catch(e => {
				if (isRefusal(e)) throw e
				return null
			})
			if (gen !== moveGen || closed) return false
			const key = p && `${p.pan} ${p.tilt} ${p.zoom} ${p.lens}`
			if (p && key === prev && (o.zoomTo === undefined || p.lens === null || Math.abs(p.lens - o.zoomTo) <= 1)) {
				// where the lens came to rest, and only from a wait no newer move has replaced: a reading from
				// mid-move, or one a newer zoom overtook, would be taken as fresh by the next relative zoom
				if (p.lens !== null && zoom) zoom = { ...zoom, pos: p.lens, stale: false }
				return true
			}
			prev = key
		}
		return false
	}

	/** After a move: once the camera stands still, runs `then`, unless another move came first. */
	const whenSettled = (what: string, then: () => Promise<void>) => {
		const gen = ++moveGen
		background(what, async () => {
			if (await still(gen, { pollMs: settlePollMs, maxMs: 20 * settlePollMs })) await then()
		})
	}

	const frameSize = async () => {
		if (frame) return frame
		const fr = learnFrame(await client.command("Get3DPos", { channel: ch }))
		if (!fr) throw new ControlError(502, "The camera didn't say its picture size.")
		return fr
	}

	/**
	 * Centres `aim` (a point of the picture as it is now) and/or zooms the lens to `pos`, in one POST, the
	 * point first. Measured on the RLC-823S1: a point pans and tilts without zooming and is done about a
	 * second later; `ZoomPos` sent after it lets both finish, but a point sent after `ZoomPos` stops the
	 * zoom where it is. `Set3DPos` with a box zooms OUT on this camera (position 8 → 7, or → 4 at speed 64,
	 * for a 1.5× box), which is why nothing sends one.
	 *
	 * Sends nothing, and answers false, when a newer move (`gen`) came while it waited: the page lets a
	 * wheel-out go 150 ms after an aimed step, and if that step was still learning the frame size, its
	 * zoom in would reach the camera after the zoom out and undo it.
	 */
	const aimAndZoom = async (gen: number, aim: { x: number; y: number } | null, pos: number | null, speed: number) => {
		const calls: ReolinkCall[] = []
		if (aim) {
			const fr = await frameSize()
			calls.push({ cmd: "Set3DPos", param: { "3DPos": { channel: ch, ...boxPixels({ ...aim, w: 0, h: 0 }, fr), speed, width: fr.width, height: fr.height } } })
		}
		if (pos !== null) calls.push({ cmd: "StartZoomFocus", param: { ZoomFocus: { channel: ch, op: "ZoomPos", pos } } })
		if (gen !== moveGen) return false
		for (const r of await client.batch(calls)) if (r.error) throw r.error
		return true
	}

	const freshSlots = async (signal?: AbortSignal) => (slots = slotsOf(await client.command("GetPtzPreset", { channel: ch }, signal)))

	/** A thumbnail made from what the camera sees now, or null when the camera has no still to give. */
	const thumbnailNow = async () => {
		try {
			return await makeThumbnail(await client.snapshot())
		} catch (e) {
			log.warn(`${cfg.name}: couldn't make a view thumbnail: ${e instanceof Error ? e.message : String(e)}`)
			return null
		}
	}

	/** After reaching a saved view: give it a look4-made picture if it has none at all. */
	const thumbnailIfMissing = async (id: number) => {
		const f = await features()
		const s = (slots ?? (await freshSlots())).find(x => x.id === id && x.enable)
		if (!s) return
		const v = await views.version(id, s.imgName)
		if (views.has(id, v) || (f.presetImages && s.imgName !== "" && !views.isMissing(id, v))) return
		const jpeg = await thumbnailNow()
		if (jpeg) await views.put(id, v, jpeg)
	}

	const guardNow = async () => {
		try {
			const r = await client.commandFull("GetPtzGuard", { channel: ch })
			const g = r.value?.PtzGuard
			if (!g) throw new ReolinkError("GetPtzGuard", null, "no PtzGuard in answer")
			return { g, min: Number(r.range?.PtzGuard?.timeout?.min) || 10, max: Number(r.range?.PtzGuard?.timeout?.max) || 300 }
		} catch (e) {
			if (e instanceof ReolinkError) throw new ControlError(400, "This camera has no Home view.")
			throw e
		}
	}

	/** Ops whose lost answer may leave the camera moving. */
	const MAY_MOVE = new Set<PtzBody["op"]>(["stop", "move", "zoom", "focus"])

	const ptz = async (body: PtzBody) => {
		const f = await features()
		if (!hasPtz(f)) throw new ControlError(400, "This camera can't move.")
		const armed = autoStop !== null
		const held = armed ? holding : null
		clearAutoStop()
		holding = null
		try {
			switch (body.op) {
				case "stop":
					moveGen++
					markZoomStale()
					await ptzCtrl({ op: "Stop" })
					return
				case "move": {
					const vertical = /up|down/i.test(body.direction)
					const horizontal = /left|right/i.test(body.direction)
					if ((horizontal && !f.pan) || (vertical && !f.tilt)) throw new ControlError(400, "This camera can't turn that way.")
					moveGen++
					const speed = ptzSpeed({ speed: body.speed, slow: body.slow, zoom: body.speed === undefined ? await zoomForSpeed(f) : null })
					return await hold(held, { op: OPS[body.direction], ...(f.speed ? { speed } : {}) })
				}
				case "zoom":
				case "focus": {
					if (body.op === "zoom" && !f.zoom) throw new ControlError(400, "This camera can't zoom.")
					if (body.op === "focus" && !f.focus) throw new ControlError(400, "This camera can't focus by hand.")
					moveGen++
					markZoomStale()
					const op = body.op === "zoom" ? (body.direction === "in" ? "ZoomInc" : "ZoomDec") : body.direction === "near" ? "FocusInc" : "FocusDec"
					const speed = ptzSpeed({ speed: body.speed, slow: body.slow, zoom: null })
					return await hold(held, { op, ...(f.speed ? { speed } : {}) })
				}
				case "zoomTo": {
					if (!f.zoom) throw new ControlError(400, "This camera can't zoom.")
					if (body.aim && !f.box) throw new ControlError(400, "This camera can't aim at a point of the picture.")
					// the move is counted when it arrives, before anything it reads: a later one that overtakes
					// it on the way to the camera wins, and this one is never sent (see aimAndZoom)
					const gen = ++moveGen
					const span = (await sliders()).zoom
					if (!span) throw new ControlError(400, "This camera has no zoom slider.")
					const pos = Math.round(Math.min(span.max, Math.max(span.min, body.pos)))
					// the point's speed is for the zoom it starts from
					const speed = body.aim ? ptzSpeed({ zoom: await zoomForSpeed(f) }) : 0
					if (body.aim) {
						if (!(await aimAndZoom(gen, body.aim, pos, speed))) return
					} else {
						if (gen !== moveGen) return
						await client.command("StartZoomFocus", { ZoomFocus: { channel: ch, op: "ZoomPos", pos } })
					}
					zoom = { ...span, pos, stale: false }
					// a held move this replaced was stopped by the camera taking the new command, so the wait
					// needs no auto-stop: nothing here keeps the camera moving
					if (body.settle) await still(gen, { pollMs: arrivePollMs, maxMs: arriveMaxMs, zoomTo: pos })
					return
				}
				case "focusTo": {
					if (!f.focus) throw new ControlError(400, "This camera can't focus by hand.")
					const span = (await sliders()).focus
					if (!span) throw new ControlError(400, "This camera has no focus slider.")
					const pos = Math.round(Math.min(span.max, Math.max(span.min, body.pos)))
					moveGen++
					await client.command("StartZoomFocus", { ZoomFocus: { channel: ch, op: "FocusPos", pos } })
					return
				}
				case "preset": {
					if (!f.presets) throw new ControlError(400, "This camera has no saved views.")
					moveGen++
					await ptzCtrl({ op: "ToPos", id: body.id, speed: 32 })
					markZoomStale()
					whenSettled("view thumbnail", () => thumbnailIfMissing(body.id))
					return
				}
				case "home": {
					moveGen++
					const { g } = await guardNow()
					if (Number(g.bexistPos) !== 1) throw new ControlError(409, "No Home view is saved yet. Point the camera at the feeder and use “Make this view Home”.")
					await client.command("SetPtzGuard", { PtzGuard: { channel: ch, cmdStr: "toPos" } })
					markZoomStale()
					// the camera won't say where Home is; read it once it gets there
					whenSettled("Home position", async () => {
						const pos = await currentPosition()
						if (pos) await home.set(pos)
					})
					return
				}
				case "box": {
					if (!f.box) throw new ControlError(400, "This camera can't frame a part of the picture.")
					// The box's centre, then the lens to the position whose measured magnification is the
					// current one times what makes the box fill the view (all of it: its longer side).
					const gen = ++moveGen
					const side = Math.max(body.w, body.h)
					const z = side > 0 && f.zoom ? await zoomNow() : null
					const pos = z ? Math.round(lensPosition(lensFactor(z.pos, z) / side, z)) : null
					const speed = ptzSpeed({ speed: body.speed, zoom: body.speed === undefined ? (z ?? (await zoomForSpeed(f))) : null })
					if (!(await aimAndZoom(gen, boxCentre(body), pos, speed))) return
					if (z && pos !== null) zoom = { min: z.min, max: z.max, pos, stale: false }
					return
				}
			}
		} catch (e) {
			// the camera may still be moving: the held move this op was meant to stop or replace, or a move
			// or Stop whose answer was lost (a timeout, a dropped connection). The auto-stop stays the
			// guarantee: a Stop to a camera that stands still is harmless, one left panning to its end stop is not
			if (armed || (!(e instanceof ControlError) && MAY_MOVE.has(body.op))) armAutoStop()
			throw e
		}
	}

	const setLight = async (body: LightBody) => {
		const f = await features()
		if (body.on === undefined && body.brightness === undefined) throw new ControlError(400, "Say whether to switch the light on or off, or how bright it should be.")
		if (body.id === "ir") {
			if (!f.ir) throw new ControlError(400, "This camera has no night vision switch.")
			if (body.on === undefined) throw new ControlError(400, "Night vision has no brightness.")
			// this camera family offers only Auto and Off
			await client.command("SetIrLights", { IrLights: { channel: ch, state: body.on ? "Auto" : "Off" } })
		} else {
			if (!f.spotlight) throw new ControlError(400, "This camera has no spotlight.")
			if (body.brightness !== undefined && !f.brightness) throw new ControlError(400, "This camera's spotlight can't be dimmed.")
			const led: Record<string, unknown> = { channel: ch }
			if (body.on !== undefined) led.state = body.on ? 1 : 0
			if (body.brightness !== undefined) led.bright = Math.round(Math.min(100, Math.max(0, body.brightness)))
			await client.command("SetWhiteLed", { WhiteLed: led })
			if (body.on === true) armSpotOff()
			if (body.on === false) clearSpotOff()
		}
		return read()
	}

	const setting = async (body: CameraSettingBody) => {
		const f = await features()
		switch (body.setting) {
			case "dayNight": {
				if (!f.dayNight) throw new ControlError(400, "This camera can't switch its night picture.")
				const isp = (await client.command("GetIsp", { channel: ch }))?.Isp
				if (!isp) throw new ControlError(502, "The camera didn't send its picture settings.")
				// the whole Isp back, as reolink_aio does: other fields left out might be reset
				await client.command("SetIsp", { Isp: { ...isp, dayNight: DAY_NIGHT[body.mode] } })
				break
			}
			case "tracking":
				if (!f.tracking) throw new ControlError(400, "This camera has no auto-tracking.")
				if (!trackKey) {
					const ai = await client.command("GetAiCfg", { channel: ch })
					trackKey = ai && !("bSmartTrack" in ai) && "aiTrack" in ai ? "aiTrack" : "bSmartTrack"
				}
				await client.command("SetAiCfg", { channel: ch, [trackKey]: body.on ? 1 : 0 })
				break
			case "microphone": {
				if (!f.microphone) throw new ControlError(400, "This camera has no microphone.")
				const enc = (await client.command("GetEnc", { channel: ch }))?.Enc
				if (!enc || !("audio" in enc)) throw new ControlError(400, "This camera has no microphone.")
				// SetEnc takes the whole Enc (both streams' settings); a partial one isn't known to be safe
				await client.command("SetEnc", { Enc: { ...enc, audio: body.on ? 1 : 0 } })
				break
			}
			case "autofocus":
				if (!f.autofocus) throw new ControlError(400, "This camera's autofocus can't be switched.")
				await client.command("SetAutoFocus", { AutoFocus: { channel: ch, disable: body.on ? 0 : 1 } })
				break
			case "home": {
				if (!hasPtz(f)) throw new ControlError(400, "This camera has no Home view.")
				if (!body.saveHere && body.autoReturn === undefined && body.timeoutS === undefined) throw new ControlError(400, "Say what to change about Home.")
				const { g, min, max } = await guardNow()
				const benable = body.autoReturn === undefined ? (Number(g.benable) === 1 ? 1 : 0) : body.autoReturn ? 1 : 0
				const timeout = Math.round(Math.min(max, Math.max(min, body.timeoutS ?? (Number(g.timeout) || 60))))
				if (body.saveHere) {
					await client.command("SetPtzGuard", { PtzGuard: { channel: ch, cmdStr: "setPos", bSaveCurrentPos: 1, bexistPos: 1, benable, timeout } })
					const pos = await currentPosition().catch(() => null)
					if (pos) await home.set(pos)
					await digital.setHome(body.digital)
				} else {
					if (benable === 1 && Number(g.bexistPos) !== 1) throw new ControlError(409, "Save a Home view first: there's nowhere to return to yet.")
					await client.command("SetPtzGuard", { PtzGuard: { channel: ch, cmdStr: "setPos", bSaveCurrentPos: 0, benable, timeout } })
				}
				break
			}
		}
		return read()
	}

	const imgNameFor = (id: number) => `preset_${String(id).padStart(2, "0")}`

	const preset = async (body: PresetBody) => {
		const f = await features()
		if (!f.presets) throw new ControlError(400, "This camera has no saved views.")
		const all = await freshSlots()
		const named = (name: string) => {
			const n = name.trim()
			if (!n || n.length > 31) throw new ControlError(400, "A view's name is 1 to 31 characters.")
			return n
		}
		const existing = (id: number) => {
			const s = all.find(x => x.id === id && x.enable)
			if (!s) throw new ControlError(404, `There's no saved view ${id}.`)
			return s
		}
		if (body.op === "save") {
			const name = named(body.name)
			const slot = body.id === undefined ? all.find(s => !s.enable) : all.find(s => s.id === body.id)
			if (!slot) {
				if (body.id !== undefined) throw new ControlError(404, `The camera has no view slot ${body.id}.`)
				throw new ControlError(409, `All ${all.length} saved views are in use. Delete one first.`)
			}
			const imgName = imgNameFor(slot.id)
			const thumb = await thumbnailNow()
			let uploaded = false
			if (thumb && f.presetImages) {
				// the camera's web UI uploads the picture before it saves the view
				try {
					await client.importImage(imgName, thumb)
					uploaded = true
				} catch (e) {
					log.warn(`${cfg.name}: the camera didn't take the view's thumbnail, keeping look4's own: ${e instanceof Error ? e.message : String(e)}`)
				}
			}
			// enable 1 stores where the camera points now
			await client.command("SetPtzPreset", { PtzPreset: { channel: ch, enable: 1, id: slot.id, name, ...(uploaded ? { imgName } : {}) } })
			// uploaded, the camera holds the same picture, so it's fetched again if the Reolink app re-saves the view
			await views.replace(slot.id, uploaded ? imgName : slot.imgName, thumb, uploaded)
			await digital.setView(slot.id, body.digital)
		} else if (body.op === "rename") {
			const s = existing(body.id)
			// no `enable`: only the name changes, the stored position stays
			await client.command("SetPtzPreset", { PtzPreset: { channel: ch, id: s.id, name: named(body.name), ...(s.imgName ? { imgName: s.imgName } : {}) } })
		} else {
			const s = existing(body.id)
			if (f.presetImages && s.imgName)
				await client.command("DeleteImg", { DeleteImg: { channel: ch, FileName: s.imgName } }).catch(e => log.warn(`${cfg.name}: DeleteImg failed: ${e instanceof Error ? e.message : String(e)}`))
			await client.command("SetPtzPreset", { PtzPreset: { channel: ch, enable: 0, id: s.id, name: s.name, ...(s.imgName ? { imgName: s.imgName } : {}) } })
			await views.replace(s.id, s.imgName, null)
			await digital.setView(s.id, null)
		}
		return read()
	}

	const presetImage = async (id: number, signal?: AbortSignal) => {
		const f = await features(signal)
		if (!f.presets) throw new ControlError(404, "This camera has no saved views.")
		const s = (slots?.some(x => x.id === id && x.enable) ? slots : await freshSlots(signal)).find(x => x.id === id && x.enable)
		if (!s) throw new ControlError(404, `There's no saved view ${id}.`)
		const v = await views.version(id, s.imgName)
		const stored = await views.read(id, v)
		const onCamera = f.presetImages && s.imgName !== ""
		if (stored && !(onCamera && (await views.due(id)))) return stored
		if (onCamera && !views.isMissing(id, v)) {
			try {
				const jpeg = await client.exportImage(s.imgName, signal)
				if (!isJpeg(jpeg)) throw new ReolinkError("ExportImg", null, "not a JPEG")
				// a different picture under the same image name (re-saved in the Reolink app) is a new version,
				// so pages holding the old URL fetch it again
				if (stored && !stored.equals(jpeg)) await views.replace(id, s.imgName, jpeg, true)
				else await views.put(id, v, jpeg, true)
				return jpeg
			} catch (e) {
				// a refused password is recorded (by call(), or here) so nothing tries it again
				if (isRefusal(e)) {
					if (!stored) throw e
					refused = refusal(e)
					return stored
				}
				if (stored) {
					// keep the old picture, and don't ask again for another day
					await views.put(id, v, stored, true)
					return stored
				}
				if (!(e instanceof ReolinkError)) throw e
				views.markMissing(id, v)
			}
		}
		if (stored) return stored
		throw new ControlError(404, "This view has no picture yet.")
	}

	const state = async (signal?: AbortSignal): Promise<CameraState> => {
		const f = await features(signal)
		if (!hasPtz(f)) return { moving: false, atHome: null, zoom: null, focus: null }
		const got = await ask(
			[
				{ cmd: "GetPtzStat", param: { PtzStat: { channel: ch } }, when: true },
				{ cmd: "GetPtzCurPos", param: { PtzCurPos: { channel: ch } }, when: true },
				{ cmd: "GetZoomFocus", param: { channel: ch }, when: f.zoom || f.focus },
				{ cmd: "GetPtzGuard", param: { channel: ch }, when: true }
			],
			signal
		)
		const stat = got("GetPtzStat")?.value?.PtzStat?.stat
		const zf = got("GetZoomFocus")?.value?.ZoomFocus
		const z = Number(zf?.zoom?.pos)
		const focus = Number(zf?.focus?.pos)
		if (f.zoom && Number.isFinite(z) && zoom) zoom = { ...zoom, pos: z, stale: false }
		const cur = positionOf(got("GetPtzCurPos")?.value)
		const guardSet = Number(got("GetPtzGuard")?.value?.PtzGuard?.bexistPos) === 1
		const saved = guardSet ? await home.get() : null
		return {
			moving: Number(stat ?? 0) !== 0,
			atHome: cur && saved ? samePosition(cur, saved) : null,
			zoom: f.zoom && Number.isFinite(z) ? z : null,
			focus: f.focus && Number.isFinite(focus) ? focus : null
		}
	}

	const siren = async () => {
		const f = await features()
		if (!f.siren) throw new ControlError(400, "This camera has no siren.")
		await client.command("AudioAlarmPlay", { channel: ch, alarm_mode: "times", times: 1 })
	}

	return {
		controls: signal => call(() => read(signal)),
		state: signal => call(() => state(signal)),
		ptz: body => call(() => ptz(body)),
		setLight: body => call(() => setLight(body)),
		setting: body => call(() => setting(body)),
		preset: body => call(() => preset(body)),
		presetImage: (id, signal) => call(() => presetImage(id, signal)),
		siren: () => call(siren),
		snapshot: signal => call(() => client.snapshot(signal)),
		close: async () => {
			clearAutoStop()
			moveGen++
			// a spotlight look4 switched on must not outlive look4
			if (spotOff && !blockedReason()) {
				clearSpotOff()
				await client.command("SetWhiteLed", { WhiteLed: { channel: ch, state: 0 } }).catch(() => {})
			}
			closed = true
			await client.close()
		}
	}
}

export const reolinkDriver = (opts: (cfg: ReolinkSourceConfig) => ReolinkControlOptions = () => ({})): ControlDriver => ({
	name: "reolink",
	create: (cfg, env) => (cfg.type === "reolink" ? createReolinkControl(cfg, env, opts(cfg)) : null)
})
