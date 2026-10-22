import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { LiveStream } from "../../../src/api-types.ts"
import { ApiError, liveUrl } from "../api.ts"
import { useLatest } from "../hooks.ts"

// The live picture. Real video goes through Media Source Extensions: the server
// sends fragmented MP4 (the camera's own H.264 or 4K HEVC, or the HEVC main stream
// re-encoded when this browser can't play HEVC), with the camera's sound when asked,
// and the player keeps itself within a fraction of a second of the live edge.
// Browsers without MSE, a stream MSE can't play even transcoded, and cameras showing
// still pictures use Motion JPEG instead, decoded here from a fetch so a failure
// arrives as the server's sentence rather than a broken image.
//
// Everything that belongs to a window (MediaSource, object URLs, timers, visibility)
// comes from the window that owns the element, so the player also works when it is
// portalled into a Document Picture-in-Picture window, whose timers keep running
// while the main tab is hidden.

export type PlayerState =
	| { phase: "connecting" }
	| {
			phase: "playing"
			/** `pictures`: Motion JPEG (no MSE, a stream MSE can't play, or a stills camera), not live video. */
			via: "video" | "pictures"
			width: number
			height: number
			/** The MP4's codecs (`X-Codec`), e.g. `hvc1.1.6.L150,mp4a.40.2`; it includes `mp4a` when there is sound. */
			codec: string | null
			/** `copy`: the camera's own stream; `transcode`: re-encoded by look4 (`X-Live-Path`). */
			path: "copy" | "transcode" | "pictures"
	  }
	/** `retrying`: a dropped camera or server, which the player keeps trying in the background; else only Try again helps. */
	| { phase: "error"; message: string; retrying: boolean }

/** This browser can't play what the server sent. `hevc`: it was HEVC, so a transcode may still work. */
class Unplayable extends Error {
	hevc: boolean
	constructor(message: string, hevc = false) {
		super(message)
		this.hevc = hevc
	}
}

/** The picture stopped moving while bytes kept coming (e.g. an audio gap left the tracks out of step). */
class Frozen extends Error {}

type Win = Window & typeof globalThis
type MediaSourceCtor = typeof MediaSource

const ownerWindow = (el: Element | null): Win => (el?.ownerDocument.defaultView as Win | null) ?? window

const mediaSource = (win: Win): MediaSourceCtor | null =>
	(win as { ManagedMediaSource?: MediaSourceCtor }).ManagedMediaSource ?? (win.MediaSource as MediaSourceCtor | undefined) ?? null

/** What the server sends for HEVC copy (`-tag:v hvc1`, level 5.0): probing anything else answers the wrong question. */
const hevcOk = (win: Win) => !!mediaSource(win)?.isTypeSupported('video/mp4; codecs="hvc1.1.6.L150"')

const isHevc = (codec: string) => /^(hvc1|hev1)/.test(codec)

const failure = async (res: Response) => {
	let msg = `${res.status} ${res.statusText}`
	try {
		msg = ((await res.json()) as { error?: string }).error ?? msg
	} catch {}
	return new ApiError(msg, res.status)
}

/** No bytes for this long: the connection is dead, reconnect. */
const STALL_MS = 10_000
/** Further behind the live edge than this, the player jumps forward. */
const MAX_LAG_S = 1.2
/**
 * The cushion the player keeps behind the newest frame it has: more than CATCH_UP_S over it, the player
 * plays CATCH_UP_RATE times faster until it is back under it. The Live page sat p50 0.79 s (p90 0.83)
 * behind on the real camera's Quick stream, all of it lag on top of the stream's own ~0.4 s, since the
 * jump only acts past MAX_LAG_S. Faster play closes it without the jump's skip; the pitch is kept, so
 * sound stays sound. The cushion starts at CUSHION_S and each stall (`waiting`) adds CUSHION_STEP_S, up
 * to CUSHION_MAX_S: a fixed 0.2 s stalled 1–3 times per 30 s on the mock demo's Quick stream where the
 * old 0.4–0.8 s never did, so how much a source needs is learned from the source.
 */
