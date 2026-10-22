import assert from "node:assert/strict"
import test from "node:test"
import {
	ACTIONS,
	assignChord,
	bindingLookup,
	chordFromEvent,
	chordKeycaps,
	chordProblem,
	digitOf,
	effectiveBindings,
	formatChord,
	heldDirection,
	type KeyLike,
	matchAction,
	parseChord,
	platformFromHint,
	sanitizeOverrides,
	serializeChord,
} from "../web/src/keys.ts"

const key = (init: Partial<KeyLike> & { key: string }): KeyLike => ({
	code: "",
	metaKey: false,
	ctrlKey: false,
	altKey: false,
	shiftKey: false,
	...init,
})

const defaults = bindingLookup(effectiveBindings({}))
const chord = (text: string) => parseChord(text)!

test("the default keys are the ones the sheet promises", () => {
	const cases: [KeyLike, string][] = [
		[key({ key: "ArrowLeft", code: "ArrowLeft" }), "cam.left"],
		[key({ key: "ArrowUp", code: "ArrowUp" }), "cam.up"],
		[key({ key: "[", code: "BracketLeft" }), "cam.focusNear"],
		[key({ key: "h", code: "KeyH" }), "cam.home"],
		[key({ key: "s", code: "KeyS" }), "view.snapshot"],
		[key({ key: "?", code: "Slash", shiftKey: true }), "app.shortcuts"],
		[key({ key: "0", code: "Digit0", ctrlKey: true }), "view.zoomReset"],
		[key({ key: "-", code: "Minus", metaKey: true }), "view.zoomOut"],
	]
	for (const [event, action] of cases) assert.equal(matchAction(event, defaults)?.action, action, JSON.stringify(event))
})

// The rule in keys.ts's header: a single-letter default is the initial of a word in its label. Listed
// exceptions would go here; there are none, and an exception that became an initial is stale, so this
// runs both ways.
const NOT_AN_INITIAL = new Set<string>()

test("every single-letter default is its action's initial", () => {
	for (const action of ACTIONS) {
		if (!action.defaultChord || !/^[a-z]$/.test(action.defaultChord)) continue
		const initials = action.label
			.toLowerCase()
			.split(/[^a-z]+/)
			.filter(word => word.length > 2)
			.map(word => word[0])
		assert.equal(initials.includes(action.defaultChord), !NOT_AN_INITIAL.has(action.id), `${action.id} → ${action.defaultChord}`)
	}
})

test("+ and = are one key, with and without ⌘/Ctrl", () => {
	// Plain: = unshifted and + (Shift-= on US, its own key on German, the number pad) all zoom the camera.
	for (const event of [
		key({ key: "=", code: "Equal" }),
		key({ key: "+", code: "Equal", shiftKey: true }),
		key({ key: "+", code: "BracketRight" }),
		key({ key: "+", code: "NumpadAdd" }),
	])
		assert.deepEqual(matchAction(event, defaults), { action: "cam.zoomIn", chord: chord("+"), slow: false }, JSON.stringify(event))
	// With the modifier: the picture's digital zoom, whichever of the two the browser reports.
	assert.equal(matchAction(key({ key: "=", code: "Equal", ctrlKey: true }), defaults)?.action, "view.zoomIn")
	assert.equal(matchAction(key({ key: "+", code: "Equal", ctrlKey: true, shiftKey: true }), defaults)?.action, "view.zoomIn")
	// ⌥= on a Mac types ≠: still the physical key.
	assert.equal(matchAction(key({ key: "≠", code: "Equal", metaKey: true, altKey: true }), bindingLookup(effectiveBindings({ "view.zoomIn": "mod+alt++" })))?.action, "view.zoomIn")
	// Stored either way, it reads back as one chord.
	assert.equal(serializeChord(chord("mod+=")), "mod++")
	assert.deepEqual(sanitizeOverrides({ "cam.zoomIn": "=" }), {})
})

test("Shift distinguishes letters but is part of how a symbol is typed", () => {
	assert.equal(matchAction(key({ key: "S", code: "KeyS", shiftKey: true }), defaults), null)
	// Caps Lock types "S" with no Shift held: still the plain letter.
	assert.equal(matchAction(key({ key: "S", code: "KeyS" }), defaults)?.action, "view.snapshot")
	assert.deepEqual(chordFromEvent(key({ key: "?", code: "Minus", shiftKey: true })), { key: "?", mod: false, alt: false, shift: false })
})

test("Shift with a held camera key is the same move, slowly; never for a press or a symbol", () => {
	assert.deepEqual(matchAction(key({ key: "ArrowLeft", code: "ArrowLeft", shiftKey: true }), defaults), {
		action: "cam.left",
		chord: chord("arrowleft"),
		slow: true,
	})
	// An action bound to the Shift chord itself wins over the slow fallback.
	const taken = bindingLookup(effectiveBindings({ "view.snapshot": "shift+arrowleft" }))
	assert.deepEqual(matchAction(key({ key: "ArrowLeft", code: "ArrowLeft", shiftKey: true }), taken)?.action, "view.snapshot")
	// Rebound to a letter, the slow fallback follows it; a press action on a letter does not get one.
	const lettered = bindingLookup(effectiveBindings({ "cam.focusFar": "g" }))
	assert.equal(matchAction(key({ key: "G", code: "KeyG", shiftKey: true }), lettered)?.slow, true)
	assert.equal(matchAction(key({ key: "H", code: "KeyH", shiftKey: true }), defaults), null)
})

