import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import {
	ARM,
	type Dock,
	type Grip,
	gripOnLeft,
	gripPoint,
	layoutFor,
	loadSize,
	maxPicture,
	minPicture,
	nearestZone,
	nextSnap,
	parseDock,
	parseSize,
	type Point,
	type Room,
	type SizeChoice,
	sizeFromPointer,
	type Snap,
	snapAt,
	stepSize,
	type Zone
} from "./geometry.ts"

// How the Live page arranges itself: the picture's size and the controls' place (remembered, and dragged:
// the arithmetic is geometry.ts), theater mode, full screen, and the overlay tools that hide themselves while
// you watch.

// ---------- remembered choices ----------

const read = (key: string) => {
	try {
		return localStorage.getItem(key)
	} catch {
		return null
	}
}

const write = (key: string, value: string | null) => {
	try {
		if (value === null) localStorage.removeItem(key)
		else localStorage.setItem(key, value)
	} catch {}
}

/** State kept in localStorage under `key`; `parse` turns the stored text back into a value (null = not stored or unreadable). */
export const useStored = <t>(key: string, fallback: t, parse: (raw: string) => t | null, serialize: (v: t) => string | null = v => JSON.stringify(v)) => {
	const [value, setValue] = useState<t>(() => {
		const raw = read(key)
		return raw === null ? fallback : (parse(raw) ?? fallback)
	})
	const set = useCallback(
		(next: t | ((prev: t) => t)) =>
			setValue(prev => {
				const v = typeof next === "function" ? (next as (p: t) => t)(prev) : next
				write(key, serialize(v))
				return v
			}),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[key]
	)
	return [value, set] as const
}

export const parseBool = (raw: string) => (raw === "true" ? true : raw === "false" ? false : null)

// ---------- sizes ----------

export const useMediaQuery = (query: string) => {
	const [match, setMatch] = useState(() => typeof matchMedia !== "undefined" && matchMedia(query).matches)
	useEffect(() => {
		const mq = matchMedia(query)
		const on = () => setMatch(mq.matches)
		on()
		mq.addEventListener("change", on)
		return () => mq.removeEventListener("change", on)
	}, [query])
	return match
}

/** The element's content-box size, kept current by a ResizeObserver. */
export const useSize = (ref: RefObject<HTMLElement | null>) => {
	const [size, setSize] = useState({ width: 0, height: 0 })
	// measured before the first paint, so the page never draws once at the wrong size
	useLayoutEffect(() => {
		const el = ref.current
		if (!el) return
		setSize({ width: el.clientWidth, height: el.clientHeight })
		const view = el.ownerDocument.defaultView ?? window
		const ro = new view.ResizeObserver(([entry]) => {
			if (!entry) return
			const { width, height } = entry.contentRect
			setSize(s => (Math.round(s.width) === Math.round(width) && Math.round(s.height) === Math.round(height) ? s : { width, height }))
		})
		ro.observe(el)
		return () => ro.disconnect()
	}, [ref])
	return size
}

/** The window's inner height (the Live page sizes its picture to it). */
export const useViewportHeight = () => {
	const [h, setH] = useState(() => window.innerHeight)
	useEffect(() => {
		const on = () => setH(window.innerHeight)
		window.addEventListener("resize", on)
		return () => window.removeEventListener("resize", on)
	}, [])
	return h
}

// ---------- the picture's size and the controls' place ----------

const SIZE_KEY = "look4:live-size"
/** The old splitter's width (a share of the page, or "null"): read once into SIZE_KEY, then removed. */
const OLD_WIDTH_KEY = "look4:live-width"

/** The picture's remembered size (a named size, or a share of the page). */
export const useLiveSize = () => {
	const [initial] = useState(() => {
		const { size, migrated } = loadSize(read(SIZE_KEY), read(OLD_WIDTH_KEY))
		if (migrated) {
			write(SIZE_KEY, JSON.stringify(size))
			write(OLD_WIDTH_KEY, null)
		}
		return size
	})
	return useStored<SizeChoice>(SIZE_KEY, initial, parseSize)
}

/** Where the controls go when there's room: right, left or below the picture. */
export const useLiveDock = () => useStored<Dock>("look4:live-dock", "right", parseDock, v => v)

const GRIP_CURSOR: Record<Grip, string> = { corner: "nwse-resize", "edge-x": "ew-resize", "edge-y": "ns-resize" }

/** What a resize drag shows while it runs; `armed`: letting go now enters theater. */
export type ResizeDrag = { grip: Grip; width: number; snap: Snap | null; armed: boolean }