const CUSHION_S = 0.3
const CUSHION_STEP_S = 0.1
const CUSHION_MAX_S = 0.7
const CATCH_UP_S = 0.2
const CATCH_UP_RATE = 1.15
/** Not paused, no progress for this long while bytes still arrive: reconnect. */
const FREEZE_MS = 3000
/** Playing this long forgives earlier reconnects. */
const STEADY_MS = 20_000
/**
 * After the quick reconnects fail, the player shows the error and keeps trying, waiting this long and
 * doubling up to the cap: a page left open on a camera that rebooted or dropped off the Wi-Fi comes back
 * by itself instead of waiting for a click.
 */
const BACKOFF_MS = 5000
const BACKOFF_MAX_MS = 60_000
/**
 * Failures no retry fixes: a 4xx (no such camera or stream; not 429, every live slot taken, which frees up
 * when a tab closes), and the camera refusing the password or the
 * path. Retrying a wrong password is worse than useless: every try counts toward the camera's lockout.
 */
const permanent = (e: unknown) =>
	(e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429) || (e instanceof Error && /username or password|no stream at that path/.test(e.message))

type VideoRun = {
	video: HTMLVideoElement
	url: string
	signal: AbortSignal
	onPlaying: (codec: string, path: "copy" | "transcode") => void
	onSoundBlocked: () => void
}

/** Chrome pauses a video unmuted without a user gesture (and refuses to play one unmuted): fall back to muted. */
const playOrMute = (video: HTMLVideoElement, onSoundBlocked: () => void) =>
	video.play().catch((e: unknown) => {
		if ((e as { name?: string }).name !== "NotAllowedError" || video.muted) return
		video.muted = true
		onSoundBlocked()
		video.play().catch(() => {})
	})

