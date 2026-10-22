// THE KEYBOARD SHORTCUTS — what each one does, its key out of the box, and the pure arithmetic of turning
// a key press into a binding and back into keycaps. No DOM: the runtime that acts on a match and the sheet
// that rebinds them live in keyboard.tsx; test/keys.test.ts drives this file directly. Ported from ntwine
// (packages/web/src/lib/keybindings.ts), whose rules these are.
//
// A LETTER IS ITS ACTION'S INITIAL: `s` snapshot, `r` record, `t` theater, `f` full screen, `h` back home.
// One rule predicts the keys nobody has looked up yet. Movement is placed by position instead (arrows to
// turn the camera, `[` / `]` to focus, `+` / `-` to zoom), and `?` opens the sheet, as on the web at large.
// test/keys.test.ts fails a single-letter default that is not an initial of its label.
//
// ⌘/CTRL CHORDS keep the browser's own meaning. The one exception: on the Live page ⌘/Ctrl +, − and 0
// magnify the picture instead of the page (the page around a full-bleed picture has nothing to zoom), and
// only while that page has registered them, so everywhere else they still zoom the page.
//
// SINGLE KEYS NEVER FIRE WHILE YOU TYPE: a binding without ⌘/Ctrl is ignored in a text field, a select, a
// slider or a focused splitter, and while a dialog or menu is open. A ⌘/Ctrl chord fires from anywhere.

import type { PtzDirection } from "../../src/api-types.ts"

export type ActionId =
	| "cam.left"
	| "cam.right"
	| "cam.up"
	| "cam.down"
	| "cam.zoomIn"
	| "cam.zoomOut"
	| "cam.focusNear"
	| "cam.focusFar"
	| "cam.home"
	| "cam.aim"
	| "cam.light"
	| "cam.nightVision"
	| "cam.tracking"
	| "cam.siren"
	| "view.mute"
	| "view.quality"
	| "view.snapshot"
	| "view.record"
	| "view.theater"
	| "view.fullscreen"
	| "view.popout"
	| "view.controls"
	| "view.zone"
	| "view.zoomIn"
	| "view.zoomOut"
	| "view.zoomReset"
	| "view.nextCamera"
	| "app.shortcuts"

export type ActionGroup = "camera" | "picture" | "anywhere"

export type ActionDef = {
	id: ActionId
	label: string
	group: ActionGroup
	/** Serialized chord (see serializeChord), or null for an action with no key until one is given. */
	defaultChord: string | null
	/** Runs while the key is down: the handler gets a start and an end. Auto-repeat never restarts it. */
	hold?: boolean
	/** A held key presses again with the keyboard's auto-repeat (stepping the digital zoom). */
	repeat?: boolean
	/** One short line under the label on the sheet. */
	hint?: string
}

