// THE KEYBOARD RUNTIME AND SHEET. One keydown/keyup listener per window (KeyboardProvider for the app's
// window, useShortcutWindow for a Document Picture-in-Picture one) turns a match from keys.ts into an act.
// Every action is PAGE-OWNED: a page registers a handler while it is mounted (useShortcut), so a key does
// nothing — and the browser keeps it — on a page without the thing. That is what leaves ⌘/Ctrl +, − and 0
// zooming the page everywhere except the Live page, which registers them for its digital zoom.
//
// Overrides live in localStorage["look4:keys"], minimal and sanitized, and follow a rebind in another
// window (the pop-out) through the `storage` event.

import "./keys.css"
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { Icon } from "./components/Icon.tsx"
import { Dialog } from "./feedback.tsx"
import {
	ACTIONS,
	type ActionGroup,
	type ActionId,
	GESTURES,
	GROUP_LABELS,
	type Bindings,
	type Chord,
	type Overrides,
	actionDef,
	assignChord,
	bindingLookup,
	chordFromEvent,
	chordKeycaps,
	chordProblem,
	digitOf,
	effectiveBindings,
	fixedKeys,
	formatChord,
	isDefault,
	matchAction,
	parseChord,
	platformFromHint,
	sanitizeOverrides,
} from "./keys.ts"

const STORAGE_KEY = "look4:keys"

const platform = platformFromHint(
	typeof navigator === "undefined"
		? null
		: ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? navigator.userAgent)
)

// ── the store ───────────────────────────────────────────────────────────────────────────────────────

type Snapshot = {
	overrides: Overrides
	bindings: Bindings
	lookup: Map<string, ActionId>
	/** Actions some mounted component handles right now: the rest are dimmed on the sheet. */
	registered: ReadonlySet<ActionId>
	sheetOpen: boolean
}

const readStored = (): Overrides => {
	try {
		const text = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY)
		return text ? sanitizeOverrides(JSON.parse(text)) : {}
	} catch {
		return {}
	}
}

const withOverrides = (overrides: Overrides) => {
	const bindings = effectiveBindings(overrides)
	return { overrides, bindings, lookup: bindingLookup(bindings) }
}

let snapshot: Snapshot = { ...withOverrides(readStored()), registered: new Set(), sheetOpen: false }
const subscribers = new Set<() => void>()

const update = (patch: Partial<Snapshot>) => {
	snapshot = { ...snapshot, ...patch }
	for (const fn of subscribers) fn()
}

const subscribe = (fn: () => void) => {
	subscribers.add(fn)
	return () => {
		subscribers.delete(fn)
	}
}

const useSnapshot = () => useSyncExternalStore(subscribe, () => snapshot)

const saveOverrides = (overrides: Overrides) => {
	update(withOverrides(overrides))
	try {
		if (Object.keys(overrides).length) localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
		else localStorage.removeItem(STORAGE_KEY)
	} catch {
		// Private mode or a full quota: the change still holds for this tab.
	}
}

const openSheet = () => update({ sheetOpen: true })
const closeSheet = () => update({ sheetOpen: false })

// ── registrations ───────────────────────────────────────────────────────────────────────────────────

type HoldHandler = { down: (e: { slow: boolean }) => void; up: () => void }
type Entry = { kind: "press"; run: () => void } | ({ kind: "hold"; slow?: (slow: boolean) => void } & HoldHandler)

const registry = new Map<ActionId, Entry[]>()
/** Keys down right now that started a hold, by physical key (`code`), so a keyup with different
 *  modifiers still ends it. */
const active = new Map<string, Active>()
const digitHandlers: ((n: number) => void)[] = []

const syncRegistered = () => {
	const ids = new Set<ActionId>()
	for (const [id, list] of registry) if (list.length) ids.add(id)
	update({ registered: ids })
}

