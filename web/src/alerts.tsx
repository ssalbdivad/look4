// Desktop notifications for sightings. The server already sends everything a notification says in the
// `sighting` event; this decides whether to show one (the setting, the browser's permission, the tab not
// in front) and what it says. Lives in the main app only: the live pop-out has no event connection.

import { useEffect, useState, useSyncExternalStore } from "react"
import type { ClipSummary, SettingsDto, SightingEvent } from "../../src/api-types.ts"
import { api, errorMessage } from "./api.ts"
import { Icon } from "./components/Icon.tsx"
import { Dot, Switch } from "./components/ui.tsx"
import { useFeedback } from "./feedback.tsx"
import { fmtPct, fmtRelative, humanize } from "./format.ts"
import { useLive, useLiveEvents } from "./live.tsx"
import { navigate } from "./router.tsx"

declare global {
	interface Window {
		/** Added by the look4 desktop app's preload (desktop/src/preload.ts); absent in a browser. */
		look4Desktop?: { focusWindow: () => void }
	}
}

// ---- the setting, shared by the notifier, the nudge and the Settings panel ----

let desktop: boolean | null = null
const subscribers = new Set<() => void>()

/** What the server says `alerts.desktop` is; null until the first answer. */
export const setAlertsDesktop = (on: boolean) => {
	desktop = on
	for (const fn of subscribers) fn()
}

const useAlertsDesktop = () =>
	useSyncExternalStore(
		fn => {
			subscribers.add(fn)
			return () => subscribers.delete(fn)
		},
		() => desktop
	)

// ---- the browser's permission ----

/** `unavailable`: no Notification API, or an insecure page (plain http on anything but localhost). */
export type AlertPermission = NotificationPermission | "unavailable"

export const notificationPermission = (): AlertPermission =>
	typeof Notification === "undefined" || !window.isSecureContext ? "unavailable" : Notification.permission

/** The permission, kept current when it is changed from the browser's site settings too. */
const usePermission = () => {
	const [perm, setPerm] = useState(notificationPermission)
	useEffect(() => {
		let status: PermissionStatus | null = null
		const sync = () => setPerm(notificationPermission())
		navigator.permissions?.query({ name: "notifications" }).then(
			s => {
				status = s
				s.addEventListener("change", sync)
			},
			() => {}
		)
		// a browser without permissions.query: coming back to the tab is when a change can have happened
		window.addEventListener("focus", sync)
		return () => {
			status?.removeEventListener("change", sync)
			window.removeEventListener("focus", sync)
		}
	}, [])
	const request = async () => setPerm(await Notification.requestPermission())
	return { perm, request }
}

// ---- what a notification says ----

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s)

/** "Northern cardinal · 92% sure" / "Cardinal · Backyard · seen 2m ago". */
export const sightingNotice = (e: SightingEvent, now = Date.now()) => ({
	title: `${e.label ? capitalize(e.label) : humanize(e.lookoutName)} · ${fmtPct(e.confidence)} sure`,
	body: [humanize(e.lookoutName), e.source, `seen ${fmtRelative(e.recordedAt, now)}`].join(" · ")
})

/** Shows one OS notification; clicking it brings look4 forward on the clip. Null if the browser refused. */
export const showSightingNotification = (e: SightingEvent): Notification | null => {
	const { title, body } = sightingNotice(e)
	// `image` (a large picture under the text) is in the spec and Chrome on desktop shows it; TS's DOM lib dropped it
	const options: NotificationOptions & { image?: string } = { body, tag: e.clipId }
	if (e.image) {
		options.icon = e.image
		options.image = e.image
	}
	try {
		const n = new Notification(title, options)
		n.onclick = () => {
			// in the desktop app window.focus() neither restores a minimized window nor raises it
			window.look4Desktop?.focusWindow()
			window.focus()
			navigate(`/clips/${e.clipId}`)
			n.close()
		}
		return n
	} catch {
		// Android Chrome only shows notifications from a service worker; there is none yet
		return null
	}
}

/** Notifies for each sighting while look4 isn't the tab in front. Mounted once, in the main app. */
export const SightingNotifier = () => {
	const { state } = useLive()
	// once, and again on every reconnect: the setting may have changed while the connection was down
	useEffect(() => {
		if (state !== "live") return
		const ac = new AbortController()
		api.settings(ac.signal).then(s => setAlertsDesktop(s.alerts?.desktop ?? true), () => {})
		return () => ac.abort()
	}, [state])
	useLiveEvents(e => {
		if (e.event !== "sighting" || e.data.recheck || notificationPermission() !== "granted") return
		if (document.visibilityState === "visible" && document.hasFocus()) return
		// The switch may have been flipped either way in another tab since this one read it, and a PATCH
		// tells no one: ask again (sightings are rare). Unreachable, go by what this tab last heard.
		api.settings().then(
			s => {
				const on = s.alerts?.desktop ?? true
				setAlertsDesktop(on)
				if (on) showSightingNotification(e.data)
			},
			() => {
				if (desktop === true) showSightingNotification(e.data)
			}
		)
	})
	return null
}

// ---- the nudge on the feed ----

const NUDGED = "look4:alerts-nudged"

const wasNudged = () => {
	try {
		return localStorage.getItem(NUDGED) !== null
	} catch {
		return true
	}
}

/**
 * Alerts are on but this browser was never asked, so none would ever show here. Offered once per
 * browser: either answer puts it away for good, since a nudge that comes back is a nag.
 */
