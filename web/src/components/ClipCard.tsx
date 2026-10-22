import { type CSSProperties, type FormEvent, useState } from "react"
import type { ClipSummary } from "../../../src/api-types.ts"
import { fmtPct, fmtRelative, fmtTime, humanize, matchName } from "../format.ts"
import { Link } from "../router.tsx"
import { toneStyle } from "../tone.ts"
import { Icon } from "./Icon.tsx"
import { birdGuess, confirmSpecies, useConfirmSighting } from "./LifeList.tsx"
import { Thumb } from "./ui.tsx"

/** A kept clip in the Sightings feed: the judge's best crop, what it was, how sure, when. */
export const SightingCard = ({
	clip,
	fresh,
	now,
	lookoutId,
	lookouts,
	onConfirmed,
	onWrong
}: {
	clip: ClipSummary
	fresh?: boolean
	now: number
	/** Shows a Confirm button; called with the confirmed clip. */
	onConfirmed?: (clip: ClipSummary) => void
	/** Shows a "Wrong bird" button; called with what it really was, when given. */
	onWrong?: (clip: ClipSummary, species: string | null) => void
	/** Every lookout, so each chip gets the same accent colour it has everywhere else, and the badge knows its threshold. */
	lookouts?: readonly { id: string; threshold?: number }[] | null
	/** The feed's lookout filter: that lookout's verdict titles the card (a cardinal clip can also be the woodpecker sighting). */
	lookoutId?: string
}) => {
	const best = (lookoutId && clip.matches.find(m => m.lookoutId === lookoutId)) || clip.matches[0]
	// its "what was it?" box takes the card's foot, where Confirm sits
	const [sayingWrong, setSayingWrong] = useState(false)
	const title = best ? matchName(best) : "Sighting"
	const sure = best?.species && best.speciesConfidence != null ? best.speciesConfidence : null
	// a close-up the camera zoomed in for beats a crop of the wide view
	const img = clip.media.closeUps[0] ?? clip.media.crops[0] ?? clip.media.poster
	// queued again (a backfill, a reprocess): still a sighting on its last verdicts until it is re-decided
	const rechecking = clip.status === "pending" || clip.status === "processing"
	const card = (
		<Link
			to={`/clips/${clip.id}`}
			className={`card sighting${fresh ? " is-fresh" : ""}`}
			style={best ? toneStyle(best.lookoutId, lookouts) : undefined}
			aria-label={`${title}${sure != null ? `, ${fmtPct(sure)} sure` : ""}, ${clip.confirmed ? "confirmed, " : ""}${fmtTime(clip.recordedAt)}`}
		>
			<div className="sighting-media">
				<Thumb src={img} alt="" className="sighting-thumb" />
				{clip.confirmed && (
					<span className="sighting-confirmed" title="You confirmed this sighting">
						<Icon name="check" size={13} />
						Confirmed
					</span>
				)}
				{rechecking && (
					<span className="sighting-recheck" title={clip.status === "processing" ? "look4 is checking this clip again" : "Queued to be checked again"}>
						<Icon name="refresh" size={12} />
						Re-checking
					</span>
				)}
				{clip.media.preview && (
					<span className="sighting-play" aria-hidden="true">
						<Icon name="play" size={14} />
					</span>
				)}
				{fresh && (
					<span className="sighting-new">
						<Icon name="sparkle" size={13} />
						New
					</span>
				)}
			</div>
			<div className="sighting-body">
				<div className="sighting-title">
					{title}
					{sure != null && (
						<span className="sighting-sure" title={`The spotter is ${fmtPct(sure)} sure it's a ${title}`}>
							{fmtPct(sure)}
						</span>
					)}
				</div>
				<div className="sighting-chips">
					{clip.newSpecies && (
						<span className="chip chip-lifer" title={`${clip.newSpecies} isn't on your life list yet`}>
							<Icon name="sparkle" size={12} />
							New species
						</span>
					)}
					{clip.matches.map(m => (
						<span key={m.lookoutId} className="chip chip-lookout" title={m.lookoutName} style={toneStyle(m.lookoutId, lookouts)}>
							{humanize(m.lookoutName)}
						</span>
					))}
				</div>
				<div className="sighting-meta">
					<Icon name="clock" size={14} />
					<time dateTime={clip.recordedAt} title={new Date(clip.recordedAt).toLocaleString()}>
						{fmtTime(clip.recordedAt)}
						{/* The day heading already says which day; the relative time only helps for recent ones. */}
						{now - new Date(clip.recordedAt).getTime() < 12 * 3600_000 && (
							<span className="muted"> · {fmtRelative(clip.recordedAt, now)}</span>
						)}
					</time>
				</div>
			</div>
		</Link>
	)
	if (!onConfirmed && !onWrong) return card
	// a button can't sit inside the card's link, so they sit over it
	return (
		<div className="sighting-wrap">
			{card}
			{onWrong && !clip.confirmed && <WrongBird clip={clip} title={title} onWrong={onWrong} asking={sayingWrong} setAsking={setSayingWrong} />}
			{onConfirmed && !sayingWrong && <ConfirmSighting clip={clip} onConfirmed={onConfirmed} />}
		</div>
	)
}

