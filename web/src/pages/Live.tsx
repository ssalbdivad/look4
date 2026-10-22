import { type CSSProperties, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { LiveSourceDto, LiveStream } from "../../../src/api-types.ts"
import { api, errorMessage, liveUrl } from "../api.ts"
import { Icon } from "../components/Icon.tsx"
import type { PlayerState } from "../components/LivePlayer.tsx"
import { LiveStage, type StageBox, type StageHandle, type WheelMode } from "../components/LiveStage.tsx"
import { EmptyState, LoadError, Skeleton } from "../components/ui.tsx"
import { useFeedback } from "../feedback.tsx"
import { humanize } from "../format.ts"
import { useDocumentTitle, useLatest, useResource } from "../hooks.ts"
import { isPageKey, useShortcut, useShortcutsSheet, useShortcutWindow } from "../keyboard.tsx"
import { AwayDialog } from "../live/AwayDialog.tsx"
import { type Notice, StageChips, StageOverlay } from "../live/Chips.tsx"
import {
	AUTO,
	BAR_H,
	canSide,
	choiceFor,
	choiceSnap,
	type Dock,
	dropZones,
	gripOnLeft,
	layoutFor,
	maxPicture,
	minPicture,
	overlayZones,
	PIC_MIN,
	type Point,
	type Room,
	SNAP_LABELS,
	snapAt,
	snapTargets,
	widthOf
} from "../live/geometry.ts"
import {
	parseBool,
	useDockDrag,
	useFullscreen,
	useIdle,
	useLiveDock,
	useLiveSize,
	useMediaQuery,
	usePictureResize,
	useSize,
	useStored,
	useTheater,
	useViewportHeight
} from "../live/layout.ts"
import { Menu, MenuItem, type MoreExtra, MoreMenu, StreamInfoDialog, useKeyOf } from "../live/MoreMenu.tsx"
import { Dpad, holdProps } from "../live/Move.tsx"
import { ControlsRail, railSections } from "../live/Rail.tsx"
import { type BadgeKind, Toolbar, type ToolbarProps } from "../live/Toolbar.tsx"
import { type Camera, useCamera } from "../live/useCamera.ts"
import { Link, navigate, useLocation } from "../router.tsx"
import { NeedsPasswordHelp, RtspOffHelp, usePortWatch } from "../setup/CameraHelp.tsx"

// Watch a camera live: the picture as big as the window allows, the camera's controls beside or under it,
// theater and full screen, and a pop-out that stays on top (Document Picture-in-Picture where the browser
// has it, a small window of its own elsewhere).

// ---------- which stream ----------

/** The last Sharp / Quick the user picked, per browser. */
const STREAM_KEY = "look4:live-stream"
/** localStorage, for what should outlast the session. */
const stored = {
	get: (k: string) => {
		try {
			return localStorage.getItem(k)
		} catch {
			return null
		}
	},
	set: (k: string, v: string) => {
		try {
			localStorage.setItem(k, v)
		} catch {}
	}
}

const parseStream = (raw: string | null): LiveStream | null => (raw === "main" || raw === "sub" ? raw : null)

/** What the wheel zooms first, per browser (⋯ More): the camera's lens unless the picture was picked. */
const WHEEL_KEY = "look4:live-wheel"
const parseWheel = (raw: string | null): WheelMode => (raw === "picture" ? "picture" : "camera")

/** This browser plays the camera's 4K HEVC as is, so Sharp costs the server nothing. */
const hevcPlays = () => {
	const MS = (globalThis as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource ?? globalThis.MediaSource
	return !!MS?.isTypeSupported?.('video/mp4; codecs="hvc1.1.6.L150"')
}

/** Sharp whenever the camera has it, unless the server can't transcode it and this browser can't play it as is. */
const openingStream = (src: LiveSourceDto): LiveStream =>
	src.streams.includes("main") && (src.defaultStream === "main" || hevcPlays()) ? "main" : src.defaultStream

const streamFor = (src: LiveSourceDto, want: LiveStream | null): LiveStream => (want && src.streams.includes(want) ? want : openingStream(src))

/** The pop-out window (where Document Picture-in-Picture isn't available): only the picture and a few tools. */
export const popoutUrl = (source: string, stream: LiveStream) => `/live?source=${encodeURIComponent(source)}&stream=${stream}&popout=1`

const openPopoutWindow = (source: string, stream: LiveStream) => {
	// one window per camera: clicking again brings the existing one forward
	const w = window.open(popoutUrl(source, stream), `look4-live-${source}`, "popup=yes,width=480,height=270")
	w?.focus()
	return w !== null
}

// ---------- snapshot and record ----------

/** Downloads a still: the camera's own full-resolution picture when it has one, else a frame of the stream. */
const useSnapshot = (source: string, stream: LiveStream, notify: Notify) => {
	const [busy, setBusy] = useState(false)
	const take = async () => {
		if (busy) return
		setBusy(true)
		try {
			const res = await fetch(liveUrl(source, "snapshot", stream, "&download=1"))
			if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`)
			const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `look4-${source}.jpg`
			const url = URL.createObjectURL(await res.blob())
			const a = document.createElement("a")
			a.href = url
			a.download = name
			document.body.append(a)
			a.click()
			a.remove()
			setTimeout(() => URL.revokeObjectURL(url), 10_000)
			notify(`Snapshot saved as ${name}`, { tone: "good" })
		} catch (e) {
			notify(`Couldn't take a snapshot: ${errorMessage(e)}`, { tone: "bad" })
		} finally {
			setBusy(false)
		}
	}
	return { take, busy }
}

type Rec = { phase: "starting"; name: string } | { phase: "on"; name: string; id: string; since: number; max: number } | { phase: "saving"; name: string }

/**
 * Record: press to start (the clip also keeps the seconds before the press), press again to stop and save it
 * as a kept look4 clip. It stops by itself at the server's limit, and leaving the page saves what's there.
 */
const useRecord = (source: string, notify: Notify) => {
	const [rec, setRec] = useState<Rec | null>(null)
	const [now, setNow] = useState(() => Date.now())
	const latest = useLatest(rec)

	const stop = useCallback(
		async (name: string, id: string) => {
			setRec({ phase: "saving", name })
			try {
				const { clipId } = await api.record(name, { op: "stop", id })
				notify("Clip saved", { tone: "good", action: { label: "Open", run: () => navigate(`/clips/${encodeURIComponent(clipId)}`) } })
			} catch (e) {
				notify(`Couldn't save the recording: ${errorMessage(e)}`, { tone: "bad" })
			} finally {
				setRec(r => (r?.name === name && r.phase === "saving" ? null : r))
			}
		},
		[notify]
	)
	const stopRef = useLatest(stop)

	const start = async () => {
		setRec({ phase: "starting", name: source })
		try {
			const r = await api.record(source, { op: "start" })
			setRec({ phase: "on", name: source, id: r.id, since: Date.now(), max: r.maxSeconds })
		} catch (e) {
			setRec(null)
			notify(`Couldn't start recording: ${errorMessage(e)}`, { tone: "bad" })
		}
	}

	useEffect(() => {
		if (rec?.phase !== "on") return
		const tick = setInterval(() => setNow(Date.now()), 500)
		// the server's limit: stop and save from here, so the clip still ends up on the page's toast
		const cap = setTimeout(() => void stopRef.current(rec.name, rec.id), Math.max(0, rec.since + rec.max * 1000 - Date.now()))
		return () => {
			clearInterval(tick)
			clearTimeout(cap)
		}
	}, [rec, stopRef])

	// leaving the page or switching camera mid-recording saves it rather than losing it
	useEffect(
		() => () => {
			const r = latest.current
			if (r?.phase === "on" && r.name === source) void stopRef.current(r.name, r.id)
		},
		[source, latest, stopRef]
	)
	// Closing the tab or the pop-out runs no React cleanup: without this the server would record on to its
	// limit and keep minutes nobody asked for. `keepalive` lets the request outlive the page.
	useEffect(() => {
		if (rec?.phase !== "on") return
		const { name, id } = rec
		const onHide = () => {
			void fetch(`/api/live/${encodeURIComponent(name)}/record`, {
				method: "POST",
				keepalive: true,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ op: "stop", id })
			}).catch(() => {})
			// a page kept for Back (the bfcache) comes back with nothing recording
			setRec(null)
		}
		window.addEventListener("pagehide", onHide)
		return () => window.removeEventListener("pagehide", onHide)
	}, [rec])

	return {
		rec: rec && rec.name === source ? rec : null,
		seconds: rec?.phase === "on" ? Math.max(0, (now - rec.since) / 1000) : 0,
		toggle: () => {
			const r = latest.current
			if (!r) void start()
			else if (r.phase === "on") void stop(r.name, r.id)
		}
	}
}