export const AlertsNudge = () => {
	const on = useAlertsDesktop()
	const { perm, request } = usePermission()
	const [nudged, setNudged] = useState(wasNudged)
	if (nudged || on !== true || perm !== "default") return null
	const answer = (allow: boolean) => {
		if (allow) void request()
		try {
			localStorage.setItem(NUDGED, "1")
		} catch {}
		setNudged(true)
	}
	return (
		<div className="note" role="status" style={{ alignItems: "center", flexWrap: "wrap" }}>
			<Icon name="megaphone" size={18} />
			<span>Get a notification on this computer when a lookout spots something?</span>
			<span style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
				<button type="button" className="btn btn-primary btn-sm" onClick={() => answer(true)}>
					Allow
				</button>
				<button type="button" className="btn btn-ghost btn-sm" onClick={() => answer(false)}>
					Not now
				</button>
			</span>
		</div>
	)
}

// ---- Settings → Alerts ----

/** The newest kept clip as a sighting, for "Send a test"; a made-up one when nothing is kept yet. */
const testSighting = (clip: ClipSummary | undefined): SightingEvent => {
	const m = clip?.matches[0]
	if (!clip || !m)
		return {
			clipId: "test",
			lookoutId: "test",
			lookoutName: "test",
			label: "Test alert",
			confidence: 1,
			source: "look4",
			recordedAt: new Date().toISOString(),
			image: null
		}
	return {
		clipId: clip.id,
		lookoutId: m.lookoutId,
		lookoutName: m.lookoutName,
		label: m.label,
		confidence: m.confidence,
		source: clip.source,
		recordedAt: clip.recordedAt,
		image: clip.media.closeUps[0] ?? clip.media.crops[0] ?? clip.media.poster
	}
}

const PermissionLine = ({ perm, onAllow }: { perm: AlertPermission; onAllow: () => void }) => {
	if (perm === "granted")
		return (
			<div className="status-line">
				<Dot tone="good" />
				<span>Allowed in this browser.</span>
			</div>
		)
	if (perm === "default")
		return (
			<div className="status-line">
				<Dot tone="idle" />
				<span>This browser hasn't been asked yet.</span>
				<button type="button" className="btn btn-primary btn-sm" onClick={onAllow}>
					Allow notifications
				</button>
			</div>
		)
	if (perm === "denied")
		return (
			<div className="status-line is-warn">
				<Dot tone="warn" />
				<span>
					Blocked in this browser. In Chrome or Edge: click the icon left of the address bar, open Site settings (Edge:
					Permissions for this site), set Notifications to Allow, then reload this page.
				</span>
			</div>
		)
	return (
		<div className="status-line is-warn">
			<Dot tone="warn" />
			<span>
				{typeof Notification === "undefined" && window.isSecureContext ? (
					"This browser can't show notifications."
				) : (
					<>
						Not available here: browsers only allow notifications on HTTPS or localhost. To get them on another
						computer, run <code>tailscale serve --bg 4040</code> on the look4 computer and open the{" "}
						<code>https://…ts.net</code> address it prints.
					</>
				)}
			</span>
		</div>
	)
}

export const AlertsPanel = ({ s, onSaved }: { s: SettingsDto; onSaved: (s: SettingsDto) => void }) => {
	const { toast } = useFeedback()
	const shared = useAlertsDesktop()
	const on = shared ?? s.alerts?.desktop ?? true
	const { perm, request } = usePermission()
	const [saving, setSaving] = useState(false)

	const toggle = async (next: boolean) => {
		setSaving(true)
		try {
			const saved = await api.patchSettings({ alerts: { desktop: next } })
			setAlertsDesktop(saved.alerts.desktop)
			onSaved(saved)
		} catch (e) {
			toast(errorMessage(e), { tone: "bad" })
		} finally {
			setSaving(false)
		}
	}

	const sendTest = async () => {
		try {
			const page = await api.sightings({ limit: 1 })
			if (!showSightingNotification(testSighting(page.items[0]))) toast("This browser refused to show it.", { tone: "bad" })
		} catch (e) {
			toast(errorMessage(e), { tone: "bad" })
		}
	}

	return (
		<section className="panel" aria-labelledby="sec-alerts" id="alerts">
			<h2 className="panel-title settings-title" id="sec-alerts">
				<span className="settings-icon" aria-hidden="true">
					<Icon name="megaphone" size={18} />
				</span>
				Alerts
			</h2>
			<p className="muted section-blurb">
				A notification on this computer when a lookout spots something while look4 isn't the tab in front. Click it to
				open the clip. They come only while look4 is open, in a browser tab or the desktop app; phones don't get them
				yet.
			</p>
			<PermissionLine perm={perm} onAllow={() => void request()} />
			<div className="fields">
				<div className="field field-switch">
					<span className="field-label" id="alerts-desktop-label">
						Desktop notifications
					</span>
					<Switch checked={on} onChange={v => void toggle(v)} label="Desktop notifications" disabled={saving} />
					<span className="field-help">
						For every browser with look4 open. Each browser also has to allow them once.
					</span>
				</div>
				<div>
					<button type="button" className="btn btn-ghost btn-sm" onClick={() => void sendTest()} disabled={perm !== "granted"}>
						Send a test
					</button>
				</div>
			</div>
		</section>
	)
}
