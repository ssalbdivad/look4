import { type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useRef, useState } from "react"
import type { LiveSourceDto, LiveStream } from "../../../src/api-types.ts"
import { Icon, type IconName } from "../components/Icon.tsx"
import { Switch } from "../components/ui.tsx"
import { humanize } from "../format.ts"
import { releaseAfterClick } from "../keyboard.tsx"
import type { ActionId } from "../keys.ts"
import { Menu, MenuItem, useKeyOf, usePopover } from "./MoreMenu.tsx"

// The strip of tools under the picture (over it in theater, full screen and the pop-out). Left: what you're
// watching and how; right: what you can do. Every button names its key in its tooltip.

/** A tooltip with the key in a keycap. Shown on hover and keyboard focus; never on touch. */
const Tip = ({ label, keyName }: { label: string; keyName: string | null }) => (
	<span className="lv-tip" aria-hidden="true">
		{label}
		{keyName && <kbd className="kbd">{keyName}</kbd>}
	</span>
)

export const ToolButton = ({
	icon,
	label,
	action,
	onClick,
	pressed,
	disabled,
	tone,
	wide,
	children
}: {
	icon: IconName
	label: string
	action?: ActionId
	onClick: () => void
	/** A toggle: aria-pressed, and the "on" look. */
	pressed?: boolean
	disabled?: boolean
	tone?: "rec"
	/** Only on the full bar: the narrow bar moves it into More (so the page leaves it out of the bar's narrowest width). */
	wide?: boolean
	/** A visible label next to the icon. */
	children?: ReactNode
}) => {
	const keyName = useKeyOf(action)
	return (
		<button
			type="button"
			className={`lv-tool${pressed ? " is-on" : ""}${tone ? ` is-${tone}` : ""}${children ? " has-text" : ""}`}
			onClick={onClick}
			disabled={disabled}
			aria-label={children ? undefined : label}
			aria-pressed={pressed}
			aria-keyshortcuts={keyName ?? undefined}
			data-wide={wide || undefined}
		>
			<Icon name={icon} size={20} />
			{children}
			<Tip label={label} keyName={keyName} />
		</button>
	)
}

/** One choice of a few, as radios: Tab lands on the chosen one, the arrow keys move the choice. */
export const Segmented = <t extends string>({
	label,
	value,
	options,
	onChange,
	action
}: {
	label: string
	value: t
	options: { value: t; label: string; hint: string }[]
	onChange: (v: t) => void
	action?: ActionId
}) => {
	const refs = useRef<(HTMLButtonElement | null)[]>([])
	const keyName = useKeyOf(action)
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const i = options.findIndex(o => o.value === value)
		const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0
		if (!step) return
		e.preventDefault()
		// stop the page's arrow-key camera moves while the choice has focus
		e.stopPropagation()
		const next = (i + step + options.length) % options.length
		onChange(options[next]!.value)
		refs.current[next]?.focus()
	}
	return (
		<div className="lv-seg" role="radiogroup" aria-label={label} aria-keyshortcuts={keyName ?? undefined} onKeyDown={onKeyDown}>
			{options.map((o, i) => (
				<button
					key={o.value}
					ref={el => {
						refs.current[i] = el
					}}
					type="button"
					role="radio"
					aria-checked={o.value === value}
					tabIndex={o.value === value ? 0 : -1}
					className="lv-seg-btn"
					onClick={e => {
						onChange(o.value)
						releaseAfterClick(e)
					}}
				>
					{o.label}
					<Tip label={o.hint} keyName={keyName} />
				</button>
			))}
		</div>
	)
}

export type BadgeKind = "live" | "pictures" | "stills" | "waiting"

const BADGE: Record<BadgeKind, { text: string; title: string }> = {
	live: { text: "Live", title: "Live video, about a second behind" },
	pictures: { text: "Pictures", title: "This browser can't play the camera's video, so look4 sends a fresh picture several times a second" },
	stills: { text: "Stills", title: "The camera's video stream is off, so this is a fresh picture every second or so" },
	waiting: { text: "Live", title: "Connecting…" }
}

export const LiveBadge = ({ kind }: { kind: BadgeKind }) => (
	<span className={`lv-badge is-${kind}`} title={BADGE[kind].title}>
		<span className="lv-badge-dot" aria-hidden="true" />
		{BADGE[kind].text}
	</span>
)