test("Option-composed glyphs, dead keys and non-Latin layouts bind the physical key", () => {
	assert.deepEqual(chordFromEvent(key({ key: "∆", code: "KeyJ", altKey: true })), { key: "j", mod: false, alt: true, shift: false })
	assert.deepEqual(chordFromEvent(key({ key: "Dead", code: "KeyE", altKey: true })), { key: "e", mod: false, alt: true, shift: false })
	// Cyrillic ы is on KeyS: the default `s` still takes a snapshot.
	assert.equal(matchAction(key({ key: "ы", code: "KeyS" }), defaults)?.action, "view.snapshot")
	assert.equal(chordFromEvent(key({ key: "Meta", metaKey: true })), null)
	// [ is AltGr-8 on a German PC (reported as Ctrl+Alt) and ⌥5 on a German Mac: still focus nearer.
	assert.equal(matchAction(key({ key: "[", code: "Digit8", ctrlKey: true, altKey: true }), defaults)?.action, "cam.focusNear")
	assert.equal(matchAction(key({ key: "[", code: "Digit5", altKey: true }), defaults)?.action, "cam.focusNear")
	// A chord bound on the physical key itself still wins over the typed symbol.
	const physical = bindingLookup(effectiveBindings({ "view.zone": "mod+alt+8" }))
	assert.equal(matchAction(key({ key: "[", code: "Digit8", ctrlKey: true, altKey: true }), physical)?.action, "view.zone")
})

test("chords round-trip through their stored form", () => {
	for (const text of ["s", "?", "mod++", "mod+-", "mod+0", "shift+e", "mod+alt+shift+x", "arrowdown", "f2", "space", "["]) {
		assert.equal(serializeChord(chord(text)), text)
	}
	for (const bad of ["", "mod+", "mod+Arrow-Down"]) assert.equal(parseChord(bad), null, bad)
	for (const action of ACTIONS) if (action.defaultChord) assert.equal(serializeChord(chord(action.defaultChord)), action.defaultChord)
})

test("keycaps follow each platform's modifier order and spelling", () => {
	assert.deepEqual(chordKeycaps(chord("mod+alt+shift+x"), "mac"), ["⌥", "⇧", "⌘", "X"])
	assert.deepEqual(chordKeycaps(chord("mod+alt+shift+x"), "other"), ["Ctrl", "Alt", "Shift", "X"])
	assert.equal(formatChord(chord("mod++"), "mac"), "⌘+")
	assert.equal(formatChord(chord("mod++"), "other"), "Ctrl++")
	assert.equal(formatChord(chord("arrowleft"), "other"), "←")
	assert.equal(platformFromHint("MacIntel"), "mac")
	assert.equal(platformFromHint("Win32"), "other")
})