const register = (id: ActionId, entry: Entry): (() => void) => {
	registry.set(id, [...(registry.get(id) ?? []), entry])
	syncRegistered()
	return () => {
		const list = registry.get(id) ?? []
		const index = list.lastIndexOf(entry)
		if (index !== -1) registry.set(id, list.toSpliced(index, 1))
		syncRegistered()
		// A component going away mid-hold still gets its end, so a camera move never outlives its page.
		if (entry.kind === "hold") endWhere((_code, held) => held.entry === entry)
	}
}

type Active = { entry: Entry & { kind: "hold" }; mod: boolean }

const endWhere = (test: (code: string, held: Active) => boolean) => {
	const ended = new Set<Entry>()
	for (const [code, held] of active) {
		if (!test(code, held)) continue
		active.delete(code)
		ended.add(held.entry)
	}
	for (const entry of ended) {
		// Another physical key for the same action (= and numpad +) can still be holding it.
		if ([...active.values()].some(held => held.entry === entry)) continue
		if (entry.kind === "hold") entry.up()
	}
}

const endAll = () => endWhere(() => true)

// ── the gate ────────────────────────────────────────────────────────────────────────────────────────

const asElement = (node: unknown): Element | null =>
	node && typeof node === "object" && (node as Node).nodeType === 1 ? (node as Element) : null

// The element's own role decides; `instanceof` would fail for elements in a Picture-in-Picture window.
const TEXT_ROLES = new Set(["textbox", "searchbox", "combobox", "slider", "spinbutton", "separator"])
const NOT_TYPING_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "color", "file", "image"])

/** A text field, select, slider or focused splitter: every plain key is the control's own. */
const isTypingTarget = (el: Element | null): boolean => {
	if (!el) return false
	if ((el as HTMLElement).isContentEditable) return true
	const tag = el.tagName
	if (tag === "TEXTAREA" || tag === "SELECT") return true
	if (tag === "INPUT") return !NOT_TYPING_INPUTS.has((el as HTMLInputElement).type)
	return TEXT_ROLES.has(el.getAttribute("role") ?? "")
}

// Widgets that move between their own items with the arrows (a segmented Sharp | Quick, a menu, tabs).
const ARROW_WIDGETS = '[role="radiogroup"], [role="tablist"], [role="listbox"], [role="menu"], [role="menubar"], [role="grid"], [role="tree"]'
const NAV_KEYS = new Set(["arrowleft", "arrowright", "arrowup", "arrowdown", "home", "end", "pageup", "pagedown"])

const OVERLAYS = 'dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"], [role="menu"], [role="listbox"]'

const overlayOpen = (doc: Document): boolean =>
	[...doc.querySelectorAll(OVERLAYS)].some(el => (el as Element & { checkVisibility?: () => boolean }).checkVisibility?.() ?? true)

/**
 * Whether a plain key is the PAGE's: not typed into a field, not taken by a focused widget, not under a
 * dialog or menu, not already handled. Exported for the page's own fixed keys (Esc).
 */
export const isPageKey = (event: KeyboardEvent, key?: string): boolean => {
	if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return false
	const target = asElement(event.target)
	const doc = target?.ownerDocument ?? document
	const focused = asElement(doc.activeElement)
	if (isTypingTarget(target) || isTypingTarget(focused)) return false
	if (key && NAV_KEYS.has(key) && (target?.closest(ARROW_WIDGETS) || focused?.closest(ARROW_WIDGETS))) return false
	return !overlayOpen(doc)
}

/**
 * For a control that keeps plain keys while focused (a radio group takes the arrows, a slider every key):
 * after a click, hand them back, so ← goes on turning the camera instead of flipping Sharp | Quick or
 * nudging the zoom. Chrome leaves focus on a clicked button or slider until the next click elsewhere.
 * A keyboard user who tabbed in pressed Space or Enter (`detail` 0) and keeps the control's own keys.
 */
export const releaseAfterClick = (event: { detail: number; currentTarget: HTMLElement }) => {
	if (event.detail) event.currentTarget.blur()
}

