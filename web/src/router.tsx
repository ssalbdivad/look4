import { type AnchorHTMLAttributes, type MouseEvent, useSyncExternalStore } from "react"

// A tiny History API router: enough for a handful of pages, a deep-linkable clip view and the setup wizard.

const listeners = new Set<() => void>()
const notify = () => {
	for (const l of listeners) l()
}
if (typeof window !== "undefined") window.addEventListener("popstate", notify)

const subscribe = (l: () => void) => {
	listeners.add(l)
	return () => listeners.delete(l)
}
const snapshot = () => location.pathname + location.search

export const navigate = (to: string, opts: { replace?: boolean } = {}) => {
	if (to === snapshot()) return
	// `idx` counts in-app entries, so a Back button knows whether history.back() stays inside look4.
	const idx = (history.state as { idx?: number } | null)?.idx ?? 0
	if (opts.replace) history.replaceState({ idx }, "", to)
	else history.pushState({ idx: idx + 1 }, "", to)
	// A new page starts at the top; a replace (filter change) keeps the scroll position.
	if (!opts.replace) window.scrollTo({ top: 0 })
	notify()
}

export const canGoBack = () => ((history.state as { idx?: number } | null)?.idx ?? 0) > 0

export const useLocation = () => {
	const href = useSyncExternalStore(subscribe, snapshot)
	const url = new URL(href, "http://x")
	return { path: url.pathname, query: url.searchParams, href }
}

export type Route =
	| { page: "sightings" }
	| { page: "clip"; id: string }
	| { page: "activity" }
	| { page: "settings" }
	| { page: "setup" }
	| { page: "live" }
	| { page: "missing" }

export const matchRoute = (path: string): Route => {
	const p = path.replace(/\/+$/, "") || "/"
	if (p === "/" || p === "/sightings") return { page: "sightings" }
	// Lookouts used to be a page of their own; they live on Sightings now (App redirects the URL)
	if (p === "/lookouts") return { page: "sightings" }
	if (p === "/activity") return { page: "activity" }
	if (p === "/settings") return { page: "settings" }
	if (p === "/setup") return { page: "setup" }
	if (p === "/live") return { page: "live" }
	const clip = /^\/clips\/([^/]+)$/.exec(p)
	if (clip?.[1]) return { page: "clip", id: decodeURIComponent(clip[1]) }
	return { page: "missing" }
}

const isPlainClick = (e: MouseEvent<HTMLAnchorElement>) =>
	e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.defaultPrevented

export const Link = ({
	to,
	replace,
	onClick,
	...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; replace?: boolean }) => (
	<a
		{...rest}
		href={to}
		onClick={e => {
			onClick?.(e)
			if (!isPlainClick(e)) return
			e.preventDefault()
			navigate(to, { replace })
		}}
	/>
)
