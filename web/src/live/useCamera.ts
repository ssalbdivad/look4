import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type {
	CameraControls,
	CameraSettingBody,
	CameraState,
	DigitalView,
	LightBody,
	PresetBody,
	PtzBody,
	PtzDirection
} from "../../../src/api-types.ts"
import { lensFactor, lensPosition } from "../../../src/live/zoom-curve.ts"
import { api, errorMessage } from "../api.ts"
import type { OpticalZoom, StageBox } from "../components/LiveStage.tsx"
import { useFeedback } from "../feedback.tsx"
import { useLatest, useResource } from "../hooks.ts"

// One camera's controls and state for the Live page: what it can do, where it is, and every action
// that moves or changes it. Failures go to the caller's `onError` (a toast without one), so callers only
// learn whether it worked.

/** Press-and-hold moves from any number of keys and buttons at once; Stop goes out when the last one lets go. */
export type Hold = {
	/** `key` names the thing being held ("key:left", "dpad"); pressing it again replaces its move. */
	press: (key: string, body: PtzBody) => void
	release: (key: string) => void
	releaseAll: () => void
}

export type Camera = {
	controls: CameraControls | null
	error: string | null
	reload(): void
	state: CameraState | null
	/** Sends one PTZ op; failures go to a toast and resolve false. */
	ptz(body: PtzBody): Promise<boolean>
	home(): Promise<boolean>
	frame(box: StageBox): Promise<boolean>
	/** Updates `controls`. */
	setting(body: CameraSettingBody): Promise<boolean>
	light(body: LightBody): Promise<boolean>
	// beyond the page contract: what the rail (and a pop-out mini d-pad) need
	preset(body: PresetBody): Promise<boolean>
	siren(): Promise<boolean>
	hold: Hold
	/** The view last sent (a saved view's id, or "home"), until the next manual move. */
	view: number | "home" | null
	/** A view, Home or framing move was sent and the camera hasn't reported arriving yet. */
	moving: boolean
	/** The camera's zoom for the wheel; null when it has no zoom slider. */
	optical: OpticalZoom | null
	/**
	 * The picture's magnification, set by whoever shows it: saving a view or Home saves it with them, and
	 * going to one brings its magnification back.
	 */
	picture: { current: Picture | null }
}

export type Picture = { digital(): DigitalView | null; setDigital(v: DigitalView): void }

const ACTUAL_SIZE: DigitalView = { z: 1, cx: 0.5, cy: 0.5 }

const POLL_MS = 3000
/** While a sent move is under way the state is read faster, so "moving" clears soon after it arrives. */
const SETTLE_POLL_MS = 1000
/** A first read right after the command can still say "not moving"; trust "arrived" only after this. */
const SETTLE_MIN_MS = 1500
const SETTLE_MAX_MS = 20_000
/**
 * A held move, zoom or focus is sent again this often: the server stops the camera 8 s after the last
 * move it got (its failsafe for a release that never arrives), and a long swing must outlast that.
 */
const HOLD_RESEND_MS = 4000
/**
 * The wheel steers a target zoom ahead of the lens, which follows it. After this long without a turn the
 * target is let go, and the next turn starts from where the camera says it is.
 */
const WHEEL_IDLE_MS = 2500
/**
 * A zoomTo that waits for the camera to arrive (`settle`) holds the PTZ queue only this long: what comes
 * next (a zoom out from the wheel) goes at once and ends that wait. Should it reach the server before the
 * zoomTo has gone on to the camera, the server drops the older one, so the camera never gets them reversed.
 */
const SETTLE_RELEASE_MS = 150
/** While the spotlight is on, the controls are read again this often (see the effect). */
const SPOT_REFRESH_MS = 60_000

/**
 * Whether anyone can see the camera's state: the tab, or the Picture-in-Picture window it opened, which
 * stays in front while the user works in other tabs (so the tab is hidden, the reason to use it at all).
 */
const pipWindow = () => (window as { documentPictureInPicture?: { window: Window | null } }).documentPictureInPicture?.window ?? null
const watched = () => document.visibilityState === "visible" || !!pipWindow()

const VEC: Record<PtzDirection, [number, number]> = {
	up: [0, -1],
	down: [0, 1],
	left: [-1, 0],
	right: [1, 0],
	upLeft: [-1, -1],
	upRight: [1, -1],
	downLeft: [-1, 1],
	downRight: [1, 1]
}

const fromVec = (x: number, y: number): PtzDirection | null => {
	const sx = Math.sign(x)
	const sy = Math.sign(y)
	for (const [d, [vx, vy]] of Object.entries(VEC)) if (vx === sx && vy === sy) return d as PtzDirection
	return null
}