/** Holds a cursor on the whole page while something is dragged, so it doesn't flicker off the handle. */
const holdCursor = (doc: Document, cursor: string | null) => {
	const html = doc.documentElement
	html.classList.toggle("is-resizing", cursor !== null)
	if (cursor) html.style.setProperty("--resize-cursor", cursor)
	else html.style.removeProperty("--resize-cursor")
}

/**
 * Resizing the picture from its grips: the corner, the side edge (the splitter, when the rail is beside) and
 * the bottom edge. A drag re-lays out the page live and stores the size only when it ends; Ctrl/⌘ turns the
 * snaps off, Esc puts it back, and letting go past the largest size enters theater instead. The corner is
 * also the keyboard's way in: arrows step the size, PageUp/PageDown go snap to snap, Home/End to the ends.
 */
export const usePictureResize = ({
	room,
	picture,
	snaps,
	shellRef,
	onCommit,
	onAuto,
	onTheater
}: {
	room: Room
	/** The picture's width as it is now. */
	picture: number
	snaps: Snap[]
	/** `.lv-shell`: page coordinates start at its top-left. */
	shellRef: RefObject<HTMLElement | null>
	onCommit: (width: number, snap: Snap | null) => void
	onAuto: () => void
	onTheater: () => void
}) => {
	const [drag, setDrag] = useState<ResizeDrag | null>(null)
	const [flash, setFlash] = useState(false)
	const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const latest = useRef({ room, picture, snaps, onCommit, onAuto, onTheater })
	latest.current = { room, picture, snaps, onCommit, onAuto, onTheater }
	const end = useRef<(() => void) | null>(null)
	// a drag in progress when the page goes ends with it (listeners, the page's cursor)
	useEffect(
		() => () => {
			end.current?.()
			clearTimeout(flashTimer.current)
		},
		[]
	)

	const onPointerDown = (grip: Grip) => (e: ReactPointerEvent<HTMLElement>) => {
		const shell = shellRef.current
		if (e.button !== 0 || !shell || end.current) return
		// the grips sit outside the picture, but a Shift-press must never reach Aim
		e.preventDefault()
		e.stopPropagation()
		const handle = e.currentTarget
		const doc = shell.ownerDocument
		const view = doc.defaultView ?? window
		const pointerId = e.pointerId
		const origin = () => {
			const b = shell.getBoundingClientRect()
			return { x: b.left, y: b.top }
		}
		const o = origin()
		const from = latest.current.picture
		const g = gripPoint(latest.current.room, from, grip)
		// where on the handle it was grabbed doesn't matter: the grip point keeps that offset from the pointer
		const offset = { x: e.clientX - o.x - g.x, y: e.clientY - o.y - g.y }
		let last: { x: number; y: number; free: boolean } = { x: e.clientX, y: e.clientY, free: false }
		let state: ResizeDrag | null = null

		const update = () => {
			const { room, snaps } = latest.current
			const o = origin()
			const r = sizeFromPointer(room, grip, { x: last.x - o.x - offset.x, y: last.y - o.y - offset.y }, snaps, last.free, from)
			const onLeft = gripOnLeft(room, layoutFor(room, r.width).place)
			// at (or past) the window's edge the grip can't be pulled any further: that's the theater gesture too
			const atEdge =
				(grip !== "edge-x" && last.y >= view.innerHeight - 4) || (grip !== "edge-y" && (onLeft ? last.x <= 4 : last.x >= view.innerWidth - 4))
			const armed = r.width >= maxPicture(room) - 0.5 && (r.beyond >= ARM || atEdge)
			state = { grip, width: r.width, snap: r.snap, armed }
			setDrag(state)
		}
		const move = (ev: PointerEvent) => {
			if (ev.pointerId !== pointerId) return
			// let go outside the window, where no pointerup arrives
			if (!(ev.buttons & 1)) return up(ev)
			last = { x: ev.clientX, y: ev.clientY, free: ev.ctrlKey || ev.metaKey }
			update()
		}
		const up = (ev: PointerEvent) => {
			if (ev.pointerId !== pointerId) return
			const done = state
			stop()
			// a press without a move (half of a double-click) changes nothing: a named size stays named
			if (!done) return
			if (done.armed) latest.current.onTheater()
			else latest.current.onCommit(done.width, done.snap)
		}
		const cancel = (ev: PointerEvent) => ev.pointerId === pointerId && stop()
		const key = (ev: KeyboardEvent) => {
			if (ev.key === "Escape") {
				// this Esc cancels the drag and does nothing else (not leave theater, not stop aiming)
				ev.preventDefault()
				ev.stopImmediatePropagation()
				stop()
			} else if ((ev.key === "Control" || ev.key === "Meta") && state) {
				last = { ...last, free: ev.type === "keydown" }
				update()
			}
		}
		const stop = () => {
			view.removeEventListener("pointermove", move)
			view.removeEventListener("pointerup", up)
			view.removeEventListener("pointercancel", cancel)
			view.removeEventListener("keydown", key, true)
			view.removeEventListener("keyup", key, true)
			if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId)
			holdCursor(doc, null)
			end.current = null
			setDrag(null)
		}
		// Listening on the window, not the handle: the splitter is replaced by the edge strip when the rail
		// drops below mid-drag, and the drag must carry on regardless.
		handle.setPointerCapture(pointerId)
		view.addEventListener("pointermove", move)
		view.addEventListener("pointerup", up)
		view.addEventListener("pointercancel", cancel)
		view.addEventListener("keydown", key, true)
		view.addEventListener("keyup", key, true)
		const { room, picture } = latest.current
		holdCursor(doc, grip === "corner" && gripOnLeft(room, layoutFor(room, picture).place) ? "nesw-resize" : GRIP_CURSOR[grip])
		end.current = stop
	}

	/** Show the size label for a moment after a key changed the size. */
	const flashLabel = () => {
		setFlash(true)
		clearTimeout(flashTimer.current)
		flashTimer.current = setTimeout(() => setFlash(false), 1000)
	}

	const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
		const { room, picture, snaps } = latest.current
		const onLeft = gripOnLeft(room, layoutFor(room, picture).place)
		const big = e.shiftKey
		let next: { width: number; snap: Snap | null } | null = null
		// the arrows move the grip: down and outward make the picture bigger
		if (e.key === "ArrowDown") next = stepSize(room, picture, 1, big, snaps)
		else if (e.key === "ArrowUp") next = stepSize(room, picture, -1, big, snaps)
		else if (e.key === "ArrowRight") next = stepSize(room, picture, onLeft ? -1 : 1, big, snaps)
		else if (e.key === "ArrowLeft") next = stepSize(room, picture, onLeft ? 1 : -1, big, snaps)
		else if (e.key === "PageUp") next = nextSnap(room, picture, 1, snaps)
		else if (e.key === "PageDown") next = nextSnap(room, picture, -1, snaps)
		else if (e.key === "Home") next = { width: minPicture(room), snap: snapAt(snaps, minPicture(room)) }
		else if (e.key === "End") next = { width: maxPicture(room), snap: snapAt(snaps, maxPicture(room)) }
		else if (e.key !== "Enter") return
		e.preventDefault()
		e.stopPropagation()
		if (next) latest.current.onCommit(next.width, next.snap)
		else latest.current.onAuto()
		flashLabel()
	}

	return {
		drag,
		/** The size label shows: mid-drag, or just after a key. */
		labelShown: !!drag || flash,
		/** For each grip element: drag to resize, double-click for the automatic size. */
		gripProps: (grip: Grip) => ({
			onPointerDown: onPointerDown(grip),
			onDoubleClick: () => latest.current.onAuto()
		}),
		onKeyDown
	}
}