/**
 * "Wrong bird": not what the spotter said. Asks what it really was (optional); look4 keeps the answer
 * and shows it to the spotter the next time it is about to make the same call.
 */
const WrongBird = ({
	clip,
	title,
	onWrong,
	asking,
	setAsking
}: {
	clip: ClipSummary
	title: string
	onWrong: (clip: ClipSummary, species: string | null) => void
	asking: boolean
	setAsking: (asking: boolean) => void
}) => {
	const [name, setName] = useState("")
	if (asking) {
		const submit = (e: FormEvent) => {
			e.preventDefault()
			onWrong(clip, name.trim() || null)
		}
		return (
			<form className="sighting-confirm-ask" onSubmit={submit}>
				<input value={name} onChange={e => setName(e.target.value)} placeholder="What was it? (optional)" aria-label="What bird was it really?" autoFocus maxLength={80} />
				<button type="submit" className="btn btn-primary btn-sm" aria-label="Mark as the wrong bird">
					<Icon name="check" size={14} />
				</button>
				<button type="button" className="btn btn-ghost btn-sm" onClick={() => setAsking(false)} aria-label="Cancel">
					<Icon name="x" size={14} />
				</button>
			</form>
		)
	}
	return (
		<button type="button" className="sighting-wrong" onClick={() => setAsking(true)} title={`Not a ${title}: say what it was, so look4 learns`}>
			<Icon name="x" size={14} />
			Wrong bird
		</button>
	)
}

/** "Yes, that's it": confirms the sighting, adding its bird to the life list when it's new. */
const ConfirmSighting = ({ clip, onConfirmed }: { clip: ClipSummary; onConfirmed: (clip: ClipSummary) => void }) => {
	const { confirm, busy } = useConfirmSighting(onConfirmed)
	const [asking, setAsking] = useState(false)
	const [name, setName] = useState(() => birdGuess(clip))
	// the badge on its picture says so
	if (clip.confirmed) return null
	if (asking) {
		const submit = async (e: FormEvent) => {
			e.preventDefault()
			if (await confirm(clip, name)) setAsking(false)
		}
		return (
			<form className="sighting-confirm-ask" onSubmit={submit}>
				<input value={name} onChange={e => setName(e.target.value)} placeholder="Which bird?" aria-label="Which bird is it?" autoFocus required maxLength={80} />
				<button type="submit" className="btn btn-primary btn-sm" disabled={busy} aria-label="Confirm">
					<Icon name="check" size={14} />
				</button>
				<button type="button" className="btn btn-ghost btn-sm" onClick={() => setAsking(false)} aria-label="Cancel">
					<Icon name="x" size={14} />
				</button>
			</form>
		)
	}
	return (
		<button
			type="button"
			className={`sighting-confirm${clip.newSpecies ? " is-new" : ""}`}
			disabled={busy}
			onClick={() => (confirmSpecies(clip) ? confirm(clip) : setAsking(true))}
			title={clip.newSpecies ? `Confirm, and add ${clip.newSpecies} to your life list` : confirmSpecies(clip) ? `Confirm this ${confirmSpecies(clip)}` : "Confirm, and say which bird it is"}
		>
			{busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="check" size={14} />}
			{clip.newSpecies ? "Confirm + add" : "Confirm"}
		</button>
	)
}

export const SightingSkeleton = () => (
	<div className="card sighting is-skeleton" aria-hidden="true">
		<div className="sighting-media">
			<span className="skeleton skeleton-fill" />
		</div>
		<div className="sighting-body">
			<span className="skeleton" style={{ width: "70%", height: 20 }} />
			<span className="skeleton" style={{ width: "45%", height: 18, borderRadius: 999 }} />
			<span className="skeleton" style={{ width: "35%", height: 14 }} />
		</div>
	</div>
)

/** The feed while it loads: a day header and a screenful of cards, shimmering. */
export const FeedSkeleton = () => (
	<div className="feed" aria-busy="true" aria-label="Loading sightings">
		<div className="day" style={{ "--n": 8 } as CSSProperties}>
			<div className="day-head is-skeleton" aria-hidden="true">
				<span className="day-pill">
					<span className="skeleton" style={{ width: 36, height: 38, borderRadius: 10 }} />
					<span className="skeleton" style={{ width: 140, height: 18 }} />
				</span>
			</div>
			{Array.from({ length: 8 }, (_, i) => (
				<SightingSkeleton key={i} />
			))}
		</div>
	</div>
)
