import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import type { LiveSourceDto, LiveStream } from "../../../src/api-types.ts"
import type { PlayerState } from "../components/LivePlayer.tsx"
import type { WheelMode } from "../components/LiveStage.tsx"
import { Icon, type IconName } from "../components/Icon.tsx"
import { Dialog } from "../feedback.tsx"
import { humanize } from "../format.ts"
import { ShortcutKeys, useShortcutLabel } from "../keyboard.tsx"
import type { ActionId } from "../keys.ts"

// The Live page's menus: a small popover primitive, the camera picker's and the ⋯ More menu's lists, and
// the Stream info dialog. Menus open upward, over the picture, since the tools sit at its bottom edge.

/** The key an action is on right now ("S", "Ctrl++"), or null (no action, or no key). */
export const useKeyOf = (id: ActionId | undefined): string | null => {
	const key = useShortcutLabel(id ?? "app.shortcuts")
	return id ? key : null
}

/** Open/close for a popover anchored in `wrapRef`: a click outside or Esc closes it, and Esc gives focus back to the trigger. */
export const usePopover = (onOpenChange?: (open: boolean) => void) => {
	const [open, setOpen] = useState(false)
	const wrapRef = useRef<HTMLDivElement>(null)
	const triggerRef = useRef<HTMLButtonElement>(null)
	const changed = useRef(onOpenChange)
	changed.current = onOpenChange
	const set = useCallback((v: boolean) => {
		setOpen(v)
		changed.current?.(v)
	}, [])
	useEffect(() => {
		if (!open) return
		const doc = wrapRef.current?.ownerDocument ?? document
		const onDown = (e: PointerEvent) => {
			if (!wrapRef.current?.contains(e.target as Node)) set(false)
		}
		doc.addEventListener("pointerdown", onDown, true)
		return () => doc.removeEventListener("pointerdown", onDown, true)
	}, [open, set])
	const close = useCallback(() => set(false), [set])
	return {
		open,
		wrapRef,
		triggerRef,
		toggle: () => set(!open),
		close,
		onKeyDown: (e: KeyboardEvent) => {
			if (e.key !== "Escape") return
			// the page's own Esc (leave theater, stop aiming) must not also fire
			e.preventDefault()
			e.stopPropagation()
			set(false)
			triggerRef.current?.focus()
		}
	}
}

/** Arrow keys, Home and End move between a menu's items. */
const roveMenu = (e: KeyboardEvent<HTMLElement>) => {
	const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)')]
	if (!items.length) return
	const i = items.indexOf(e.target as HTMLElement)
	let next: number | null = null
	if (e.key === "ArrowDown") next = (i + 1) % items.length
	else if (e.key === "ArrowUp") next = (i - 1 + items.length) % items.length
	else if (e.key === "Home") next = 0
	else if (e.key === "End") next = items.length - 1
	if (next === null) return
	e.preventDefault()
	e.stopPropagation()
	items[next]?.focus()
}

export const Menu = ({
	label,
	trigger,
	tip,
	action,
	className = "",
	triggerClass = "lv-tool",
	onOpenChange,
	children
}: {
	label: string
	/** What the trigger button shows. */
	trigger: ReactNode
	tip: string
	action?: ActionId
	className?: string
	triggerClass?: string
	onOpenChange?: (open: boolean) => void
	children: (close: () => void) => ReactNode
}) => {
	const pop = usePopover(onOpenChange)
	const menuRef = useRef<HTMLDivElement>(null)
	const keyName = useKeyOf(action)
	// focus the chosen (or first) item on open, as a menu button does
	useEffect(() => {
		if (!pop.open) return
		const m = menuRef.current
		;(m?.querySelector<HTMLElement>('[aria-checked="true"]') ?? m?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)'))?.focus()
	}, [pop.open])
	return (
		<div className={`lv-pop-wrap ${className}`} ref={pop.wrapRef}>
			<button
				type="button"
				ref={pop.triggerRef}
				className={`${triggerClass}${pop.open ? " is-open" : ""}`}
				aria-haspopup="menu"
				aria-expanded={pop.open}
				aria-label={label}
				onClick={pop.toggle}
				onKeyDown={e => {
					if (e.key === "ArrowUp" || e.key === "ArrowDown") {
						e.preventDefault()
						e.stopPropagation()
						if (!pop.open) pop.toggle()
					}
				}}
			>
				{trigger}
				{!pop.open && (
					<span className="lv-tip" aria-hidden="true">
						{tip}
						{keyName && <kbd className="kbd">{keyName}</kbd>}
					</span>
				)}
			</button>
			{pop.open && (
				<div
					ref={menuRef}
					className="lv-menu"
					role="menu"
					aria-label={label}
					onKeyDown={e => {
						pop.onKeyDown(e)
						if (e.key === "Tab") pop.close()
						else roveMenu(e)
					}}
				>
					{children(pop.close)}
				</div>
			)}
		</div>
	)
}