/** A dock drag in progress: the zones (frozen when it started), the one that would take the controls, the pointer. */
export type DockDrag = { zones: Zone[]; active: Dock; at: Point }

/**
 * Dragging the controls by their header to another side. It starts after 4 px of movement, so a click on the
 * header's grip still opens its menu (and a drag swallows that click); Esc cancels. `zones` is asked once
 * per drag, in the coordinates `origin` gives (the shell's top-left on screen).
 */
export const useDockDrag = ({ zones, origin, onDrop }: { zones: () => Zone[]; origin: () => Point; onDrop: (dock: Dock) => void }) => {
	const [drag, setDrag] = useState<DockDrag | null>(null)
	const latest = useRef({ zones, origin, onDrop })
	latest.current = { zones, origin, onDrop }
	const end = useRef<(() => void) | null>(null)
	useEffect(() => () => end.current?.(), [])

	const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
		if (e.button !== 0 || end.current) return
		const handle = e.currentTarget
		const doc = handle.ownerDocument
		const view = doc.defaultView ?? window
		const pointerId = e.pointerId
		const start = { x: e.clientX, y: e.clientY }
		let state: DockDrag | null = null
		let frozen: Zone[] = []

		const move = (ev: PointerEvent) => {
			if (ev.pointerId !== pointerId) return
			if (!(ev.buttons & 1)) return up(ev)
			if (!state) {
				if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return
				frozen = latest.current.zones()
				// nowhere to go (a picture with no room for the controls beside it): no drag at all
				if (!frozen.length) return stop()
				handle.setPointerCapture(pointerId)
				holdCursor(doc, "grabbing")
			}
			const o = latest.current.origin()
			const zone = nearestZone(frozen, { x: ev.clientX - o.x, y: ev.clientY - o.y })
			if (!zone) return
			state = { zones: frozen, active: zone.dock, at: { x: ev.clientX - o.x, y: ev.clientY - o.y } }
			setDrag(state)
		}
		const up = (ev: PointerEvent) => {
			if (ev.pointerId !== pointerId) return
			const done = state
			stop()
			if (done) latest.current.onDrop(done.active)
		}
		const cancel = (ev: PointerEvent) => ev.pointerId === pointerId && stop()
		const key = (ev: KeyboardEvent) => {
			if (ev.key !== "Escape" || !state) return
			ev.preventDefault()
			ev.stopImmediatePropagation()
			stop()
		}
		const stop = () => {
			view.removeEventListener("pointermove", move)
			view.removeEventListener("pointerup", up)
			view.removeEventListener("pointercancel", cancel)
			view.removeEventListener("keydown", key, true)
			if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId)
			if (state) {
				holdCursor(doc, null)
				// the release after a drag must not also click the grip (and open its menu)
				const swallow = (ev: MouseEvent) => {
					ev.preventDefault()
					ev.stopPropagation()
				}
				view.addEventListener("click", swallow, { capture: true, once: true })
				setTimeout(() => view.removeEventListener("click", swallow, true), 0)
			}
			state = null
			end.current = null
			setDrag(null)
		}
		view.addEventListener("pointermove", move)
		view.addEventListener("pointerup", up)
		view.addEventListener("pointercancel", cancel)
		view.addEventListener("keydown", key, true)
		end.current = stop
	}

	return { drag, onPointerDown }
}

