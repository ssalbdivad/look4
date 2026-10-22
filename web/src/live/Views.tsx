import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react"
import type { CameraPreset } from "../../../src/api-types.ts"
import { Icon, type IconName } from "../components/Icon.tsx"
import { Dialog, useFeedback } from "../feedback.tsx"
import { useShortcutLabel, withShortcut } from "../keyboard.tsx"
import { RailSection } from "./Rail.tsx"
import type { Camera } from "./useCamera.ts"

// Saved views: the camera's presets as thumbnails, Home first, and "Save this view".

/** "View 3": the first free number, so names never repeat. */
export const nextViewName = (presets: Pick<CameraPreset, "name">[]) => {
	const taken = new Set(presets.map(p => p.name.trim().toLowerCase()))
	let n = presets.length + 1
	while (taken.has(`view ${n}`)) n++
	return `View ${n}`
}

/** The camera's limit on view names (Reolink: 31 characters). */
const MAX_NAME = 31

type Prompt = { title: string; initial: string; action: string; run: (name: string) => Promise<boolean> }

export const ViewsSection = ({ source, camera }: { source: string; camera: Camera }) => {
	const { confirm } = useFeedback()
	const p = camera.controls!.ptz!
	const [prompt, setPrompt] = useState<Prompt | null>(null)
	const homeKey = useShortcutLabel("cam.home")
	const canSave = p.maxPresets > p.presets.length
	const atHome = camera.view === "home" || (camera.view === null && camera.state?.atHome === true)

	const go = (id: number) => void camera.ptz({ op: "preset", id })

	return (
		<RailSection title="Views" className="rail-views-sec">
			<ul className="rail-views" aria-label={`Saved views of ${source}`}>
				{p.guard && (
					<li className={atHome ? "rail-view is-on" : "rail-view"}>
						<button
							type="button"
							className="rail-view-btn"
							disabled={!p.guard.set}
							aria-pressed={atHome}
							title={p.guard.set ? withShortcut("Back home", homeKey) : "No Home yet: point the camera and use Make this view Home"}
							onClick={() => void camera.home()}
						>
							<span className="rail-view-img is-home">
								<Icon name="home" size={26} />
								{camera.view === "home" && camera.moving && <Moving />}
							</span>
							<span className="rail-view-name">Home</span>
						</button>
					</li>
				)}
				{p.presets.map((v, i) => {
					const on = camera.view === v.id
					return (
						<li key={v.id} className={on ? "rail-view is-on" : "rail-view"}>
							<button type="button" className="rail-view-btn" aria-pressed={on} title={i < 9 ? `${v.name} (${i + 1})` : v.name} onClick={() => go(v.id)}>
								<ViewThumb src={v.image} />
								{on && camera.moving && <Moving />}
								<span className="rail-view-name">{v.name}</span>
							</button>
							{i < 9 && (
								<kbd className="rail-view-key" aria-hidden="true">
									{i + 1}
								</kbd>
							)}
							<ViewMenu
								label={`More for ${v.name}`}
								items={[
									{
										icon: "pencil",
										label: "Rename",
										run: () =>
											setPrompt({
												title: "Rename view",
												initial: v.name,
												action: "Rename",
												run: name => camera.preset({ op: "rename", id: v.id, name })
											})
									},
									{
										icon: "refresh",
										label: "Update to this view",
										run: async () => {
											const ok = await confirm({
												title: `Update “${v.name}”?`,
												body: "It will point where the camera points now.",
												confirmLabel: "Update"
											})
											if (ok) await camera.preset({ op: "save", id: v.id, name: v.name })
										}
									},
									{
										icon: "trash",
										label: "Delete",
										danger: true,
										run: async () => {
											const ok = await confirm({ title: `Delete “${v.name}”?`, body: "The camera forgets this view.", confirmLabel: "Delete", danger: true })
											if (ok) await camera.preset({ op: "delete", id: v.id })
										}
									}
								]}
							/>
						</li>
					)
				})}
				{canSave && (
					<li className="rail-view">
						<button
							type="button"
							className="rail-view-btn is-add"
							onClick={() =>
								setPrompt({
									title: "Save this view",
									initial: nextViewName(p.presets),
									action: "Save",
									run: name => camera.preset({ op: "save", name })
								})
							}
						>
							<span className="rail-view-img is-add">
								<Icon name="plus" size={22} />
							</span>
							<span className="rail-view-name">Save this view</span>
						</button>
					</li>
				)}
			</ul>
			{prompt && <NameDialog {...prompt} onClose={() => setPrompt(null)} />}
		</RailSection>
	)
}

