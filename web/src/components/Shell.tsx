import { type ReactNode, useEffect } from "react"
import { useLive } from "../live.tsx"
import { Link, matchRoute, type Route, useLocation } from "../router.tsx"
import { UNSEEN_CAP, useUnseenSightings } from "../unseen.ts"
import { useUpload } from "../upload.tsx"
import { Icon, type IconName } from "./Icon.tsx"

const NAV: { to: string; label: string; icon: IconName; pages: Route["page"][] }[] = [
	{ to: "/", label: "Sightings", icon: "binoculars", pages: ["sightings", "clip"] },
	{ to: "/live", label: "Live", icon: "video", pages: ["live"] },
	{ to: "/activity", label: "Activity", icon: "pulse", pages: ["activity"] },
	{ to: "/settings", label: "Settings", icon: "gear", pages: ["settings"] }
]

export const Shell = ({ page, children }: { page: Route["page"]; children: ReactNode }) => {
	const { state, queue } = useLive()
	const { pick } = useUpload()
	const { path } = useLocation()
	const inQueue = queue ? queue.pending + queue.processing : 0
	// the first-run check renders this frame as Sightings whatever the URL, so go by the URL
	const unseen = useUnseenSightings(page === "sightings" && matchRoute(path).page === "sightings")

	// Move focus to the new page's heading so keyboard and screen-reader users land somewhere sensible.
	useEffect(() => {
		const h = document.querySelector<HTMLElement>("[data-page-title]")
		if (h && document.activeElement !== h && document.activeElement?.closest("main") == null) h.focus({ preventScroll: true })
	}, [path])

	const nav = NAV.map(n => {
		const active = n.pages.includes(page)
		const badge = n.to === "/" ? unseen : 0
		return (
			<Link key={n.to} to={n.to} className={active ? "nav-link is-active" : "nav-link"} aria-current={active ? "page" : undefined}>
				<span className="nav-icon">
					<Icon name={n.icon} size={20} />
					{badge > 0 && (
						<span className="nav-badge" aria-hidden="true">
							{badge >= UNSEEN_CAP ? "99+" : badge}
						</span>
					)}
				</span>
				<span className="nav-label">{n.label}</span>
				{badge > 0 && <span className="sr-only">, {badge >= UNSEEN_CAP ? "over 99" : badge} new</span>}
			</Link>
		)
	})

	return (
		<>
			<a className="skip-link" href="#main">
				Skip to content
			</a>
			<header className="topbar">
				<div className="topbar-inner">
					<Link to="/" className="brand" aria-label="look4 home">
						<img className="brand-mark" src="/logo-mark.svg" alt="" width={36} height={36} />
						<span className="wordmark">
							look<span className="wordmark-4">4</span>
						</span>
					</Link>
					<nav className="nav nav-top" aria-label="Main">
						{nav}
					</nav>
					<div className="topbar-right">
						{inQueue > 0 && (
							<Link to="/activity" className="queue-badge" title={`${queue?.processing ?? 0} processing, ${queue?.pending ?? 0} waiting`}>
								<span className="spinner" aria-hidden="true" />
								{inQueue} in queue
							</Link>
						)}
						<span
							className={`live is-${state}`}
							role="status"
							title={
								state === "live"
									? "Live: new sightings appear on their own"
									: state === "offline"
										? "Not connected to look4. Retrying…"
										: "Connecting to look4…"
							}
						>
							<span className="live-dot" aria-hidden="true" />
							{/* while connecting: just a soft pulsing dot, no word to flash */}
							{state !== "connecting" && <span className="live-text">{state === "live" ? "Live" : "Offline"}</span>}
							{state === "connecting" && <span className="sr-only">Connecting</span>}
						</span>
						<button type="button" className="btn btn-primary btn-upload" onClick={pick}>
							<Icon name="upload" size={18} />
							<span>Upload</span>
						</button>
					</div>
				</div>
			</header>
			<main id="main" className="main">
				{/* keyed by page so each page eases in when you arrive */}
				<div className="page" key={page}>
					{children}
				</div>
			</main>
			<nav className="nav nav-bottom" aria-label="Main">
				{nav}
			</nav>
		</>
	)
}