/**
 * Mute / unmute. While the camera's own microphone is off there is nothing to hear, so the button opens a
 * small panel that says so and offers the camera's Microphone switch instead.
 */
export const SoundButton = ({
	muted,
	onToggle,
	microphone,
	onMicrophone
}: {
	muted: boolean
	onToggle: () => void
	/** The camera's microphone: false = off (the panel), true = on, null = not a setting look4 can change. */
	microphone: boolean | null
	onMicrophone?: (on: boolean) => Promise<boolean>
}) => {
	const pop = usePopover()
	const [busy, setBusy] = useState(false)
	const keyName = useKeyOf("view.mute")
	const micOff = microphone === false
	const label = micOff ? "Sound: the camera's microphone is off" : muted ? "Turn sound on" : "Mute"
	return (
		<div className="lv-pop-wrap" ref={pop.wrapRef}>
			<button
				type="button"
				className={`lv-tool${!muted && !micOff ? " is-on" : ""}`}
				aria-label={label}
				aria-keyshortcuts={keyName ?? undefined}
				aria-expanded={micOff ? pop.open : undefined}
				aria-haspopup={micOff ? "dialog" : undefined}
				ref={pop.triggerRef}
				onClick={() => (micOff ? pop.toggle() : onToggle())}
			>
				<Icon name={muted || micOff ? "speakerOff" : "speaker"} size={20} />
				{!pop.open && <Tip label={label} keyName={keyName} />}
			</button>
			{pop.open && (
				<div className="lv-popover" role="dialog" aria-label="Sound" onKeyDown={pop.onKeyDown}>
					<p className="lv-popover-title">
						<Icon name="micOff" size={18} />
						The camera's microphone is off
					</p>
					<p className="lv-popover-text">Turn it on to hear the yard here. The camera's own recordings get sound too.</p>
					<label className="lv-popover-row">
						<span>Microphone</span>
						<Switch
							checked={!!microphone}
							disabled={busy || !onMicrophone}
							label="Camera microphone"
							onChange={async on => {
								if (!onMicrophone) return
								setBusy(true)
								const ok = await onMicrophone(on)
								setBusy(false)
								if (ok && on) {
									pop.close()
									if (muted) onToggle()
								}
							}}
						/>
					</label>
				</div>
			)}
		</div>
	)
}

/** Which camera, as a compact menu; only when there are several. */
export const CameraPicker = ({ sources, current, onPick }: { sources: LiveSourceDto[]; current: string; onPick: (name: string) => void }) => (
	<Menu
		label="Camera"
		className="lv-picker"
		trigger={
			<>
				<Icon name="camera" size={18} />
				<span className="lv-picker-name">{humanize(current)}</span>
				<Icon name="chevronDown" size={16} />
			</>
		}
		tip="Switch camera"
		action="view.nextCamera"
	>
		{close =>
			sources.map(s => (
				<MenuItem
					key={s.name}
					checked={s.name === current}
					onSelect={() => {
						close()
						onPick(s.name)
					}}
				>
					{humanize(s.name)}
				</MenuItem>
			))
		}
	</Menu>
)

export type ToolbarProps = {
	variant: "bar" | "overlay" | "pop"
	badge: BadgeKind | null
	sound: { muted: boolean; toggle: () => void; microphone: boolean | null; setMicrophone?: (on: boolean) => Promise<boolean> } | null
	quality: { stream: LiveStream; set: (s: LiveStream) => void } | null
	cameras: { list: LiveSourceDto[]; current: string; pick: (name: string) => void } | null
	aim: { on: boolean; toggle: () => void } | null
	snapshot: { take: () => void; busy: boolean } | null
	record: { phase: "idle" | "starting" | "on" | "saving"; toggle: () => void } | null
	popout: { on: boolean; toggle: () => void } | null
	theater: { on: boolean; toggle: () => void } | null
	fullscreen: { on: boolean; toggle: () => void } | null
	rail: { shown: boolean; toggle: () => void } | null
	more: ReactNode
	/** Pop-out only: back to the look4 window. */
	back?: { label: string; run: () => void }
	hidden?: boolean
	/** Pointer over the tools: keep them up (overlay variants hide themselves when idle). */
	onHover?: (over: boolean) => void
	/** A double-click on the bar's empty space (not a button), as on a window's title bar. */
	onEmptyDoubleClick?: () => void
	/** A press on the bar's empty space: drag the picture by it, as by a window's title bar. */
	onEmptyPointerDown?: (e: PointerEvent<HTMLDivElement>) => void
}

