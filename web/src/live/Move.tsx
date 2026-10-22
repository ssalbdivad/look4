import { type CSSProperties, type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react"
import type { PositionRange, PtzBody, PtzDirection } from "../../../src/api-types.ts"
import { lensFactor } from "../../../src/live/zoom-curve.ts"
import { Icon, type IconName } from "../components/Icon.tsx"
import { Switch } from "../components/ui.tsx"
import { releaseAfterDrag, useShortcutLabel, withShortcut } from "../keyboard.tsx"
import { RailSection } from "./Rail.tsx"
import type { Camera } from "./useCamera.ts"

// Steering: a d-pad with Home in the middle, the optical zoom as a slider, and focus behind a disclosure.

/** Optical zoom as the lens magnification people know, by the lens's measured curve (1×–2.5× on an RLC-823S1). */
export const zoomFactor = (pos: number, r: Pick<PositionRange, "min" | "max">) => lensFactor(pos, r)

const fmtZoom = (x: number) => `${x.toFixed(1)}×`

/**
 * Press-and-hold on a button: pointer capture keeps the hold when the finger slides off, and the release,
 * a cancel, a lost capture or losing focus all let go. Shift held at the press means slow.
 */
export const holdProps = (camera: Camera, key: string, body: (slow: boolean) => PtzBody) => {
	const release = () => camera.hold.release(key)
	return {
		onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
			if (e.button !== 0 || e.currentTarget.disabled) return
			e.currentTarget.setPointerCapture(e.pointerId)
			camera.hold.press(key, body(e.shiftKey))
		},
		onPointerUp: release,
		onPointerCancel: release,
		onLostPointerCapture: release,
		onBlur: release,
		onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
			if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
				e.preventDefault()
				camera.hold.press(key, body(e.shiftKey))
			}
		},
		onKeyUp: (e: KeyboardEvent<HTMLButtonElement>) => {
			if (e.key === "Enter" || e.key === " ") release()
		},
		onContextMenu: (e: { preventDefault(): void }) => e.preventDefault()
	}
}

const slowly = (slow: boolean) => (slow ? { slow: true as const } : {})

type Cell = { d: PtzDirection; label: string; rotate: number } | null

const CELLS: Cell[] = [
	{ d: "upLeft", label: "Up and left", rotate: -45 },
	{ d: "up", label: "Tilt up", rotate: 0 },
	{ d: "upRight", label: "Up and right", rotate: 45 },
	{ d: "left", label: "Turn left", rotate: -90 },
	null,
	{ d: "right", label: "Turn right", rotate: 90 },
	{ d: "downLeft", label: "Down and left", rotate: -135 },
	{ d: "down", label: "Tilt down", rotate: 180 },
	{ d: "downRight", label: "Down and right", rotate: 135 }
]

/** The eight-way pad; its hub goes Home. Exported for the pop-out's mini controls. */
export const Dpad = ({ camera, size = "md" }: { camera: Camera; size?: "sm" | "md" }) => {
	const p = camera.controls?.ptz
	const keyed: Partial<Record<PtzDirection, string | null>> = {
		up: useShortcutLabel("cam.up"),
		down: useShortcutLabel("cam.down"),
		left: useShortcutLabel("cam.left"),
		right: useShortcutLabel("cam.right")
	}
	const homeKey = useShortcutLabel("cam.home")
	// a pad taken away mid-hold (the pop-out's tools, a window shrinking) never sees the pointerup
	useEffect(
		() => () => {
			for (const cell of CELLS) if (cell) camera.hold.release(`dpad:${cell.d}`)
		},
		[camera.hold]
	)
	if (!p || !(p.pan || p.tilt)) return null
	const homeSet = !!p.guard?.set
	return (
		<div className={`rail-dpad is-${size}`} role="group" aria-label="Turn the camera (hold to move, Shift for slow)">
			{CELLS.map((cell, i) => {
				if (!cell)
					return p.guard ? (
						<button
							key="hub"
							type="button"
							className="rail-dpad-hub"
							disabled={!homeSet}
							aria-label="Back home"
							title={homeSet ? withShortcut("Back home", homeKey) : "No Home yet"}
							onClick={() => void camera.home()}
						>
							<Icon name="home" size={size === "sm" ? 16 : 20} />
						</button>
					) : (
						<span key="hub" className="rail-dpad-hub" aria-hidden="true" />
					)
				const { d, label, rotate } = cell
				const disabled = (!p.tilt && /up|down/i.test(d)) || (!p.pan && /left|right/i.test(d))
				return (
					<button
						key={d}
						type="button"
						className={i % 2 === 0 ? "rail-dpad-btn is-diag" : "rail-dpad-btn"}
						aria-label={label}
						title={withShortcut(`${label}: hold`, keyed[d] ?? null)}
						disabled={disabled}
						{...holdProps(camera, `dpad:${d}`, slow => ({ op: "move", direction: d, ...slowly(slow) }))}
					>
						<span className="rail-dpad-arrow" style={{ transform: `rotate(${rotate}deg)` }}>
							<Icon name="arrow" size={size === "sm" ? 16 : 20} />
						</span>
					</button>
				)
			})}
		</div>
	)
}

