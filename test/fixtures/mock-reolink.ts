// A fake Reolink camera: the CGI API subset look4 uses, with the real JSON shapes,
// token leases, the -6 "please login first" error and the failed-login countdown
// (`remain_times`). Tests and the e2e point a `reolink` source at it.
//
// - Recordings: Login, Logout, GetDevInfo, GetTime, Search, Download/Playback, Snap.
// - Camera motion: GetMdState, GetAiState (driven by `setMotion` / `setAi`).
// - Live control (`abilities: "ptz"`, which starts from the real RLC-823S1's answers in
//   reolink-rlc823s1.json): GetAbility, PtzCtrl, presets with thumbnails (ExportImg,
//   multipart ImportImg, DeleteImg), the guard point, zoom/focus, Set3DPos, GetPtzStat,
//   GetPtzCurPos, lights, Isp, Enc, AiCfg, AutoFocus and the siren. `action: 1` answers
//   carry the real camera's `range`. Like the real RLC-823S1: GetPtzStat always says 0
//   (still), a move to a position takes `settleMs` with the positions read passing
//   through, `Set3DPos` with a point only pans and tilts, and with a box it pans to the
//   box's centre and zooms OUT a step.
// Batches (several commands in one POST) are answered in order, like the camera does.

import { execFileSync } from "node:child_process"
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import http, { type IncomingMessage, type ServerResponse } from "node:http"
import https from "node:https"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"

/** The real RLC-823S1's answers (value, and range/initial for the commands asked with action 1). */
export const RLC823S1: Record<string, { value: any; range?: any; initial?: any }> = JSON.parse(
	readFileSync(join(import.meta.dirname, "reolink-rlc823s1.json"), "utf8")
).answers
const FIXED_ABILITY = { Ability: { abilityChn: [{ ledControl: { permit: 6, ver: 1 }, snap: { permit: 6, ver: 1 }, ptzType: { permit: 0, ver: 0 }, ptzCtrl: { permit: 0, ver: 0 } }] } }

export type MockFile = {
	/** Local video file served for this recording. */
	path: string
	start: Date
	end: Date
	/** Camera path; generated in Reolink's format when omitted. */
	name?: string
}

export type MockRequest = {
	cmd: string
	token: string | null
	/** Parsed `param` of a JSON command, the query of a GET (Download), or the parsed upload of ImportImg. */
	param: unknown
	/** rspCode when the mock answered with an error, else null. */
	rspCode: number | null
	/** The JSON command's `action` (1 asks for ranges). */
	action?: number
	/** Which HTTP request it came in (counting from 1): the commands of one batch share it. */
	http?: number
}