/** releaseAfterClick for a slider, from its pointerdown: a drag ends wherever the pointer is let go. */
export const releaseAfterDrag = (event: { currentTarget: HTMLElement }) => {
	const el = event.currentTarget
	const doc = el.ownerDocument
	const done = () => {
		doc.removeEventListener("pointerup", done)
		doc.removeEventListener("pointercancel", done)
		if (doc.activeElement === el) el.blur()
	}
	doc.addEventListener("pointerup", done)
	doc.addEventListener("pointercancel", done)
}

// ── the listener ────────────────────────────────────────────────────────────────────────────────────

const holdId = (event: KeyboardEvent, chord: Chord) => event.code || chord.key

const onKeyDown = (event: KeyboardEvent) => {
	if (event.isComposing || event.keyCode === 229) return
	if (event.key === "Shift") {
		if (!event.repeat) for (const { entry } of new Set(active.values())) entry.slow?.(true)
		return
	}
	const match = matchAction(event, snapshot.lookup)
	if (match) {
		const { action, chord } = match
		// The sheet's own key closes it; every other plain key waits for the overlay to go.
		const sheetKey = action === "app.shortcuts" && snapshot.sheetOpen && !event.defaultPrevented
		if (!chord.mod && !sheetKey && !isPageKey(event, chord.key)) return
		const entry = registry.get(action)?.at(-1)
		if (!entry) return
		event.preventDefault()
		if (entry.kind === "hold") {
			const id = holdId(event, chord)
			if (event.repeat || active.has(id)) return
			const already = [...active.values()].some(held => held.entry === entry)
			active.set(id, { entry, mod: chord.mod })
			if (!already) entry.down({ slow: match.slow })
			return
		}
		if (event.repeat && !actionDef(action).repeat) return
		entry.run()
		return
	}
	const digit = digitOf(event)
	const handler = digitHandlers.at(-1)
	if (digit === null || !handler || !isPageKey(event)) return
	event.preventDefault()
	if (!event.repeat) handler(digit)
}

const onKeyUp = (event: KeyboardEvent) => {
	if (!active.size) return
	if (event.key === "Shift") {
		for (const { entry } of new Set(active.values())) entry.slow?.(false)
		return
	}
	// A Mac sends no keyup for a key released while ⌘ is down: letting go of ⌘ ends what it started.
	if (event.key === "Meta" || event.key === "Control") return endWhere((_code, held) => held.mod)
	const id = event.code || chordFromEvent(event)?.key
	if (id) endWhere(code => code === id)
}

const onHidden = (event: Event) => {
	if (event.type !== "visibilitychange" || document.visibilityState === "hidden") endAll()
}

const attach = (win: Window): (() => void) => {
	win.addEventListener("keydown", onKeyDown)
	win.addEventListener("keyup", onKeyUp)
	// A key released while the window is not focused never reports its keyup.
	win.addEventListener("blur", endAll)
	win.document.addEventListener("visibilitychange", onHidden)
	return () => {
		win.removeEventListener("keydown", onKeyDown)
		win.removeEventListener("keyup", onKeyUp)
		win.removeEventListener("blur", endAll)
		win.document.removeEventListener("visibilitychange", onHidden)
		endAll()
	}
}

// ── public hooks ────────────────────────────────────────────────────────────────────────────────────

/** The app's one listener, the `?` sheet, and cross-window sync of rebinds. Mount once, near the root. */
export const KeyboardProvider = ({ children }: { children: ReactNode }) => {
	useEffect(() => attach(window), [])
	useEffect(
		() =>
			register("app.shortcuts", {
				kind: "press",
				run: () => (snapshot.sheetOpen ? closeSheet() : openSheet()),
			}),
		[]
	)
	useEffect(() => {
		const onStorage = (event: StorageEvent) => {
			if (event.key === STORAGE_KEY || event.key === null) update(withOverrides(readStored()))
		}
		window.addEventListener("storage", onStorage)
		return () => window.removeEventListener("storage", onStorage)
	}, [])
	return (
		<>
			{children}
			<SheetHost />
		</>
	)
}