// ORDER IS THE SHEET'S ORDER.
export const ACTIONS: readonly ActionDef[] = [
	{ id: "cam.left", label: "Turn left", group: "camera", defaultChord: "arrowleft", hold: true },
	{ id: "cam.right", label: "Turn right", group: "camera", defaultChord: "arrowright", hold: true },
	{ id: "cam.up", label: "Tilt up", group: "camera", defaultChord: "arrowup", hold: true },
	{ id: "cam.down", label: "Tilt down", group: "camera", defaultChord: "arrowdown", hold: true },
	// `+` is Shift-= on many layouts, so the unshifted = is the same key (foldKey).
	{ id: "cam.zoomIn", label: "Zoom in", group: "camera", defaultChord: "+", hold: true, hint: "= works too" },
	{ id: "cam.zoomOut", label: "Zoom out", group: "camera", defaultChord: "-", hold: true },
	{ id: "cam.focusNear", label: "Focus nearer", group: "camera", defaultChord: "[", hold: true },
	{ id: "cam.focusFar", label: "Focus farther", group: "camera", defaultChord: "]", hold: true },
	{ id: "cam.home", label: "Back home", group: "camera", defaultChord: "h" },
	{ id: "cam.aim", label: "Aim the camera", group: "camera", defaultChord: "a", hint: "Drag a box or click a point" },
	{ id: "cam.light", label: "Light (spotlight on / off)", group: "camera", defaultChord: "l" },
	{ id: "cam.nightVision", label: "Night vision on / off", group: "camera", defaultChord: null },
	{ id: "cam.tracking", label: "Auto-tracking on / off", group: "camera", defaultChord: null },
	{ id: "cam.siren", label: "Siren", group: "camera", defaultChord: null, hint: "One short burst" },
	{ id: "view.mute", label: "Mute / unmute", group: "picture", defaultChord: "m" },
	{ id: "view.quality", label: "Quality: Sharp ⇄ Quick", group: "picture", defaultChord: "q" },
	{ id: "view.snapshot", label: "Snapshot", group: "picture", defaultChord: "s" },
	{ id: "view.record", label: "Record", group: "picture", defaultChord: "r", hint: "Press again to stop and save" },
	{ id: "view.theater", label: "Theater mode", group: "picture", defaultChord: "t" },
	{ id: "view.fullscreen", label: "Full screen", group: "picture", defaultChord: "f" },
	{ id: "view.popout", label: "Pop out", group: "picture", defaultChord: "p" },
	{ id: "view.controls", label: "Controls: show / hide", group: "picture", defaultChord: "c" },
	{ id: "view.zone", label: "Detection zone", group: "picture", defaultChord: "z" },
	{ id: "view.zoomIn", label: "Magnify", group: "picture", defaultChord: "mod++", repeat: true, hint: "Digital: the camera stays put" },
	{ id: "view.zoomOut", label: "Magnify less", group: "picture", defaultChord: "mod+-", repeat: true },
	{ id: "view.zoomReset", label: "Actual size", group: "picture", defaultChord: "mod+0" },
	{ id: "view.nextCamera", label: "Next camera", group: "picture", defaultChord: "n" },
	{ id: "app.shortcuts", label: "Keyboard shortcuts", group: "anywhere", defaultChord: "?" },
]

export const GROUP_LABELS: Record<ActionGroup, string> = {
	camera: "Camera (moves the real camera)",
	picture: "Picture",
	anywhere: "Anywhere",
}

export type Platform = "mac" | "other"

/** The keys that are not rebindable, listed on the sheet so it is the whole keyboard in one place. */
export const fixedKeys = (platform: Platform): { label: string; caps: string[] }[] => [
	{ label: "Go to saved view 1–9", caps: ["1–9"] },
	{ label: "Hold for slower camera moves", caps: [platform === "mac" ? "⇧" : "Shift"] },
	{ label: "Leave Aim, theater or full screen; close a menu", caps: ["Esc"] },
]

/** Mouse and touch, also on the sheet: they have no key, but nobody finds them otherwise. */
export const GESTURES: readonly { label: string; how: string }[] = [
	{ label: "Zoom where the pointer is", how: "Wheel" },
	{ label: "Magnify", how: "Pinch" },
	{ label: "Look around while magnified", how: "Drag" },
	{ label: "Full screen", how: "Double-click" },
	{ label: "Frame a box with the camera", how: "Shift-drag" },
	{ label: "Resize the picture", how: "Drag its corner" },
	{ label: "Automatic size", how: "Double-click the corner" },
	{ label: "Theater", how: "Drag the corner past the window's edge" },
	{ label: "Move the controls", how: "Drag their header" },
]

const ACTION_IDS = new Set<string>(ACTIONS.map(a => a.id))

export const isActionId = (value: unknown): value is ActionId => typeof value === "string" && ACTION_IDS.has(value)

export const actionDef = (id: ActionId): ActionDef => ACTIONS.find(a => a.id === id)!

// ── chords ──────────────────────────────────────────────────────────────────────────────────────────

/** One binding. `mod` is ⌘ on a Mac and Ctrl elsewhere; either satisfies it when matching. */
export type Chord = { key: string; mod: boolean; alt: boolean; shift: boolean }