const Moving = () => (
	<span className="rail-view-moving" role="status">
		<span className="spinner" aria-hidden="true" />
		<span className="sr-only">Moving…</span>
	</span>
)

const ViewThumb = ({ src }: { src: string | null }) => {
	const [failed, setFailed] = useState<string | null>(null)
	return (
		<span className="rail-view-img">
			{src && failed !== src ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(src)} /> : <Icon name="pin" size={22} />}
		</span>
	)
}

const NameDialog = ({ title, initial, action, run, onClose }: Prompt & { onClose: () => void }) => {
	const [name, setName] = useState(initial)
	const [busy, setBusy] = useState(false)
	const clean = name.trim()
	const submit = async (e: FormEvent) => {
		e.preventDefault()
		if (!clean || busy) return
		setBusy(true)
		const ok = await run(clean)
		setBusy(false)
		if (ok) onClose()
	}
	return (
		<Dialog open title={title} onClose={onClose} size="sm">
			<form className="rail-name-form" onSubmit={submit}>
				<label className="sr-only" htmlFor="rail-view-name">
					Name
				</label>
				<input
					id="rail-view-name"
					value={name}
					maxLength={MAX_NAME}
					data-autofocus
					onFocus={e => e.currentTarget.select()}
					onChange={e => setName(e.target.value)}
				/>
				<div className="dialog-actions">
					<button type="button" className="btn btn-ghost" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn btn-primary" disabled={!clean || busy}>
						{busy && <span className="spinner" aria-hidden="true" />}
						{action}
					</button>
				</div>
			</form>
		</Dialog>
	)
}

type MenuItem = { icon: IconName; label: string; danger?: boolean; run: () => void | Promise<void> }

/**
 * A view's ⋯ menu, as a popover: the top layer escapes the rail's scrolling and its blurred overlay
 * (which would clip or re-anchor a positioned menu), and the browser closes it on Esc or a click away.
 */
const ViewMenu = ({ label, items }: { label: string; items: MenuItem[] }) => {
	const btn = useRef<HTMLButtonElement>(null)
	const pop = useRef<HTMLDivElement>(null)
	const [open, setOpen] = useState(false)

	const place = () => {
		const b = btn.current
		const m = pop.current
		const win = b?.ownerDocument.defaultView
		if (!b || !m || !win) return
		const r = b.getBoundingClientRect()
		const left = Math.max(8, Math.min(r.right - m.offsetWidth, win.innerWidth - m.offsetWidth - 8))
		const below = r.bottom + 4
		const top = below + m.offsetHeight > win.innerHeight - 8 ? Math.max(8, r.top - m.offsetHeight - 4) : below
		m.style.left = `${left}px`
		m.style.top = `${top}px`
	}

	useEffect(() => {
		if (!open) return
		const win = btn.current?.ownerDocument.defaultView
		const close = () => pop.current?.hidePopover()
		win?.addEventListener("resize", close)
		win?.addEventListener("scroll", close, true)
		return () => {
			win?.removeEventListener("resize", close)
			win?.removeEventListener("scroll", close, true)
		}
	}, [open])

	return (
		<>
			<button
				ref={btn}
				type="button"
				className="rail-view-more"
				aria-label={label}
				title={label}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => {
					const m = pop.current
					if (!m) return
					if (open) m.hidePopover()
					else {
						m.showPopover()
						place()
						m.querySelector<HTMLElement>("[role=menuitem]")?.focus()
					}
				}}
			>
				<Icon name="dots" size={16} />
			</button>
			<div
				ref={pop}
				popover="auto"
				className="menu rail-menu"
				role="menu"
				aria-label={label}
				onToggle={e => setOpen((e as unknown as { newState: string }).newState === "open")}
				onKeyDown={e => {
					if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
					e.preventDefault()
					const all = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")]
					const i = all.indexOf(e.target as HTMLElement)
					all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus()
				}}
			>
				{items.map(it => (
					<MenuButton
						key={it.label}
						item={it}
						onPick={() => {
							pop.current?.hidePopover()
							btn.current?.focus()
							void it.run()
						}}
					>
						<Icon name={it.icon} size={16} />
						{it.label}
					</MenuButton>
				))}
			</div>
		</>
	)
}

const MenuButton = ({ item, onPick, children }: { item: MenuItem; onPick: () => void; children: ReactNode }) => (
	<button type="button" role="menuitem" className={item.danger ? "menu-item is-danger" : "menu-item"} onClick={onPick}>
		{children}
	</button>
)