const playVideo = async (run: VideoRun) => {
	const { video, signal } = run
	const win = ownerWindow(video)
	const doc = video.ownerDocument
	const MS = mediaSource(win)
	if (!MS) throw new Unplayable("no Media Source Extensions")
	const res = await fetch(run.url, { signal })
	if (!res.ok) throw await failure(res)
	const codec = res.headers.get("X-Codec") ?? ""
	const hevc = isHevc(codec)
	const type = `video/mp4; codecs="${codec}"`
	if (!MS.isTypeSupported(type)) {
		await res.body?.cancel().catch(() => {})
		throw new Unplayable(`this browser can't play ${type}`, hevc)
	}
	const header = res.headers.get("X-Live-Path")
	const path = header === "copy" || header === "transcode" ? header : "copy"
	const ms = new MS()
	video.disableRemotePlayback = true
	const objectUrl = win.URL.createObjectURL(ms)
	video.src = objectUrl
	const off: Array<() => void> = []
	const on = <k extends keyof HTMLMediaElementEventMap>(type: k, fn: (e: HTMLMediaElementEventMap[k]) => void) => {
		video.addEventListener(type, fn)
		off.push(() => video.removeEventListener(type, fn))
	}
	let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
	try {
		await new Promise<void>((resolve, reject) => {
			ms.addEventListener("sourceopen", () => resolve(), { once: true })
			signal.addEventListener("abort", () => reject(signal.reason), { once: true })
		})
		let sb: SourceBuffer
		try {
			sb = ms.addSourceBuffer(type)
		} catch {
			// isTypeSupported can say yes to what the decoder then refuses
			throw new Unplayable(`this browser can't play ${type}`, hevc)
		}
		sb.mode = "segments"
		video.preservesPitch = true
		// set by the freeze watchdog below: the player is waiting for data, so nothing to catch up on
		let waitingSince: number | null = null
		let cushion = CUSHION_S
		/** Plays a little faster while well behind the newest buffered frame, never against a stall. */
		const chase = () => {
			const b = video.buffered
			const lag = b.length ? b.end(b.length - 1) - video.currentTime : 0
			const behind = started && !video.paused && !video.seeking && waitingSince === null && video.readyState >= 3
			const rate = !behind ? 1 : lag > cushion + CATCH_UP_S ? CATCH_UP_RATE : lag < cushion ? 1 : video.playbackRate
			if (video.playbackRate !== rate) video.playbackRate = rate
		}
		const queue: Uint8Array[] = []
		let failed: Error | null = null
		let started = false
		let unmutedAt = 0
		const feed = () => {
			if (sb.updating || ms.readyState !== "open") return
			const b = video.buffered
			if (b.length) {
				const end = b.end(b.length - 1)
				if (started && !video.paused && end - video.currentTime > MAX_LAG_S) video.currentTime = end - cushion
				chase()
				// keep the buffer short: a live view never seeks back. Measured from the newest frame, not the
				// playhead, so a video the browser paused in a background tab doesn't fill the quota; on its return
				// the lag check above jumps to the live edge
				if (end - b.start(0) > 30) {
					sb.remove(b.start(0), end - 10)
					return
				}
			}
			if (!queue.length) return
			const bytes = new Uint8Array(queue.reduce((n, c) => n + c.length, 0))
			let at = 0
			for (const c of queue.splice(0)) {
				bytes.set(c, at)
				at += c.length
			}
			try {
				sb.appendBuffer(bytes)
			} catch (e) {
				failed = e instanceof Error ? e : new Error(String(e))
			}
		}
		sb.addEventListener("updateend", () => {
			feed()
			if (!started && video.buffered.length) {
				started = true
				// the first fragment can start up to a GOP back: begin at the live edge (less the cushion), not wherever it starts
				const b = video.buffered
				video.currentTime = Math.max(b.start(b.length - 1), b.end(b.length - 1) - cushion)
				void playOrMute(video, run.onSoundBlocked)
			}
		})
		sb.addEventListener("error", () => (failed = new Unplayable("the browser couldn't decode the stream", hevc)))
		// "playing" can fire before the first frame is on screen: report once one has been presented, so a
		// stream switch never swaps to a blank element
		let shown = false
		const showing = () => {
			if (signal.aborted) return
			shown = true
			run.onPlaying(codec, path)
		}
		on("playing", () => {
			if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(showing)
			else showing()
		})
		// the picture's size changed mid-stream (resize also fires for the first metadata, before any frame)
		on("resize", () => {
			if (shown) showing()
		})
		on("volumechange", () => {
			if (!video.muted) unmutedAt = performance.now()
		})
		on("pause", () => {
			// Chrome answers an unmute that came without a user gesture by pausing the video
			if (signal.aborted || video.muted || performance.now() - unmutedAt > 1000) return
			video.muted = true
			run.onSoundBlocked()
			video.play().catch(() => {})
		})

		// freeze watchdog
		let lastTime = -1
		let lastMove = performance.now()
		let bytesSinceMove = 0
		let played = false
		on("waiting", () => {
			// ran out of picture while playing (not the start's wait, nor a seek's): keep more in hand from now on
			if (waitingSince === null && played && !video.seeking) cushion = Math.min(CUSHION_MAX_S, cushion + CUSHION_STEP_S)
			waitingSince ??= performance.now()
			chase()
		})
		on("playing", () => {
			waitingSince = null
			played = true
		})
		on("timeupdate", chase)
		const tick = () => {
			const now = performance.now()
			if (!started || video.paused || video.seeking || doc.visibilityState === "hidden") {
				lastMove = now
				bytesSinceMove = 0
				waitingSince = null
				return
			}
			if (video.currentTime !== lastTime) {
				lastTime = video.currentTime
				lastMove = now
				bytesSinceMove = 0
			} else if (now - lastMove > FREEZE_MS && bytesSinceMove > 0) failed ??= new Frozen("The picture froze.")
		}
		const watch = win.setInterval(tick, 500)
		off.push(() => win.clearInterval(watch))
		const onVisible = () => {
			// a background tab may have paused the video; the lag chaser then jumps to the live edge
			if (doc.visibilityState === "visible" && started && video.paused) void playOrMute(video, run.onSoundBlocked)
		}
		doc.addEventListener("visibilitychange", onVisible)
		off.push(() => doc.removeEventListener("visibilitychange", onVisible))

		const body = (reader = res.body!.getReader())
		for (;;) {
			const timer = win.setTimeout(() => body.cancel().catch(() => {}), STALL_MS)
			const { done, value } = await body.read().finally(() => win.clearTimeout(timer))
			if (failed) throw failed
			if (video.error) throw new Unplayable(video.error.message || "the browser couldn't decode the stream", hevc)
			if (done) {
				if (signal.aborted) return
				throw new Error("The camera's stream stopped.")
			}
			bytesSinceMove += value.length
			queue.push(value)
			feed()
		}
	} finally {
		// the run loop reconnects on the same signal, so a response dropped on a freeze or error stays open (a browser
		// connection, and a server ffmpeg with its camera session) until it is cancelled here
		void (reader ?? res.body)?.cancel().catch(() => {})
		for (const f of off) f()
		win.URL.revokeObjectURL(objectUrl)
	}
}