test("the browser's, the editor's and the page's own keys are refused with the reason", () => {
	assert.equal(chordProblem(chord("mod+w"), "mac"), "⌘W belongs to the browser")
	assert.equal(chordProblem(chord("mod+shift+t"), "other"), "Ctrl+Shift+T belongs to the browser")
	assert.equal(chordProblem(chord("mod+c"), "other"), "Ctrl+C is a text-editing shortcut")
	assert.equal(chordProblem(chord("alt+arrowleft"), "other"), "Alt+← is the browser's Back / Forward")
	assert.equal(chordProblem(chord("3"), "mac"), "1–9 go to saved views")
	assert.match(chordProblem(chord("escape"), "mac") ?? "", /can't be changed/)
	for (const text of ["tab", "enter", "space", "f5"]) assert.ok(chordProblem(chord(text), "mac"), text)
	// The Live page's digital zoom takes these from the browser on purpose, so they stay bindable.
	for (const text of ["mod++", "mod+-", "mod+0"]) assert.equal(chordProblem(chord(text), "other"), null, text)
	for (const text of ["x", "shift+s", "alt+space", "mod+alt+w", "0", "shift+arrowleft"]) assert.equal(chordProblem(chord(text), "mac"), null, text)
	for (const action of ACTIONS) if (action.defaultChord) assert.equal(chordProblem(chord(action.defaultChord), "mac"), null, action.id)
})

test("a binding that would take Shift's slow camera move is refused", () => {
	assert.equal(chordProblem(chord("shift+arrowleft"), "mac", { overrides: {}, id: "view.snapshot" }), "Shift with ← is slow Turn left")
	assert.equal(chordProblem(chord("alt+shift+x"), "other", { overrides: { "cam.up": "alt+x" }, id: "view.snapshot" }), "Shift with Alt+X is slow Tilt up")
	// The other way round: a camera key whose Shift form something else already has.
	assert.equal(
		chordProblem(chord("x"), "mac", { overrides: { "view.snapshot": "shift+x" }, id: "cam.left" }),
		"Shift with X is Snapshot, so it can't be slow Turn left",
	)
	// A swap counts: Record takes ←, so Turn left is handed Record's X, whose Shift form is Snapshot.
	assert.equal(
		chordProblem(chord("arrowleft"), "mac", { overrides: { "view.record": "x", "view.snapshot": "shift+x" }, id: "view.record" }),
		"Shift with X is Snapshot, so it can't be slow Turn left",
	)
	// A clash already in storage does not block an unrelated change.
	assert.equal(chordProblem(chord("x"), "mac", { overrides: { "view.snapshot": "shift+arrowleft" }, id: "view.record" }), null)
	// Free once the camera key has moved, and a non-hold key's Shift form is anyone's.
	assert.equal(chordProblem(chord("shift+arrowleft"), "mac", { overrides: { "cam.left": "j" }, id: "view.snapshot" }), null)
	assert.equal(chordProblem(chord("shift+s"), "mac", { overrides: {}, id: "view.record" }), null)
	// Rebinding the hold action itself to its own Shift form leaves nothing to steal from.
	assert.equal(chordProblem(chord("shift+arrowleft"), "mac", { overrides: {}, id: "cam.left" }), null)
})

test("binding a key another action holds swaps the two", () => {
	const { overrides, swappedWith } = assignChord({}, "view.snapshot", chord("r"))
	assert.equal(swappedWith, "view.record")
	assert.deepEqual(overrides, { "view.snapshot": "r", "view.record": "s" })
	// Swapping back lands both on their defaults: no overrides at all.
	assert.deepEqual(assignChord(overrides, "view.snapshot", chord("s")).overrides, {})
	// Taking a key from an action that had none by default leaves the taker's slot empty, not invented.
	const given = assignChord({}, "cam.siren", chord("x")).overrides
	assert.deepEqual(given, { "cam.siren": "x" })
	const took = assignChord(given, "cam.tracking", chord("x"))
	assert.equal(took.swappedWith, "cam.siren")
	assert.deepEqual(took.overrides, { "cam.tracking": "x" })
})

test("overrides stay minimal: an unbound default is an explicit null, an unbound no-key action is nothing", () => {
	assert.deepEqual(assignChord({}, "view.zone", null).overrides, { "view.zone": null })
	assert.deepEqual(assignChord({ "cam.siren": "x" }, "cam.siren", null).overrides, {})
})

test("stored overrides are validated one entry at a time", () => {
	for (const junk of [null, "mod++", [], 7, "{"]) assert.deepEqual(sanitizeOverrides(junk), {})
	assert.deepEqual(
		sanitizeOverrides({ "view.snapshot": "x", "view.gone": "y", "view.record": "mod+w", "cam.home": 7, "view.zone": null, "view.mute": "mod+Arrow-Down" }),
		{ "view.snapshot": "x", "view.zone": null }
	)
	// A hand-edited duplicate settles to the first claimant instead of leaving one dead.
	const duped = sanitizeOverrides({ "view.nextCamera": "s" })
	assert.equal(bindingLookup(effectiveBindings(duped)).get("s"), "view.snapshot")
	assert.equal(effectiveBindings(duped)["view.nextCamera"], null)
})

test("no two defaults share a chord", () => {
	const seen = new Set<string>()
	for (const action of ACTIONS) {
		if (!action.defaultChord) continue
		assert.ok(!seen.has(action.defaultChord), action.defaultChord)
		seen.add(action.defaultChord)
	}
})

test("digits 1–9 by physical key or number pad, never with ⌘/Ctrl or Alt", () => {
	assert.equal(digitOf(key({ key: "3", code: "Digit3" })), 3)
	// AZERTY types & on Digit1 without Shift.
	assert.equal(digitOf(key({ key: "&", code: "Digit1" })), 1)
	assert.equal(digitOf(key({ key: "9", code: "Numpad9" })), 9)
	assert.equal(digitOf(key({ key: "0", code: "Digit0" })), null)
	assert.equal(digitOf(key({ key: "1", code: "Digit1", ctrlKey: true })), null)
	assert.equal(digitOf(key({ key: "¡", code: "Digit1", altKey: true })), null)
})

test("held arrows add up to diagonals; on one axis the later press wins", () => {
	assert.equal(heldDirection(["cam.up", "cam.left"]), "upLeft")
	assert.equal(heldDirection(["cam.down", "cam.right", "cam.zoomIn"]), "downRight")
	assert.equal(heldDirection(["cam.left", "cam.right"]), "right")
	assert.equal(heldDirection(["cam.right", "cam.left", "cam.up"]), "upLeft")
	assert.equal(heldDirection([]), null)
})