const SheetHost = () => <KeyboardShortcutsSheet open={useSnapshot().sheetOpen} onClose={closeSheet} />

/** Keys pressed in another window of the app (a Document Picture-in-Picture pop-out) act too. */
export const useShortcutWindow = (win: Window | null | undefined) => {
	useEffect(() => (win && win !== window ? attach(win) : undefined), [win])
}

/**
 * Register a page's handler while mounted. A function is a press (auto-repeat ignored unless the action
 * repeats); `{ down, up }` is a hold: `down` once when the key goes down (`slow` when Shift is held), `up`
 * when it comes up, the window loses focus, or the component unmounts.
 */
export const useShortcut = (
	id: ActionId,
	handler: (() => void) | { down: (e: { slow: boolean }) => void; up: () => void },
	enabled = true
) => {
	const ref = useRef(handler)
	ref.current = handler
	const hold = typeof handler !== "function"
	useEffect(() => {
		if (!enabled) return
		const call = () => ref.current
		const entry: Entry = hold
			? {
					kind: "hold",
					down: e => {
						const h = call()
						if (typeof h === "function") h()
						else h.down(e)
					},
					up: () => {
						const h = call()
						if (typeof h !== "function") h.up()
					},
				}
			: {
					kind: "press",
					run: () => {
						const h = call()
						if (typeof h === "function") h()
						else h.down({ slow: false })
					},
				}
		return register(id, entry)
	}, [id, enabled, hold])
}

/**
 * Several hold actions as one, for moves that combine: `onChange` gets the actions held now, in the order
 * they went down, and whether Shift is held, every time either changes — including Shift pressed or
 * released mid-move. The rail turns ← + ↑ into a diagonal with `heldDirection` and sends a stop on [].
 */
export const useHeldShortcuts = (
	ids: readonly ActionId[],
	onChange: (held: ActionId[], slow: boolean) => void,
	enabled = true
) => {
	const ref = useRef(onChange)
	ref.current = onChange
	const key = ids.join(" ")
	useEffect(() => {
		if (!enabled) return
		let held: ActionId[] = []
		let slow = false
		const emit = () => ref.current([...held], slow)
		const offs = (key.split(" ") as ActionId[]).map(id =>
			register(id, {
				kind: "hold",
				down: e => {
					held = [...held.filter(h => h !== id), id]
					slow = e.slow
					emit()
				},
				up: () => {
					held = held.filter(h => h !== id)
					if (!held.length) slow = false
					emit()
				},
				slow: next => {
					if (next === slow || !held.length) return
					slow = next
					emit()
				},
			})
		)
		return () => {
			for (const off of offs) off()
		}
	}, [key, enabled])
}

/** Digit keys 1–9 (fixed): the page's saved views. */
export const useDigitShortcut = (handler: (n: number) => void, enabled = true) => {
	const ref = useRef(handler)
	ref.current = handler
	useEffect(() => {
		if (!enabled) return
		const run = (n: number) => ref.current(n)
		digitHandlers.push(run)
		return () => {
			const index = digitHandlers.lastIndexOf(run)
			if (index !== -1) digitHandlers.splice(index, 1)
		}
	}, [enabled])
}

const labelOf = (id: ActionId) => {
	const chord = snapshot.bindings[id]
	return chord ? formatChord(chord, platform) : null
}

/** An action's CURRENT key ("S", "⌘+", "Ctrl++"), or null when it has none. Follows a rebind live. */
export const useShortcutLabel = (id: ActionId): string | null => useSyncExternalStore(subscribe, () => labelOf(id))

/** "Snapshot (S)": the control's own words, then its key. */
export const withShortcut = (label: string, key: string | null): string => (key ? `${label} (${key})` : label)

/** What `?` does. */
export const useShortcutsSheet = (): { open: () => void } => ({ open: openSheet })