/**
 * What a set of held inputs means together: moves add up, so ↑ and ← held at once go up-left and opposite
 * arrows cancel; otherwise the most recent zoom or focus wins. Null: nothing to do (send Stop).
 */
export const combineHolds = (held: PtzBody[]): PtzBody | null => {
	const moves = held.filter(b => b.op === "move")
	if (moves.length) {
		let x = 0
		let y = 0
		for (const m of moves) {
			const [vx, vy] = VEC[m.direction]
			x += vx
			y += vy
		}
		const direction = fromVec(x, y)
		const last = moves[moves.length - 1]!
		return direction ? { op: "move", direction, ...(last.slow ? { slow: true } : {}) } : null
	}
	return held[held.length - 1] ?? null
}

/** `onError`: where failures are told (the page routes them onto the picture in full screen and pop-outs). */
export const useCamera = (source: string, controllable: boolean, onError?: (message: string) => void): Camera => {
	const { toast } = useFeedback()
	const onErrorRef = useLatest(onError)
	const res = useResource(s => (controllable ? api.controls(source, s) : Promise.resolve(null)), [source, controllable])
	const controls = res.data
	const [state, setState] = useState<CameraState | null>(null)
	const [view, setView] = useState<number | "home" | null>(null)
	const [settleFrom, setSettleFrom] = useState<number | null>(null)
	const settleRef = useLatest(settleFrom)
	const controlsRef = useLatest(controls)
	const stateRef = useLatest(state)
	const picture = useRef<Picture | null>(null)

	const fail = useCallback(
		(what: string, e: unknown) => {
			const message = `${what}: ${errorMessage(e)}`
			if (onErrorRef.current) onErrorRef.current(message)
			else toast(message, { tone: "bad" })
		},
		[toast, onErrorRef]
	)

	// a new camera starts with nothing marked
	useEffect(() => {
		setState(null)
		setView(null)
		setSettleFrom(null)
	}, [source])

	// ---- state polling: every 3 s while it can be seen, every second while a sent move settles
	const canPoll = controllable && !!controls?.ptz
	useEffect(() => {
		if (!canPoll) return
		// the window a timer was set on: the PiP window's while it's open, since Chrome slows a hidden tab's
		// timers to once a minute after a while, and that tab is hidden exactly while the PiP is in use
		let timer: { id: number; win: Window } | undefined
		let ac: AbortController | null = null
		let stopped = false
		let busy = false
		const tick = async () => {
			timer = undefined
			if (stopped) return
			// unseen: check back later rather than stop, since a PiP window opening or closing fires no visibilitychange
			if (!watched()) return schedule()
			busy = true
			ac = new AbortController()
			try {
				const s = await api.cameraState(source, ac.signal)
				if (stopped) return
				setState(s)
				const from = settleRef.current
				if (from !== null && ((!s.moving && Date.now() - from >= SETTLE_MIN_MS) || Date.now() - from > SETTLE_MAX_MS)) setSettleFrom(null)
			} catch {
				// a missed read is not worth a toast every 3 s; the next one usually works
			}
			busy = false
			if (!stopped) schedule()
		}
		const schedule = () => {
			if (timer !== undefined || stopped) return
			const win = pipWindow() ?? window
			const t = { id: win.setTimeout(tick, settleRef.current !== null ? SETTLE_POLL_MS : POLL_MS), win }
			timer = t
			// a closing PiP window takes its timers with it: carry on in the tab
			if (win !== window)
				win.addEventListener(
					"pagehide",
					() => {
						if (timer === t) timer = { id: window.setTimeout(tick, POLL_MS), win: window }
					},
					{ once: true }
				)
		}
		const onVisible = () => {
			// back in front: read now rather than at the next check
			if (document.visibilityState === "visible" && !busy) {
				timer?.win.clearTimeout(timer.id)
				timer = undefined
				void tick()
			}
		}
		void tick()
		document.addEventListener("visibilitychange", onVisible)
		return () => {
			stopped = true
			timer?.win.clearTimeout(timer.id)
			ac?.abort()
			document.removeEventListener("visibilitychange", onVisible)
		}
		// settleFrom restarts the loop so a just-sent move is read within a second, not three
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [source, canPoll, settleFrom !== null])

	// ---- one PTZ queue, so a Stop can never overtake the move it ends
	const queue = useRef<Promise<unknown>>(Promise.resolve())
	const send = useCallback(
		(body: PtzBody): Promise<boolean> => {
			const before = queue.current
			const run = before.then(() =>
				api.ptz(source, body).then(
					() => true,
					e => {
						fail("The camera didn't move", e)
						return false
					}
				)
			)
			const waits = body.op === "zoomTo" && body.settle
			queue.current = waits ? Promise.race([run, before.then(() => new Promise(r => window.setTimeout(r, SETTLE_RELEASE_MS)))]) : run
			return run
		},
		[source, fail]
	)

	const ptz = useCallback(
		async (body: PtzBody) => {
			// anything but a view, Home or a focus change leaves the marked view
			const p = controlsRef.current?.ptz
			if (body.op === "preset") {
				setView(body.id)
				picture.current?.setDigital(p?.presets.find(v => v.id === body.id)?.digital ?? ACTUAL_SIZE)
			} else if (body.op === "home") {
				setView("home")
				picture.current?.setDigital(p?.guard?.digital ?? ACTUAL_SIZE)
			}
			else if (body.op !== "focus" && body.op !== "focusTo" && body.op !== "stop") setView(null)
			const settles = body.op === "preset" || body.op === "home" || body.op === "box" || body.op === "zoomTo"
			if (settles) setSettleFrom(Date.now())
			const ok = await send(body)
			if (!ok && settles) setSettleFrom(null)
			return ok
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[send]
	)

	// ---- the wheel's zoom: a target the lens follows, one zoomTo at a time and always the latest. `aiming`
	// counts aimed zooms on their way; `gen` is bumped by every new target, so an older one's answer leaves it be.
	const wheel = useRef<{ target: number; at: number; sending: boolean; sent: number | null; aiming: number; gen: number }>({
		target: 0,
		at: 0,
		sending: false,
		sent: null,
		aiming: 0,
		gen: 0
	})
	const zoomRange = controls?.ptz?.zoom ? (controls.ptz.zoomRange ?? null) : null
	const canBox = !!controls?.ptz?.box
	const optical = useMemo<OpticalZoom | null>(() => {
		if (!zoomRange || zoomRange.max <= zoomRange.min) return null
		const r = zoomRange
		// the lens's measured magnification (src/live/zoom-curve.ts), not a straight line to a nominal 5×
		const top = lensFactor(r.max, r)
		const factorOf = (pos: number) => lensFactor(pos, r)
		const posOf = (factor: number) => lensPosition(factor, r)
		/** The whole lens position `factor` times the magnification at `from` (a position) comes to, as far as the lens goes. */
		const stepTo = (from: number, factor: number) => Math.round(posOf(Math.min(top, factorOf(from) * factor)))
		// the lens position the wheel last steered to, or, once it has rested, where the camera says it is
		const current = () => {
			const w = wheel.current
			if (Date.now() - w.at > WHEEL_IDLE_MS && !w.sending && !w.aiming) {
				w.target = stateRef.current?.zoom ?? r.pos
				w.sent = Math.round(w.target)
			}
			return w
		}
		const follow = () => {
			const w = wheel.current
			const pos = Math.round(w.target)
			if (w.sending || pos === w.sent) return
			w.sending = true
			w.sent = pos
			void ptz({ op: "zoomTo", pos }).then(() => {
				w.sending = false
				follow()
			})
		}
		return {
			zoomBy: log => {
				const w = current()
				w.at = Date.now()
				w.gen++
				const from = factorOf(w.target)
				const to = Math.min(top, Math.max(1, from * Math.exp(log)))
				w.target = posOf(to)
				follow()
				return log - Math.log(to / from)
			},
			room: () => top / factorOf(current().target),
			snap: factor => {
				const from = current().target
				return factorOf(stepTo(from, factor)) / factorOf(from)
			},
			aimZoom: canBox
				? async ({ aim, factor }) => {
						const w = current()
						const pos = stepTo(w.target, factor)
						// where the lens is going from now: a zoom out meanwhile starts from there, and goes at once
						const gen = ++w.gen
						w.target = pos
						w.sent = pos
						w.at = Date.now()
						w.aiming++
						const ok = await ptz({ op: "zoomTo", pos, ...(aim ? { aim } : {}), settle: true })
						w.aiming--
						w.at = Date.now()
						// refused or lost: the next turn starts from where the camera says it is
						if (!ok && w.gen === gen) w.at = 0
						return ok
					}
				: undefined,
			frame: canBox
				? async box => {
						const w = current()
						const from = w.target
						const gen = ++w.gen
						const ok = await ptz({ op: "box", x: box.x, y: box.y, w: box.w, h: box.h })
						// the server zooms by the box's longer side, as far as the lens goes
						const side = Math.max(box.w, box.h)
						if (ok && side > 0 && w.gen === gen) {
							// where the lens is going, until the camera has said where it got to
							w.target = stepTo(from, 1 / side)
							w.sent = w.target
							w.at = Date.now()
						}
						return ok
					}
				: undefined
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [zoomRange?.min, zoomRange?.max, canBox, ptz])

	const held = useRef(new Map<string, PtzBody>())
	const sent = useRef<string | null>(null)
	const resend = useRef<{ id: number; win: Window } | null>(null)
	const applyHolds = useCallback(() => {
		const next = combineHolds([...held.current.values()])
		const key = next ? JSON.stringify(next) : null
		if (key === sent.current) return
		const wasMoving = sent.current !== null
		sent.current = key
		if (resend.current) resend.current.win.clearInterval(resend.current.id)
		resend.current = null
		if (!next) {
			if (wasMoving) void send({ op: "stop" })
			return
		}
		// Held: say it again now and then, or the server's failsafe stops the camera mid-swing. One at a
		// time, none after a failure (that already said so), and on the PiP window's clock where a hidden
		// tab's would be slowed past the failsafe.
		const win = pipWindow() ?? window
		let busy = true
		const settle = (ok: boolean) => {
			busy = false
			if (!ok && resend.current === r) {
				win.clearInterval(r.id)
				resend.current = null
			}
		}
		const r = {
			id: win.setInterval(() => {
				if (busy) return
				busy = true
				void send(next).then(settle)
			}, HOLD_RESEND_MS),
			win
		}
		resend.current = r
		void ptz(next).then(settle)
	}, [ptz, send])
	const hold = useMemo<Hold>(
		() => ({
			press: (key, body) => {
				// re-inserting puts it last, so it counts as the most recent
				held.current.delete(key)
				held.current.set(key, body)
				applyHolds()
			},
			release: key => {
				if (held.current.delete(key)) applyHolds()
			},
			releaseAll: () => {
				held.current.clear()
				applyHolds()
			}
		}),
		[applyHolds]
	)
	// switching windows mid-hold never sends the key-up: stop rather than wait for the server's failsafe
	useEffect(() => {
		const stop = () => hold.releaseAll()
		window.addEventListener("blur", stop)
		return () => {
			window.removeEventListener("blur", stop)
			stop()
		}
	}, [hold])

	// Bumped by every change: a background re-read that started before it would put back the old value.
	const changes = useRef(0)
	const changed = useCallback(
		async (what: string, call: () => Promise<CameraControls>) => {
			changes.current++
			try {
				const next = await call()
				res.setData(() => next)
				return true
			} catch (e) {
				fail(what, e)
				return false
			}
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[fail]
	)

	// look4 switches the spotlight off by itself after a while (the camera's own app can too), and the
	// polled state has no lights: while it's on, read the controls again, so the switch, L and the note
	// saying when it goes off follow the lamp instead of acting on one that is already off
	const spotOn = !!controls?.lights.find(l => l.id === "spotlight")?.on
	useEffect(() => {
		if (!spotOn || !controllable) return
		const ac = new AbortController()
		const t = setInterval(() => {
			if (!watched()) return
			const at = changes.current
			api.controls(source, ac.signal).then(
				c => {
					if (changes.current === at) res.setData(() => c)
				},
				() => {}
			)
		}, SPOT_REFRESH_MS)
		return () => {
			clearInterval(t)
			ac.abort()
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [source, controllable, spotOn])

	return {
		controls,
		error: res.error,
		reload: res.reload,
		state,
		ptz,
		home: () => ptz({ op: "home" }),
		frame: box => ptz({ op: "box", x: box.x, y: box.y, w: box.w, h: box.h }),
		setting: body =>
			changed("Couldn't change the camera setting", () =>
				api.cameraSetting(source, body.setting === "home" && body.saveHere ? { ...body, digital: picture.current?.digital() ?? null } : body)
			),
		light: body => changed("Couldn't switch the light", () => api.light(source, body)),
		preset: body =>
			changed(body.op === "delete" ? "Couldn't delete the view" : "Couldn't save the view", () =>
				api.preset(source, body.op === "save" ? { ...body, digital: picture.current?.digital() ?? null } : body)
			),
		siren: async () => {
			try {
				await api.siren(source)
				return true
			} catch (e) {
				fail("The siren didn't sound", e)
				return false
			}
		},
		hold,
		view,
		moving: settleFrom !== null || !!state?.moving,
		optical,
		picture
	}
}
