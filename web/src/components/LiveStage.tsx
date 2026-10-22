import { type PointerEvent as ReactPointerEvent, type ReactNode, type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react"
import { flushSync } from "react-dom"
import type { DigitalView, LiveStream } from "../../../src/api-types.ts"
import { useLatest } from "../hooks.ts"
import { afterLens, anchoredBox, type Burst, change, grey, lensBox, lensStep, nextBurst, nextHold, startBurst, startHold, type View, within } from "../live/lens.ts"
import { Iris } from "../live/iris.ts"
import "../live-stage.css"
import { LivePlayer, type PlayerState } from "./LivePlayer.tsx"

// The picture surface of the live view: the player (double-buffered, so switching Quick ↔ Sharp keeps the
// old picture until the new one plays), digital zoom and pan, Aim (frame a box or pick a point for the
// camera), the detection-zone outline and a poster while connecting. Overlay content (chips, toolbar) is
// drawn above, never zoomed.
//
// Geometry: the picture is letterboxed (object-fit: contain) in the stage. The digital view is
// `{ z, cx, cy }`: the zoom and the point of the full frame (normalized, top-left origin) shown at the
// stage's centre. Every coordinate the stage reports is normalized full-frame, so zoom, pan and
// letterboxing never leak out.

/** A rectangle in normalized full-frame coordinates, top-left origin. */
export type StageBox = { x: number; y: number; w: number; h: number }

export type StageHandle = {
	/** Multiply digital zoom around the centre (1–8×). */
	zoomBy(factor: number): void
	resetZoom(): void
	/** The magnification now, to save with a view. */
	digital(): DigitalView
	/** Back to a saved magnification (1× for none). */
	setDigital(v: DigitalView): void
	/** The visible part of the full frame, normalized. */
	viewport(): StageBox
	/** Hands the magnification to the camera's lens, as the wheel does when it rests. */
	toLens(): Promise<LensResult>
}

/** `full`: the lens is in as far as it goes (or can't frame); `busy`: it is still taking the last one. */
export type LensResult = "framed" | "full" | "busy" | "failed"

/**
 * The camera's own zoom. In, the wheel aims the lens at the pointer and zooms it, magnifying what it can't
 * take ("camera"), or magnifies at the pointer at once and hands that to the lens when it rests ("picture");
 * out, past 1×, it zooms the lens out.
 */
export type OpticalZoom = {
	/** Zooms the lens by `log` (the natural log of the factor) as far as it goes, at once; returns the part it couldn't. */
	zoomBy(log: number): number
	/** How many times further the lens can zoom in (1: all the way in). */
	room(): number
	/** The zoom the lens really makes when asked for `factor`: its positions are whole steps, and it stops at its limit. */
	snap(factor: number): number
	/**
	 * Centres `aim` (a point of the picture as the camera sees it now) and zooms the lens `factor` times;
	 * resolves once the camera has arrived (false: it refused). Absent when the camera can't aim.
	 */
	aimZoom?: (o: { aim?: { x: number; y: number }; factor: number }) => Promise<boolean>
	/** Pans, tilts and zooms so `box` fills the picture; absent when the camera can't frame a box. */
	frame?: (box: StageBox) => Promise<boolean>
}

/** What the wheel zooms first: the camera's lens (the default) or the picture (see lens.ts). */
export type WheelMode = "camera" | "picture"

export type LiveStageProps = {
	source: string
	/** Switching double-buffers: the old picture stays until the new one plays (at most 8 s). */
	stream: LiveStream
	stills: boolean
	/** Bump to reconnect. */
	attempt: number
	/** Ask for the camera's sound track; the page knows whether there can be any. */
	audio?: boolean
	/** Unmute only from a click or key handler (see LivePlayer's `muted`). */
	muted: boolean
	/** Aim mode: a drag frames a box, a click picks a point (w = h = 0). Otherwise Shift-drag does it. */
	aim: boolean
	onAim?: (box: StageBox) => void
	onState: (s: PlayerState) => void
	onZoom?: (factor: number, viewport: StageBox) => void
	/** The wheel zooms this lens (first, or once it rests: `wheel`), and zooming out past 1× zooms it out. Pinches only magnify. */
	optical?: OpticalZoom | null
	/** Camera first unless "picture". */
	wheel?: WheelMode
	/** The picture was double-clicked (mouse): the page toggles full screen. */
	onDoubleClick?: () => void
	/** A stream switch started (the stream being switched to) or ended (null). */
	onSwitch?: (to: LiveStream | null) => void
	/** The browser refused to play with sound, so the player muted itself: the page should show muted. */
	onSoundBlocked?: () => void
	/** Outline of the detection zone, in normalized full-frame coordinates. */
	zone?: StageBox | null
	/** Shown until the first frame (and whenever the picture isn't playing). */
	poster?: string | null
	/** Drawn above the picture, not zoomed. Direct children receive pointer events; the layer itself doesn't. */
	children?: ReactNode
	ref?: Ref<StageHandle>
}

const MIN_ZOOM = 1
const MAX_ZOOM = 8
const TAP_ZOOM = 2.5
/** A switch shows the new stream after this long even if it isn't playing yet. */
const SWITCH_MAX_MS = 8000
/** How long the old stream stays underneath after a swap. */
const RETIRE_MS = 700
/** Moves shorter than this are clicks, not drags. */
const CLICK_PX = 5
const DOUBLE_TAP_MS = 300
/** The wheel's magnification goes to the lens once the wheel has rested this long... */
const HANDOFF_MS = 700
/** ...if the lens can take at least this much of it. Camera first drives the lens while it has this much room. */
const MIN_HANDOFF = 1.1
/**
 * Camera first: the first request of a run goes this long after the first notch, so the first events of a
 * flick go as one move. Later notches don't push it back: the camera takes a second a step, so any wait here
 * is lag, and what comes meanwhile goes with the next step.
 */
const GATHER_MS = 50
/** Camera first: a request under one lens step waits for more notches, and is dropped after this without any. */
const SMALL_DROP_MS = 600
/**
 * Camera first: the picture is still catching up with a move outside a run (a lens zoom out, a saved view,
 * a run cut off with its step on the way) for this long: its request, the move, and the stream's ~1 s. A
 * point aimed on it now would be read by the camera in the view it has, not the one shown, and would stop
 * that move halfway, so a run's first step waits this out. A far saved view may take longer; not measured.
 */
const OUT_SHOWS_MS = 2500
/**
 * Wheel events less than this apart are one gesture (a flick of notches, a trackpad's swipe and its momentum):
 * one that began scrolling the page goes on scrolling it when the picture comes under the pointer.
 */
const WHEEL_REST_MS = 400
/** While the lens moves, the picture is sampled this small this often (see lens.ts). */
const SAMPLE_W = 64
const SAMPLE_H = 36
const SAMPLE_MS = 100

type Sample = { el: HTMLVideoElement | HTMLImageElement; size: { w: number; h: number }; grey: Uint8Array }
/**
 * Camera first: a chain of lens steps from one wheel-in until the picture is current again. `target` is the
 * part of the picture (as shown when it began) the camera is going to, each step's box inside the last;
 * `rest` the zoom (a log) past the lens's limit, magnified once the picture is current. `overlay`: the
 * picture was current when the first step went, so the target is shown on it (everything else blurred)
 * until the move shows (`shown`); otherwise, and after, only the quiet cue. `steps`: how many have gone.
 */
type LensRun = {
	inFlight: boolean
	steps: number
	sent: number | null
	arrived: number | null
	target: StageBox | null
	rest: number
	overlay: boolean
	shown: boolean
}

type Geometry = { cw: number; ch: number; ox: number; oy: number; w: number; h: number }
type Point = { x: number; y: number }

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** Where the letterboxed picture sits in a `cw × ch` stage. */
const geometryOf = (cw: number, ch: number, aspect: number): Geometry => {
	const w = Math.min(cw, ch * aspect)
	const h = w / aspect
	return { cw, ch, ox: (cw - w) / 2, oy: (ch - h) / 2, w, h }
}

/** Keeps the picture covering the stage on an axis where it is larger, centred where it is smaller. */
const clampView = (g: Geometry, v: View): View => {
	const z = clamp(v.z, MIN_ZOOM, MAX_ZOOM)
	if (!g.w || !g.h) return { z, cx: 0.5, cy: 0.5 }
	const hw = g.cw / (2 * z * g.w)
	const hh = g.ch / (2 * z * g.h)
	return { z, cx: hw >= 0.5 ? 0.5 : clamp(v.cx, hw, 1 - hw), cy: hh >= 0.5 ? 0.5 : clamp(v.cy, hh, 1 - hh) }
}

const toFrame = (g: Geometry, v: View, p: Point): Point => ({
	x: v.cx + (p.x - g.cw / 2) / (v.z * g.w),
	y: v.cy + (p.y - g.ch / 2) / (v.z * g.h)
})

const toScreen = (g: Geometry, v: View, n: Point): Point => ({
	x: g.cw / 2 + (n.x - v.cx) * v.z * g.w,
	y: g.ch / 2 + (n.y - v.cy) * v.z * g.h
})

/** The view at zoom `z` that keeps frame point `n` under stage point `p`. */
const anchored = (g: Geometry, n: Point, p: Point, z: number): View =>
	clampView(g, { z, cx: n.x - (p.x - g.cw / 2) / (z * g.w), cy: n.y - (p.y - g.ch / 2) / (z * g.h) })

const viewportOf = (g: Geometry, v: View): StageBox => {
	if (!g.w || !g.h) return { x: 0, y: 0, w: 1, h: 1 }
	const a = toFrame(g, v, { x: 0, y: 0 })
	const b = toFrame(g, v, { x: g.cw, y: g.ch })
	const x = clamp(a.x, 0, 1)
	const y = clamp(a.y, 0, 1)
	return { x, y, w: clamp(b.x, 0, 1) - x, h: clamp(b.y, 0, 1) - y }
}

type Layer = { id: number; source: string; stream: LiveStream; stills: boolean }
/** `old`: the previous front, kept underneath for a moment after a swap in case the new one's first paint lags. */
type Buffers = { front: Layer; next: Layer | null; old: Layer | null }

type Gesture =
	| { kind: "box"; id: number; start: Point; at: Point; touch: boolean }
	| { kind: "pan"; id: number; start: Point; view: View; moved: boolean }
	| { kind: "pinch"; a: number; b: number; dist: number; anchor: Point; z: number }
	| { kind: "tap"; id: number; start: Point }

let layerIds = 0

export const LiveStage = ({
	source,
	stream,
	stills,
	attempt,
	audio,
	muted,
	aim,
	onAim,
	onState,
	onZoom,
	optical,
	wheel = "camera",
	onDoubleClick,
	onSwitch,
	onSoundBlocked,
	zone,
	poster,
	children,
	ref
}: LiveStageProps) => {
	const surfaceRef = useRef<HTMLDivElement>(null)
	const zoomRef = useRef<HTMLDivElement>(null)
	const zoneRef = useRef<HTMLDivElement>(null)
	const boxRef = useRef<HTMLDivElement>(null)
	const lensRef = useRef<HTMLDivElement>(null)
	const props = useLatest({ onAim, onState, onZoom, optical, wheel, onDoubleClick, onSwitch, onSoundBlocked, aim, zone })

	// ---------- double buffer ----------

	const [buffers, setBuffers] = useState<Buffers>(() => ({ front: { id: ++layerIds, source, stream, stills }, next: null, old: null }))
	const buffersRef = useRef(buffers)
	buffersRef.current = buffers
	const states = useRef(new Map<number, PlayerState>())
	const [frontPlaying, setFrontPlaying] = useState(false)

	const promote = (to: Layer) => {
		const cur = buffersRef.current
		if (cur.next?.id !== to.id) return
		buffersRef.current = { front: to, next: null, old: states.current.get(cur.front.id)?.phase === "playing" ? cur.front : null }
		setBuffers(buffersRef.current)
		const s = states.current.get(to.id) ?? { phase: "connecting" }
		setFrontPlaying(s.phase === "playing")
		if (s.phase === "playing" && s.width && s.height) setAspect(s.width / s.height)
		props.current.onState(s)
		props.current.onSwitch?.(null)
	}

	useLayoutEffect(() => {
		const cur = buffersRef.current
		const target = cur.next ?? cur.front
		if (target.source === source && target.stream === stream && target.stills === stills) return
		const front = cur.front
		const frontState = states.current.get(front.id)
		const layer = { id: ++layerIds, source, stream, stills }
		let next: Buffers
		if (front.source === source && front.stream === stream && front.stills === stills) next = { front, next: null, old: null }
		// another camera, or nothing worth keeping on screen: replace right away
		else if (front.source !== source || frontState?.phase !== "playing") next = { front: layer, next: null, old: null }
		else next = { front, next: layer, old: null }
		buffersRef.current = next
		setBuffers(next)
		if (next.front !== front) {
			setFrontPlaying(false)
			if (front.source !== source) {
				cancelHandoff()
				setView({ z: 1, cx: 0.5, cy: 0.5 }, false)
			}
		} else if (next.front === front && !next.next) props.current.onState(frontState ?? { phase: "connecting" })
		props.current.onSwitch?.(next.next ? next.next.stream : null)
	}, [source, stream, stills])

	useEffect(() => {
		const next = buffers.next
		if (!next) return
		const win = surfaceRef.current?.ownerDocument.defaultView ?? window
		const t = win.setTimeout(() => promote(next), SWITCH_MAX_MS)
		return () => win.clearTimeout(t)
	}, [buffers.next])

	useEffect(() => {
		if (!buffers.old) return
		const win = surfaceRef.current?.ownerDocument.defaultView ?? window
		const t = win.setTimeout(() => {
			buffersRef.current = { ...buffersRef.current, old: null }
			setBuffers(buffersRef.current)
		}, RETIRE_MS)
		return () => win.clearTimeout(t)
	}, [buffers.old])

	const layerState = (layer: Layer) => (s: PlayerState) => {
		states.current.set(layer.id, s)
		const cur = buffersRef.current
		if (cur.next?.id === layer.id) {
			if (s.phase === "playing") promote(layer)
			return
		}
		if (cur.front.id !== layer.id) return
		// the old picture is gone anyway: show the new stream now
		if (cur.next && s.phase !== "playing") return promote(cur.next)
		if (s.phase === "playing") {
			setFrontPlaying(true)
			if (s.width && s.height) setAspect(s.width / s.height)
		} else setFrontPlaying(false)
		props.current.onState(s)
	}

	useEffect(() => {
		const live = new Set([buffers.front.id, buffers.next?.id, buffers.old?.id])
		for (const id of states.current.keys()) if (!live.has(id)) states.current.delete(id)
	}, [buffers])

	// ---------- digital zoom ----------

	const view = useRef<View>({ z: 1, cx: 0.5, cy: 0.5 })
	const geo = useRef<Geometry>(geometryOf(0, 0, 16 / 9))
	const aspect = useRef(16 / 9)
	const [zoomed, setZoomed] = useState(false)
	const reported = useRef("")
	const frame = useRef(0)

	const drawZone = () => {
		const el = zoneRef.current
		const z = props.current.zone
		if (!el) return
		if (!z || !geo.current.w) {
			el.hidden = true
			return
		}
		const g = geo.current
		const a = toScreen(g, view.current, { x: z.x, y: z.y })
		const b = toScreen(g, view.current, { x: z.x + z.w, y: z.y + z.h })
		el.hidden = false
		el.style.transform = `translate(${a.x}px, ${a.y}px)`
		el.style.width = `${b.x - a.x}px`
		el.style.height = `${b.y - a.y}px`
	}

	const apply = (animate = false) => {
		const g = geo.current
		const v = (view.current = clampView(g, view.current))
		const el = zoomRef.current
		if (el) {
			el.classList.toggle("is-anim", animate)
			el.style.transform = `translate(${g.cw / 2 - (g.ox + v.cx * g.w) * v.z}px, ${g.ch / 2 - (g.oy + v.cy * g.h) * v.z}px) scale(${v.z})`
		}
		drawZone()
		drawLens()
		setZoomed(v.z > 1.001)
		const win = surfaceRef.current?.ownerDocument.defaultView ?? window
		if (frame.current) return
		// one report per frame however many pointer events arrive
		frame.current = win.requestAnimationFrame(() => {
			frame.current = 0
			const vp = viewportOf(geo.current, view.current)
			const key = `${view.current.z.toFixed(3)} ${vp.x.toFixed(4)} ${vp.y.toFixed(4)} ${vp.w.toFixed(4)} ${vp.h.toFixed(4)}`
			if (key === reported.current) return
			reported.current = key
			props.current.onZoom?.(view.current.z, vp)
		})
	}

	const setView = (v: View, animate: boolean) => {
		view.current = v
		apply(animate)
	}

	const setAspect = (a: number) => {
		if (Math.abs(a - aspect.current) < 0.001) return
		aspect.current = a
		geo.current = geometryOf(geo.current.cw, geo.current.ch, a)
		apply()
	}

	const zoomAt = (p: Point, z: number, animate: boolean) => {
		const g = geo.current
		setView(anchored(g, toFrame(g, view.current, p), p, clamp(z, MIN_ZOOM, MAX_ZOOM)), animate)
	}

	// ---------- handing the magnification to the lens (lens.ts) ----------

	const freezeRef = useRef<HTMLCanvasElement>(null)
	const [held, setHeld] = useState(false)
	/** Bumped by another camera and by unmounting: a handoff under way no longer applies. */
	const handoffGen = useRef(0)
	const handing = useRef(false)
	/** The wheel zoomed in and the lens hasn't taken it yet. */
	const pendingIn = useRef(false)
	const handoffTimer = useRef<{ id: number; win: Window } | null>(null)
	/** Camera first: the zoom the wheel asked for (a natural log) and no lens step has been sent for yet; 0 for none. */
	const want = useRef(0)
	const lastNotch = useRef(0)
	const gatherTimer = useRef<{ id: number; win: Window; due: number } | null>(null)
	/** Camera first: the chain of lens steps under way, until the picture is current again. */
	const run = useRef<LensRun | null>(null)
	/** When the camera was last sent somewhere outside a run (see OUT_SHOWS_MS): the picture shows that a while after. */
	const lastMove = useRef(-Infinity)
	/** Where the pointer last was over the stage: camera first anchors a step there when it sends it. */
	const hover = useRef<Point | null>(null)
	/** When the wheel last scrolled the page (see WHEEL_REST_MS). */
	const pageWheel = useRef(-Infinity)

	/**
	 * A reader of the front picture, as a 64×36 grey copy: each call samples it and says how much it changed
	 * since the first sample and since the previous one (null without a picture to sample).
	 */
	const pictureSampler = () => {
		const doc = surfaceRef.current!.ownerDocument
		const sampler = doc.createElement("canvas")
		sampler.width = SAMPLE_W
		sampler.height = SAMPLE_H
		const ctx = sampler.getContext("2d", { willReadFrequently: true })
		// a fine downscale: the default one samples a few source pixels each, and their noise reads as change
		if (ctx) ctx.imageSmoothingQuality = "high"
		let first: Uint8Array | null = null
		let last: Uint8Array | null = null
		// the front player's picture (a canvas can't read a video still loading, or a picture it may not read)
		const sample = (): Sample | null => {
			const el = zoomRef.current?.querySelector<HTMLVideoElement | HTMLImageElement>(".stage-layer.is-front .stage-el")
			const size = el && ("videoWidth" in el ? el.readyState >= 2 && { w: el.videoWidth, h: el.videoHeight } : el.complete && { w: el.naturalWidth, h: el.naturalHeight })
			if (!el || !ctx || !size || !size.w || !size.h) return null
			try {
				ctx.drawImage(el, 0, 0, SAMPLE_W, SAMPLE_H)
				return { el, size, grey: grey(ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data) }
			} catch {
				return null
			}
		}
		return () => {
			const s = sample()
			if (s) first ??= s.grey
			const out = { s, fromStart: s && first ? change(first, s.grey) : null, fromLast: s && last ? change(last, s.grey) : null }
			if (s) last = s.grey
			return out
		}
	}

	/**
	 * Samples the front picture every SAMPLE_MS while a lens move travels from the camera to the picture
	 * (lens.ts's phases): `each` sees the phase and the sample until the move has settled, which resolves
	 * the promise, as does `alive` turning false (another camera, another move).
	 */
	const watchMove = (sent: () => number | null | false, alive: () => boolean, each: (phase: "live" | "held", s: Sample | null) => void) => {
		const win = surfaceRef.current!.ownerDocument.defaultView ?? window
		const read = pictureSampler()
		let hold = startHold(performance.now())
		return new Promise<void>(resolve => {
			const tick = () => {
				if (!alive()) return resolve()
				const { s, fromStart, fromLast } = read()
				hold = nextHold(hold, { t: performance.now(), sent: sent(), fromStart, fromLast })
				if (hold.phase === "done") return resolve()
				each(hold.phase, s)
				win.setTimeout(tick, SAMPLE_MS)
			}
			tick()
		})
	}

	/** Whatever the wheel asked of the lens and it hasn't settled yet, in either mode, no longer applies. */
	const dropWheel = () => {
		pendingIn.current = false
		handoffTimer.current?.win.clearTimeout(handoffTimer.current.id)
		handoffTimer.current = null
		endRun()
	}

	const cancelHandoff = () => {
		handoffGen.current++
		dropWheel()
	}

	const toLens = async (): Promise<LensResult> => {
		const lens = props.current.optical
		if (handing.current || run.current) return "busy"
		const f = lens?.frame ? Math.min(view.current.z, lens.room()) : 1
		if (!lens?.frame || f < MIN_HANDOFF) return "full"
		pendingIn.current = false
		handing.current = true
		const gen = handoffGen.current
		const box = lensBox(view.current, f)
		const freeze = freezeRef.current
		let sent: number | null | false = null
		let shown = false
		const settled = watchMove(
			() => sent,
			() => gen === handoffGen.current,
			(phase, s) => {
				if (phase === "held") {
					if (!shown) flushSync(() => setHeld((shown = true)))
				} else if (s && freeze) {
					// the scene from before the move, ready to cover the picture the moment the move reaches it
					if (freeze.width !== s.size.w || freeze.height !== s.size.h) {
						freeze.width = s.size.w
						freeze.height = s.size.h
					}
					freeze.getContext("2d")?.drawImage(s.el, 0, 0, s.size.w, s.size.h)
				}
			}
		)
		const ok = await lens.frame(box)
		sent = ok ? performance.now() : false
		await settled
		// the held picture goes in the same frame as the view changes, or it shows a frame out of place
		flushSync(() => setHeld(false))
		// whatever was magnified or panned meanwhile carries over
		if (ok && gen === handoffGen.current) setView(afterLens(view.current, box), false)
		if (freeze) freeze.width = freeze.height = 0
		handing.current = false
		return ok ? "framed" : "failed"
	}

	const armHandoff = () => {
		const win = surfaceRef.current?.ownerDocument.defaultView ?? window
		if (handoffTimer.current) handoffTimer.current.win.clearTimeout(handoffTimer.current.id)
		handoffTimer.current = {
			id: win.setTimeout(() => {
				handoffTimer.current = null
				if (!pendingIn.current) return
				// not in the middle of a drag or a pinch, nor while the lens is still taking the last one
				if (gesture.current || handing.current) return armHandoff()
				void toLens()
			}, HANDOFF_MS),
			win
		}
	}

	// ---------- camera first: the lens aims at the pointer and zooms, step after step; the picture magnifies after ----------

	/** The lens drives the wheel's zoom-in only from 1× and while it has room; past that the picture magnifies. */
	const lensTakes = (lens: OpticalZoom | null | undefined): lens is OpticalZoom => !!lens?.aimZoom && view.current.z <= 1.001 && lens.room() >= MIN_HANDOFF

	const pointer = () => hover.current ?? { x: geo.current.cw / 2, y: geo.current.ch / 2 }

	/** The step the unsent zoom would make now: a box at the pointer in the view the camera has (or is going to), as far as the lens goes. */
	const wantedBox = (lens: OpticalZoom | null | undefined) => {
		if (want.current <= 0 || !lens) return null
		const f = Math.min(Math.exp(want.current), lens.room())
		return f > 1.001 ? anchoredBox(toFrame(geo.current, view.current, pointer()), f) : null
	}

	/** The feedback's layers (iris.ts), made once per mounted `.stage-lens` (a Picture-in-Picture window mounts its own). */
	const irisRef = useRef<Iris | null>(null)
	const iris = () => {
		const el = lensRef.current
		if (!el) return null
		if (irisRef.current?.root !== el) irisRef.current = new Iris(el)
		return irisRef.current
	}

	/**
	 * Camera first's feedback (iris.ts), drawn without waiting for React. The first step's target (and the
	 * steps asked for meanwhile, inside it) shows on the picture, everything around it blurred and dimmed: the
	 * part about to be zoomed away. When the move reaches the picture it opens to the frame and goes; later
	 * steps, whose picture is already moving, only get the quiet cue. `notch`: a wheel notch asked for this
	 * (the box ticks, or the quiet cue closes in), not the pointer moving the box or a step going.
	 */
	const drawLens = (notch = false) => {
		const lens = iris()
		if (!lens) return
		const r = run.current
		const g = geo.current
		lens.size(g.cw, g.ch, { x: g.ox, y: g.oy, w: g.w, h: g.h })
		let box: StageBox | null = null
		if (r && r.overlay && !r.shown && g.w) {
			const next = wantedBox(props.current.optical)
			box = r.target ? (next ? within(r.target, next) : r.target) : next
		}
		if (r && box) {
			const a = toScreen(g, view.current, { x: box.x, y: box.y })
			const c = toScreen(g, view.current, { x: box.x + box.w, y: box.y + box.h })
			// runs start at 1×, so the box's share of the frame is the zoom it asks for
			lens.aim({ x: a.x, y: a.y, w: c.x - a.x, h: c.y - a.y }, pointer(), 1 / box.w, notch)
			lens.working(r.sent !== null)
			return
		}
		if (!r) return
		// the first step's move reaches the picture: the box becomes the view
		if (r.shown) lens.open()
		// a step past the first is asked for or on its way: the quiet cue stays on without a notch
		lens.quiet(pointer(), notch, want.current > 0 || (r.inFlight && r.steps > 1))
	}

	/**
	 * Sends the next step after `ms` unless one is due sooner: the first notches of a flick go together, and
	 * later ones never push it back.
	 */
	const armGather = (ms = GATHER_MS) => {
		const win = surfaceRef.current?.ownerDocument.defaultView ?? window
		const due = performance.now() + ms
		const t = gatherTimer.current
		if (t && t.due <= due) return
		if (t) t.win.clearTimeout(t.id)
		gatherTimer.current = {
			id: win.setTimeout(() => {
				gatherTimer.current = null
				pump()
			}, Math.max(0, ms)),
			win,
			due
		}
	}

	/** The run is over (finished, refused, cancelled, or taken over by a zoom out): its feedback goes, unsent zoom with it. */
	function endRun() {
		const r = run.current
		// a step cut off on its way still moves the camera, and the picture shows it later
		if (r?.inFlight) lastMove.current = performance.now()
		run.current = null
		want.current = 0
		gatherTimer.current?.win.clearTimeout(gatherTimer.current.id)
		gatherTimer.current = null
		// nothing went: the target relaxes back out as it goes; otherwise it just goes (a move that showed
		// has handed over already)
		if (r) {
			if (r.sent === null) iris()?.retreat()
			else iris()?.end()
		}
	}

	/** The picture still shows the camera before a move outside a run, for this much longer (ms); 0 when current. */
	const staleFor = () => Math.max(0, lastMove.current + OUT_SHOWS_MS - performance.now())

	/**
	 * Starts a run on the first notch: the feedback at once, the first step after GATHER_MS (or once the
	 * picture is current, see OUT_SHOWS_MS), and a watch on the picture that ends the run once it is current
	 * again, then magnifies what the lens couldn't take.
	 */
	const beginRun = () => {
		const r: LensRun = { inFlight: false, steps: 0, sent: null, arrived: null, target: null, rest: 0, overlay: staleFor() === 0, shown: false }
		run.current = r
		armGather()
		drawLens(true)
		const win = surfaceRef.current!.ownerDocument.defaultView ?? window
		let read: ReturnType<typeof pictureSampler> | null = null
		let b: Burst = startBurst(performance.now())
		const tick = () => {
			if (run.current !== r) return
			const busy = r.inFlight || (want.current > 0 && gatherTimer.current !== null)
			if (r.sent === null && busy) {
				// The first step isn't sent yet: the watch starts with it. Whatever the picture does before
				// (a zoom out still showing) isn't this run's move, and the first sample waits out the
				// overlay's first paint.
				b = startBurst(performance.now())
				return void win.setTimeout(tick, SAMPLE_MS)
			}
			read ??= pictureSampler()
			const { fromStart, fromLast } = read()
			b = nextBurst(b, { t: performance.now(), busy, sent: r.sent, arrived: r.arrived, fromStart, fromLast })
			if (b.phase !== "live" && !r.shown) {
				r.shown = true
				drawLens()
			}
			if (b.phase !== "done") return void win.setTimeout(tick, SAMPLE_MS)
			// The picture shows where the camera went: what was past the lens's limit magnifies at the
			// pointer now, never while the picture is still zooming. Less than a lens step left over goes.
			const more = r.rest
			endRun()
			if (more > 0) zoomAt(pointer(), view.current.z * Math.exp(more), false)
		}
		tick()
	}

	/**
	 * Sends the zoom asked for and not sent yet as one lens step, unless a step is on its way (its arrival
	 * sends the next). The step aims at the centre of a box anchored at the pointer, in the coordinates of
	 * the view the camera has now, which is where the last step went (the picture may not show it yet): the
	 * scene point under the pointer is under it again once the picture catches up.
	 */
	const pump = () => {
		const r = run.current
		if (!r || r.inFlight || want.current <= 0) return
		// not in the middle of a drag or a pinch, nor while "Zoom camera here" moves the lens
		if (gesture.current || handing.current) return armGather(GATHER_MS)
		// the first step aims on the picture as shown: not until it shows the camera as it is
		const stale = r.sent === null ? staleFor() : 0
		if (stale > 0) return armGather(stale)
		const lens = props.current.optical
		if (!lens?.aimZoom || view.current.z > 1.001) {
			// a pinch magnified meanwhile: the picture takes it all, once current
			r.rest += want.current
			want.current = 0
			return drawLens()
		}
		const step = lensStep(want.current, lens.room(), lens.snap)
		r.rest += step.rest
		want.current = step.want
		const f = step.lens
		if (f === 1) {
			// under one lens step: wait for more; a run that never sent anything is dropped when no more comes
			if (r.sent === null) {
				const idle = performance.now() - lastNotch.current
				if (idle >= SMALL_DROP_MS) return endRun()
				armGather(SMALL_DROP_MS - idle)
			}
			return drawLens()
		}
		const box = anchoredBox(toFrame(geo.current, view.current, pointer()), f)
		r.target = r.target ? within(r.target, box) : box
		// a run held for the picture to catch up gets its box now that it shows the scene the camera has
		if (r.sent === null) r.overlay = true
		r.inFlight = true
		r.steps++
		r.sent = performance.now()
		drawLens()
		const arrived = (ok: boolean) => {
			if (run.current !== r) return
			r.inFlight = false
			// refused (useCamera says so): no retry, and what was asked meanwhile goes with it
			if (!ok) return endRun()
			r.arrived = performance.now()
			pump()
		}
		lens.aimZoom({ aim: { x: box.x + box.w / 2, y: box.y + box.h / 2 }, factor: f }).then(arrived, () => arrived(false))
	}

	/**
	 * The wheel, camera first. In: the first notch starts a run of lens steps at the pointer (see pump);
	 * past the lens's limit the picture magnifies once current. Out: the zoom not sent yet, then the
	 * magnification, then the lens, which takes over from a run under way.
	 */
	const wheelCamera = (lens: OpticalZoom, p: Point, log: number) => {
		const z = view.current.z
		const r = run.current
		if (log > 0) {
			if (!lens.aimZoom) {
				// a lens that can't aim zooms around the middle; what it can't take magnifies at the pointer
				const rest = lens.zoomBy(log)
				if (rest > 1e-9) zoomAt(p, z * Math.exp(rest), false)
				return
			}
			if (r || (!handing.current && lensTakes(lens))) {
				want.current += log
				lastNotch.current = performance.now()
				if (!r) beginRun()
				else {
					// nothing on its way: this goes as the next step; on its way, it goes when the camera arrives
					if (!r.inFlight) armGather()
					drawLens(true)
				}
				return
			}
			zoomAt(p, z * Math.exp(log), false)
			return
		}
		if (r && r.rest > 0) {
			// the magnification waiting for the picture: less, or none
			r.rest = Math.max(0, r.rest + log)
			return
		}
		// Scrolled back out before it went: less, or nothing at all (and no run, if nothing was sent). What a
		// sent step's rounding to whole lens positions left over isn't a request to take back.
		if (want.current > 0 && (!r || r.sent === null || lens.snap(Math.exp(want.current)) > 1.001)) {
			// as many notches out as in can leave a rounding hair (5.6e-17 after three): that's nothing
			const left = want.current + log
			want.current = left > 1e-9 ? left : 0
			if (!want.current && r && r.sent === null) endRun()
			else drawLens(true)
			return
		}
		want.current = 0
		const to = clamp(z * Math.exp(log), MIN_ZOOM, MAX_ZOOM)
		const rest = log - Math.log(to / z)
		// the lens goes out at once, from where the last step sent it, whatever the picture shows yet
		const lensOut = rest < 0 && !handing.current ? lens.zoomBy(rest) !== rest : false
		if (to !== z) zoomAt(p, to, false)
		if (lensOut) {
			lastMove.current = performance.now()
			// the user changed their mind: the zoom out takes over from the run
			if (r) endRun()
		}
	}

	useEffect(() => cancelHandoff, [])
	// a request from the other mode no longer applies
	useEffect(() => dropWheel, [wheel])

	useImperativeHandle(
		ref,
		() => ({
			zoomBy: (factor: number) => zoomAt({ x: geo.current.cw / 2, y: geo.current.ch / 2 }, view.current.z * factor, true),
			resetZoom: () => {
				// actual size: nothing the wheel asked of the lens magnifies after it either
				dropWheel()
				setView({ z: 1, cx: 0.5, cy: 0.5 }, true)
			},
			digital: () => ({ ...view.current }),
			setDigital: v => {
				// a saved view moves the camera too: whatever the wheel asked of the lens is moot, and the
				// next run waits for the picture to show where it went
				dropWheel()
				lastMove.current = performance.now()
				setView({ ...v }, true)
			},
			viewport: () => viewportOf(geo.current, view.current),
			toLens
		}),
		[]
	)

	useLayoutEffect(drawZone, [zone?.x, zone?.y, zone?.w, zone?.h])

	useLayoutEffect(() => {
		const el = surfaceRef.current!
		const win = (el.ownerDocument.defaultView ?? window) as Window & typeof globalThis
		const measure = () => {
			geo.current = geometryOf(el.clientWidth, el.clientHeight, aspect.current)
			apply()
		}
		measure()
		// the owner window's observer: a Picture-in-Picture window renders while the main tab is hidden
		const ro = new win.ResizeObserver(measure)
		ro.observe(el)
		/** The wheel at `at` zooms; out past 1× with the lens all the way out, it does nothing. */
		const zoomWheel = (at: Point, log: number, pinch: boolean) => {
			if (!pinch && props.current.wheel === "camera" && props.current.optical) return wheelCamera(props.current.optical, at, log)
			// Picture first, the wheel zooms at the pointer: in, it magnifies there at once, and once it rests the
			// camera's lens frames what it magnified (toLens); out, the magnification back to 1×, then the lens out
			// (around the middle, but by then the lens framed what was under the pointer). A pinch only magnifies.
			const lens = pinch ? null : props.current.optical
			const z = clamp(view.current.z * Math.exp(log), MIN_ZOOM, MAX_ZOOM)
			const rest = log - Math.log(z / view.current.z)
			const lensOut = rest < 0 && lens && !handing.current ? lens.zoomBy(rest) !== rest : false
			if (log < 0 && z === view.current.z && !lensOut) return
			if (z !== view.current.z) zoomAt(at, z, false)
			if (lens?.frame && (log > 0 || pendingIn.current)) {
				if (log > 0) pendingIn.current = true
				armHandoff()
			}
		}
		// Over the picture the wheel is the picture's, all the way out too; the page scrolls from anywhere else.
		// A page scroll under way stays the page's when it slides the picture under the pointer, or a scroll up
		// from the rail below would stop at the picture and zoom the camera in.
		const onPageWheel = (e: WheelEvent) => {
			if (!el.contains(e.target as Node)) pageWheel.current = performance.now()
		}
		const onWheel = (e: WheelEvent) => {
			const now = performance.now()
			// a trackpad pinch arrives as ctrl+wheel with small deltas: never the page's, which it would zoom
			const pinch = e.ctrlKey
			// an event the browser won't let be cancelled is scrolling the page already: zooming too would do both
			if (!e.cancelable || (!pinch && now - pageWheel.current < WHEEL_REST_MS)) {
				pageWheel.current = now
				return
			}
			e.preventDefault()
			const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaY
			const r = el.getBoundingClientRect()
			const at = { x: e.clientX - r.left, y: e.clientY - r.top }
			hover.current = at
			zoomWheel(at, -dy * (pinch ? 0.01 : 0.002), pinch)
		}
		win.addEventListener("wheel", onPageWheel, { capture: true, passive: true })
		el.addEventListener("wheel", onWheel, { passive: false })
		return () => {
			ro.disconnect()
			win.removeEventListener("wheel", onPageWheel, { capture: true })
			el.removeEventListener("wheel", onWheel)
			if (frame.current) win.cancelAnimationFrame(frame.current)
			frame.current = 0
		}
	}, [])

	// ---------- pointer gestures ----------

	const pointers = useRef(new Map<number, Point>())
	const gesture = useRef<Gesture | null>(null)
	const lastTap = useRef<{ t: number; p: Point } | null>(null)
	const lastPointerType = useRef("mouse")
	const [panning, setPanning] = useState(false)
	const [boxing, setBoxing] = useState(false)

	const local = (e: { clientX: number; clientY: number }): Point => {
		const r = surfaceRef.current!.getBoundingClientRect()
		return { x: e.clientX - r.left, y: e.clientY - r.top }
	}

	const drawBox = (g: Extract<Gesture, { kind: "box" }> | null) => {
		const el = boxRef.current
		if (!el) return
		const big = g && Math.hypot(g.at.x - g.start.x, g.at.y - g.start.y) >= CLICK_PX
		el.hidden = !big
		if (!g || !big) return
		el.style.transform = `translate(${Math.min(g.start.x, g.at.x)}px, ${Math.min(g.start.y, g.at.y)}px)`
		el.style.width = `${Math.abs(g.at.x - g.start.x)}px`
		el.style.height = `${Math.abs(g.at.y - g.start.y)}px`
	}

	const endGesture = () => {
		gesture.current = null
		drawBox(null)
		setPanning(false)
		setBoxing(false)
	}

	const finishBox = (g: Extract<Gesture, { kind: "box" }>) => {
		const geom = geo.current
		const a = toFrame(geom, view.current, g.start)
		if (Math.hypot(g.at.x - g.start.x, g.at.y - g.start.y) < CLICK_PX) {
			// a point in the letterbox isn't on the picture
			if (a.x < 0 || a.x > 1 || a.y < 0 || a.y > 1) return
			props.current.onAim?.({ x: a.x, y: a.y, w: 0, h: 0 })
			return
		}
		const b = toFrame(geom, view.current, g.at)
		const x0 = clamp(Math.min(a.x, b.x), 0, 1)
		const y0 = clamp(Math.min(a.y, b.y), 0, 1)
		const x1 = clamp(Math.max(a.x, b.x), 0, 1)
		const y1 = clamp(Math.max(a.y, b.y), 0, 1)
		if (x1 <= x0 || y1 <= y0) return
		props.current.onAim?.({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
	}

	const startPinch = () => {
		const [[a, pa], [b, pb]] = [...pointers.current.entries()] as [[number, Point], [number, Point]]
		const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 }
		drawBox(null)
		setBoxing(false)
		setPanning(false)
		gesture.current = {
			kind: "pinch",
			a,
			b,
			dist: Math.max(1, Math.hypot(pa.x - pb.x, pa.y - pb.y)),
			anchor: toFrame(geo.current, view.current, mid),
			z: view.current.z
		}
	}

	const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (e.pointerType === "mouse" && e.button !== 0) return
		lastPointerType.current = e.pointerType
		const p = local(e)
		pointers.current.set(e.pointerId, p)
		e.currentTarget.setPointerCapture(e.pointerId)
		if (pointers.current.size === 2) return startPinch()
		if (pointers.current.size > 2) return
		const touch = e.pointerType === "touch"
		if (props.current.aim || e.shiftKey) {
			gesture.current = { kind: "box", id: e.pointerId, start: p, at: p, touch }
			setBoxing(true)
		} else if (view.current.z > 1.001) gesture.current = { kind: "pan", id: e.pointerId, start: p, view: view.current, moved: false }
		else gesture.current = { kind: "tap", id: e.pointerId, start: p }
	}

	const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (props.current.wheel === "camera") {
			hover.current = local(e)
			// the step not sent yet follows the pointer
			if (want.current > 0 && run.current) drawLens()
		}
		if (!pointers.current.has(e.pointerId)) return
		const p = local(e)
		pointers.current.set(e.pointerId, p)
		const g = gesture.current
		if (!g) return
		if (g.kind === "box" && g.id === e.pointerId) {
			g.at = p
			drawBox(g)
		} else if (g.kind === "pan" && g.id === e.pointerId) {
			if (!g.moved && Math.hypot(p.x - g.start.x, p.y - g.start.y) < CLICK_PX / 2) return
			if (!g.moved) setPanning(true)
			g.moved = true
			const geom = geo.current
			setView(
				clampView(geom, {
					z: g.view.z,
					cx: g.view.cx - (p.x - g.start.x) / (g.view.z * geom.w),
					cy: g.view.cy - (p.y - g.start.y) / (g.view.z * geom.h)
				}),
				false
			)
		} else if (g.kind === "pinch") {
			const pa = pointers.current.get(g.a)
			const pb = pointers.current.get(g.b)
			if (!pa || !pb) return
			const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 }
			const z = clamp((g.z * Math.hypot(pa.x - pb.x, pa.y - pb.y)) / g.dist, MIN_ZOOM, MAX_ZOOM)
			setView(anchored(geo.current, g.anchor, mid, z), false)
		}
	}

	const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
		if (!pointers.current.delete(e.pointerId)) return
		const g = gesture.current
		if (!g) return
		if (g.kind === "pinch") {
			// one finger left: carry on panning with it
			const rest = [...pointers.current.entries()][0]
			if (rest && view.current.z > 1.001) {
				// moved: lifting the second finger isn't a tap
				gesture.current = { kind: "pan", id: rest[0], start: rest[1], view: view.current, moved: true }
			} else if (!pointers.current.size) endGesture()
			return
		}
		if (("id" in g && g.id !== e.pointerId) || pointers.current.size) return
		if (g.kind === "box" && !cancelled) finishBox(g)
		const p = local(e)
		const tapped = !cancelled && e.pointerType === "touch" && g.kind !== "box" && Math.hypot(p.x - g.start.x, p.y - g.start.y) < CLICK_PX * 2
		if (g.kind === "pan" && g.moved) lastTap.current = null
		else if (tapped) {
			// double-tap toggles 1× ↔ 2.5× at the finger
			const prev = lastTap.current
			const now = performance.now()
			if (prev && now - prev.t < DOUBLE_TAP_MS && Math.hypot(p.x - prev.p.x, p.y - prev.p.y) < 30) {
				lastTap.current = null
				if (view.current.z > 1.001) setView({ z: 1, cx: 0.5, cy: 0.5 }, true)
				else zoomAt(p, TAP_ZOOM, true)
			} else lastTap.current = { t: now, p }
		}
		endGesture()
	}

	// Esc abandons a box being drawn
	useEffect(() => {
		if (!boxing) return
		const doc = surfaceRef.current!.ownerDocument
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") endGesture()
		}
		doc.addEventListener("keydown", onKey, true)
		return () => doc.removeEventListener("keydown", onKey, true)
	}, [boxing])

	const layers = [buffers.old, buffers.next, buffers.front].filter(l => l !== null)
	const className = ["stage", zoomed && "is-zoomed", panning && "is-panning", (aim || boxing) && "is-aim", held && "is-held"].filter(Boolean).join(" ")

	return (
		<div className={className}>
			<div
				ref={surfaceRef}
				className="stage-surface"
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={e => onPointerEnd(e, false)}
				onPointerCancel={e => onPointerEnd(e, true)}
				onLostPointerCapture={e => onPointerEnd(e, true)}
				onDoubleClick={() => {
					// touch double-taps zoom instead; in Aim each click is a point
					if (lastPointerType.current !== "touch" && !props.current.aim) props.current.onDoubleClick?.()
				}}
				onContextMenu={e => {
					if (gesture.current) e.preventDefault()
				}}
			>
				<div ref={zoomRef} className="stage-zoom">
					{poster && !frontPlaying && <img className="stage-poster" src={poster} alt="" draggable={false} />}
					{layers.map(l => {
						const front = l.id === buffers.front.id
						return (
							<div key={l.id} className={front ? "stage-layer is-front" : "stage-layer is-next"} aria-hidden={front ? undefined : true}>
								<LivePlayer
									source={l.source}
									stream={l.stream}
									stills={l.stills}
									attempt={attempt}
									audio={audio}
									muted={front ? muted : true}
									onState={layerState(l)}
									onSoundBlocked={front ? () => props.current.onSoundBlocked?.() : undefined}
								/>
							</div>
						)
					})}
					<canvas ref={freezeRef} className={held ? "stage-freeze is-on" : "stage-freeze"} aria-hidden="true" />
				</div>
				<div ref={zoneRef} className="stage-zone" hidden aria-hidden="true" />
				<div ref={boxRef} className="stage-aimbox" hidden aria-hidden="true" />
				<div ref={lensRef} className="stage-lens" aria-hidden="true">
					<div className="stage-lens-shade" />
					<div className="stage-lens-ripple" />
					<div className="stage-lens-ripple" />
					<div className="stage-lens-rim">
						<div className="stage-lens-box">
							<div className="stage-lens-halo" />
							<div className="stage-lens-glow">
								<div className="stage-lens-comet" />
							</div>
							<div className="stage-lens-line" />
							<div className="stage-lens-edge" />
							<div className="stage-lens-trace">
								<div className="stage-lens-comet" />
							</div>
						</div>
					</div>
					<div className="stage-lens-read">
						<span />
					</div>
				</div>
			</div>
			{children !== undefined && <div className="stage-over">{children}</div>}
		</div>
	)
}