/** The parts of a KeyboardEvent this file reads (a plain object in tests). */
export type KeyLike = {
	key: string
	code?: string
	metaKey: boolean
	ctrlKey: boolean
	altKey: boolean
	shiftKey: boolean
}

const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt", "AltGraph", "CapsLock", "OS", "Hyper", "Super", "Fn", "FnLock", "NumLock", "ScrollLock"])

// Punctuation by PHYSICAL key, for when `event.key` stops naming the key pressed: Option on a Mac composes
// a glyph (⌥= is "≠") or a dead key, and a non-Latin layout types its own letter.
const CODE_PUNCTUATION: Record<string, string> = {
	Comma: ",",
	Period: ".",
	Slash: "/",
	Semicolon: ";",
	Quote: "'",
	BracketLeft: "[",
	BracketRight: "]",
	Backslash: "\\",
	Minus: "-",
	Equal: "=",
	Backquote: "`",
}

const keyFromCode = (code: string): string | null => {
	if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
	if (/^Digit[0-9]$/.test(code)) return code.slice(5)
	return CODE_PUNCTUATION[code] ?? null
}

/** `=` is the unshifted `+` on most layouts, and browsers zoom on either: one key for bindings. */
const foldKey = (key: string): string => (key === "=" ? "+" : key)

/**
 * The chord a keydown means, or null for a lone modifier (the sheet previews those live instead).
 *
 * THE SHIFT RULE. A letter keeps Shift: `s` and `⇧S` are different bindings. A symbol does not: `?` is
 * Shift-/ on a US board and its own key elsewhere, so the binding is the character typed and Shift is part
 * of how it was typed. Named keys (arrows, Enter) keep Shift like letters do.
 */
export const chordFromEvent = (event: KeyLike): Chord | null => {
	if (!event.key || MODIFIER_KEYS.has(event.key)) return null
	const mod = event.metaKey || event.ctrlKey
	const alt = event.altKey
	const physical = event.code ? keyFromCode(event.code) : null
	if (event.key === "Dead") return physical ? { key: foldKey(physical), mod, alt, shift: event.shiftKey } : null
	if (event.key === " " || event.key === "Spacebar") return { key: "space", mod, alt, shift: event.shiftKey }
	if (event.key.length > 1) return { key: event.key.toLowerCase(), mod, alt, shift: event.shiftKey }
	const typed = event.key
	// Option-composed glyphs and non-Latin letters: bind the physical key and keep Shift, which the
	// character no longer carries.
	if ((alt || !/^[\x21-\x7e]$/.test(typed)) && physical) return { key: foldKey(physical), mod, alt, shift: event.shiftKey }
	if (/^[a-z]$/i.test(typed)) return { key: typed.toLowerCase(), mod, alt, shift: event.shiftKey }
	return { key: foldKey(typed), mod, alt, shift: false }
}

export const serializeChord = (chord: Chord): string =>
	`${chord.mod ? "mod+" : ""}${chord.alt ? "alt+" : ""}${chord.shift ? "shift+" : ""}${chord.key}`

export const parseChord = (text: string): Chord | null => {
	if (typeof text !== "string" || !text) return null
	let rest = text
	const chord: Chord = { key: "", mod: false, alt: false, shift: false }
	for (const modifier of ["mod", "alt", "shift"] as const) {
		if (rest.startsWith(`${modifier}+`) && rest.length > modifier.length + 1) {
			chord[modifier] = true
			rest = rest.slice(modifier.length + 1)
		}
	}
	if (!rest || (rest.length > 1 && !/^[a-z0-9]+$/.test(rest))) return null
	chord.key = foldKey(rest)
	return chord
}

// ── display ─────────────────────────────────────────────────────────────────────────────────────────

/** From `navigator.userAgentData.platform`, `navigator.platform` or the user agent, whichever exists. */
export const platformFromHint = (hint: string | null | undefined): Platform => (/mac|iphone|ipad|ipod/i.test(hint ?? "") ? "mac" : "other")