export const MenuItem = ({
	icon,
	checked,
	radio,
	disabled,
	onSelect,
	hint,
	action,
	children
}: {
	icon?: IconName
	/** A checkable item (shows a tick when on); undefined = a plain item. */
	checked?: boolean
	/** One of a set (a `menuitemradio`): checking it unchecks the others. */
	radio?: boolean
	disabled?: boolean
	onSelect: () => void
	hint?: string
	action?: ActionId
	children: ReactNode
}) => {
	return (
		<button
			type="button"
			role={radio ? "menuitemradio" : checked === undefined ? "menuitem" : "menuitemcheckbox"}
			aria-checked={checked}
			className="lv-menu-item"
			disabled={disabled}
			tabIndex={-1}
			onClick={onSelect}
		>
			<span className="lv-menu-icon">{checked ? <Icon name="check" size={18} /> : icon ? <Icon name={icon} size={18} /> : null}</span>
			<span className="lv-menu-text">
				{children}
				{hint && <span className="lv-menu-hint">{hint}</span>}
			</span>
			{action && <ShortcutKeys id={action} />}
		</button>
	)
}

/** An item that moved into ⋯ More because the toolbar is narrow. */
export type MoreExtra = { icon: IconName; label: string; action?: ActionId; checked?: boolean; run: () => void }

export const MoreMenu = ({
	extras,
	zone,
	wheel,
	onStreamInfo,
	onShortcuts,
	onAway,
	onOpenChange
}: {
	extras: MoreExtra[]
	/** The detection zone outline: null when there's no zone to show. */
	zone: { on: boolean; toggle: () => void } | null
	/** What the wheel zooms first: null without a camera lens to zoom. */
	wheel: { mode: WheelMode; set: (mode: WheelMode) => void } | null
	onStreamInfo: () => void
	onShortcuts: () => void
	onAway: () => void
	onOpenChange?: (open: boolean) => void
}) => (
	<Menu label="More" tip="More" trigger={<Icon name="dots" size={20} />} onOpenChange={onOpenChange} className="lv-more">
		{close => {
			const run = (f: () => void) => () => {
				close()
				f()
			}
			return (
				<>
					{extras.map(x => (
						<MenuItem key={x.label} icon={x.icon} checked={x.checked} action={x.action} onSelect={run(x.run)}>
							{x.label}
						</MenuItem>
					))}
					{extras.length > 0 && <hr className="lv-menu-sep" />}
					<MenuItem
						icon="target"
						checked={zone?.on ?? false}
						disabled={!zone}
						action="view.zone"
						hint={zone ? undefined : "No zone set yet (Settings)"}
						onSelect={() => {
							if (!zone) return
							close()
							zone.toggle()
						}}
					>
						Show detection zone
					</MenuItem>
					{wheel && (
						<>
							<hr className="lv-menu-sep" />
							<MenuItem radio checked={wheel.mode === "camera"} onSelect={run(() => wheel.set("camera"))}>
								Wheel: camera zoom first
							</MenuItem>
							<MenuItem radio checked={wheel.mode === "picture"} onSelect={run(() => wheel.set("picture"))}>
								Wheel: magnify first
							</MenuItem>
							<hr className="lv-menu-sep" />
						</>
					)}
					<MenuItem icon="info" onSelect={run(onStreamInfo)}>
						Stream info
					</MenuItem>
					<MenuItem icon="keyboard" action="app.shortcuts" onSelect={run(onShortcuts)}>
						Keyboard shortcuts
					</MenuItem>
					<MenuItem icon="globe" onSelect={run(onAway)}>
						Watching from away
					</MenuItem>
				</>
			)
		}}
	</Menu>
)

const PATH_TEXT = {
	copy: "The camera's own video, passed straight through",
	transcode: "Re-encoded by look4 so this browser can play it",
	pictures: "A stream of pictures (this browser can't play the video)"
} as const

/** What's playing, for when something looks off: which stream, how big, which codec and how it gets here. */
export const StreamInfoDialog = ({
	open,
	onClose,
	src,
	stream,
	state,
	model
}: {
	open: boolean
	onClose: () => void
	src: LiveSourceDto
	stream: LiveStream
	state: PlayerState
	model: string | null
}) => {
	const playing = state.phase === "playing" ? state : null
	const rows: [string, ReactNode][] = [
		["Camera", `${humanize(src.name)}${model ? ` · ${model}` : ""}${src.aliases.length ? ` (also ${src.aliases.map(humanize).join(", ")})` : ""}`],
		[
			"Stream",
			src.feed === "stills"
				? "Stills: the camera's video stream is off"
				: src.streams.length > 1
					? stream === "main"
						? "Sharp (the camera's main stream)"
						: "Quick (the camera's light sub-stream)"
					: "The camera's only stream"
		],
		["Picture", playing && playing.width > 0 ? `${playing.width} × ${playing.height}` : state.phase === "connecting" ? "Connecting…" : "—"],
		["How", playing ? PATH_TEXT[playing.path] : "—"],
		["Codec", playing?.codec ? <code>{playing.codec}</code> : "—"],
		["Sound", playing?.codec ? (/mp4a/.test(playing.codec) ? "Yes" : "No sound track") : "—"],
		["Recording", src.recording ? "look4 records this camera, so Record can save clips" : "Not recorded by look4"]
	]
	return (
		<Dialog open={open} title="Stream info" onClose={onClose} size="sm">
			<dl className="lv-info">
				{rows.map(([k, v]) => (
					<div key={k}>
						<dt>{k}</dt>
						<dd>{v}</dd>
					</div>
				))}
			</dl>
			{state.phase === "error" && <p className="lv-info-error">{state.message}</p>}
		</Dialog>
	)
}