// ── keycaps ─────────────────────────────────────────────────────────────────────────────────────────

const KeycapList = ({ caps, label, muted }: { caps: readonly string[]; label: string; muted?: boolean }) => (
	<span className={`kbd-group${muted ? " is-muted" : ""}`} aria-label={label}>
		{caps.map((cap, i) => (
			<kbd key={i} className="kbd" aria-hidden="true">
				{cap}
			</kbd>
		))}
	</span>
)

export const Keycaps = ({ chord, muted }: { chord: Chord; muted?: boolean }) => (
	<KeycapList caps={chordKeycaps(chord, platform)} label={formatChord(chord, platform)} muted={muted} />
)

/** The current key of an action as caps, or nothing when it has none (for menus that show keys). */
export const ShortcutKeys = ({ id }: { id: ActionId }) => {
	const chord = useSnapshot().bindings[id]
	return chord ? <Keycaps chord={chord} muted /> : null
}

// ── the sheet ───────────────────────────────────────────────────────────────────────────────────────

type Held = { mod: boolean; alt: boolean; shift: boolean }
const NOTHING_HELD: Held = { mod: false, alt: false, shift: false }

const GROUPS: ActionGroup[] = ["camera", "picture", "anywhere"]

/**
 * The whole keyboard on one card, and where it is changed: click a key, press the new one. A key another
 * action holds SWAPS the two (keys.ts assignChord) and the status line says what moved where; a key the
 * browser or the page owns is refused on the spot with the reason, and the row shakes. Every change saves
 * as it is made.
 */