// ---------- theater and full screen ----------

/** Theater mode: the picture fills the browser window (not the screen). Remembered; while on, `html.is-theater` hides the app around it. */
export const useTheater = (active: boolean) => {
	const [on, setOn] = useStored("look4:live-theater", false, parseBool)
	// before paint and before the page measures where it starts: leaving theater brings the top bar back, and
	// measured while it was still hidden the picture would be sized for a taller window than it has
	useLayoutEffect(() => {
		const html = document.documentElement
		html.classList.toggle("is-theater", on && active)
		return () => html.classList.remove("is-theater")
	}, [on, active])
	return [on, setOn] as const
}

/** The Fullscreen API on one element; `supported` is false where only a <video> can go full screen (iPhone). */
export const useFullscreen = (ref: RefObject<HTMLElement | null>) => {
	const [on, setOn] = useState(false)
	useEffect(() => {
		const sync = () => setOn(!!document.fullscreenElement && document.fullscreenElement === ref.current)
		document.addEventListener("fullscreenchange", sync)
		return () => document.removeEventListener("fullscreenchange", sync)
	}, [ref])
	const supported = typeof document !== "undefined" && !!document.fullscreenEnabled
	const toggle = useCallback(() => {
		const el = ref.current
		if (!el) return
		if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
		else void el.requestFullscreen?.({ navigationUI: "hide" }).catch(() => {})
	}, [ref])
	return { on, supported, toggle }
}

/**
 * Overlay tools that get out of the way: shown on any pointer move, touch, focus or key, hidden after
 * `ms` of nothing, but never while the pointer is over them or something inside them has focus or is open.
 */
export const useIdle = (ref: RefObject<HTMLElement | null>, enabled: boolean, ms = 2500, stay?: () => boolean) => {
	const [shown, setShown] = useState(true)
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const hold = useRef(false)
	const stayRef = useRef(stay)
	stayRef.current = stay
	const poke = useCallback(() => {
		setShown(true)
		clearTimeout(timer.current)
		timer.current = setTimeout(() => {
			if (hold.current || stayRef.current?.()) poke()
			else setShown(false)
		}, ms)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ms])
	useEffect(() => {
		if (!enabled) {
			clearTimeout(timer.current)
			setShown(true)
			return
		}
		const el = ref.current
		const view = el?.ownerDocument.defaultView ?? window
		poke()
		const onKey = () => poke()
		view.addEventListener("keydown", onKey)
		el?.addEventListener("pointermove", poke)
		el?.addEventListener("pointerdown", poke)
		el?.addEventListener("focusin", poke)
		return () => {
			clearTimeout(timer.current)
			view.removeEventListener("keydown", onKey)
			el?.removeEventListener("pointermove", poke)
			el?.removeEventListener("pointerdown", poke)
			el?.removeEventListener("focusin", poke)
		}
	}, [enabled, ref, poke])
	/** Keep the tools up while `on` (pointer over them, a menu open); hiding resumes `ms` after it ends. */
	const keep = useCallback(
		(on: boolean) => {
			hold.current = on
			if (on) {
				clearTimeout(timer.current)
				setShown(true)
			} else poke()
		},
		[poke]
	)
	return { shown: shown || !enabled, poke, keep }
}

// ---------- small things ----------

/** Seconds as m:ss. */
export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`