const NAMED_KEYS: Record<string, string> = {
	enter: "Enter",
	escape: "Esc",
	space: "Space",
	tab: "Tab",
	backspace: "Backspace",
	delete: "Delete",
	arrowup: "↑",
	arrowdown: "↓",
	arrowleft: "←",
	arrowright: "→",
	home: "Home",
	end: "End",
	pageup: "PgUp",
	pagedown: "PgDn",
	insert: "Ins",
}

const MAC_NAMED_KEYS: Record<string, string> = { backspace: "⌫", delete: "⌦" }

/** One string per cap, in each platform's modifier order: Apple's ⌥⇧⌘, Windows/Linux's Ctrl Alt Shift. */
export const chordKeycaps = (chord: Chord, platform: Platform): string[] => {
	const k = chord.key
	const key =
		(platform === "mac" ? MAC_NAMED_KEYS[k] : undefined) ??
		NAMED_KEYS[k] ??
		(/^f[0-9]{1,2}$/.test(k) ? k.toUpperCase() : k.length === 1 ? k.toUpperCase() : k)
	if (platform === "mac") return [...(chord.alt ? ["⌥"] : []), ...(chord.shift ? ["⇧"] : []), ...(chord.mod ? ["⌘"] : []), key]
	return [...(chord.mod ? ["Ctrl"] : []), ...(chord.alt ? ["Alt"] : []), ...(chord.shift ? ["Shift"] : []), key]
}

/** "⌘+", "Ctrl++" (Firefox's own spelling for its zoom), "S", "←". */
export const formatChord = (chord: Chord, platform: Platform): string =>
	chordKeycaps(chord, platform).join(platform === "mac" ? "" : "+")

// ── what can be bound ───────────────────────────────────────────────────────────────────────────────

// Chords a page cannot win or must not take: the browser keeps some outright (a tab never sees ⌘W), the
// rest are editing or navigation muscle memory. Letters listed bare; the check adds `mod+`. Not `+`, `-`
// or `0`: the Live page takes those for digital zoom, on purpose.
const BROWSER_CHORDS = new Set(["w", "t", "n", "q", "l", "r", "f", "p", "s", "d", "o", "h", "m", "g", "j", "u", "y", "e", "k", "tab", "1", "2", "3", "4", "5", "6", "7", "8", "9", "`", "[", "]", "arrowleft", "arrowright"])
const EDITING_CHORDS = new Set(["a", "c", "v", "x", "z", "b", "i", "backspace", "delete", "arrowup", "arrowdown", "home", "end"])
const BROWSER_KEYS = new Set(["f5", "f11", "f12"])

/**
 * Why a chord cannot be bound, or null when it can. Worded for the sheet's row. Given the binding it is for
 * (the current overrides and the action), it also refuses a change that would take away a slow camera move.
 */
export const chordProblem = (chord: Chord, platform: Platform, change?: { overrides: Overrides; id: ActionId }): string | null => {
	const name = formatChord(chord, platform)
	const bare = !chord.mod && !chord.alt
	if (chord.key === "escape") return "Esc leaves things and closes menus, so it can't be changed"
	if (chord.key === "tab") return "Tab moves between controls"
	if (chord.key === "enter") return `${name} presses the focused button`
	if (bare && chord.key === "space") return "Space presses the focused button"
	if (bare && /^[1-9]$/.test(chord.key)) return "1–9 go to saved views"
	if (BROWSER_KEYS.has(chord.key)) return `${name} belongs to the browser`
	if (chord.alt && !chord.mod && (chord.key === "arrowleft" || chord.key === "arrowright")) return `${name} is the browser's Back / Forward`
	if (chord.mod && !chord.alt) {
		if (EDITING_CHORDS.has(chord.key)) return `${name} is a text-editing shortcut`
		if (BROWSER_CHORDS.has(chord.key)) return `${name} belongs to the browser`
	}
	return change ? slowMoveProblem(chord, platform, change.overrides, change.id) : null
}

/**
 * Shift with a hold action's key is that action, slowly (matchAction), and the sheet lists Shift as a fixed
 * key. But an exact chord wins over that fallback, so a binding on the Shift form would quietly take the slow
 * move away. The pairs in `bindings` where that happens.
 */
