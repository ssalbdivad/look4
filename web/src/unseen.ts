// Sightings that landed while the feed wasn't in front of you: the count on the Sightings tab.
// Kept in localStorage, so it survives a reload and every open tab shows (and clears) the same one.
// Ids rather than a counter: a clip matching two lookouts sends two events, and each tab hears both.
// Live events alone miss whatever lands while no page is open, the tab sleeps or the stream
// reconnects, so the server is asked too: what was ingested since you last looked, merged in.

import { useEffect, useSyncExternalStore } from "react"
import { api } from "./api.ts"
import { useLive, useLiveEvents } from "./live.tsx"

const KEY = "look4:unseen-sightings"
/** When you last had the feed in front of you; the server counts from here. */
const SEEN_KEY = "look4:sightings-seen-at"

/** Past this the badge reads "99+", so there is no point remembering more. */
export const UNSEEN_CAP = 100

const read = (): string[] => {
	try {
		const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]")
		return Array.isArray(v) ? v.filter(x => typeof x === "string") : []
	} catch {
		return []
	}
}

let ids = typeof localStorage === "undefined" ? [] : read()
const subscribers = new Set<() => void>()

const set = (next: string[]) => {
	ids = next
	try {
		if (next.length) localStorage.setItem(KEY, JSON.stringify(next))
		else localStorage.removeItem(KEY)
	} catch {}
	for (const fn of subscribers) fn()
}

const add = (more: string[]) => {
	const fresh = more.filter(id => !ids.includes(id))
	if (fresh.length) set([...ids, ...fresh].slice(-UNSEEN_CAP))
}

const seenAt = () => {
	try {
		return localStorage.getItem(SEEN_KEY)
	} catch {
		return null
	}
}

const markSeen = () => {
	try {
		localStorage.setItem(SEEN_KEY, new Date().toISOString())
	} catch {}
	if (ids.length) set([])
}

const subscribe = (fn: () => void) => {
	subscribers.add(fn)
	// another tab added or cleared some
	const sync = (e: StorageEvent) => {
		if (e.key !== KEY) return
		ids = read()
		fn()
	}
	window.addEventListener("storage", sync)
	return () => {
		subscribers.delete(fn)
		window.removeEventListener("storage", sync)
	}
}

const feedInView = (onFeed: boolean) => onFeed && document.visibilityState === "visible"

/**
 * How many sightings arrived since you last looked at the feed. Counts while you are on another page,
 * the tab is hidden or no page is open at all; looking at the feed clears it. Re-checks of past
 * footage don't count: they notify no one, and a backfill would bury the badge.
 */
export const useUnseenSightings = (onFeed: boolean) => {
	const { connected } = useLive()
	useLiveEvents(e => {
		if (e.event !== "sighting" || e.data.recheck || feedInView(onFeed)) return
		add([e.data.clipId])
	})
	// catch up on whatever the event stream didn't deliver: on load, on every reconnect, on coming back
	useEffect(() => {
		if (!connected || onFeed) return
		let ac: AbortController | undefined
		const catchUp = () => {
			const since = seenAt()
			// a first visit has nothing to catch up on: everything already there is old news
			if (!since) return markSeen()
			if (document.visibilityState !== "visible") return
			ac?.abort()
			ac = new AbortController()
			api.unseenSightings(since, ac.signal).then(r => {
				// you may have opened the feed in another tab meanwhile
				if (seenAt() === since) add(r.ids)
			}, () => {})
		}
		catchUp()
		document.addEventListener("visibilitychange", catchUp)
		return () => {
			ac?.abort()
			document.removeEventListener("visibilitychange", catchUp)
		}
	}, [connected, onFeed])
	// the feed in front of you: clear it, and move the mark to whenever you stop looking
	useEffect(() => {
		if (!onFeed) return
		// hiding the tab stops the clock; showing it clears what came in meanwhile
		const onVisibility = () => markSeen()
		const leave = () => {
			if (document.visibilityState === "visible") markSeen()
		}
		leave()
		document.addEventListener("visibilitychange", onVisibility)
		window.addEventListener("pagehide", leave)
		return () => {
			leave()
			document.removeEventListener("visibilitychange", onVisibility)
			window.removeEventListener("pagehide", leave)
		}
	}, [onFeed])
	return useSyncExternalStore(subscribe, () => ids.length)
}