const CRLF2 = [13, 10, 13, 10]

const indexOf = (buf: Uint8Array, seq: number[], from = 0) => {
	outer: for (let i = from; i + seq.length <= buf.length; i++) {
		for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer
		return i
	}
	return -1
}

const playPictures = async (img: HTMLImageElement, url: string, signal: AbortSignal, onFrame: () => void) => {
	const win = ownerWindow(img)
	const res = await fetch(url, { signal })
	if (!res.ok) throw await failure(res)
	const reader = res.body!.getReader()
	let buf = new Uint8Array(0)
	let shown: string | null = null
	let busy = false
	const show = (jpeg: Uint8Array) => {
		// still drawing the last one: skip this frame rather than fall behind
		if (busy) return
		busy = true
		const next = win.URL.createObjectURL(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }))
		img.onload = () => {
			if (shown) win.URL.revokeObjectURL(shown)
			shown = next
			busy = false
			onFrame()
		}
		img.onerror = () => {
			win.URL.revokeObjectURL(next)
			busy = false
		}
		img.src = next
	}
	try {
		for (;;) {
			const timer = win.setTimeout(() => reader.cancel().catch(() => {}), STALL_MS)
			const { done, value } = await reader.read().finally(() => win.clearTimeout(timer))
			if (done) {
				if (signal.aborted) return
				throw new Error("The camera stopped sending pictures.")
			}
			const merged = new Uint8Array(buf.length + value.length)
			merged.set(buf)
			merged.set(value, buf.length)
			buf = merged
			for (;;) {
				const end = indexOf(buf, CRLF2)
				if (end < 0) break
				const head = new TextDecoder().decode(buf.subarray(0, end))
				const len = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? NaN)
				if (!Number.isFinite(len)) throw new Error("The picture stream was garbled.")
				if (buf.length < end + 4 + len) break
				show(buf.slice(end + 4, end + 4 + len))
				buf = buf.slice(end + 4 + len)
			}
		}
	} finally {
		// a garbled stream throws with the response still open; the next attempt opens another
		void reader.cancel().catch(() => {})
		img.onload = img.onerror = null
		if (shown) win.URL.revokeObjectURL(shown)
	}
}

/** A per-tab list in sessionStorage. */
const sessionSet = (storageKey: string) => ({
	has: (key: string) => (sessionStorage.getItem(storageKey) ?? "").split("\n").includes(key),
	add: (key: string) => sessionStorage.setItem(storageKey, [...(sessionStorage.getItem(storageKey) ?? "").split("\n"), key].join("\n"))
})

/** Streams video could not play at all this session: the next visit goes straight to pictures. */
const noVideo = sessionSet("look4:live-pictures")
/** Sources whose HEVC this browser couldn't decode this session: ask for the H.264 transcode straight away. */
const noHevc = sessionSet("look4:live-nohevc")

export type LivePlayerProps = {
	source: string
	stream: LiveStream
	/** The source sends still pictures, not video. */
	stills: boolean
	/** Bump to reconnect. */
	attempt: number
	/** Ask for the camera's sound track (`&audio=1`); `X-Audio: 0` streams play silently as before. */
	audio?: boolean
	/**
	 * Default true. Turning sound on must come from a user gesture: set it to false inside a click or key
	 * handler (React applies it before the handler returns). Without one, Chrome pauses the video; the player
	 * then mutes itself again and calls `onSoundBlocked`.
	 */
	muted?: boolean
	onState: (s: PlayerState) => void
	/** The browser refused to play with sound, so the player muted itself. */
	onSoundBlocked?: () => void
}