const slowMoveTakers = (bindings: Bindings): { shifted: ActionId; hold: ActionId; plain: Chord }[] => {
	const lookup = bindingLookup(bindings)
	const out: { shifted: ActionId; hold: ActionId; plain: Chord }[] = []
	for (const action of ACTIONS) {
		const chord = bindings[action.id]
		if (!chord?.shift) continue
		const plain = { ...chord, shift: false }
		const hold = lookup.get(serializeChord(plain))
		if (hold && actionDef(hold).hold) out.push({ shifted: action.id, hold, plain })
	}
	return out
}

// Judged on the bindings after the change, swap included, so a key handed to the swapped action counts too.
// Only a pair the change creates is refused: one already in storage does not block unrelated rebinds.
const slowMoveProblem = (chord: Chord, platform: Platform, overrides: Overrides, id: ActionId): string | null => {
	const pair = (taker: { shifted: ActionId; hold: ActionId }) => `${taker.shifted} ${taker.hold}`
	const before = new Set(slowMoveTakers(effectiveBindings(overrides)).map(pair))
	const taker = slowMoveTakers(effectiveBindings(assignChord(overrides, id, chord).overrides)).find(t => !before.has(pair(t)))
	if (!taker) return null
	const plain = formatChord(taker.plain, platform)
	const hold = actionDef(taker.hold).label
	if (taker.shifted === id) return `Shift with ${plain} is slow ${hold}`
	return `Shift with ${plain} is ${actionDef(taker.shifted).label}, so it can't be slow ${hold}`
}

// ── the effective map ───────────────────────────────────────────────────────────────────────────────

/** Changes from the defaults: a chord string, or null for "no key at all". */
export type Overrides = Partial<Record<ActionId, string | null>>

export type Bindings = Record<ActionId, Chord | null>

const defaultOf = (action: ActionDef): Chord | null => (action.defaultChord === null ? null : parseChord(action.defaultChord))

export const effectiveBindings = (overrides: Overrides): Bindings => {
	const out = {} as Bindings
	for (const action of ACTIONS) {
		const override = overrides[action.id]
		out[action.id] = override === undefined ? defaultOf(action) : override === null ? null : parseChord(override)
	}
	return out
}

/** chord string → action, for the keydown path. On a duplicate (only hand-edited storage can make one)
 *  the earlier action keeps the key. */
export const bindingLookup = (bindings: Bindings): Map<string, ActionId> => {
	const map = new Map<string, ActionId>()
	for (const action of ACTIONS) {
		const chord = bindings[action.id]
		if (chord && !map.has(serializeChord(chord))) map.set(serializeChord(chord), action.id)
	}
	return map
}

export type Match = {
	action: ActionId
	chord: Chord
	/** Shift held on a hold action bound without it: move the camera at half speed. */
	slow: boolean
}

/**
 * The action a keydown triggers. An exact chord wins; failing that, Shift with a key whose plain binding is
 * a HOLD action is that action, slowly (Shift-← turns left at half speed). Symbols never get here with Shift,
 * since Shift is how they are typed (the shift rule), so `+` is never "slow" by accident.
 */
export const matchAction = (event: KeyLike, lookup: Map<string, ActionId>): Match | null => {
	const chord = chordFromEvent(event)
	if (!chord) return null
	const exact = lookup.get(serializeChord(chord))
	if (exact) return { action: exact, chord, slow: false }
	// A symbol some layouts can only type with Option (a German Mac's [ is ⌥5) or AltGr (Windows reports
	// it as Ctrl+Alt): unclaimed as the physical chord, it is the symbol typed.
	if (event.altKey && !event.metaKey && /^[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]$/.test(event.key)) {
		const typed = { key: foldKey(event.key), mod: false, alt: false, shift: false }
		const action = lookup.get(serializeChord(typed))
		if (action) return { action, chord: typed, slow: false }
	}
	if (!chord.shift) return null
	const plain = { ...chord, shift: false }
	const action = lookup.get(serializeChord(plain))
	return action && actionDef(action).hold ? { action, chord: plain, slow: true } : null
}

