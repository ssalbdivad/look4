import { type ReactNode, useId, useState } from "react"
import type { CameraControls, PtzBody } from "../../../src/api-types.ts"
import { Icon } from "../components/Icon.tsx"
import { ErrorNote } from "../components/ui.tsx"
import { useFeedback } from "../feedback.tsx"
import { useDigitShortcut, useHeldShortcuts, useShortcut } from "../keyboard.tsx"
import { type ActionId, heldDirection } from "../keys.ts"
import { HomeSection } from "./Home.tsx"
import { LightsSection } from "./Lights.tsx"
import { MoveSection } from "./Move.tsx"
import type { Camera } from "./useCamera.ts"
import { ViewsSection } from "./Views.tsx"
import "./rail.css"

// The camera's controls beside, below or over the picture. It stays mounted while hidden, so its
// keyboard shortcuts keep working in theater and full screen with the rail tucked away.

export type RailMode = "side" | "below" | "overlay" | "tabs"

type Has = { views: boolean; move: boolean; home: boolean; lights: boolean }

export const railSections = (c: CameraControls | null): Has => {
	const p = c?.ptz
	return {
		views: !!p && (p.presets.length > 0 || p.maxPresets > 0 || !!p.guard),
		move: !!p && (p.pan || p.tilt || p.zoom || p.focus),
		home: !!p?.guard,
		lights: !!c && (c.lights.length > 0 || c.dayNight !== null || !!p?.tracking || c.siren || c.microphone !== null)
	}
}

type Tab = "views" | "move" | "camera"
const TABS: Array<{ id: Tab; label: string }> = [
	{ id: "views", label: "Views" },
	{ id: "move", label: "Move" },
	{ id: "camera", label: "Camera" }
]

export const ControlsRail = ({
	source,
	camera,
	mode,
	hidden,
	onAim
}: {
	source: string
	camera: Camera
	mode: RailMode
	hidden?: boolean
	onAim?: () => void
}) => {
	useCameraShortcuts(camera, onAim)
	const [tab, setTab] = useState<Tab>("views")
	const ids = useId()
	const c = camera.controls
	const has = railSections(c)

	if (!c) {
		if (!camera.error) return null
		return (
			<aside className={`rail is-${mode}`} hidden={hidden} aria-label="Camera controls">
				<ErrorNote message={`Camera controls: ${camera.error}`} onRetry={camera.reload} />
			</aside>
		)
	}
	if (!has.views && !has.move && !has.home && !has.lights) return null

	const views = has.views && <ViewsSection key="views" source={source} camera={camera} />
	const move = has.move && <MoveSection key="move" camera={camera} onAim={onAim} />
	const home = has.home && <HomeSection key="home" camera={camera} />
	const lights = has.lights && <LightsSection key="lights" camera={camera} />

	if (mode === "tabs") {
		const panels: Record<Tab, ReactNode[]> = { views: [views], move: [move], camera: [home, lights] }
		const shown = TABS.filter(t => panels[t.id].some(Boolean))
		const current = shown.some(t => t.id === tab) ? tab : (shown[0]?.id ?? "views")
		return (
			<aside className="rail is-tabs" hidden={hidden} aria-label="Camera controls">
				{shown.length > 1 && (
					<div
						className="segmented rail-tabs"
						role="tablist"
						aria-label="Camera controls"
						onKeyDown={e => {
							if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
							e.preventDefault()
							const i = shown.findIndex(t => t.id === current)
							const next = shown[(i + (e.key === "ArrowRight" ? 1 : shown.length - 1)) % shown.length]!
							setTab(next.id)
							document.getElementById(`${ids}-tab-${next.id}`)?.focus()
						}}
					>
						{shown.map(t => (
							<button
								key={t.id}
								id={`${ids}-tab-${t.id}`}
								type="button"
								role="tab"
								className="segment"
								aria-selected={t.id === current}
								aria-checked={t.id === current}
								aria-controls={`${ids}-panel`}
								tabIndex={t.id === current ? 0 : -1}
								onClick={() => setTab(t.id)}
							>
								{t.label}
							</button>
						))}
					</div>
				)}
				<div className="rail-panel" id={`${ids}-panel`} role="tabpanel" aria-labelledby={`${ids}-tab-${current}`}>
					{panels[current]}
				</div>
			</aside>
		)
	}

	return (
		<aside className={`rail is-${mode}`} hidden={hidden} aria-label="Camera controls">
			{views}
			{move}
			{home}
			{lights}
		</aside>
	)
}

