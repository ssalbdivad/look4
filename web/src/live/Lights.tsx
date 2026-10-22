import { type ReactNode, useEffect, useRef, useState } from "react"
import type { CameraLight, DayNightMode } from "../../../src/api-types.ts"
import { Icon, type IconName } from "../components/Icon.tsx"
import { Switch } from "../components/ui.tsx"
import { releaseAfterClick, useShortcutLabel, withShortcut } from "../keyboard.tsx"
import { RangeRow, useCommitted } from "./Move.tsx"
import { RailSection } from "./Rail.tsx"
import type { Camera } from "./useCamera.ts"

// Picture & lights: one compact row per thing the camera has, nothing for what it lacks.

const DAY_NIGHT: Array<{ mode: DayNightMode; label: string }> = [
	{ mode: "auto", label: "Auto" },
	{ mode: "color", label: "Colour" },
	{ mode: "bw", label: "B&W" }
]

/** How long Shoo must be held: long enough that a stray tap can't set it off. */
const SHOO_HOLD_MS = 1000
/** One burst lasts about this long; the button rests meanwhile. */
const SHOO_REST_MS = 5000

const Row = ({ icon, label, note, warn, children }: { icon: IconName; label: string; note?: string; warn?: boolean; children: ReactNode }) => (
	<div className="rail-row">
		<Icon name={icon} size={18} className="rail-row-icon" />
		<span className="rail-row-text">
			<span className="rail-row-label">{label}</span>
			{note && <span className={warn ? "rail-row-note is-warn" : "rail-row-note"}>{note}</span>}
		</span>
		{children}
	</div>
)

/** A switch that stays disabled while its change is on the way. */
const BusySwitch = ({ checked, label, onChange, title }: { checked: boolean; label: string; onChange: (on: boolean) => Promise<unknown>; title?: string }) => {
	const [busy, setBusy] = useState(false)
	return (
		<span title={title}>
			<Switch
				checked={checked}
				label={label}
				disabled={busy}
				onChange={async on => {
					setBusy(true)
					await onChange(on)
					setBusy(false)
				}}
			/>
		</span>
	)
}

const Spotlight = ({ camera, light }: { camera: Camera; light: CameraLight }) => {
	const shortcut = useShortcutLabel("cam.light")
	const b = useCommitted(light.brightness ?? 0, brightness => void camera.light({ id: "spotlight", brightness }))
	return (
		<>
			{/* while on, the note says when look4 switches it off by itself */}
			<Row icon="bulb" label="Spotlight" note={light.on ? light.detail : undefined}>
				<BusySwitch checked={light.on} label="Spotlight" title={withShortcut("Spotlight", shortcut)} onChange={on => camera.light({ id: "spotlight", on })} />
			</Row>
			{light.on && light.brightness !== undefined && (
				<div className="rail-sub">
					<RangeRow label="Spotlight brightness" min={0} max={100} value={b.value} onChange={b.set} valueText={`${Math.round(b.value)}%`} />
				</div>
			)}
		</>
	)
}

