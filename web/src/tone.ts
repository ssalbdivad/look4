import type { CSSProperties } from "react"

// Each lookout gets an accent colour so its chips, cards and verdicts are recognisable at a glance.
// The six tones are mixes of the brand tokens (app.css, --tone-0..5), so both themes stay on brand.

const TONES = 6

const hash = (s: string) => {
	let h = 2166136261
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
	return h >>> 0
}

/**
 * The lookout's place in the list when the list is known, so a handful of lookouts never share a
 * colour; otherwise a stable hash of its id.
 */
export const toneOf = (id: string, all?: readonly { id: string }[] | null) => {
	const i = all ? all.findIndex(l => l.id === id) : -1
	return (i >= 0 ? i : hash(id)) % TONES
}

/** Sets `--tone` for the element; CSS reads it for the accent. */
export const toneStyle = (id: string, all?: readonly { id: string }[] | null) =>
	({ "--tone": `var(--tone-${toneOf(id, all)})` }) as CSSProperties
