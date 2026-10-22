import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react"
import type { SseEvent } from "../../src/api-types.ts"
import { api } from "./api.ts"
import { useLatest } from "./hooks.ts"

type Queue = { pending: number; processing: number }
type Listener = (e: SseEvent) => void

/** `connecting` until the first open or a grace period, so a cold load never flashes "Offline". */
export type LiveState = "connecting" | "live" | "offline"

type Live = {
	connected: boolean
	state: LiveState
	queue: Queue | null
	subscribe: (l: Listener) => () => void
}

const LiveContext = createContext<Live>({ connected: false, state: "connecting", queue: null, subscribe: () => () => {} })

/** How long a first connection may take before the header admits it is offline. */
const GRACE_MS = 3000

const EVENTS: SseEvent["event"][] = ["clip", "sighting", "source", "queue", "lookout", "lifelist"]

/** One EventSource for the whole app; pages subscribe to what they care about. */
export const LiveProvider = ({ children }: { children: ReactNode }) => {
	const [state, setState] = useState<LiveState>("connecting")
	const [queue, setQueue] = useState<Queue | null>(null)
	const listeners = useRef(new Set<Listener>())
	const [live] = useState(() => ({
		subscribe: (l: Listener) => {
			listeners.current.add(l)
			return () => {
				listeners.current.delete(l)
			}
		}
	}))

	useEffect(() => {
		const ac = new AbortController()
		api.stats(ac.signal).then(s => setQueue(s.queue), () => {})
		const es = new EventSource("/api/events")
		let opened = false
		const grace = setTimeout(() => {
			if (!opened) setState("offline")
		}, GRACE_MS)
		es.onopen = () => {
			opened = true
			setState("live")
		}
		// EventSource reconnects on its own; we only reflect the state. An error before the first open
		// waits out the grace period (a dev server still starting); after it, offline is the truth.
		es.onerror = () => {
			if (es.readyState === EventSource.OPEN) return
			if (opened) setState("offline")
		}
		for (const name of EVENTS) {
			es.addEventListener(name, msg => {
				let data: unknown
				try {
					data = JSON.parse((msg as MessageEvent<string>).data)
				} catch {
					return
				}
				const event = { event: name, data } as SseEvent
				if (event.event === "queue") setQueue(event.data)
				for (const l of listeners.current) l(event)
			})
		}
		return () => {
			clearTimeout(grace)
			ac.abort()
			es.close()
		}
	}, [])

	return <LiveContext value={{ connected: state === "live", state, queue, subscribe: live.subscribe }}>{children}</LiveContext>
}

export const useLive = () => useContext(LiveContext)

/** Calls `handler` for every server event; the handler may change between renders. */
export const useLiveEvents = (handler: Listener) => {
	const { subscribe } = useLive()
	const latest = useLatest(handler)
	useEffect(() => subscribe(e => latest.current(e)), [subscribe, latest])
}