export const LightsSection = ({ camera }: { camera: Camera }) => {
	const c = camera.controls!
	const tracking = c.ptz?.tracking ?? null
	const ir = c.lights.find(l => l.id === "ir")
	const spot = c.lights.find(l => l.id === "spotlight")
	const [dnBusy, setDnBusy] = useState(false)
	const irShortcut = useShortcutLabel("cam.nightVision")
	const trackShortcut = useShortcutLabel("cam.tracking")
	return (
		<RailSection title="Picture & lights" className="rail-lights">
			{c.dayNight && (
				<Row icon="contrast" label="Night picture">
					<div className="segmented rail-seg" role="radiogroup" aria-label="Night picture">
						{DAY_NIGHT.map(o => (
							<button
								key={o.mode}
								type="button"
								role="radio"
								className="segment"
								aria-checked={c.dayNight === o.mode}
								disabled={dnBusy}
								onClick={async e => {
									releaseAfterClick(e)
									if (c.dayNight === o.mode) return
									setDnBusy(true)
									await camera.setting({ setting: "dayNight", mode: o.mode })
									setDnBusy(false)
								}}
							>
								{o.label}
							</button>
						))}
					</div>
				</Row>
			)}
			{ir && (
				<Row icon="moon" label="Night vision" note={ir.on ? "Auto" : "Off"}>
					<BusySwitch checked={ir.on} label="Night vision" title={withShortcut("Night vision", irShortcut)} onChange={on => camera.light({ id: "ir", on })} />
				</Row>
			)}
			{spot && <Spotlight camera={camera} light={spot} />}
			{tracking && (
				<Row icon="walk" label="Auto-tracking" note="Swings the camera off the feeder" warn={tracking.on}>
					<BusySwitch checked={tracking.on} label="Auto-tracking" title={withShortcut("Auto-tracking", trackShortcut)} onChange={on => camera.setting({ setting: "tracking", on })} />
				</Row>
			)}
			{c.siren && (
				<Row icon="siren" label="Siren" note="Hold Shoo for one burst">
					<ShooButton camera={camera} />
				</Row>
			)}
			{c.microphone !== null && (
				<Row icon={c.microphone ? "mic" : "micOff"} label="Microphone" note="Also adds sound to the camera's recordings">
					<BusySwitch checked={c.microphone} label="Microphone" onChange={on => camera.setting({ setting: "microphone", on })} />
				</Row>
			)}
		</RailSection>
	)
}

/** Press and hold for a second (a ring fills up) to sound the siren once; letting go early cancels. */
const ShooButton = ({ camera }: { camera: Camera }) => {
	const [phase, setPhase] = useState<"idle" | "holding" | "sounding">("idle")
	const phaseRef = useRef(phase)
	phaseRef.current = phase
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	useEffect(() => () => clearTimeout(timer.current), [])

	const start = () => {
		if (phaseRef.current !== "idle") return
		setPhase("holding")
		timer.current = setTimeout(async () => {
			setPhase("sounding")
			const ok = await camera.siren()
			timer.current = setTimeout(() => setPhase("idle"), ok ? SHOO_REST_MS : 0)
		}, SHOO_HOLD_MS)
	}
	const cancel = () => {
		if (phaseRef.current !== "holding") return
		clearTimeout(timer.current)
		setPhase("idle")
	}
	return (
		<button
			type="button"
			className={`rail-shoo is-${phase}`}
			aria-label="Shoo: hold for one second to sound the siren"
			title="Hold for 1 s: one burst of the siren"
			disabled={phase === "sounding"}
			onPointerDown={e => {
				if (e.button !== 0) return
				e.currentTarget.setPointerCapture(e.pointerId)
				start()
			}}
			onPointerUp={cancel}
			onPointerCancel={cancel}
			onLostPointerCapture={cancel}
			onBlur={cancel}
			onKeyDown={e => {
				if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
					e.preventDefault()
					start()
				}
			}}
			onKeyUp={e => {
				if (e.key === "Enter" || e.key === " ") cancel()
			}}
			onContextMenu={e => e.preventDefault()}
		>
			<span className="rail-shoo-dial">
				<svg className="rail-shoo-ring" viewBox="0 0 36 36" aria-hidden="true">
					<circle className="rail-shoo-track" cx="18" cy="18" r="16" pathLength={100} />
					<circle className="rail-shoo-fill" cx="18" cy="18" r="16" pathLength={100} style={{ animationDuration: `${SHOO_HOLD_MS}ms` }} />
				</svg>
				<Icon name="siren" size={16} />
			</span>
			<span className="rail-shoo-text">{phase === "sounding" ? "Sounding" : phase === "holding" ? "Hold…" : "Shoo"}</span>
		</button>
	)
}
