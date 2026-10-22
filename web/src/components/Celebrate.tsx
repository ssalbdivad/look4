import { type CSSProperties, useEffect, useState } from "react"
import type { ClipSummary } from "../../../src/api-types.ts"
import { api } from "../api.ts"
import { Dialog } from "../feedback.tsx"
import { fmtPct, fmtTime, humanize, matchName } from "../format.ts"
import { navigate } from "../router.tsx"
import { Icon } from "./Icon.tsx"
import { Mascot } from "./Mascot.tsx"
import { Thumb } from "./ui.tsx"

// The one-time party for the very first sighting, once per install. It's armed ("waiting") by a
// first run of the setup wizard, or by the feed being seen empty; the first sighting the feed shows
// after that gets the party, and once it has ("done") it never fires again. Arming doesn't wait for
// an empty feed, because the main path fills the feed during setup: a Reolink camera pulls its last
// 24 hours, and the first clips are judged while the person is still on the judge step. Someone who
// was never armed (look4 had sightings before this browser ever saw it empty or set it up) never
// gets one.

const KEY = "look4:first-sighting"

const read = () => {
	try {
		return localStorage.getItem(KEY)
	} catch {
		return "done"
	}
}
const write = (v: "waiting" | `waiting:${string}` | "done") => {
	try {
		localStorage.setItem(KEY, v)
	} catch {}
}
// "empty" is what an older build wrote for the same thing
/** Whether the next sighting the feed shows gets the party. */
export const firstSightingWaiting = () => {
	const v = read()
	return v === "empty" || !!v?.startsWith("waiting")
}

/** The setup wizard on a fresh install: the next first sighting gets the party. A no-op once it has had one. */
export const armFirstSighting = () => {
	if (!read()) write("waiting")
}

/** The Done step teased this sighting by name, so the party is for it too, not whatever is newest by then. */
export const pinFirstSighting = (clipId: string) => {
	if (firstSightingWaiting()) write(`waiting:${clipId}`)
}

/**
 * `showingEmpty`: the unfiltered feed is showing its empty state. `newest`: the top of the feed.
 * Returns the sighting to celebrate (once), and a way to close it.
 */
export const useFirstSighting = (showingEmpty: boolean, newest: ClipSummary | undefined) => {
	const [party, setParty] = useState<ClipSummary | null>(null)
	useEffect(() => {
		if (!showingEmpty || read()) return
		// The feed may be showing a moment of stale filtered data; ask the server before believing it.
		const ac = new AbortController()
		api.sightings({ limit: 1 }, ac.signal).then(
			p => {
				if (!p.items.length) armFirstSighting()
			},
			() => {}
		)
		return () => ac.abort()
	}, [showingEmpty])
	useEffect(() => {
		if (!newest || !firstSightingWaiting()) return
		const pinned = read()?.match(/^waiting:(.+)$/)?.[1]
		write("done")
		if (!pinned || pinned === newest.id) return setParty(newest)
		// the pinned clip may be gone by now (deleted, re-decided): then the newest gets the party
		api.clip(pinned).then(c => setParty(c.status === "kept" ? c : newest), () => setParty(newest))
	}, [newest])
	return [party, () => setParty(null)] as const
}

// Confetti in the brand colours, bursting from behind the eagle in two rings and flying well past
// the dialog's edges, then drifting down. Deterministic, so every celebration looks the same.
const COLOURS = ["var(--l4-primary)", "var(--l4-accent)", "var(--l4-good)", "var(--l4-bad)", "var(--l4-sky)", "var(--l4-primary)", "var(--tone-5)"]
const COUNT = 40
const PIECES = Array.from({ length: COUNT }, (_, i) => {
	// mostly up and out: the eagle sits at the dialog's top edge, so the lower half would land on the text
	const a = Math.PI + (i / COUNT) * Math.PI * 1.1 - 0.05 * Math.PI + (i % 3) * 0.09
	const d = (i % 2 ? 150 : 230) + ((i * 37) % 90)
	return {
		"--x": `${Math.round(Math.cos(a) * d * 1.25)}px`,
		"--y": `${Math.round(Math.sin(a) * d * 0.85)}px`,
		"--r": `${(i * 67) % 360}deg`,
		"--c": COLOURS[i % COLOURS.length],
		"--t": `${(i % 5) * 0.04}s`
	} as CSSProperties
})

export const FirstSightingCelebration = ({ clip, onClose }: { clip: ClipSummary; onClose: () => void }) => {
	const best = clip.matches[0]
	const what = best ? matchName(best) : "something"
	return (
		<Dialog open title="Your first sighting!" onClose={onClose} size="sm" className="dialog-celebrate">
			<div className="celebrate-art" aria-hidden="true">
				<span className="confetti">
					{PIECES.map((style, i) => (
						<span key={i} className={`confetti-bit${i % 3 === 0 ? " is-round" : i % 3 === 1 ? " is-ribbon" : ""}`} style={style} />
					))}
				</span>
				<Mascot pose="found" size={148} />
			</div>
			{/* focus lands on the words, not the button: a ring on a just-opened dialog looks like a glitch */}
			<p className="celebrate-lead" tabIndex={-1} data-autofocus>
				look4 spotted <strong>{what}</strong>
				{best ? `, ${fmtPct(best.confidence)} sure,` : ""} at {fmtTime(clip.recordedAt)}. All that watching paid off.
			</p>
			<Thumb src={clip.media.closeUps[0] ?? clip.media.crops[0] ?? clip.media.poster} alt="" className="celebrate-thumb" eager />
			<div className="dialog-actions">
				<button type="button" className="btn btn-ghost" onClick={onClose}>
					Keep watching
				</button>
				<button
					type="button"
					className="btn btn-primary"
					onClick={() => {
						onClose()
						navigate(`/clips/${clip.id}`)
					}}
				>
					<Icon name="binoculars" size={18} />
					Take a look
				</button>
			</div>
		</Dialog>
	)
}