// ---------- the view's state, shared by the page and the pop-outs ----------

type Notify = (text: string, opts?: { tone?: Notice["tone"]; action?: Notice["action"] }) => void

let noticeIds = 0

/**
 * Everything about watching one camera that the page, the Picture-in-Picture window and the pop-out window
 * have in common: the stream and its fallbacks, sound, magnification, Aim, snapshot and record.
 */
const useLiveView = (src: LiveSourceDto, camera: Camera, { initialStream, toasts }: { initialStream: LiveStream | null; toasts: boolean }) => {
	const { toast } = useFeedback()
	const stageRef = useRef<StageHandle>(null)
	// saving a view saves the picture's magnification with it; going to one brings it back
	camera.picture.current = {
		digital: () => stageRef.current?.digital() ?? null,
		setDigital: v => stageRef.current?.setDigital(v)
	}

	// a message for the toasts and, where those can't be seen (full screen, pop-outs), for a chip on the picture
	const [notice, setNotice] = useState<Notice | null>(null)
	const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const notify = useCallback<Notify>(
		(text, opts = {}) => {
			if (toasts) toast(text, opts)
			const id = ++noticeIds
			setNotice({ id, text, tone: opts.tone ?? "info", action: opts.action && { ...opts.action, run: () => (setNotice(null), opts.action!.run()) } })
			clearTimeout(noticeTimer.current)
			noticeTimer.current = setTimeout(() => setNotice(n => (n?.id === id ? null : n)), opts.action ? 7000 : 4500)
		},
		[toast, toasts]
	)
	useEffect(() => () => clearTimeout(noticeTimer.current), [])

	// ---- stream: the URL's (once), else the remembered pick, else Sharp. Never switched automatically: a
	// stalling Sharp looked the same from here whether the link was slow or the camera or server hiccuped,
	// so the old drop to Quick fired on fast connections too.
	const [choice, setChoice] = useStored<LiveStream | null>(STREAM_KEY, null, parseStream, v => v)
	const [override, setOverride] = useState(initialStream)
	const stream = streamFor(src, override ?? choice)
	const pick = useCallback(
		(s: LiveStream) => {
			setOverride(null)
			setChoice(s)
		},
		[setChoice]
	)

	const [state, setState] = useState<PlayerState>({ phase: "connecting" })
	const [switching, setSwitching] = useState<LiveStream | null>(null)
	const [attempt, setAttempt] = useState(0)

	// ---- sound: starts muted (the browser's rule); "on" is remembered and applied at the first click or key
	const [soundOn, setSoundOn] = useStored("look4:live-sound", false, parseBool)
	const [gestured, setGestured] = useState(() => !!(navigator as { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive)
	useEffect(() => {
		if (gestured) return
		const on = () => setGestured(true)
		window.addEventListener("pointerdown", on, true)
		window.addEventListener("keydown", on, true)
		return () => {
			window.removeEventListener("pointerdown", on, true)
			window.removeEventListener("keydown", on, true)
		}
	}, [gestured])
	const muted = !(soundOn && gestured)
	const toggleSound = () => {
		if (muted) {
			setGestured(true)
			setSoundOn(true)
		} else setSoundOn(false)
	}
	const mic = camera.controls?.microphone ?? null
	// Whether to ask for the sound track. A camera look4 can't ask is tried; one whose microphone is off has
	// nothing to send. The answer arrives after the stream has started, and changing it reconnects, so start
	// from what this camera said last time.
	const micKey = `look4:live-mic:${src.name}`
	const micKnown = camera.controls ? camera.controls.microphone === true : null
	useEffect(() => {
		if (micKnown !== null) stored.set(micKey, String(micKnown))
	}, [micKey, micKnown])
	const audio = src.controllable ? (micKnown ?? stored.get(micKey) === "true") : true
	const hasTrack = state.phase === "playing" && !!state.codec && /mp4a/.test(state.codec)
	const soundShown = src.feed === "stream" && (src.controllable ? mic !== null : hasTrack)

	// ---- what the wheel zooms first; the pop-out window, an app of its own, reads the same key when it opens
	const [wheel, setWheelMode] = useState(() => parseWheel(stored.get(WHEEL_KEY)))
	const setWheel = (mode: WheelMode) => {
		stored.set(WHEEL_KEY, mode)
		setWheelMode(mode)
	}

	// ---- the rest
	const [zoom, setZoom] = useState(1)
	const [aim, setAim] = useState(false)
	const canFrame = !!camera.controls?.ptz?.box
	const snap = useSnapshot(src.name, stream, notify)
	const record = useRecord(src.name, notify)
	const settings = useResource(s => api.settings(s), [])
	const roi = settings.data?.roi ?? null
	const [zoneOn, setZoneOn] = useState(false)

	useEffect(() => {
		setAim(false)
		setSwitching(null)
	}, [src.name])
	useEffect(() => {
		if (!canFrame) setAim(false)
	}, [canFrame])

	const frame = async (box: StageBox) => {
		setAim(false)
		await camera.frame(box)
	}
	const zoomCameraHere = async () => {
		const stage = stageRef.current
		if (!stage) return
		// a camera that frames a box but doesn't say how far its lens goes: frame the view and start again at 1×
		if (!camera.optical) {
			if (await camera.frame(stage.viewport())) stage.resetZoom()
			return
		}
		if ((await stage.toLens()) === "full") notify("The camera is zoomed in as far as it goes.")
	}

	// a fresh still to show until the first frame; `fast` takes what a running session already has
	const posterT = useMemo(() => Date.now(), [src.name])
	const poster = src.feed ? liveUrl(src.name, "snapshot", stream, `&fast=1&t=${posterT}`) : null

	const atHome = camera.state?.atHome
	return {
		stageRef,
		stream,
		pick,
		state,
		switching,
		notice,
		notify,
		muted,
		toggleSound,
		soundShown,
		mic,
		zoom,
		wheel,
		setWheel,
		aim,
		setAim,
		canFrame,
		snap,
		record,
		roi,
		zoneOn,
		setZoneOn,
		retry: () => setAttempt(n => n + 1),
		stageProps: {
			source: src.name,
			stream,
			stills: src.feed === "stills",
			attempt,
			audio,
			muted,
			aim,
			onAim: canFrame ? frame : undefined,
			onState: setState,
			onZoom: (z: number) => setZoom(z),
			optical: camera.optical,
			wheel,
			onSwitch: setSwitching,
			onSoundBlocked: () => setGestured(false),
			zone: zoneOn ? roi : null,
			poster
		},
		chips: {
			moved: atHome === false && !!camera.controls?.ptz?.guard?.set,
			returnAfterS: camera.controls?.ptz?.guard?.autoReturn ? camera.controls.ptz.guard.timeoutS : null,
			moving: camera.moving && camera.view === "home",
			onHome: () => void camera.home(),
			zoom,
			onResetZoom: () => stageRef.current?.resetZoom(),
			onZoomCamera: canFrame ? () => void zoomCameraHere() : null,
			rec: record.rec ? { phase: record.rec.phase, seconds: record.seconds } : null,
			switching,
			aiming: aim,
			onStopAim: () => setAim(false)
		}
	}
}

type LiveView = ReturnType<typeof useLiveView>

const badgeOf = (src: LiveSourceDto, state: PlayerState): BadgeKind | null =>
	!src.feed ? null : src.feed === "stills" ? "stills" : state.phase !== "playing" ? "waiting" : state.via === "pictures" ? "pictures" : "live"

/** The `view.*` keys that make sense in every window. */
const usePictureShortcuts = (src: LiveSourceDto, lv: LiveView) => {
	// with the camera's microphone off there is nothing to unmute, and flipping the setting would show nothing
	const mute = () => (lv.mic === false ? lv.notify("The camera's microphone is off. Switch it on from the sound button.") : lv.toggleSound())
	useShortcut("view.mute", mute, lv.soundShown)
	useShortcut("view.quality", () => lv.pick(lv.stream === "main" ? "sub" : "main"), src.streams.length > 1 && src.feed === "stream")
	useShortcut("view.snapshot", () => void lv.snap.take(), !!src.feed)
	useShortcut("view.record", lv.record.toggle, src.recording)
	useShortcut("view.zone", () => lv.setZoneOn(z => !z), !!lv.roi && !!src.feed)
	useShortcut("view.zoomIn", () => lv.stageRef.current?.zoomBy(1.25), !!src.feed)
	useShortcut("view.zoomOut", () => lv.stageRef.current?.zoomBy(0.8), !!src.feed)
	useShortcut("view.zoomReset", () => lv.stageRef.current?.resetZoom(), !!src.feed)
}

// ---------- Picture-in-Picture ----------

type DocumentPip = { requestWindow: (o: { width: number; height: number }) => Promise<Window> }
const documentPip = () => (window as { documentPictureInPicture?: DocumentPip }).documentPictureInPicture ?? null

/** The app's styles, into another window: rules copied where readable, linked where not. */
const copyStyles = (doc: Document) => {
	const base = doc.createElement("base")
	base.href = location.href
	doc.head.append(base)
	for (const sheet of [...document.styleSheets]) {
		try {
			const style = doc.createElement("style")
			style.textContent = [...sheet.cssRules].map(r => r.cssText).join("\n")
			doc.head.append(style)
		} catch {
			if (!sheet.href) continue
			const link = doc.createElement("link")
			link.rel = "stylesheet"
			link.href = sheet.href
			doc.head.append(link)
		}
	}
	// the fonts this page already loaded, so the window doesn't fetch (or wait for) them again
	for (const face of document.fonts)
		try {
			doc.fonts.add(face)
		} catch {}
}

/** An always-on-top window the page renders the picture into (Chrome and Edge on desktop). */
const usePip = () => {
	const [win, setWin] = useState<Window | null>(null)
	const supported = !!documentPip()
	const open = async (title: string) => {
		const pip = documentPip()
		if (!pip) return false
		const w = await pip.requestWindow({ width: 480, height: 270 })
		copyStyles(w.document)
		w.document.title = title
		w.document.documentElement.classList.add("is-pip")
		w.addEventListener("pagehide", () => setWin(cur => (cur === w ? null : cur)), { once: true })
		setWin(w)
		return true
	}
	useEffect(() => () => win?.close(), [win])
	return { win, supported, open, close: () => win?.close() }
}

// ---------- the page ----------

export const LivePage = () => {
	useDocumentTitle("Live")
	const { query } = useLocation()
	const list = useResource(s => api.live(s), [])
	const sources = list.data ?? []
	const asked = query.get("source")
	const src = sources.find(s => s.name === asked || (!!asked && s.aliases.includes(asked))) ?? sources[0]
	const [initialStream] = useState(() => parseStream(query.get("stream")))

	// scopes the full-bleed layout (and the quieter top bar) to this page
	useEffect(() => {
		document.documentElement.classList.add("on-live")
		return () => document.documentElement.classList.remove("on-live")
	}, [])

	if (list.error && !list.data) return <LoadError message={list.error} status={list.errorStatus} onRetry={list.reload} what="your cameras" />
	if (!list.data)
		return (
			<div className="lv">
				<h1 className="sr-only" tabIndex={-1} data-page-title>
					Live
				</h1>
				<Skeleton className="lv-skeleton" />
			</div>
		)
	if (!src)
		return (
			<div className="lv lv-empty">
				<h1 className="sr-only" tabIndex={-1} data-page-title>
					Live
				</h1>
				<EmptyState
					title="No camera to watch yet"
					mascot="looking"
					actions={
						<Link to="/setup?step=source" className="btn btn-primary">
							<Icon name="camera" size={18} />
							Connect a camera
						</Link>
					}
				>
					<p>Connect a Reolink or any network camera (RTSP) and it shows up here live. Folders of videos have no live view.</p>
				</EmptyState>
			</div>
		)
	return <LiveScreen sources={sources} src={src} initialStream={initialStream} onReload={list.reload} />
}

/** The breathing room below the picture's card (the toolbar's height, BAR_H, is geometry.ts's). */
const BOTTOM_GAP = 16

const LiveScreen = ({
	sources,
	src,
	initialStream,
	onReload
}: {
	sources: LiveSourceDto[]
	src: LiveSourceDto
	initialStream: LiveStream | null
	onReload: () => void
}) => {
	const steerable = src.controllable && src.problem !== "login-refused"
	// camera failures go where the page's own messages go: a toast, and the chip on the picture in full
	// screen and the PiP, where a toast can't be seen (called later, once `lv` exists)
	const camera = useCamera(src.name, steerable, message => lv.notify(message, { tone: "bad" }))
	const pip = usePip()
	// the stage: the full-screen element, and where the overlay tools watch for movement
	const shellRef = useRef<HTMLDivElement>(null)
	const fs = useFullscreen(shellRef)
	const lv = useLiveView(src, camera, { initialStream, toasts: true })
	const sheet = useShortcutsSheet()
	const { toast } = useFeedback()
	useShortcutWindow(pip.win)

	const phone = useMediaQuery("(max-width: 720px)")
	// a phone on its side; never a short desktop window, which would lose the app's navigation with no way back
	const flatPhone = useMediaQuery("(orientation: landscape) and (max-height: 500px) and (pointer: coarse)")
	const coarse = useMediaQuery("(pointer: coarse)")
	const [theater, setTheater] = useTheater(!!src.feed)
	const immersive = !!src.feed && (theater || fs.on || flatPhone)

	// ---- the rail
	const has = railSections(camera.controls)
	const railExists = steerable && (camera.controls ? has.views || has.move || has.home || has.lights : true)
	const [railHidden, setRailHidden] = useStored("look4:live-rail-hidden", false, parseBool)
	const [overlayRail, setOverlayRail] = useState(false)
	const toggleRail = () => (immersive ? setOverlayRail(v => !v) : setRailHidden(v => !v))

	// ---- problems with the camera (walkthroughs beside the picture)
	const rtspOff = src.problem === "rtsp-off" && !!src.host
	const watch = usePortWatch(src.host ?? "", rtspOff, p => p.rtsp)
	const reloadRef = useLatest(onReload)
	useEffect(() => {
		// RTSP switched on in the Reolink app while this page is open: pick it up without a reload
		if (rtspOff && watch.ports?.rtsp) {
			reloadRef.current()
			lv.retry()
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [watch.ports?.rtsp])
	const problems = (rtspOff || src.problem === "needs-password" || src.problem === "login-refused" || src.problem === "no-address") && (
		<div className="lv-problems">
			{rtspOff && (
				<RtspOffHelp
					host={src.host!}
					cameraName={humanize(src.name)}
					ports={watch.ports ?? undefined}
					collapsed
					checking={watch.checking}
					nextCheckIn={watch.nextCheckIn}
					checks={watch.checks}
					onCheck={watch.check}
				/>
			)}
			{src.problem === "needs-password" && (
				<NeedsPasswordHelp>
					<Link to="/settings" className="btn btn-ghost btn-sm">
						<Icon name="gear" size={16} />
						Open Settings
					</Link>
				</NeedsPasswordHelp>
			)}
			{(src.problem === "login-refused" || src.problem === "no-address") && (
				<div className="note note-bad" role="alert">
					<Icon name="alert" size={18} />
					<span>{src.detail}</span>
					<Link to="/settings" className="btn btn-ghost btn-sm">
						Fix it
					</Link>
				</div>
			)}
		</div>
	)
	const asideShown = !!problems || (railExists && !railHidden)

	// ---- size: one picture width (a named size, or a share of the page) under the top bar, the controls
	// beside it while they fit on the side they're docked to, else under it
	const pageRef = useRef<HTMLDivElement>(null)
	const { width } = useSize(pageRef)
	const vh = useViewportHeight()
	const [top, setTop] = useState(0)
	useLayoutEffect(() => {
		const el = pageRef.current
		if (!el) return
		// offsets, not the bounding box: the page's arrival animation moves it 10 px while this first runs
		let y = 0
		for (let e: HTMLElement | null = el; e; e = e.offsetParent as HTMLElement | null) y += e.offsetTop
		setTop(y)
	}, [width, vh, immersive])
	const [size, setSize] = useLiveSize()
	const [dock, setDock] = useLiveDock()
	// The toolbar's narrowest (the narrow bar's tools side by side): the picture is never narrower, or the
	// tools would spill out of the card over the controls. Measured from the page's bar after each render.
	const [barMin, setBarMin] = useState(PIC_MIN)
	useLayoutEffect(() => {
		const bar = shellRef.current?.querySelector<HTMLElement>(".lv-main > .lv-bar")
		if (!bar) return
		const view = bar.ownerDocument.defaultView ?? window
		const px = (v: string) => parseFloat(v) || 0
		const cs = view.getComputedStyle(bar)
		let w = px(cs.paddingLeft) + px(cs.paddingRight) + 2 // and the card's border
		let n = 0
		for (const el of bar.children as HTMLCollectionOf<HTMLElement>) {
			// the full bar's extras go into More on the narrow one
			if (el.hasAttribute("data-wide")) continue
			w += el.classList.contains("lv-bar-gap") ? px(view.getComputedStyle(el).minWidth) : el.offsetWidth
			n++
		}
		const next = Math.ceil(w + px(cs.columnGap) * Math.max(0, n - 1))
		if (Math.abs(next - barMin) > 1) setBarMin(next)
	})
	const room: Room = { width, height: vh - top - BAR_H - BOTTOM_GAP, aside: asideShown, dock, min: barMin }
	// "Actual pixels": one stream pixel per screen pixel
	const native = lv.state.phase === "playing" && lv.state.width > 0 ? lv.state.width / (window.devicePixelRatio || 1) : null
	const snaps = snapTargets(room, native)
	const storedWidth = widthOf(room, size)
	const resize = usePictureResize({
		room,
		picture: storedWidth,
		snaps,
		shellRef,
		onCommit: (w, snap) => setSize(choiceFor(room, w, snap?.id ?? null)),
		onAuto: () => setSize(AUTO),
		// the drag's start size stays: theater is a mode, not a size
		onTheater: () => setTheater(true)
	})
	const plan = layoutFor(room, resize.drag?.width ?? storedWidth)
	const railMode = immersive ? "overlay" : phone ? "tabs" : plan.place === "side" ? "side" : "below"
	const gripLeft = gripOnLeft(room, plan.place)
	const grips = !immersive && !phone

	// ---- moving the controls: drop them right, left or below (left or right over the picture in theater)
	/** Right or left only while a side layout fits there (the automatic size, if the current one leaves no room). */
	const fitsBeside = (d: Dock) => layoutFor({ ...room, dock: d }, widthOf({ ...room, dock: d }, AUTO)).place === "side"
	const putDock = (d: Dock) => {
		if (immersive) {
			// over the picture there is no "below": right is where a below dock's panel already is
			if (d === "right" && dock === "below") return
			return setDock(d)
		}
		setDock(d)
		const there = { ...room, dock: d }
		if (canSide(there) && layoutFor(there, widthOf(there, size)).place !== "side" && fitsBeside(d)) setSize(AUTO)
	}
	/** The visible window in the shell's coordinates, less the sticky top bar (nothing is drawn under it). */
	const shellView = () => {
		const b = shellRef.current?.getBoundingClientRect()
		const bar = document.querySelector(".topbar")?.getBoundingClientRect()
		const y = immersive || !bar ? 0 : Math.max(0, bar.bottom)
		return { x: -(b?.left ?? 0), y: y - (b?.top ?? 0), w: window.innerWidth, h: window.innerHeight - y }
	}
	const origin = () => {
		const b = shellRef.current?.getBoundingClientRect()
		return { x: b?.left ?? 0, y: b?.top ?? 0 }
	}
	const zonesNow = () => {
		const shell = shellRef.current
		if (!shell) return []
		if (immersive) return overlayZones(shell.clientWidth, shell.clientHeight)
		return dropZones(room, size, shellView())
	}
	const dockDrag = useDockDrag({ origin, zones: zonesNow, onDrop: putDock })
	// the picture dragged by its toolbar's empty space: to the left or right, the controls going to the other side
	const pictureDrag = useDockDrag({
		origin,
		zones: () => zonesNow().filter(z => z.dock !== "below"),
		onDrop: d => putDock(d === "left" ? "right" : "left")
	})
	const resetLayout = () => {
		setDock("right")
		setSize(AUTO)
		setRailHidden(false)
	}

	// ---- overlay tools (theater, full screen): shown on movement, gone after a few idle seconds
	const idle = useIdle(shellRef, immersive && !lv.aim, 2500, () => !!shellRef.current?.querySelector(".lv-menu, .lv-popover, .lv-bar :focus-visible"))

	// ---- actions
	const toggleTheater = () => {
		if (fs.on) fs.toggle()
		setTheater(t => !t)
	}
	// where only a <video> may go full screen (iPhone), theater is the nearest thing
	const toggleFullscreen = () => (fs.supported ? fs.toggle() : setTheater(t => !t))
	const togglePopout = async () => {
		if (pip.win) return pip.close()
		if (fs.on) fs.toggle()
		if (pip.supported) {
			try {
				if (await pip.open(`${humanize(src.name)} · live`)) return
			} catch {
				// no gesture left, or the browser said no: the plain window still works
			}
		}
		if (!openPopoutWindow(src.name, lv.stream)) toast("Your browser blocked the pop-out window. Allow pop-ups for look4 and try again.", { tone: "bad" })
	}
	const pickCamera = (name: string) => navigate(`/live?source=${encodeURIComponent(name)}`, { replace: true })
	const nextCamera = () => {
		const i = sources.findIndex(s => s.name === src.name)
		pickCamera(sources[(i + 1) % sources.length]!.name)
	}
	const toggleAim = () => lv.setAim(a => !a)

	usePictureShortcuts(src, lv)
	useShortcut("view.theater", toggleTheater, !!src.feed)
	useShortcut("view.fullscreen", toggleFullscreen, !!src.feed)
	useShortcut("view.popout", () => void togglePopout(), !!src.feed && !coarse)
	useShortcut("view.controls", toggleRail, railExists)
	useShortcut("view.nextCamera", nextCamera, sources.length > 1)

	// Esc: stop aiming first, then leave theater (the browser itself takes Esc out of full screen)
	const escRef = useLatest(() => {
		if (lv.aim) lv.setAim(false)
		else if (theater && !fs.on) setTheater(false)
		else return false
		return true
	})
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape" && isPageKey(e) && escRef.current()) e.preventDefault()
		}
		const wins = [window, pip.win].filter((w): w is Window => !!w)
		for (const w of wins) w.addEventListener("keydown", onKey)
		return () => {
			for (const w of wins) w.removeEventListener("keydown", onKey)
		}
	}, [escRef, pip.win])

	// ---- dialogs from the More menu
	const [info, setInfo] = useState(false)
	const [away, setAway] = useState(false)

	// The full bar's width, from what it holds: 38 px buttons 4 px apart, the badge, Sharp|Quick and the
	// picker (its name runs ~8 px a character, capped at 16ch), plus padding and a little gap. A fixed
	// breakpoint was right for one camera and pushed More off the bar with two.
	const railButton = railExists && (immersive || !phone || railHidden)
	const tools = [lv.canFrame, !!src.feed, src.recording, src.feed && !coarse, src.feed && !flatPhone, !!src.feed, railButton, true].filter(Boolean).length
	const fullBar =
		36 +
		66 +
		(lv.soundShown ? 42 : 0) +
		(src.streams.length > 1 && src.feed === "stream" ? 136 : 0) +
		(sources.length > 1 ? 74 + 8 * Math.min(16, humanize(src.name).length) : 0) +
		42 * tools
	const compact = phone || (immersive ? width : plan.picture) < Math.max(640, fullBar)
	const extras: MoreExtra[] = []
	if (compact && lv.canFrame) extras.push({ icon: "aim", label: "Aim the camera", action: "cam.aim", checked: lv.aim, run: toggleAim })
	if (compact && !coarse && src.feed) extras.push({ icon: "pip", label: "Pop out", action: "view.popout", run: () => void togglePopout() })
	if (compact && src.feed) extras.push({ icon: "theater", label: "Theater mode", action: "view.theater", checked: theater, run: toggleTheater })
	// a phone's toolbar has no room for the camera picker beside Record and Full screen, which it pushed off screen
	if (phone && sources.length > 1)
		for (const s of sources) extras.push({ icon: "camera", label: humanize(s.name), checked: s.name === src.name, run: () => pickCamera(s.name) })
	if (grips) {
		extras.push({ icon: "expand", label: "Fit to window", checked: choiceSnap(size) === "fit", run: () => setSize({ snap: "fit" }) })
		extras.push({ icon: "sparkle", label: "Automatic size", checked: choiceSnap(size) === "auto", run: () => setSize(AUTO) })
	}

	const theaterKey = useKeyOf("view.theater")
	const toolbar = (variant: ToolbarProps["variant"], hidden?: boolean) => (
		<Toolbar
			variant={variant}
			hidden={hidden}
			onHover={over => idle.keep(over)}
			onEmptyDoubleClick={variant === "bar" && src.feed ? toggleTheater : undefined}
			onEmptyPointerDown={variant === "bar" && grips ? pictureDrag.onPointerDown : undefined}
			badge={phone && !immersive ? null : badgeOf(src, lv.state)}
			sound={lv.soundShown ? { muted: lv.muted, toggle: lv.toggleSound, microphone: lv.mic, setMicrophone: on => camera.setting({ setting: "microphone", on }) } : null}
			quality={src.streams.length > 1 && src.feed === "stream" ? { stream: lv.stream, set: lv.pick } : null}
			cameras={sources.length > 1 && !phone ? { list: sources, current: src.name, pick: pickCamera } : null}
			aim={lv.canFrame && !compact ? { on: lv.aim, toggle: toggleAim } : null}
			snapshot={src.feed ? { take: () => void lv.snap.take(), busy: lv.snap.busy } : null}
			record={src.recording ? { phase: lv.record.rec?.phase ?? "idle", toggle: lv.record.toggle } : null}
			popout={src.feed && !coarse && !compact ? { on: !!pip.win, toggle: () => void togglePopout() } : null}
			theater={src.feed && !compact && !flatPhone ? { on: theater, toggle: toggleTheater } : null}
			fullscreen={src.feed ? { on: fs.on, toggle: toggleFullscreen } : null}
			// a phone's bar has no room for it while the tabs show, and hiding them gives the picture nothing
			rail={railExists && (immersive || !phone || railHidden) ? { shown: immersive ? overlayRail : !railHidden, toggle: toggleRail } : null}
			more={
				<MoreMenu
					extras={extras}
					zone={lv.roi && src.feed ? { on: lv.zoneOn, toggle: () => lv.setZoneOn(z => !z) } : null}
					wheel={camera.optical && src.feed ? { mode: lv.wheel, set: lv.setWheel } : null}
					onStreamInfo={() => setInfo(true)}
					onShortcuts={sheet.open}
					onAway={() => setAway(true)}
				/>
			}
		/>
	)

	const rail = railExists && (
		<ControlsRail
			source={src.name}
			camera={camera}
			mode={railMode}
			hidden={immersive ? !overlayRail : railHidden}
			onAim={lv.canFrame ? toggleAim : undefined}
		/>
	)
	const chips = <StageChips {...lv.chips} notice={fs.on ? lv.notice : null} badge={phone && !immersive ? badgeOf(src, lv.state) : null} compact={phone} />

	// the size label: mid-drag, or for a moment after a key on the corner grip
	const shown = resize.drag?.width ?? storedWidth
	const shownSnap = resize.drag ? resize.drag.snap : snapAt(snaps, shown)
	const sizeLabel = resize.labelShown && !resize.drag?.armed && (
		<div className="lv-sizelabel" aria-hidden="true">
			{Math.round(shown)} × {Math.round((shown * 9) / 16)}
			{shownSnap && <span> · {shownSnap.label}</span>}
		</div>
	)

	const picture = pip.win ? (
		<div className="lv-elsewhere">
			<Icon name="pip" size={30} />
			<p>Playing in the pop-out window</p>
			<button type="button" className="btn btn-sm lv-retry" onClick={pip.close}>
				Bring it back
			</button>
		</div>
	) : src.feed ? (
		<LiveStage ref={lv.stageRef} {...lv.stageProps} onDoubleClick={toggleFullscreen}>
			<StageOverlay src={src} state={lv.state} switching={!!lv.switching} onRetry={lv.retry} compact={phone} />
			{chips}
			{immersive && toolbar("overlay", !idle.shown)}
		</LiveStage>
	) : (
		<div className="stage">
			<StageOverlay src={src} state={lv.state} switching={false} onRetry={lv.retry} />
		</div>
	)

	const max = maxPicture(room)
	const namedSnap = choiceSnap(size)
	const corner = grips && (
		<div
			className={`lv-grip${gripLeft ? " is-left" : ""}${resize.drag ? " is-active" : ""}`}
			role="separator"
			tabIndex={0}
			aria-label="Picture size"
			aria-orientation="vertical"
			aria-valuemin={Math.round(minPicture(room))}
			aria-valuemax={Math.round(max)}
			aria-valuenow={Math.round(storedWidth)}
			aria-valuetext={`Picture ${Math.round(storedWidth)} by ${Math.round((storedWidth * 9) / 16)} pixels${namedSnap ? `, ${SNAP_LABELS[namedSnap].toLowerCase()}` : ""}`}
			title="Drag to resize · double-click for automatic size"
			onKeyDown={resize.onKeyDown}
			{...resize.gripProps("corner")}
		>
			<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
				<path d="M11 3 3 11 M11 7 7 11 M11 10.5 10.5 11" />
			</svg>
		</div>
	)

	// the controls' header: drag it to dock them elsewhere, or click its grip for the same as a menu
	const dockMenu = (overlay: boolean) => (
		<Menu label="Camera controls position" tip="Drag to move the controls · click for options" trigger={<Icon name="grip" size={18} />} triggerClass="lv-railhead-grip" className="lv-dockmenu">
			{close => {
				const run = (f: () => void) => () => {
					close()
					f()
				}
				const options: Dock[] = overlay ? ["left", "right"] : ["right", "left", "below"]
				return (
					<>
						{options.map(d => (
							<MenuItem
								key={d}
								radio
								checked={overlay ? (d === "left") === (dock === "left") : dock === d}
								hint={!overlay && d !== "below" && !fitsBeside(d) ? "Below until the window is wider" : undefined}
								onSelect={run(() => putDock(d))}
							>
								{d === "right" ? "Right" : d === "left" ? "Left" : "Below"}
							</MenuItem>
						))}
						<hr className="lv-menu-sep" />
						<MenuItem icon="sliders" action="view.controls" onSelect={run(toggleRail)}>
							Hide controls
						</MenuItem>
						{!overlay && (
							<MenuItem icon="refresh" hint="Controls on the right, automatic size" onSelect={run(resetLayout)}>
								Reset layout
							</MenuItem>
						)}
					</>
				)
			}}
		</Menu>
	)
	const railHead = (overlay: boolean) => (
		<div className="lv-railhead" onPointerDown={dockDrag.onPointerDown}>
			{dockMenu(overlay)}
			<span className="rail-head">{problems && !overlay ? "Camera" : "Camera controls"}</span>
		</div>
	)

	const style = {
		"--pic-w": `${Math.round(plan.picture)}px`,
		"--rail-w": `${Math.round(plan.rail)}px`,
		// the rail may use the window's whole height beside the picture, scrolling inside past that
		"--avail-h": `${Math.max(Math.round((plan.picture * 9) / 16 + BAR_H), vh - top - BOTTOM_GAP)}px`
	} as CSSProperties

	const moving = dockDrag.drag ?? pictureDrag.drag
	// the pill follows the pointer, flipped to its other side where it would leave the window
	const pillRef = useRef<HTMLDivElement>(null)
	const pillAt = (at: Point) => {
		const v = shellView()
		const w = pillRef.current?.offsetWidth ?? 170
		const h = pillRef.current?.offsetHeight ?? 32
		const right = Math.min(v.x + v.w, shellRef.current?.clientWidth ?? Infinity) - 8
		return { left: at.x + 12 + w > right ? at.x - 12 - w : at.x + 12, top: at.y + 12 + h > v.y + v.h - 8 ? at.y - 12 - h : at.y + 12 }
	}
	return (
		<div ref={pageRef} className={`lv${phone ? " is-phone" : ""}`} data-place={phone ? "phone" : plan.place} data-dock={dock} style={style}>
			<h1 className="sr-only" tabIndex={-1} data-page-title>
				Live: {humanize(src.name)}
			</h1>
			<div
				ref={shellRef}
				className={`lv-shell${immersive ? " is-immersive" : ""}${immersive && !idle.shown ? " is-idle" : ""}${resize.drag ? " is-dragging" : ""}${dockDrag.drag ? " is-moving" : ""}`}
			>
				<section className="lv-main" aria-label={`Live view of ${humanize(src.name)}`}>
					<div className={`lv-frame${resize.drag?.snap ? " is-snapped" : ""}`}>
						{picture}
						{!immersive && sizeLabel}
					</div>
					{!immersive && toolbar("bar")}
					{corner}
					{/* the side and bottom edges resize too (pointer only: the corner is the keyboard's) */}
					{grips && plan.place !== "side" && <div className={`lv-edge-x${gripLeft ? " is-left" : ""}`} aria-hidden="true" {...resize.gripProps("edge-x")} />}
					{grips && <div className="lv-edge-y" aria-hidden="true" {...resize.gripProps("edge-y")} />}
				</section>
				{grips && asideShown && plan.place === "side" && (
					<div className="lv-split" aria-hidden="true" title="Drag to resize · double-click for automatic size" {...resize.gripProps("edge-x")} />
				)}
				{immersive ? (
					rail && (
						<div className={`lv-orail ${dock === "left" ? "is-left" : "is-right"}${overlayRail ? "" : " is-hidden"}`}>
							<div className="lv-opanel">
								{/* phones keep their panel as it was: no header to drag */}
								{!phone && !flatPhone && railHead(true)}
								{rail}
							</div>
						</div>
					)
				) : (
					<aside className="lv-aside" hidden={!asideShown} aria-label="Camera">
						{!phone && railHead(false)}
						<div className="lv-aside-body">
							{problems}
							{railExists && !camera.controls && !camera.error && !railHidden && <Skeleton className="lv-rail-skeleton" />}
							{rail}
						</div>
					</aside>
				)}
				{resize.drag?.armed && (
					<div className="lv-arm" aria-hidden="true">
						<span className="lv-arm-pill">
							Release for theater
							{theaterKey && <kbd className="kbd">{theaterKey}</kbd>}
						</span>
					</div>
				)}
				{moving && (
					<div className="lv-dropzones" aria-hidden="true">
						{moving.zones.map(z => (
							<div
								key={z.dock}
								className={`lv-dropzone${z.dock === moving.active ? " is-active" : ""}`}
								data-dock={z.dock}
								style={{ left: z.rect.x, top: z.rect.y, width: z.rect.w, height: z.rect.h }}
							>
								<span>{z.dock === "right" ? "Right" : z.dock === "left" ? "Left" : "Below"}</span>
							</div>
						))}
						<div ref={pillRef} className="lv-dockpill" style={pillAt(moving.at)}>
							<Icon name="grip" size={16} />
							{dockDrag.drag ? "Camera controls" : "Picture"}
						</div>
					</div>
				)}
				<StreamInfoDialog open={info} onClose={() => setInfo(false)} src={src} stream={lv.stream} state={lv.state} model={camera.controls?.model ?? null} />
				<AwayDialog open={away} onClose={() => setAway(false)} />
			</div>
			{pip.win &&
				createPortal(
					<PopView
						src={src}
						lv={lv}
						camera={camera}
						back={{ label: "Back into the page", run: () => (pip.close(), window.focus()) }}
					/>,
					pip.win.document.body
				)}
		</div>
	)
}

// ---------- pop-outs ----------

/** A small d-pad and zoom for a pop-out big enough to hold them. Hold to move, as on the rail. */
const MiniPad = ({ camera }: { camera: Camera }) => {
	// gone mid-hold (the window shrank) never sees the release (the Dpad does the same for its arrows)
	useEffect(
		() => () => {
			camera.hold.release("pop:zoom-in")
			camera.hold.release("pop:zoom-out")
		},
		[camera.hold]
	)
	const p = camera.controls?.ptz
	if (!p || !(p.pan || p.tilt || p.zoom)) return null
	const zoom = (direction: "in" | "out") => holdProps(camera, `pop:zoom-${direction}`, slow => ({ op: "zoom", direction, ...(slow ? { slow: true } : {}) }))
	return (
		<div className="lv-minipad">
			<Dpad camera={camera} size="sm" />
			{p.zoom && (
				<div className="lv-minipad-zoom" role="group" aria-label="Zoom (hold)">
					<button type="button" aria-label="Zoom in (hold)" title="Zoom in" {...zoom("in")}>
						<Icon name="plus" size={16} />
					</button>
					<button type="button" aria-label="Zoom out (hold)" title="Zoom out" {...zoom("out")}>
						<Icon name="minus" size={16} />
					</button>
				</div>
			)}
		</div>
	)
}

/**
 * The picture alone, filling a small window: the Picture-in-Picture window (portalled from the page, which
 * keeps all the state) and the plain pop-out window. The tools show on open and whenever the pointer moves;
 * a big enough window also gets a mini d-pad.
 */
const PopView = ({ src, lv, camera, back }: { src: LiveSourceDto; lv: LiveView; camera: Camera; back: { label: string; run: () => void } }) => {
	const rootRef = useRef<HTMLDivElement>(null)
	const size = useSize(rootRef)
	const idle = useIdle(rootRef, !lv.aim, 3000, () => !!rootRef.current?.querySelector(".lv-menu, .lv-popover, .lv-bar :focus-visible, .lv-minipad :active"))
	const big = size.width >= 600 && size.height >= 330
	return (
		<div ref={rootRef} className={`lv-popview${idle.shown ? "" : " is-idle"}${big ? " is-big" : ""}`}>
			{src.feed ? (
				<LiveStage ref={lv.stageRef} {...lv.stageProps}>
					<StageOverlay src={src} state={lv.state} switching={!!lv.switching} onRetry={lv.retry} compact />
					<StageChips {...lv.chips} notice={lv.notice} compact />
					{/* hidden by CSS when idle, never unmounted: a button taken away mid-hold never sees its release */}
					{big && <MiniPad camera={camera} />}
					<Toolbar
						variant="pop"
						hidden={!idle.shown}
						onHover={idle.keep}
						badge={size.width >= 420 ? badgeOf(src, lv.state) : null}
						sound={lv.soundShown ? { muted: lv.muted, toggle: lv.toggleSound, microphone: lv.mic, setMicrophone: on => camera.setting({ setting: "microphone", on }) } : null}
						quality={src.streams.length > 1 && src.feed === "stream" ? { stream: lv.stream, set: lv.pick } : null}
						cameras={null}
						aim={big && lv.canFrame ? { on: lv.aim, toggle: () => lv.setAim(a => !a) } : null}
						snapshot={{ take: () => void lv.snap.take(), busy: lv.snap.busy }}
						record={src.recording ? { phase: lv.record.rec?.phase ?? "idle", toggle: lv.record.toggle } : null}
						popout={null}
						theater={null}
						fullscreen={null}
						rail={null}
						more={null}
						back={back}
					/>
				</LiveStage>
			) : (
				<div className="stage">
					<StageOverlay src={src} state={lv.state} switching={false} onRetry={lv.retry} compact />
				</div>
			)}
		</div>
	)
}

/** The plain pop-out window (`?popout=1`): its own app instance, all picture. */
export const LivePopout = () => {
	const { query } = useLocation()
	const name = query.get("source") ?? ""
	const list = useResource(s => api.live(s), [])
	const src = list.data?.find(s => s.name === name || s.aliases.includes(name))
	const [initialStream] = useState(() => parseStream(query.get("stream")))
	useDocumentTitle(src ? `${humanize(src.name)} · live` : "Live")

	useEffect(() => {
		document.documentElement.classList.add("is-popout")
		return () => document.documentElement.classList.remove("is-popout")
	}, [])

	let body: ReactNode
	if (list.error)
		body = (
			<div className="lv-center is-scrim">
				<p>{list.error}</p>
			</div>
		)
	else if (!list.data)
		body = (
			<div className="lv-center">
				<span className="spinner" aria-hidden="true" />
			</div>
		)
	else if (!src)
		body = (
			<div className="lv-center is-scrim">
				<p>There's no camera called “{name}”.</p>
			</div>
		)
	else body = <PopoutWindow src={src} initialStream={initialStream} />
	return (
		<main className="lv-popout" aria-label="Live camera">
			{body}
		</main>
	)
}

const PopoutWindow = ({ src, initialStream }: { src: LiveSourceDto; initialStream: LiveStream | null }) => {
	// no toasts here: camera failures go to the chip on the picture (called later, once `lv` exists)
	const camera = useCamera(src.name, src.controllable && src.problem !== "login-refused", message => lv.notify(message, { tone: "bad" }))
	const lv = useLiveView(src, camera, { initialStream, toasts: false })
	usePictureShortcuts(src, lv)
	const back = () => {
		const url = `/live?source=${encodeURIComponent(src.name)}`
		if (window.opener && !window.opener.closed) {
			window.opener.location.href = url
			window.opener.focus()
		} else window.open(url, "_blank")
	}
	return (
		<>
			<PopView src={src} lv={lv} camera={camera} back={{ label: "Open in look4", run: back }} />
			{/* mounted for its keyboard shortcuts (arrows move the camera here too), never shown */}
			{src.controllable && <ControlsRail source={src.name} camera={camera} mode="overlay" hidden onAim={lv.canFrame ? () => lv.setAim(a => !a) : undefined} />}
		</>
	)
}