/** A titled block of the rail. */
export const RailSection = ({ title, icon, children, className = "" }: { title: string; icon?: Parameters<typeof Icon>[0]["name"]; children: ReactNode; className?: string }) => {
	const id = useId()
	return (
		<section className={`rail-sec ${className}`.trim()} aria-labelledby={id}>
			<h3 className="rail-head" id={id}>
				{icon && <Icon name={icon} size={16} />}
				{title}
			</h3>
			{children}
		</section>
	)
}

// ---------- keyboard ----------

const HOLD_OPS: Partial<Record<ActionId, (slow: boolean) => PtzBody>> = {
	"cam.zoomIn": slow => ({ op: "zoom", direction: "in", ...(slow ? { slow } : {}) }),
	"cam.zoomOut": slow => ({ op: "zoom", direction: "out", ...(slow ? { slow } : {}) }),
	"cam.focusNear": slow => ({ op: "focus", direction: "near", ...(slow ? { slow } : {}) }),
	"cam.focusFar": slow => ({ op: "focus", direction: "far", ...(slow ? { slow } : {}) })
}

/**
 * Every `cam.*` shortcut, and 1–9 for the saved views. The held keys act as one: ↑ with ← goes up-left,
 * Shift pressed mid-move slows it, and with no arrow held the latest zoom or focus key wins.
 */
const useCameraShortcuts = (camera: Camera, onAim?: () => void) => {
	const { confirm } = useFeedback()
	const c = camera.controls
	const p = c?.ptz ?? null

	const holds: ActionId[] = []
	if (p?.pan) holds.push("cam.left", "cam.right")
	if (p?.tilt) holds.push("cam.up", "cam.down")
	if (p?.zoom) holds.push("cam.zoomIn", "cam.zoomOut")
	if (p?.focus) holds.push("cam.focusNear", "cam.focusFar")
	useHeldShortcuts(
		holds,
		(held, slow) => {
			const direction = heldDirection(held)
			const op = [...held].reverse().find(id => HOLD_OPS[id])
			const body: PtzBody | null = direction ? { op: "move", direction, ...(slow ? { slow } : {}) } : op ? HOLD_OPS[op]!(slow) : null
			if (body) camera.hold.press("keys", body)
			else camera.hold.release("keys")
		},
		holds.length > 0
	)

	useShortcut("cam.home", () => void camera.home(), !!p?.guard?.set)
	useShortcut("cam.aim", () => onAim?.(), !!onAim && !!p?.box)

	const spot = c?.lights.find(l => l.id === "spotlight")
	const ir = c?.lights.find(l => l.id === "ir")
	useShortcut("cam.light", () => spot && void camera.light({ id: "spotlight", on: !spot.on }), !!spot)
	useShortcut("cam.nightVision", () => ir && void camera.light({ id: "ir", on: !ir.on }), !!ir)
	useShortcut("cam.tracking", () => p?.tracking && void camera.setting({ setting: "tracking", on: !p.tracking.on }), !!p?.tracking)
	// the rail's Shoo button wants a 1 s hold; a key gets a confirm instead
	useShortcut(
		"cam.siren",
		() =>
			void confirm({ title: "Sound the siren?", body: "One short burst. It scares the birds off too.", confirmLabel: "Shoo", danger: true }).then(
				ok => ok && camera.siren()
			),
		!!c?.siren
	)

	useDigitShortcut(n => {
		const preset = p?.presets[n - 1]
		if (preset) void camera.ptz({ op: "preset", id: preset.id })
	}, !!p?.presets.length)
}