/**
 * A slider for something the camera reports back (zoom, focus, brightness): it follows the camera,
 * except while being dragged and until the camera has caught up with where it was let go.
 */
export const useCommitted = (live: number, commit: (v: number) => unknown, delayMs = 250) => {
	const [draft, setDraft] = useState<number | null>(null)
	const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const giveUp = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	useEffect(
		() => () => {
			clearTimeout(pending.current)
			clearTimeout(giveUp.current)
		},
		[]
	)
	useEffect(() => {
		if (draft !== null && pending.current === undefined && Math.abs(live - draft) <= 1) setDraft(null)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [live])
	const set = (v: number) => {
		setDraft(v)
		clearTimeout(pending.current)
		pending.current = setTimeout(() => {
			pending.current = undefined
			commit(v)
			clearTimeout(giveUp.current)
			// the camera never reported this value (it rounds, or the command failed): follow it again
			giveUp.current = setTimeout(() => setDraft(null), 6000)
		}, delayMs)
	}
	return { value: draft ?? live, set }
}

export const RangeRow = ({
	label,
	min,
	max,
	value,
	onChange,
	valueText,
	lower,
	higher,
	step = 1,
	disabled
}: {
	label: string
	min: number
	max: number
	value: number
	onChange: (v: number) => void
	valueText?: string
	/** The buttons at each end: one step down / up. */
	lower?: { icon: IconName; label: string; step: number }
	higher?: { icon: IconName; label: string; step: number }
	step?: number
	disabled?: boolean
}) => {
	const fill = max > min ? ((value - min) / (max - min)) * 100 : 0
	const clamp = (v: number) => Math.min(max, Math.max(min, v))
	return (
		<div className="rail-range">
			{lower && (
				<button type="button" className="rail-step" aria-label={lower.label} title={lower.label} disabled={disabled || value <= min} onClick={() => onChange(clamp(value - lower.step))}>
					<Icon name={lower.icon} size={18} />
				</button>
			)}
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				disabled={disabled}
				aria-label={label}
				aria-valuetext={valueText}
				style={{ "--fill": `${fill}%` } as CSSProperties}
				onChange={e => onChange(Number(e.target.value))}
				onPointerDown={releaseAfterDrag}
			/>
			{higher && (
				<button type="button" className="rail-step" aria-label={higher.label} title={higher.label} disabled={disabled || value >= max} onClick={() => onChange(clamp(value + higher.step))}>
					<Icon name={higher.icon} size={18} />
				</button>
			)}
			{valueText && (
				<output className="rail-range-val" aria-hidden="true">
					{valueText}
				</output>
			)}
		</div>
	)
}

export const ZoomControl = ({ camera }: { camera: Camera }) => {
	const p = camera.controls?.ptz
	const r = p?.zoomRange ?? null
	const zoomIn = useShortcutLabel("cam.zoomIn")
	const zoomOut = useShortcutLabel("cam.zoomOut")
	const z = useCommitted(camera.state?.zoom ?? r?.pos ?? 0, pos => void camera.ptz({ op: "zoomTo", pos }))
	if (!p?.zoom) return null
	if (!r)
		return (
			<div className="rail-holds" role="group" aria-label="Zoom (hold)">
				<HoldButton camera={camera} hold="zoomOut" icon="zoomOut" label={withShortcut("Zoom out: hold", zoomOut)} body={s => ({ op: "zoom", direction: "out", ...slowly(s) })} />
				<HoldButton camera={camera} hold="zoomIn" icon="zoomIn" label={withShortcut("Zoom in: hold", zoomIn)} body={s => ({ op: "zoom", direction: "in", ...slowly(s) })} />
			</div>
		)
	const step = Math.max(1, Math.round((r.max - r.min) / 8))
	return (
		<RangeRow
			label="Zoom"
			min={r.min}
			max={r.max}
			value={z.value}
			onChange={z.set}
			valueText={fmtZoom(zoomFactor(z.value, r))}
			lower={{ icon: "zoomOut", label: withShortcut("Zoom out", zoomOut), step }}
			higher={{ icon: "zoomIn", label: withShortcut("Zoom in", zoomIn), step }}
		/>
	)
}

const HoldButton = ({ camera, hold, icon, label, body }: { camera: Camera; hold: string; icon: IconName; label: string; body: (slow: boolean) => PtzBody }) => {
	// like the pad: a rail remounted mid-hold (theater, C) never sees the pointerup, and the resend would keep it going
	useEffect(() => () => camera.hold.release(`btn:${hold}`), [camera.hold, hold])
	return (
		<button type="button" className="rail-step is-hold" aria-label={label} title={label} {...holdProps(camera, `btn:${hold}`, body)}>
			<Icon name={icon} size={18} />
		</button>
	)
}

const FocusControls = ({ camera }: { camera: Camera }) => {
	const p = camera.controls!.ptz!
	const r = p.focusRange
	const near = useShortcutLabel("cam.focusNear")
	const far = useShortcutLabel("cam.focusFar")
	const f = useCommitted(camera.state?.focus ?? r?.pos ?? 0, pos => void camera.ptz({ op: "focusTo", pos }))
	const [afBusy, setAfBusy] = useState(false)
	return (
		<div className="rail-focus">
			{r ? (
				<RangeRow
					label="Focus"
					min={r.min}
					max={r.max}
					value={f.value}
					onChange={f.set}
					lower={{ icon: "minus", label: withShortcut("Focus nearer", near), step: Math.max(1, Math.round((r.max - r.min) / 40)) }}
					higher={{ icon: "plus", label: withShortcut("Focus farther", far), step: Math.max(1, Math.round((r.max - r.min) / 40)) }}
				/>
			) : (
				p.focus && (
					<div className="rail-holds" role="group" aria-label="Focus (hold)">
						<HoldButton camera={camera} hold="focusNear" icon="minus" label={withShortcut("Focus nearer: hold", near)} body={s => ({ op: "focus", direction: "near", ...slowly(s) })} />
						<span className="rail-holds-label">Focus</span>
						<HoldButton camera={camera} hold="focusFar" icon="plus" label={withShortcut("Focus farther: hold", far)} body={s => ({ op: "focus", direction: "far", ...slowly(s) })} />
					</div>
				)
			)}
			{p.autofocus !== null && (
				<label className="rail-row">
					<span className="rail-row-label">Autofocus</span>
					<Switch
						checked={p.autofocus}
						label="Autofocus"
						disabled={afBusy}
						onChange={async on => {
							setAfBusy(true)
							await camera.setting({ setting: "autofocus", on })
							setAfBusy(false)
						}}
					/>
				</label>
			)}
		</div>
	)
}

export const MoveSection = ({ camera, onAim }: { camera: Camera; onAim?: () => void }) => {
	const p = camera.controls!.ptz!
	const [focusOpen, setFocusOpen] = useState(false)
	const aimKey = useShortcutLabel("cam.aim")
	const hasFocus = p.focus || p.focusRange !== null || p.autofocus !== null
	return (
		<RailSection title="Move" className="rail-move">
			<Dpad camera={camera} />
			<ZoomControl camera={camera} />
			{(hasFocus || (onAim && p.box)) && (
				<div className="rail-move-more">
					{hasFocus && (
						<button type="button" className="rail-disclose" aria-expanded={focusOpen} onClick={() => setFocusOpen(o => !o)}>
							<Icon name="chevronRight" size={16} />
							Focus
						</button>
					)}
					{onAim && p.box && (
						<button type="button" className="btn btn-ghost btn-sm rail-aim" onClick={onAim} title={withShortcut("Aim: drag a box on the picture to frame it", aimKey)}>
							<Icon name="aim" size={16} />
							Aim
						</button>
					)}
				</div>
			)}
			{hasFocus && focusOpen && <FocusControls camera={camera} />}
		</RailSection>
	)
}
