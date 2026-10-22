import { type FormEvent, useState } from "react"
import type { ClipSummary, LifeListEntryDto, LifeListResponse } from "../../../src/api-types.ts"
import { api, errorMessage } from "../api.ts"
import { useFeedback } from "../feedback.tsx"
import { birdName, fmtDate, fmtRelative, plural } from "../format.ts"
import { Link } from "../router.tsx"
import { Icon } from "./Icon.tsx"
import { Thumb } from "./ui.tsx"

/** Today as the date input wants it, in local time. */
const today = () => {
	const d = new Date()
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/** A long list shows this many species until it is opened. */
const FOLDED = 12

/** The life list on Sightings: every species seen, and a one-line form to add a bird. */
export const LifeListPanel = ({
	data,
	now,
	onChange
}: {
	data: LifeListResponse | null
	now: number
	onChange: (next: LifeListResponse) => void
}) => {
	const [open, setOpen] = useState(false)
	if (!data) return null
	const entries = data.entries
	const shown = open ? entries : entries.slice(0, FOLDED)
	return (
		<section className="panel lifelist" aria-labelledby="life-list">
			<div className="lifelist-head">
				<h2 className="panel-title" id="life-list">
					<Icon name="list" size={18} />
					Life list
					<span className="lifelist-count">{plural(entries.length, "species", "species")}</span>
				</h2>
				<AddBird onAdded={onChange} />
			</div>
			{entries.length === 0 ? (
				<p className="field-help">
					Add the birds you've already seen here. Confirming a sighting adds its bird too, and a lookout can ask for a
					species not on this list.
				</p>
			) : (
				<ul className="lifelist-chips">
					{shown.map(e => (
						<Lifer key={e.species} e={e} now={now} onRemoved={onChange} />
					))}
					{entries.length > FOLDED && (
						<li>
							<button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(o => !o)}>
								{open ? "Show fewer" : `Show all ${entries.length}`}
							</button>
						</li>
					)}
				</ul>
			)}
		</section>
	)
}

const AddBird = ({ onAdded }: { onAdded: (next: LifeListResponse) => void }) => {
	const { toast } = useFeedback()
	const [species, setSpecies] = useState("")
	const [seenAt, setSeenAt] = useState(today)
	const [saving, setSaving] = useState(false)
	const submit = async (e: FormEvent) => {
		e.preventDefault()
		const name = species.trim()
		if (!name) return
		setSaving(true)
		try {
			onAdded(await api.addLifer({ species: name, seenAt: seenAt || undefined }))
			toast(`Added ${name} to your life list`, { tone: "good" })
			setSpecies("")
		} catch (err) {
			toast(errorMessage(err), { tone: "bad" })
		} finally {
			setSaving(false)
		}
	}
	return (
		<form className="lifelist-add" onSubmit={submit}>
			<input
				value={species}
				onChange={e => setSpecies(e.target.value)}
				placeholder="Add a bird, e.g. Mourning Dove"
				aria-label="Bird to add to your life list"
				maxLength={80}
			/>
			<input type="date" value={seenAt} max={today()} onChange={e => setSeenAt(e.target.value)} aria-label="First seen (optional)" title="First seen (optional)" />
			<button type="submit" className="btn btn-primary" disabled={saving || !species.trim()}>
				{saving ? <span className="spinner" aria-hidden="true" /> : <Icon name="plus" size={18} />}
				Add
			</button>
		</form>
	)
}

const Lifer = ({ e, now, onRemoved }: { e: LifeListEntryDto; now: number; onRemoved: (next: LifeListResponse) => void }) => {
	const { toast, confirm } = useFeedback()
	const remove = async () => {
		const ok = await confirm({
			title: `Remove ${e.species}?`,
			body: "A lookout asking for birds not on your life list will count it as new again.",
			confirmLabel: "Remove",
			danger: true
		})
		if (!ok) return
		try {
			onRemoved(await api.removeLifer(e.species))
		} catch (err) {
			toast(errorMessage(err), { tone: "bad" })
		}
	}
	const title = [
		e.firstSeenAt ? `First seen ${fmtDate(e.firstSeenAt, now)}` : null,
		e.sightings > 0 ? `${plural(e.sightings, "sighting")}, last ${fmtRelative(e.lastSeenAt, now)}` : null
	]
		.filter(Boolean)
		.join(" · ")
	return (
		<li className="chip lifer-chip" title={title || undefined}>
			{e.image && <Thumb src={e.image} alt="" className="lifer-avatar" />}
			{e.clipId ? <Link to={`/clips/${e.clipId}`}>{e.species}</Link> : <span>{e.species}</span>}
			{e.sightings > 0 && <span className="lifer-n">{e.sightings}</span>}
			<button type="button" className="lifer-x" onClick={remove} aria-label={`Remove ${e.species}`}>
				<Icon name="x" size={12} />
			</button>
		</li>
	)
}

/**
 * Confirms a sighting: a "yes" for each lookout that kept it, and its bird onto the life list when it
 * is new. With no species from the spotter, it asks which bird first.
 */
export const useConfirmSighting = (onConfirmed: (clip: ClipSummary) => void) => {
	const { toast } = useFeedback()
	const [busy, setBusy] = useState(false)
	const run = async (clip: ClipSummary, species?: string) => {
		setBusy(true)
		try {
			const res = await api.confirmClip(clip.id, { species: species?.trim() || undefined })
			onConfirmed(res.clip)
			toast(res.added ? `Confirmed · ${res.added} added to your life list` : "Confirmed", { tone: "good" })
			return true
		} catch (e) {
			toast(errorMessage(e), { tone: "bad" })
			return false
		} finally {
			setBusy(false)
		}
	}
	return { confirm: run, busy }
}

/** The bird a confirmation would add: the new species, else any species the spotter named. */
export const confirmSpecies = (clip: ClipSummary) => clip.newSpecies ?? clip.matches.find(m => m.species)?.species ?? null

/**
 * A confirmation always names its life-list bird, so with no species named it asks, prefilled with
 * what the spotter called it: a label like "Black-capped Chickadee (likely)" is often the species
 * the judge left out of its species field.
 */
export const birdGuess = (clip: ClipSummary) => {
	const label = clip.matches.find(m => m.label)?.label
	return label && !/\bbird\b/i.test(label) ? birdName(label) : ""
}
