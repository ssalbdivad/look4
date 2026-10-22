import { useEffect, useState } from "react"
import { AlertsNudge, SightingNotifier } from "./alerts.tsx"
import { Shell } from "./components/Shell.tsx"
import { FeedSkeleton } from "./components/ClipCard.tsx"
import { EmptyState, PageHead } from "./components/ui.tsx"
import { FeedbackProvider, useFeedback } from "./feedback.tsx"
import { api } from "./api.ts"
import { fmtPct, humanize } from "./format.ts"
import { useDocumentTitle } from "./hooks.ts"
import { LiveProvider, useLiveEvents } from "./live.tsx"
import { ActivityPage } from "./pages/Activity.tsx"
import { ClipDetailPage } from "./pages/ClipDetail.tsx"
import { LivePage, LivePopout } from "./pages/Live.tsx"
import { SettingsPage } from "./pages/Settings.tsx"
import { SetupPage } from "./pages/Setup.tsx"
import { SightingsPage } from "./pages/Sightings.tsx"
import { Link, matchRoute, navigate, type Route, useLocation } from "./router.tsx"
import { UploadProvider } from "./upload.tsx"

/** A pop-out window is only ever the picture: no app frame, no live-event connection, no upload drop zone. */
const POPOUT = typeof location !== "undefined" && location.pathname.replace(/\/+$/, "") === "/live" && new URLSearchParams(location.search).get("popout") === "1"

export const App = () =>
	POPOUT ? (
		<FeedbackProvider>
			<LivePopout />
		</FeedbackProvider>
	) : (
	<FeedbackProvider>
		<LiveProvider>
			<UploadProvider>
				<Routes />
			</UploadProvider>
		</LiveProvider>
	</FeedbackProvider>
	)

const Routes = () => {
	const { path, query } = useLocation()
	const route = matchRoute(path)
	// the old Lookouts and Life list pages are part of Sightings now; their links (and `?new=1`) still land there
	const legacy = ["/lookouts", "/life-list"].includes(path.replace(/\/+$/, ""))
	useEffect(() => {
		if (legacy) navigate(`/${query.size ? `?${query}` : ""}`, { replace: true })
	}, [legacy, query])
	const gate = useFirstRunGate(route.page)
	// While the first-run check is out, show the app's frame at once and, after a beat, the feed's
	// skeleton, so a slow host never looks like a blank page and a fast one never flashes.
	// render nothing until the URL is "/": the feed mounting first would read (and clear) `?new=1` too early
	if (legacy) return null
	if (gate === "checking")
		return (
			<Shell page="sightings">
				<div className="booting">
					<PageHead title="Sightings" sub="Clips your lookouts kept, newest first." />
					<FeedSkeleton />
				</div>
			</Shell>
		)
	// The wizard is a calm full page of its own, without the app's navigation.
	if (route.page === "setup") return <SetupPage />
	return (
		<Shell page={route.page}>
			<SightingToasts quiet={route.page === "sightings" || route.page === "live"} />
			<SightingNotifier />
			{route.page === "sightings" && <AlertsNudge />}
			{route.page === "sightings" && <SightingsPage />}
			{route.page === "clip" && <ClipDetailPage key={route.id} id={route.id} />}
			{route.page === "live" && <LivePage />}
			{route.page === "activity" && <ActivityPage />}
			{route.page === "settings" && <SettingsPage />}
			{route.page === "missing" && <NotFound />}
		</Shell>
	)
}

const REDIRECTED = "look4:setup-redirected"

/**
 * A brand-new install (GET /api/setup says not completed) opens the setup wizard instead of an empty
 * feed, once per browser session, so "Skip" or wandering back to / never traps anyone in a loop.
 * Holds the feed (showing its skeleton) until it knows, so the feed doesn't flash before the redirect.
 */
const useFirstRunGate = (page: Route["page"]) => {
	const [state, setState] = useState<"checking" | "open">(() =>
		page === "sightings" && !sessionStorage.getItem(REDIRECTED) ? "checking" : "open"
	)
	useEffect(() => {
		if (state !== "checking") return
		const ac = new AbortController()
		let cancelled = false
		// an older server without /api/setup, or a slow one, must never block the app
		const timer = setTimeout(() => ac.abort(), 2500)
		api.setup(ac.signal).then(
			s => {
				if (cancelled) return
				sessionStorage.setItem(REDIRECTED, "1")
				if (!s.completed) navigate("/setup", { replace: true })
				setState("open")
			},
			() => {
				if (!cancelled) setState("open")
			}
		)
		return () => {
			cancelled = true
			clearTimeout(timer)
			ac.abort()
		}
	}, [state])
	return state
}

/**
 * Away from the feed, a new sighting is announced with a toast that links to it. Not on the feed, which
 * shows it anyway, and not on Live (or its Picture-in-Picture, portalled from that page): nothing is drawn
 * over the picture, and a sighting there is a minute or two behind what's on screen. Desktop notifications
 * (alerts.tsx) are separate and unaffected.
 */
const SightingToasts = ({ quiet }: { quiet: boolean }) => {
	const { toast } = useFeedback()
	useLiveEvents(e => {
		// a backfill re-finds old clips by the dozen: the feed shows them, a toast each would bury the page
		if (e.event !== "sighting" || quiet || e.data.recheck) return
		const id = e.data.clipId
		const what = e.data.label ?? "Something"
		toast(`Spotted: ${what} (${humanize(e.data.lookoutName)}), ${fmtPct(e.data.confidence)} sure`, {
			tone: "good",
			action: { label: "View", run: () => navigate(`/clips/${id}`) }
		})
	})
	return null
}

const NotFound = () => {
	useDocumentTitle("Not found")
	return (
		<EmptyState title="Nothing to see here" mascot="puzzled">
			<p>This page flew off. Try the <Link to="/">sightings feed</Link>.</p>
		</EmptyState>
	)
}