export const Toolbar = (p: ToolbarProps) => {
	const onHover = useRef(p.onHover)
	onHover.current = p.onHover
	// A bar swapped out from under the pointer (its own Theater or Full screen button mounts the other
	// bar) never gets the pointerleave, and the overlay would be kept up for good.
	useEffect(() => () => onHover.current?.(false), [])
	return (
		<div
			className={`lv-bar is-${p.variant}${p.hidden ? " is-hidden" : ""}`}
			role="toolbar"
			aria-label="Live view"
			onPointerEnter={e => e.pointerType === "mouse" && p.onHover?.(true)}
			onPointerLeave={e => e.pointerType === "mouse" && p.onHover?.(false)}
			onDoubleClick={e => {
				const t = e.target as Element
				if (p.onEmptyDoubleClick && (t === e.currentTarget || t.classList.contains("lv-bar-gap"))) p.onEmptyDoubleClick()
			}}
			onPointerDown={e => {
				const t = e.target as Element
				if (p.onEmptyPointerDown && (t === e.currentTarget || t.classList.contains("lv-bar-gap"))) p.onEmptyPointerDown(e)
			}}
		>
			{p.badge && <LiveBadge kind={p.badge} />}
			{p.sound && <SoundButton muted={p.sound.muted} onToggle={p.sound.toggle} microphone={p.sound.microphone} onMicrophone={p.sound.setMicrophone} />}
			{p.quality && (
				<Segmented
					label="Picture quality"
					value={p.quality.stream}
					onChange={p.quality.set}
					action="view.quality"
					options={[
						{ value: "main", label: "Sharp", hint: "Sharp: full resolution" },
						{ value: "sub", label: "Quick", hint: "Quick: the light stream, for slow connections" }
					]}
				/>
			)}
			{p.cameras && <CameraPicker sources={p.cameras.list} current={p.cameras.current} onPick={p.cameras.pick} />}
			<span className="lv-bar-gap" />
			{p.aim && <ToolButton wide icon="aim" label={p.aim.on ? "Stop aiming" : "Aim: drag a box to frame it"} action="cam.aim" pressed={p.aim.on} onClick={p.aim.toggle} />}
			{p.snapshot && <ToolButton icon="camera" label={p.snapshot.busy ? "Saving the snapshot…" : "Snapshot"} action="view.snapshot" disabled={p.snapshot.busy} onClick={p.snapshot.take} />}
			{p.record && (
				<ToolButton
					icon={p.record.phase === "on" ? "stop" : "record"}
					label={p.record.phase === "on" ? "Stop and save" : p.record.phase === "saving" ? "Saving the clip…" : "Record"}
					action="view.record"
					tone="rec"
					pressed={p.record.phase === "on"}
					disabled={p.record.phase === "starting" || p.record.phase === "saving"}
					onClick={p.record.toggle}
				/>
			)}
			{p.popout && <ToolButton wide icon="pip" label={p.popout.on ? "Back into the page" : "Pop out"} action="view.popout" pressed={p.popout.on} onClick={p.popout.toggle} />}
			{p.theater && <ToolButton wide icon="theater" label={p.theater.on ? "Leave theater mode" : "Theater mode"} action="view.theater" pressed={p.theater.on} onClick={p.theater.toggle} />}
			{p.fullscreen && (
				<ToolButton icon={p.fullscreen.on ? "compress" : "expand"} label={p.fullscreen.on ? "Leave full screen" : "Full screen"} action="view.fullscreen" onClick={p.fullscreen.toggle} />
			)}
			{p.rail && <ToolButton icon="sliders" label={p.rail.shown ? "Hide camera controls" : "Camera controls"} action="view.controls" pressed={p.rail.shown} onClick={p.rail.toggle} />}
			{p.more}
			{/* not an arrow: beside the mini d-pad's ← it read as "turn left" */}
			{p.back && <ToolButton icon="pip" label={p.back.label} onClick={p.back.run} />}
		</div>
	)
}