export type MockReolinkOptions = {
	files: MockFile[]
	protocol?: "http" | "https"
	tokenLeaseSeconds?: number
	username?: string
	password?: string
	model?: string
	firmware?: string
	/** Which command serves files; the other answers "not support", like firmware that only has one. */
	downloadCmd?: "Download" | "Playback"
	/** The JPEG `Snap` answers with. Default: a small gray frame. */
	snapshot?: Buffer
	/**
	 * Refuse every login the way a camera does after too many bad passwords. The
	 * detail is what reolink_aio matches on ("Login has been locked"); the rspCode
	 * is deliberately the same -7 as a wrong password, so callers must read the detail.
	 */
	locked?: boolean
	/** Listen port; default a free one. A fixed port lets a saved source survive restarting the mock. */
	port?: number
	/**
	 * How far the camera's clock is ahead of this machine's (negative = behind),
	 * as with a wrong time zone or Reolink's own DST switch off. `GetTime`,
	 * Search and the file stamps all speak the camera's clock; `files` stay in
	 * this machine's time.
	 */
	clockOffsetMs?: number
	/** This machine's clock as the camera's is derived from it; tests with a fake clock pass theirs. */
	now?: () => number
	/** Read on every download: a recording it names gets an error answer, like a camera busy serving the Reolink app. */
	failDownload?: (name: string) => boolean
	/**
	 * What `GetAbility` reports: `ptz` is the real RLC-823S1's answer (pan, tilt,
	 * zoom, presets, IR, spotlight, …), `fixed` a bullet camera with IR only. Default `fixed`.
	 */
	abilities?: "fixed" | "ptz"
	/** How long a move to a position (a view, Home, `Set3DPos`, `StartZoomFocus`) takes; reads in between see it on its way. Default 300 ms. */
	settleMs?: number
	/** ImportImg answers with an error, like firmware that doesn't take uploads. */
	failImport?: boolean
	/** Read on every signed-in JSON command: one it names gets an error answer (-17), like a camera too busy to act. */
	failCommand?: (cmd: string, param: any) => boolean
	/**
	 * How long a JSON POST takes to answer, like the real camera's 0.2–0.8 s. Its commands act (and are
	 * recorded) when it arrives, as the camera's do. Default 0.
	 */
	latencyMs?: number
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0")
const ymd = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
const hms = (d: Date) => `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
const rt = (d: Date) => ({ year: d.getFullYear(), mon: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), min: d.getMinutes(), sec: d.getSeconds() })
const fromRt = (t: any) => new Date(t.year, t.mon - 1, t.day, t.hour, t.min, t.sec)
const sameDay = (a: Date, b: Date) => ymd(a) === ymd(b)
const clone = <t>(v: t): t => structuredClone(v)

/** `Mp4Record/2026-10-14/RecM07_20261014_093012_093042_6D28808_1E2F3A.mp4`, as the RLC-8xx series names them. */
export const reolinkFileName = (start: Date, end: Date, size: number) =>
	`Mp4Record/${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}/RecM07_${ymd(start)}_${hms(start)}_${hms(end)}_6D28808_${size.toString(16).toUpperCase()}.mp4`

const selfSignedCert = () => {
	const dir = mkdtempSync(join(tmpdir(), "look4-mock-cert-"))
	try {
		execFileSync(
			"openssl",
			["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "2", "-subj", "/CN=reolink-mock"],
			{ stdio: "ignore" }
		)
		return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

/** Motor position as GetPtzCurPos reports it, plus the lens's zoom/focus steps (GetZoomFocus). */
export type MockPosition = { Ppos: number; Tpos: number; Zpos: number; Fpos: number; zoom: number; focus: number }

/** The motor zoom step for a lens zoom step; the real camera read Zpos 234 at zoom 8. */
const zpos = (zoom: number) => Math.round((zoom * 234) / 8)

const DIRECTIONS: Record<string, [number, number]> = {
	Left: [-1, 0],
	Right: [1, 0],
	Up: [0, -1],
	Down: [0, 1],
	LeftUp: [-1, -1],
	RightUp: [1, -1],
	LeftDown: [-1, 1],
	RightDown: [1, 1]
}

export type AiKind = "people" | "vehicle" | "dog_cat" | "face"

export const startMockReolink = async (opts: MockReolinkOptions) => {
	const username = opts.username ?? "admin"
	const password = opts.password ?? "hunter2"
	const lease = opts.tokenLeaseSeconds ?? 3600
	const downloadCmd = opts.downloadCmd ?? "Download"
	const settleMs = opts.settleMs ?? 300
	const tokens = new Map<string, number>()
	const requests: MockRequest[] = []
	const files = opts.files
	const skew = opts.clockOffsetMs ?? 0
	const camera = (d: Date) => new Date(d.getTime() + skew)
	let remain = 10
	const real = RLC823S1
	const zoomRange = real.GetZoomFocus!.range.ZoomFocus.zoom.pos as { min: number; max: number }
	const focusRange = real.GetZoomFocus!.range.ZoomFocus.focus.pos as { min: number; max: number }
	const timeoutRange = real.GetPtzGuard!.range.PtzGuard.timeout as { min: number; max: number }
	const cur = real.GetPtzCurPos!.value.PtzCurPos
	const zf = real.GetZoomFocus!.value.ZoomFocus
	const thumb = (background: string) => sharp({ create: { width: 169, height: 95, channels: 3, background } }).jpeg().toBuffer()

	/** Mutable camera state the control commands read and write. */
	const state = {
		ir: "Auto" as "Auto" | "Off",
		whiteLed: 0,
		bright: Number(real.GetWhiteLed!.value.WhiteLed.bright),
		/** The camera's 64 preset slots (ids 0-based), as GetPtzPreset lists them. */
		presets: clone(real.GetPtzPreset!.value.PtzPreset) as Array<{ channel: number; enable: number; id: number; name: string; imgName: string }>,
		/** Where each saved preset points. */
		presetPos: new Map<number, MockPosition>(),
		/** Stored thumbnails by file name (`preset_00`), what ExportImg serves and ImportImg/DeleteImg change. */
		images: new Map<string, Buffer>([
			["preset_00", await thumb("#3a6b35")],
			["preset_01", await thumb("#8a6d3b")]
		]),
		/** Every PtzCtrl param, in order. */
		ptz: [] as Array<Record<string, unknown>>,
		pos: { Ppos: Number(cur.Ppos), Tpos: Number(cur.Tpos), Zpos: Number(cur.Zpos), Fpos: Number(cur.Fpos), zoom: Number(zf.zoom.pos), focus: Number(zf.focus.pos) } as MockPosition,
		guard: { ...clone(real.GetPtzGuard!.value.PtzGuard), pos: null as MockPosition | null },
		autofocusDisable: Number(real.GetAutoFocus!.value.AutoFocus.disable),
		isp: clone(real.GetIsp!.value.Isp),
		enc: clone(real.GetEnc!.value.Enc),
		ai: clone(real.GetAiCfg!.value),
		sirenPlays: 0,
		motion: 0,
		aiAlarm: { people: 0, vehicle: 0, dog_cat: 0, face: 0 } as Record<AiKind, number>
	}
	state.presetPos.set(0, { ...state.pos, Ppos: state.pos.Ppos - 420, Tpos: state.pos.Tpos + 12, zoom: 0, Zpos: 0 })
	state.presetPos.set(1, { ...state.pos })
	const ptzCamera = opts.abilities === "ptz"
	const snapshot = opts.snapshot ?? (await sharp({ create: { width: 64, height: 36, channels: 3, background: "#808080" } }).jpeg().toBuffer())

	const entries = () =>
		files.map(f => {
			const size = statSync(f.path).size
			return { ...f, size, name: f.name ?? reolinkFileName(f.start, f.end, size) }
		})

	const validToken = (t: string | null) => {
		const exp = t ? tokens.get(t) : undefined
		return exp !== undefined && exp > Date.now()
	}

	const sendJson = (res: ServerResponse, body: unknown) => {
		const text = JSON.stringify(body)
		// real cameras label their JSON (errors included) as text/html
		res.writeHead(200, { "content-type": "text/html", "content-length": Buffer.byteLength(text) })
		res.end(text)
	}

	type Answer = { item: Record<string, unknown>; rspCode: number | null }
	const failItem = (cmd: string, rspCode: number, detail: string): Answer => ({ item: { cmd, code: 1, error: { rspCode, detail } }, rspCode })
	const fail = (cmd: string, rspCode: number, detail: string) => [failItem(cmd, rspCode, detail).item]
	const ok = (cmd: string, value: unknown = { rspCode: 200 }): Answer => ({ item: { cmd, code: 0, value }, rspCode: null })
	const badParam = (cmd: string) => failItem(cmd, -4, "param error")

	/** The move to `state.pos` under way: GetPtzCurPos and GetZoomFocus read a point between until `until`. */
	let travel: { from: MockPosition; to: MockPosition; start: number; until: number } | null = null
	/** Where the camera says it is: `state.pos`, or on the way there (a test setting `state.pos` itself jumps). */
	const reported = (): MockPosition => {
		const t = travel
		const now = Date.now()
		if (!t || t.to !== state.pos || now >= t.until) return state.pos
		const k = (now - t.start) / (t.until - t.start)
		const mix = (key: keyof MockPosition) => Math.round(t.from[key] + (t.to[key] - t.from[key]) * k)
		return { Ppos: mix("Ppos"), Tpos: mix("Tpos"), Zpos: mix("Zpos"), Fpos: mix("Fpos"), zoom: mix("zoom"), focus: mix("focus") }
	}
	const goTo = (p: MockPosition) => {
		const from = reported()
		const now = Date.now()
		state.pos = { ...p }
		travel = { from, to: state.pos, start: now, until: now + settleMs }
	}

	/** The control commands of a PTZ camera, all answered from `state`. */
	const control = (cmd: string, param: any): Answer | null => {
		switch (cmd) {
			case "GetWhiteLed":
				return ok(cmd, { WhiteLed: { ...clone(real.GetWhiteLed!.value.WhiteLed), state: state.whiteLed, bright: state.bright } })
			case "SetWhiteLed": {
				const w = param?.WhiteLed
				if (!w) return badParam(cmd)
				if ("bright" in w) {
					if (!(w.bright >= 0 && w.bright <= 100)) return badParam(cmd)
					state.bright = Number(w.bright)
				}
				if ("state" in w) state.whiteLed = Number(w.state) === 1 ? 1 : 0
				return ok(cmd)
			}
			case "GetPtzPreset":
				return ok(cmd, { PtzPreset: state.presets })
			case "SetPtzPreset": {
				const p = param?.PtzPreset
				const slot = state.presets.find(s => s.id === p?.id)
				if (!slot) return badParam(cmd)
				if (typeof p.name === "string") slot.name = p.name
				if (typeof p.imgName === "string") slot.imgName = p.imgName
				// no `enable`: a rename, the stored position stays
				if ("enable" in p) {
					slot.enable = Number(p.enable) === 1 ? 1 : 0
					if (slot.enable) state.presetPos.set(slot.id, { ...state.pos })
					else state.presetPos.delete(slot.id)
				}
				return ok(cmd)
			}
			case "PtzCtrl": {
				state.ptz.push(param)
				const op = String(param?.op)
				const step = Math.max(1, Math.round(Number(param?.speed ?? 32) / 8))
				if (op in DIRECTIONS) {
					const [dx, dy] = DIRECTIONS[op]!
					state.pos = { ...state.pos, Ppos: state.pos.Ppos + dx * step, Tpos: state.pos.Tpos + dy * step }
				} else if (op === "ZoomInc" || op === "ZoomDec") {
					const zoom = Math.min(zoomRange.max, Math.max(zoomRange.min, state.pos.zoom + (op === "ZoomInc" ? 1 : -1)))
					state.pos = { ...state.pos, zoom, Zpos: zpos(zoom) }
				} else if (op === "FocusInc" || op === "FocusDec") {
					state.pos = { ...state.pos, focus: Math.min(focusRange.max, Math.max(focusRange.min, state.pos.focus + (op === "FocusInc" ? -5 : 5))) }
				} else if (op === "ToPos") {
					const p = state.presetPos.get(Number(param?.id))
					if (!p) return badParam(cmd)
					goTo(p)
				}
				return ok(cmd)
			}
			case "GetPtzStat":
				// the real camera says 0 mid-move too
				return ok(cmd, { PtzStat: { channel: 0, stat: 0 } })
			case "GetPtzCurPos": {
				const { Ppos, Tpos, Zpos, Fpos } = reported()
				return ok(cmd, { PtzCurPos: { Fpos, Ppos, Tpos, Zpos, channel: 0 } })
			}
			case "GetPtzGuard": {
				const { pos: _, ...g } = state.guard
				return ok(cmd, { PtzGuard: g })
			}
			case "SetPtzGuard": {
				const g = param?.PtzGuard
				if (g?.cmdStr === "toPos") {
					if (!state.guard.pos) return badParam(cmd)
					goTo(state.guard.pos)
					return ok(cmd)
				}
				if (g?.cmdStr !== "setPos") return badParam(cmd)
				if ("timeout" in g && !(g.timeout >= timeoutRange.min && g.timeout <= timeoutRange.max)) return badParam(cmd)
				if (Number(g.bSaveCurrentPos) === 1) {
					state.guard.pos = { ...state.pos }
					state.guard.bexistPos = 1
				}
				if ("benable" in g) state.guard.benable = Number(g.benable) === 1 ? 1 : 0
				if ("timeout" in g) state.guard.timeout = Number(g.timeout)
				return ok(cmd)
			}
			case "GetZoomFocus": {
				const p = reported()
				return ok(cmd, { ZoomFocus: { channel: 0, focus: { pos: p.focus }, zoom: { pos: p.zoom } } })
			}
			case "StartZoomFocus": {
				const z = param?.ZoomFocus
				const range = z?.op === "ZoomPos" ? zoomRange : z?.op === "FocusPos" ? focusRange : null
				if (!range || !Number.isInteger(z.pos) || z.pos < range.min || z.pos > range.max) return badParam(cmd)
				goTo(z.op === "ZoomPos" ? { ...state.pos, zoom: z.pos, Zpos: zpos(z.pos) } : { ...state.pos, focus: z.pos })
				return ok(cmd)
			}
			case "GetAutoFocus":
				return ok(cmd, { AutoFocus: { afType: 0, channel: 0, disable: state.autofocusDisable } })
			case "SetAutoFocus":
				if (!param?.AutoFocus || !("disable" in param.AutoFocus)) return badParam(cmd)
				state.autofocusDisable = Number(param.AutoFocus.disable) === 1 ? 1 : 0
				return ok(cmd)
			case "Get3DPos":
				return ok(cmd, clone(real.Get3DPos!.value))
			case "Set3DPos": {
				const p = param?.["3DPos"]
				const ints = ["posX", "posY", "posWidth", "posHeight", "width", "height", "speed"].every(k => Number.isInteger(p?.[k]))
				if (!ints || p.posX < 0 || p.posY < 0 || p.posX + p.posWidth > p.width || p.posY + p.posHeight > p.height) return badParam(cmd)
				// centre of the box, relative to the frame's centre, moves the camera; a box (any size) zooms out
				// a step, as the real camera's 1.5× box went from position 8 to 7
				const cx = (p.posX + p.posWidth / 2) / p.width - 0.5
				const cy = (p.posY + p.posHeight / 2) / p.height - 0.5
				const zoom = p.posWidth > 0 || p.posHeight > 0 ? Math.max(zoomRange.min, state.pos.zoom - 1) : state.pos.zoom
				goTo({ ...state.pos, Ppos: state.pos.Ppos + Math.round(cx * 200), Tpos: state.pos.Tpos + Math.round(cy * 100), zoom, Zpos: zpos(zoom) })
				return ok(cmd)
			}
			case "GetIsp":
				return ok(cmd, { Isp: state.isp })
			case "SetIsp":
				if (!param?.Isp) return badParam(cmd)
				state.isp = { ...state.isp, ...param.Isp }
				return ok(cmd)
			case "GetEnc":
				return ok(cmd, { Enc: state.enc })
			case "SetEnc": {
				const e = param?.Enc
				// like the firmware's own client: always the whole Enc, never a partial one
				if (!e?.mainStream || !e?.subStream || !("audio" in e)) return badParam(cmd)
				state.enc = clone(e)
				return ok(cmd)
			}
			case "GetAiCfg":
				return ok(cmd, state.ai)
			case "SetAiCfg":
				for (const k of ["bSmartTrack", "trackType", "aiDisappearBackTime", "aiStopBackTime"]) if (param && k in param) state.ai[k] = param[k]
				return ok(cmd)
			case "AudioAlarmPlay":
				if (param?.alarm_mode !== "times" && param?.alarm_mode !== "manual") return badParam(cmd)
				state.sirenPlays++
				return ok(cmd)
			case "DeleteImg":
				state.images.delete(String(param?.DeleteImg?.FileName))
				return ok(cmd)
		}
		return null
	}

	const runCommand = (cmd: string, action: number, param: any, token: string | null): Answer => {
		if (cmd === "Login") {
			if (opts.locked) return failItem(cmd, -7, "Login has been locked")
			const u = param?.User
			if (u?.userName !== username || u?.password !== password) {
				// newer firmware counts down to a lockout and says how many tries are left
				remain = Math.max(0, remain - 1)
				const f = failItem(cmd, -7, "login failed")
				return { item: { ...f.item, value: { auth_warning_info: { remain_times: remain } } }, rspCode: -7 }
			}
			remain = 10
			const name = Math.random().toString(16).slice(2, 17)
			tokens.set(name, Date.now() + lease * 1000)
			return ok(cmd, { Token: { leaseTime: lease, name } })
		}
		if (!validToken(token)) return failItem(cmd, -6, "please login first")
		if (opts.failCommand?.(cmd, param)) return failItem(cmd, -17, "device busy")
		switch (cmd) {
			case "Logout":
				tokens.delete(token!)
				return ok(cmd)
			case "GetDevInfo":
				return ok(cmd, {
					DevInfo: {
						model: opts.model ?? "RLC-823S1",
						firmVer: opts.firmware ?? "v3.1.0.2368_23062700",
						name: "Feeder",
						channelNum: 1,
						audioNum: 1,
						type: "IPC",
						serial: "00000000000000"
					}
				})
			case "GetTime":
				return ok(cmd, { Dst: { enable: 0 }, Time: { ...rt(camera(new Date((opts.now ?? Date.now)()))), timeZone: 18000, timeFmt: "DD/MM/YYYY", hourFmt: 0 } })
			case "Search": {
				const s = param?.Search
				const from = fromRt(s.StartTime)
				const to = fromRt(s.EndTime)
				const status = [{ mon: from.getMonth() + 1, year: from.getFullYear(), table: "0".repeat(31) }]
				// like the real camera: a range spanning days lists the calendar only, no files
				if (!sameDay(from, to)) return ok(cmd, { SearchResult: { channel: s.channel, Status: status } })
				const File = entries()
					.filter(f => camera(f.start) >= from && camera(f.start) <= to)
					.map(f => ({
						EndTime: rt(camera(f.end)),
						StartTime: rt(camera(f.start)),
						frameRate: 0,
						height: 0,
						name: f.name,
						size: f.size,
						type: s.streamType ?? "main",
						width: 0
					}))
				return ok(cmd, { SearchResult: { channel: s.channel, File, Status: status } })
			}
			case "GetAbility":
				return ok(cmd, ptzCamera ? clone(real.GetAbility!.value) : FIXED_ABILITY)
			case "GetIrLights":
				return ok(cmd, { IrLights: { state: state.ir } })
			case "SetIrLights":
				state.ir = param?.IrLights?.state === "Off" ? "Off" : "Auto"
				return ok(cmd)
			case "GetMdState":
				return ok(cmd, { state: state.motion })
			case "GetAiState": {
				const kind = (k: AiKind) => ({ alarm_state: state.aiAlarm[k], support: k === "face" ? 0 : 1 })
				return ok(cmd, { channel: 0, dog_cat: kind("dog_cat"), face: kind("face"), people: kind("people"), vehicle: kind("vehicle") })
			}
		}
		const answer = ptzCamera ? control(cmd, param) : null
		if (!answer) return failItem(cmd, -9, "not support")
		// `action: 1` also returns the camera's limits, as the real one does
		if (action === 1 && answer.rspCode === null && real[cmd]?.range) answer.item.range = real[cmd]!.range
		if (action === 1 && answer.rspCode === null && real[cmd]?.initial) answer.item.initial = real[cmd]!.initial
		return answer
	}

	/** `multipart/form-data` parts: name, file name, content type and bytes. */
	const multipart = (body: Buffer, contentType: string) => {
		const boundary = /boundary=("?)([^";]+)\1/i.exec(contentType)?.[2]
		if (!boundary) return []
		const parts: Array<{ name: string | null; filename: string | null; type: string | null; data: Buffer }> = []
		const sep = Buffer.from(`--${boundary}`)
		let at = body.indexOf(sep)
		while (at !== -1) {
			const start = at + sep.length
			if (body.subarray(start, start + 2).toString() === "--") break
			const next = body.indexOf(sep, start)
			if (next === -1) break
			const part = body.subarray(start + 2, next - 2)
			const headEnd = part.indexOf("\r\n\r\n")
			const head = part.subarray(0, headEnd).toString()
			parts.push({
				name: /name="([^"]*)"/i.exec(head)?.[1] ?? null,
				filename: /filename="([^"]*)"/i.exec(head)?.[1] ?? null,
				type: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? null,
				data: part.subarray(headEnd + 4)
			})
			at = next
		}
		return parts
	}

	let httpCount = 0
	const handler = (req: IncomingMessage, res: ServerResponse) => {
		const n = ++httpCount
		const record = (r: MockRequest) => requests.push({ ...r, http: n })
		const url = new URL(req.url ?? "/", "http://mock")
		if (url.pathname !== "/cgi-bin/api.cgi") {
			res.writeHead(404).end("not found")
			return
		}
		const cmd = url.searchParams.get("cmd") ?? ""
		const token = url.searchParams.get("token")

		if (req.method === "GET" && cmd === "Snap") {
			const query = Object.fromEntries(url.searchParams)
			const rspCode = validToken(token) ? null : -6
			record({ cmd, token, param: query, rspCode })
			if (rspCode !== null) return sendJson(res, fail(cmd, rspCode, "please login first"))
			res.writeHead(200, { "content-type": "image/jpeg", "content-length": snapshot.length })
			res.end(snapshot)
			return
		}

		if (req.method === "GET" && (cmd === "Download" || cmd === "Playback")) {
			const query = Object.fromEntries(url.searchParams)
			const error = (rspCode: number, detail: string) => {
				record({ cmd, token, param: query, rspCode })
				sendJson(res, fail(cmd, rspCode, detail))
			}
			if (!validToken(token)) return error(-6, "please login first")
			if (cmd !== downloadCmd) return error(-9, "not support")
			const file = entries().find(f => f.name === url.searchParams.get("source"))
			if (!file) return error(-12, "file not exist")
			if (opts.failDownload?.(file.name)) return error(-17, "device busy")
			record({ cmd, token, param: query, rspCode: null })
			res.writeHead(200, {
				"content-type": "application/octet-stream",
				"content-length": file.size,
				"content-disposition": `attachment; filename="${url.searchParams.get("output") ?? "video.mp4"}"`
			})
			createReadStream(file.path).pipe(res)
			return
		}

		const chunks: Buffer[] = []
		req.on("data", (c: Buffer) => chunks.push(c))
		req.on("end", () => {
			const raw = Buffer.concat(chunks)
			const type = String(req.headers["content-type"] ?? "")

			// the thumbnail upload: multipart field `ptz-image`, file name `<uuid>&<imgName>&<bytes>&<channel>`
			if (cmd === "ImportImg") {
				const part = multipart(raw, type).find(p => p.name === url.searchParams.get("file"))
				const [uuid, imgName, size, channel] = (part?.filename ?? "").split("&")
				const param = part ? { field: part.name, uuid, imgName, size: Number(size), channel: Number(channel), type: part.type, bytes: part.data.length } : null
				const answer = !validToken(token)
					? failItem(cmd, -6, "please login first")
					: opts.failImport || !ptzCamera
						? failItem(cmd, -9, "not support")
						: !part || !imgName || Number(size) !== part.data.length || part.data[0] !== 0xff || part.data[1] !== 0xd8
							? badParam(cmd)
							: (state.images.set(imgName, Buffer.from(part.data)), ok(cmd))
				record({ cmd, token, param, rspCode: answer.rspCode })
				return sendJson(res, [answer.item])
			}

			let items: any[]
			try {
				const parsed = JSON.parse(raw.toString("utf8"))
				items = Array.isArray(parsed) ? parsed : [parsed]
			} catch {
				res.writeHead(400).end("bad request")
				return
			}

			// a thumbnail comes back as the raw JPEG, not JSON
			if (items.length === 1 && items[0]?.cmd === "ExportImg") {
				const param = items[0]?.param
				const jpeg = ptzCamera && validToken(token) ? state.images.get(String(param?.ExportImg?.FileName)) : undefined
				const rspCode = jpeg ? null : validToken(token) ? -13 : -6
				record({ cmd: "ExportImg", token, param, rspCode, action: items[0]?.action })
				if (!jpeg) return sendJson(res, fail("ExportImg", rspCode!, rspCode === -6 ? "please login first" : "get config failed"))
				res.writeHead(200, { "content-type": "image/jpeg", "content-length": jpeg.length })
				res.end(jpeg)
				return
			}

			const out = items.map((item, i) => {
				const name = (i === 0 && cmd) || item?.cmd
				const { item: answer, rspCode } = runCommand(name, Number(item?.action ?? 0), item?.param, token)
				record({ cmd: name, token, param: item?.param, rspCode, action: item?.action })
				return answer
			})
			if (opts.latencyMs) setTimeout(() => sendJson(res, out), opts.latencyMs)
			else sendJson(res, out)
		})
	}

	const protocol = opts.protocol ?? "http"
	const server = protocol === "https" ? https.createServer(selfSignedCert(), handler) : http.createServer(handler)
	await new Promise<void>(resolve => server.listen(opts.port ?? 0, "127.0.0.1", resolve))
	const port = (server.address() as AddressInfo).port

	return {
		/** `127.0.0.1:<port>`: drop straight into a reolink source's `host`. */
		host: `127.0.0.1:${port}`,
		port,
		protocol,
		username,
		password,
		/** Every request (every command of a batch), in order. */
		requests,
		/** The `param` of every successful `cmd`, in order. */
		sent: (cmd: string) => requests.filter(r => r.cmd === cmd && r.rspCode === null).map(r => r.param as any),
		/** Mutable: push to simulate a new recording appearing on the SD card. */
		files,
		/** Camera path of each file, as Search reports it. */
		names: () => entries().map(f => f.name),
		/** Lights, presets, position and PTZ commands received; tests read and change it. */
		state,
		/** The camera's own motion detection (`GetMdState`) sees motion, or stops seeing it. */
		setMotion: (on: boolean) => {
			state.motion = on ? 1 : 0
		},
		/** The camera's AI detection (`GetAiState`) sees `kind`, or stops seeing it. */
		setAi: (kind: AiKind, on: boolean) => {
			state.aiAlarm[kind] = on ? 1 : 0
		},
		/** Invalidates every token, as a lease running out or a camera reboot would. */
		expireTokens: () => tokens.clear(),
		close: () =>
			new Promise<void>(resolve => {
				server.closeAllConnections()
				server.close(() => resolve())
			})
	}
}

export type MockReolink = Awaited<ReturnType<typeof startMockReolink>>