/** The fixed digit keys: 1–9 by physical key (AZERTY types `&` there without Shift), or the number pad. */
export const digitOf = (event: KeyLike): number | null => {
	if (event.metaKey || event.ctrlKey || event.altKey) return null
	const fromCode = event.code ? /^(?:Digit|Numpad)([1-9])$/.exec(event.code)?.[1] : undefined
	const digit = fromCode ?? (/^[1-9]$/.test(event.key) ? event.key : undefined)
	return digit ? Number(digit) : null
}

/**
 * Bind `id` to `chord` (null unbinds it). A chord another action holds is SWAPPED, not refused or stolen:
 * the other action takes `id`'s old key, so nothing is left unbound behind the user's back. Returns the
 * minimal overrides.
 */
export const assignChord = (overrides: Overrides, id: ActionId, chord: Chord | null): { overrides: Overrides; swappedWith: ActionId | null } => {
	const current = effectiveBindings(overrides)
	const next: Bindings = { ...current, [id]: chord }
	let swappedWith: ActionId | null = null
	if (chord) {
		const wanted = serializeChord(chord)
		for (const action of ACTIONS) {
			const held = current[action.id]
			if (action.id !== id && held && serializeChord(held) === wanted) {
				next[action.id] = current[id]
				swappedWith = action.id
			}
		}
	}
	return { overrides: minimalOverrides(next), swappedWith }
}

/** An action on its default carries no entry, so a later change to a default still reaches it. */
export const minimalOverrides = (bindings: Bindings): Overrides => {
	const out: Overrides = {}
	for (const action of ACTIONS) {
		const chord = bindings[action.id]
		const text = chord ? serializeChord(chord) : null
		const def = defaultOf(action)
		if (text !== (def ? serializeChord(def) : null)) out[action.id] = text
	}
	return out
}

export const isDefault = (overrides: Overrides, id: ActionId): boolean => overrides[id] === undefined

/**
 * Stored overrides, validated one entry at a time: unknown actions, malformed chords and chords that can
 * no longer be bound fall back to their default rather than poisoning the whole map, and a hand-edited
 * duplicate settles to the first claimant.
 */
export const sanitizeOverrides = (raw: unknown): Overrides => {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
	const out: Overrides = {}
	for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!isActionId(id)) continue
		if (value === null) {
			out[id] = null
			continue
		}
		const chord = typeof value === "string" ? parseChord(value) : null
		if (chord && !chordProblem(chord, "other") && !chordProblem(chord, "mac")) out[id] = serializeChord(chord)
	}
	const bindings = effectiveBindings(out)
	const seen = new Set<string>()
	for (const action of ACTIONS) {
		const chord = bindings[action.id]
		if (!chord) continue
		const text = serializeChord(chord)
		if (seen.has(text)) bindings[action.id] = null
		seen.add(text)
	}
	return minimalOverrides(bindings)
}

// ── held keys ───────────────────────────────────────────────────────────────────────────────────────

const AXES: Partial<Record<ActionId, ["x" | "y", -1 | 1]>> = {
	"cam.left": ["x", -1],
	"cam.right": ["x", 1],
	"cam.up": ["y", -1],
	"cam.down": ["y", 1],
}

const DIRECTIONS: Record<string, PtzDirection> = {
	"-1,0": "left",
	"1,0": "right",
	"0,-1": "up",
	"0,1": "down",
	"-1,-1": "upLeft",
	"1,-1": "upRight",
	"-1,1": "downLeft",
	"1,1": "downRight",
}

/**
 * The camera move a set of held arrows means, in the order they went down: two arrows on different axes
 * make a diagonal; on one axis the later press wins (holding ← then → turns right). Null for none.
 */
export const heldDirection = (held: readonly ActionId[]): PtzDirection | null => {
	let x = 0
	let y = 0
	for (const id of held) {
		const axis = AXES[id]
		if (!axis) continue
		if (axis[0] === "x") x = axis[1]
		else y = axis[1]
	}
	return DIRECTIONS[`${x},${y}`] ?? null
}