export const LivePlayer = ({ source, stream, stills, attempt, audio = false, muted = true, onState, onSoundBlocked }: LivePlayerProps) => {
	const videoRef = useRef<HTMLVideoElement>(null)
	const imgRef = useRef<HTMLImageElement>(null)
	const [, rerender] = useState(0)
	const key = `${source}:${stream}`
	const via = stills || !mediaSource(window) || noVideo.has(key) ? "pictures" : "video"
	const onStateRef = useLatest(onState)
	// a live stream re-fires "playing" after every brief underrun: only changes reach the page
	const last = useRef("")
	const report = useRef((s: PlayerState) => {
		const key = JSON.stringify(s)
		if (key === last.current) return
		last.current = key
		onStateRef.current(s)
	})
	const blockedRef = useLatest(onSoundBlocked)

	useLayoutEffect(() => {
		const v = videoRef.current
		if (v && v.muted !== muted) v.muted = muted
	}, [muted, via])

	useEffect(() => {
		const el = videoRef.current ?? imgRef.current
		const win = ownerWindow(el)
		const ac = new AbortController()
		let retries = 0
		let hevc = hevcOk(win) && !noHevc.has(source)
		report.current({ phase: "connecting" })
		const run = async () => {
			for (;;) {
				let playingSince = 0
				try {
					if (via === "video") {
						const video = videoRef.current!
						const extra = `${hevc ? "&hevc=1" : ""}${audio ? "&audio=1" : ""}`
						await playVideo({
							video,
							url: liveUrl(source, "mp4", stream, extra),
							signal: ac.signal,
							onPlaying: (codec, path) => {
								playingSince ||= performance.now()
								report.current({ phase: "playing", via: "video", width: video.videoWidth, height: video.videoHeight, codec, path })
							},
							onSoundBlocked: () => blockedRef.current?.()
						})
					} else {
						const img = imgRef.current!
						let first = true
						await playPictures(img, liveUrl(source, "mjpeg", stream), ac.signal, () => {
							if (!first) return
							first = false
							playingSince = performance.now()
							report.current({ phase: "playing", via: "pictures", width: img.naturalWidth, height: img.naturalHeight, codec: null, path: "pictures" })
						})
					}
					return
				} catch (e) {
					if (ac.signal.aborted) return
					if (playingSince && performance.now() - playingSince > STEADY_MS) retries = 0
					if (e instanceof Unplayable && via === "video") {
						// HEVC this browser can't decode: the server's H.264 transcode before falling back to pictures
						if (e.hevc && hevc) {
							hevc = false
							noHevc.add(source)
							report.current({ phase: "connecting" })
							continue
						}
						noVideo.add(key)
						rerender(n => n + 1)
						return
					}
					const message = e instanceof Error ? e.message : String(e)
					if (permanent(e)) {
						report.current({ phase: "error", message, retrying: false })
						return
					}
					// a dropped stream reconnects at once a few times; past that, or when the server explained
					// (the camera is off or not answering), the error shows while the player keeps trying, slower
					retries++
					const wait = e instanceof ApiError || retries > 3 ? Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** Math.max(0, retries - 4)) : e instanceof Frozen ? 0 : 1500
					report.current(wait >= BACKOFF_MS ? { phase: "error", message, retrying: true } : { phase: "connecting" })
					if (wait) await new Promise(r => win.setTimeout(r, wait))
					if (ac.signal.aborted) return
				}
			}
		}
		void run()
		return () => {
			ac.abort()
			const v = videoRef.current
			if (v) {
				v.removeAttribute("src")
				v.load()
			}
		}
	}, [source, stream, via, attempt, audio])

	return (
		<div className="stage-media">
			{via === "video" ? (
				<video ref={videoRef} className="stage-el" muted playsInline aria-label={`Live video from ${source}`} />
			) : (
				<img ref={imgRef} className="stage-el" alt={`Live picture from ${source}`} draggable={false} />
			)}
		</div>
	)
}