export const KeyboardShortcutsSheet = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
	const { overrides, bindings, registered } = useSnapshot()
	const [recording, setRecording] = useState<ActionId | null>(null)
	const [held, setHeld] = useState<Held>(NOTHING_HELD)
	const [problem, setProblem] = useState<{ id: ActionId; text: string; nonce: number } | null>(null)
	const [changed, setChanged] = useState<{ ids: ActionId[]; nonce: number }>({ ids: [], nonce: 0 })
	const [status, setStatus] = useState("")
	const nonce = useRef(0)
	// Esc while recording cancels the recording; the native <dialog> may still take the same press as
	// "close" (its cancel event follows the keydown in the same task), so that one close is ignored.
	const keepOpen = useRef(false)

	useEffect(() => {
		if (open) return
		setRecording(null)
		setProblem(null)
		setStatus("")
	}, [open])

	const keysOf = (id: ActionId, from: Bindings) => {
		const chord = from[id]
		return chord ? formatChord(chord, platform) : null
	}
	const nameOf = (id: ActionId) => actionDef(id).label

	const commit = (id: ActionId, chord: Chord | null) => {
		const { overrides: next, swappedWith } = assignChord(snapshot.overrides, id, chord)
		saveOverrides(next)
		const after = effectiveBindings(next)
		setRecording(null)
		setHeld(NOTHING_HELD)
		setProblem(null)
		setChanged({ ids: swappedWith ? [id, swappedWith] : [id], nonce: ++nonce.current })
		if (!chord) setStatus(`${nameOf(id)} has no key now`)
		else if (swappedWith) {
			const moved = keysOf(swappedWith, after)
			setStatus(`${nameOf(id)} is now ${keysOf(id, after)}. ${nameOf(swappedWith)} ${moved ? `took ${moved}` : "has no key now"}`)
		} else setStatus(`${nameOf(id)} is now ${keysOf(id, after)}`)
	}

	const reset = (id: ActionId) => {
		const def = actionDef(id).defaultChord
		commit(id, def === null ? null : parseChord(def))
		const back = def === null ? null : parseChord(def)
		setStatus(back ? `${nameOf(id)} is back to ${formatChord(back, platform)}` : `${nameOf(id)} is back to no key`)
	}

	const resetAll = () => {
		const moved = ACTIONS.filter(a => !isDefault(snapshot.overrides, a.id)).map(a => a.id)
		saveOverrides({})
		setRecording(null)
		setProblem(null)
		setChanged({ ids: moved, nonce: ++nonce.current })
		setStatus("Every shortcut is back to its default")
	}

	// RECORDING owns the keyboard: window CAPTURE, ahead of the dialog's Esc and of the runtime's listener,
	// so pressing `?` or ⌘+ to bind it binds it instead of doing it. Tab is let through: it leaves the row.
	useEffect(() => {
		if (!recording) return
		const id = recording
		const onDown = (event: KeyboardEvent) => {
			if (event.key === "Tab") {
				setRecording(null)
				setHeld(NOTHING_HELD)
				return
			}
			event.preventDefault()
			event.stopPropagation()
			event.stopImmediatePropagation()
			if (event.isComposing || event.repeat) return
			const modifiers = { mod: event.metaKey || event.ctrlKey, alt: event.altKey, shift: event.shiftKey }
			if (event.key === "Escape") {
				keepOpen.current = true
				setTimeout(() => {
					keepOpen.current = false
				})
				setRecording(null)
				setHeld(NOTHING_HELD)
				setProblem(null)
				return
			}
			if ((event.key === "Backspace" || event.key === "Delete") && !modifiers.mod && !modifiers.alt && !modifiers.shift) {
				commit(id, null)
				return
			}
			const chord = chordFromEvent(event)
			if (!chord) {
				setHeld(modifiers)
				return
			}
			const reason = chordProblem(chord, platform, { overrides: snapshot.overrides, id })
			if (reason) {
				setProblem({ id, text: reason, nonce: ++nonce.current })
				return
			}
			commit(id, chord)
		}
		const onUp = (event: KeyboardEvent) => setHeld({ mod: event.metaKey || event.ctrlKey, alt: event.altKey, shift: event.shiftKey })
		window.addEventListener("keydown", onDown, true)
		window.addEventListener("keyup", onUp, true)
		return () => {
			window.removeEventListener("keydown", onDown, true)
			window.removeEventListener("keyup", onUp, true)
		}
		// commit reads the store itself; re-subscribing per render would drop a held modifier.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [recording])

	const anyChanged = ACTIONS.some(a => !isDefault(overrides, a.id))

	return (
		<Dialog
			open={open}
			title="Keyboard shortcuts"
			onClose={() => {
				if (keepOpen.current) return
				onClose()
			}}
			className="keys-sheet"
		>
			<div className="keys-list" data-autofocus tabIndex={-1}>
				<p className="keys-rule muted">Letter keys are each action's initial. Click a key to change it.</p>
				{GROUPS.map(group => {
					const actions = ACTIONS.filter(a => a.group === group)
					const idle = actions.every(a => !registered.has(a.id))
					return (
						<section key={group} className="keys-group" aria-label={GROUP_LABELS[group]}>
							<h3>{GROUP_LABELS[group]}</h3>
							{idle && <p className="keys-note muted">On the Live page.</p>}
							<ul>
								{actions.map(action => {
									const def = action.defaultChord === null ? null : parseChord(action.defaultChord)
									return (
										<ShortcutRow
											key={action.id}
											id={action.id}
											label={action.label}
											hint={action.hint}
											chord={bindings[action.id]}
											inactive={!registered.has(action.id) && !idle}
											isDefault={isDefault(overrides, action.id)}
											defaultLabel={def ? formatChord(def, platform) : "no key"}
											recording={recording === action.id}
											held={held}
											problem={problem?.id === action.id ? problem : null}
											changedNonce={changed.ids.includes(action.id) ? changed.nonce : 0}
											onRecord={() => {
												setProblem(null)
												setHeld(NOTHING_HELD)
												setRecording(current => (current === action.id ? null : action.id))
											}}
											onCancel={() => {
												setRecording(current => (current === action.id ? null : current))
												setHeld(NOTHING_HELD)
												setProblem(null)
											}}
											onReset={() => reset(action.id)}
										/>
									)
								})}
							</ul>
						</section>
					)
				})}
				<section className="keys-group" aria-label="Fixed keys">
					<h3>Fixed keys</h3>
					<ul>
						{fixedKeys(platform).map(fixed => (
							<li key={fixed.label} className="keys-row is-fixed">
								<span className="keys-label">{fixed.label}</span>
								<span className="keys-cap-slot">
									<KeycapList caps={fixed.caps} label={fixed.caps.join(" ")} muted />
								</span>
							</li>
						))}
					</ul>
				</section>
				<section className="keys-group" aria-label="Mouse and touch">
					<h3>Mouse &amp; touch</h3>
					<ul>
						{GESTURES.map(gesture => (
							<li key={gesture.label} className="keys-row is-fixed">
								<span className="keys-label">{gesture.label}</span>
								<span className="keys-cap-slot">
									<span className="keys-gesture">{gesture.how}</span>
								</span>
							</li>
						))}
					</ul>
				</section>
			</div>
			<footer className="keys-foot">
				<span className="keys-status" aria-live="polite">
					{status || "Click a key to change it"}
				</span>
				<button type="button" className="btn btn-ghost btn-sm" disabled={!anyChanged} onClick={resetAll}>
					Restore defaults
				</button>
			</footer>
		</Dialog>
	)
}

const ShortcutRow = ({
	id,
	label,
	hint,
	chord,
	inactive,
	isDefault,
	defaultLabel,
	recording,
	held,
	problem,
	changedNonce,
	onRecord,
	onCancel,
	onReset,
}: {
	id: ActionId
	label: string
	hint?: string
	chord: Chord | null
	/** Nothing on this page or camera answers it right now. */
	inactive: boolean
	isDefault: boolean
	defaultLabel: string
	recording: boolean
	held: Held
	problem: { text: string; nonce: number } | null
	changedNonce: number
	onRecord: () => void
	onCancel: () => void
	onReset: () => void
}) => {
	const heldCaps = recording ? chordKeycaps({ key: "", ...held }, platform).slice(0, -1) : []
	const join = platform === "mac" ? "" : "+"
	return (
		<li
			data-shortcut={id}
			className={`keys-row${inactive ? " is-inactive" : ""}`}
			title={inactive ? "Does nothing on this page or camera" : undefined}
		>
			{changedNonce > 0 && <span key={changedNonce} aria-hidden="true" className="keys-flash" />}
			<span className="keys-label">
				{label}
				{hint && <span className="keys-hint">{hint}</span>}
			</span>
			<span className="keys-slot">
				{problem ? (
					<span role="alert" className="keys-problem" title={problem.text}>
						{problem.text}
					</span>
				) : recording ? (
					<span className="keys-waiting">Esc to cancel, Backspace to clear</span>
				) : null}
			</span>
			{!isDefault && !recording && (
				<button type="button" className="icon-btn keys-reset" aria-label={`Reset ${label} to ${defaultLabel}`} title={`Reset to ${defaultLabel}`} onClick={onReset}>
					<Icon name="refresh" size={15} />
				</button>
			)}
			<button
				type="button"
				className={`keys-btn${recording ? " is-recording" : ""}`}
				aria-label={recording ? `Press the new key for ${label}` : `Change the key for ${label}${chord ? `, now ${formatChord(chord, platform)}` : ""}`}
				aria-pressed={recording}
				onClick={onRecord}
				onBlur={onCancel}
			>
				{recording ? (
					<span key={problem?.nonce ?? 0} className={`keys-listening${problem ? " is-refused" : ""}`}>
						{heldCaps.length > 0 ? (
							<b>
								{heldCaps.join(join)}
								{join}…
							</b>
						) : (
							"Press a key"
						)}
					</span>
				) : chord ? (
					<span key={changedNonce} className={changedNonce ? "keys-pop" : undefined}>
						<Keycaps chord={chord} />
					</span>
				) : (
					<span className="keys-none">No key</span>
				)}
			</button>
		</li>
	)
}
