import { type FormEvent, useMemo, useRef, useState } from "react"
import type { ClipDetail, LookoutDto } from "../../../src/api-types.ts"
import type { Detection, Stage } from "../../../src/types.ts"
import { api, errorMessage } from "../api.ts"
import { Icon } from "../components/Icon.tsx"
import { birdGuess, confirmSpecies, useConfirmSighting } from "../components/LifeList.tsx"
import { Mascot } from "../components/Mascot.tsx"
import { EmptyState, LoadError, Meter, PageHead, Skeleton, StatusChip, Switch, Thumb } from "../components/ui.tsx"
import { useFeedback } from "../feedback.tsx"
import {
	birdName,
	fmtCostExact,
	fmtDate,
	fmtDuration,
	fmtMs,
	fmtPct,
	fmtTokens,
	fmtWhen,
	humanize,
	matchName,
	modelLabel,
	readFailure,
	readReason,
	readRetry
} from "../format.ts"
import { useDocumentTitle, useNow, useResource } from "../hooks.ts"
import { useLiveEvents } from "../live.tsx"
import { canGoBack, Link, navigate } from "../router.tsx"
import { toneStyle } from "../tone.ts"

const STAGES: Stage[] = ["probe", "motion", "detect", "judge"]
/** src/db.ts DETECTOR_ONLY: with no judge, the detector's match alone keeps a clip. */
const DETECTOR_ONLY = "detector-only"
const keeps = (v: { match: boolean; confidence: number; model: string }, threshold: number) =>
	v.match && (v.model === DETECTOR_ONLY || v.confidence >= threshold)
const STAGE_NAME: Record<Stage, string> = { probe: "file check", motion: "motion gate", detect: "detector", judge: "judge" }

export const ClipDetailPage = ({ id }: { id: string }) => {
	const clip = useResource(s => api.clip(id, s), [id])
	const lookouts = useResource(s => api.lookouts(s), [])
	const now = useNow()
	const d = clip.data
	const title = d ? clipTitle(d) : "Clip"
	useDocumentTitle(title)

	useLiveEvents(e => {
		if (e.event === "clip" && e.data.clipId === id) clip.reload()
	})

	if (clip.error && !d)
		return (
			<>
				<BackLink />
				{clip.errorStatus === 404 ? (
					<EmptyState title="This clip is gone" mascot="puzzled">
						<p>It may have been deleted, or retention cleaned it up after it was passed over.</p>
					</EmptyState>
				) : (
					<LoadError message={clip.error} status={clip.errorStatus} onRetry={clip.reload} what="this clip" />
				)}
			</>
		)
	if (!d) return <DetailSkeleton />

	return (
		<>
			<BackLink />
			<PageHead
				title={title}
				sub={
					<span className="detail-sub">
						<StatusChip status={d.status} droppedAt={d.status === "rejected" ? null : d.droppedAt} retry={readRetry({ ...d, error: d.clip.error })} />
						<span>{fmtWhen(d.recordedAt, now)}</span>
						<span aria-hidden="true">·</span>
						<span>{humanize(d.source)}</span>
						{d.durationS !== null && (
							<>
								<span aria-hidden="true">·</span>
								<span>{fmtDuration(d.durationS)}</span>
							</>
						)}
					</span>
				}
			/>
			<div className="detail">
				<div className="detail-main">
					{d.media.closeUps.length > 0 && (
						<section className="panel panel-closeups">
							<h2 className="panel-title">Close-up</h2>
							<div className="closeups">
								{d.media.closeUps.map((src, i) => (
									<a key={src} href={src} target="_blank" rel="noreferrer" className="closeup">
										<Thumb src={src} alt={`Close-up photo ${i + 1}: the camera zoomed in for it`} eager={i === 0} />
									</a>
								))}
							</div>
						</section>
					)}
					<MediaPanel d={d} />
					<StatusNote d={d} />
					{d.media.crops.length > 0 && (
						<section className="panel panel-crops">
							<h2 className="panel-title">What the spotter saw</h2>
							<div className="crops">
								{d.media.crops.map((src, i) => (
									<a key={src} href={src} target="_blank" rel="noreferrer" className="crop">
										<Thumb src={src} alt={`Close-up ${i + 1} the spotter looked at`} />
									</a>
								))}
							</div>
						</section>
					)}
					{/* under the player on wide screens, so the two columns come out about even */}
					<CostPanel d={d} />
				</div>
				<aside className="detail-side">
					{(d.newSpecies || (d.matches.length > 0 && !d.confirmed)) && <ConfirmNote key={d.newSpecies} d={d} onConfirmed={() => clip.reload()} />}
					<Verdicts d={d} lookouts={lookouts.data} onChange={next => clip.setData(() => next)} />
					<Actions d={d} onReprocessed={() => clip.setData(c => (c ? { ...c, status: "pending", reason: "Waiting for another look" } : c))} />
				</aside>
			</div>
		</>
	)
}

/** A sighting not yet confirmed: "yes, that's it", adding its bird to the life list when it's new. */
const ConfirmNote = ({ d, onConfirmed }: { d: ClipDetail; onConfirmed: () => void }) => {
	const { confirm, busy } = useConfirmSighting(onConfirmed)
	const ask = !confirmSpecies(d)
	const [name, setName] = useState(() => birdGuess(d))
	const submit = (e: FormEvent) => {
		e.preventDefault()
		confirm(d, name)
	}
	return (
		<form className="note note-lifer" onSubmit={submit}>
			<Icon name="sparkle" size={18} />
			<div className="note-body">
				{d.newSpecies ? (
					<>
						<strong>{d.newSpecies}</strong> isn't on your life list yet. Confirming adds it.
					</>
				) : (
					"Is this right? Confirming adds the bird to your life list if it isn't there."
				)}
				{ask && <input value={name} onChange={e => setName(e.target.value)} placeholder="Which bird?" aria-label="Which bird is it?" required maxLength={80} />}
			</div>
			<button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
				{busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="check" size={16} />}
				Confirm
			</button>
		</form>
	)
}

const clipTitle = (d: ClipDetail) => {
	const best = d.matches[0]
	if (best) return matchName(best)
	// a passed-over clip still often has a name: the judge said what it saw ("Chipping Sparrow")
	const named = [...d.verdicts].filter(v => v.species || v.label).sort((a, b) => b.confidence - a.confidence)[0]
	if (named) return named.species ?? birdName(named.label!)
	if (d.status === "rejected") return "Passed over"
	// a busy judge isn't a failure: the clip is only waiting for its turn again
	if (d.status === "error") return readRetry({ ...d, error: d.clip.error }) ? "Back in a bit" : "Couldn't process"
	if (d.status === "kept") return "Sighting"
	// the same words as the status chip and the banner below it
	return d.status === "processing" ? "Taking a look" : "In the queue"
}

const BackLink = () => (
	<Link
		to="/"
		className="back-link"
		onClick={e => {
			// Going back keeps the feed's filter; a deep link has nowhere in-app to go back to.
			if (!canGoBack()) return
			e.preventDefault()
			history.back()
		}}
	>
		<Icon name="arrowLeft" size={18} />
		Back
	</Link>
)

const MediaPanel = ({ d }: { d: ClipDetail }) => {
	const [showBoxes, setShowBoxes] = useState(false)
	const src = d.media.preview ?? d.media.original
	// The browser can't decode every camera format (HEVC/H.265 originals, mostly); fall back to the poster.
	const [failed, setFailed] = useState<string | null>(null)
	// Until the first play, the poster wears look4's own play button instead of the browser's controls.
	const [started, setStarted] = useState(false)
	const video = useRef<HTMLVideoElement>(null)
	const boxes = useMemo(() => posterDetections(d.detections), [d.detections])
	const canOverlay = boxes.length > 0 && d.media.poster
	return (
		<section className="panel panel-media">
			<div className="media-frame">
				{showBoxes && canOverlay ? (
					<div className="overlay-wrap">
						<img src={d.media.poster ?? undefined} alt="Best frame with detection boxes" />
						{boxes.map((b, i) => (
							<span
								key={i}
								className={`det-box via-${b.via}`}
								style={{
									left: `${b.box.x * 100}%`,
									top: `${b.box.y * 100}%`,
									width: `${b.box.w * 100}%`,
									height: `${b.box.h * 100}%`
								}}
							>
								<span className="det-label">
									{b.label} {fmtPct(b.score)}
								</span>
							</span>
						))}
					</div>
				) : src && failed !== src ? (
					<>
						<video
							ref={video}
							key={src}
							controls={started}
							playsInline
							preload="metadata"
							poster={d.media.poster ?? undefined}
							src={src}
							onPlay={() => setStarted(true)}
							onError={() => setFailed(src)}
						/>
						{!started && (
							<button
								type="button"
								className="play-big"
								aria-label="Play the clip"
								onClick={() => {
									setStarted(true)
									video.current?.play().catch(() => {})
								}}
							>
								<span className="play-big-disc">
									<Icon name="play" size={30} />
								</span>
								{d.durationS !== null && <span className="play-big-len">{fmtDuration(d.durationS)}</span>}
							</button>
						)}
					</>
				) : (
					<div className="media-gone">
						<Thumb src={d.media.poster} alt="Best frame" />
						<p className="media-gone-note">
							{src
								? "This browser can't play the original's video format. Download it to watch."
								: "The video file was cleaned up by retention."}
						</p>
					</div>
				)}
			</div>
			<div className="media-bar">
				{canOverlay ? (
					<label className="switch-row">
						<Switch checked={showBoxes} onChange={setShowBoxes} label="Show what the detector found" />
						<span aria-hidden="true">
							Show what the detector found <span className="count-pill">{boxes.length}</span>
						</span>
					</label>
				) : (
					<span className="muted">{d.detections.length ? "No poster frame to draw boxes on" : "No detector boxes for this clip"}</span>
				)}
				{!d.media.preview && d.media.original && failed !== src && <span className="muted">Playing the original file</span>}
			</div>
		</section>
	)
}

/**
 * The poster is the frame of the best detection, so only boxes found on that same
 * frame line up with it; boxes from other moments would float where the bird no longer is.
 */
const posterDetections = (ds: Detection[]) => {
	const best = ds.reduce<Detection | null>((a, b) => (!a || b.score > a.score ? b : a), null)
	if (!best) return []
	return ds.filter(x => x.frameT === best.frameT).sort((a, b) => b.score - a.score).slice(0, 12)
}

const StatusNote = ({ d }: { d: ClipDetail }) => {
	// a sighting whose re-check failed (a backfill, a reprocess): what it was kept for still stands
	if (d.status === "kept" && d.clip.error)
		return (
			<div className="note note-warn" role="status">
				<Icon name="alert" size={18} />
				<span>
					<strong>Still a sighting.</strong> look4 tried to check it again and couldn't finish ({recheckError(d)}), so it kept what
					it found before. <span className="muted">Look again to retry.</span>
				</span>
			</div>
		)
	if (d.status === "kept") return null
	if (d.status === "error") return <FailureNote d={d} />
	if (d.status === "rejected")
		return (
			<div className="note">
				<Icon name="eye" size={18} />
				<span>
					<strong>Passed over{d.droppedAt ? ` at the ${STAGE_NAME[d.droppedAt]}` : ""}.</strong> {passedReason(d)}
					{d.clip.expiresAt && <span className="muted"> Kept until {fmtDate(d.clip.expiresAt)}. Label it to keep it for good.</span>}
				</span>
			</div>
		)
	return (
		<div className="note note-thinking">
			<Mascot pose="thinking" size={52} className="note-mascot" />
			<span>{d.status === "processing" ? "look4 is taking a look at this clip right now…" : "This clip is in the queue. look4 will get to it shortly."}</span>
		</div>
	)
}

/**
 * A failed clip, calmly, with the raw error one click away. One look4 will retry by itself is a
 * scheduled wait: amber, the thinking eagle, and when. Only one that won't retry is red and puzzled.
 */
const FailureNote = ({ d }: { d: ClipDetail }) => {
	const f = readFailure({ reason: d.reason, droppedAt: d.droppedAt, error: d.clip.error })
	const retry = readRetry({ ...d, error: d.clip.error })
	return (
		<div className={`note note-failure ${retry ? "note-warn is-retry" : "note-bad"}`} role="status">
			<Mascot pose={retry ? "thinking" : "puzzled"} size={52} className="note-mascot" />
			<div className="note-body">
				{retry ? (
					<p>
						{f.text}, so look4 will try again {retry.at ? `at ${retry.at}` : "shortly"} by itself. Nothing for you to do, or
						Look again to try now.
					</p>
				) : (
					<p>
						{f.text}. Look again to retry once that's sorted.
					</p>
				)}
				{f.raw && (
					<details className="note-details">
						<summary>Details</summary>
						<p className="fine">{f.raw}</p>
					</details>
				)}
			</div>
		</div>
	)
}

const recheckError =(d: ClipDetail) => {
	const said = /re-check failed at (\w+): (.+)$/.exec(d.reason ?? "")
	const msg = (said?.[2] ?? d.clip.error ?? "").split("\n")[0]!.replace(/[.\s]+$/, "")
	return said ? `the ${STAGE_NAME[said[1] as Stage] ?? said[1]} said: ${msg}` : msg
}

const passedReason = (d: ClipDetail) => {
	const r = readReason(d)
	if (!r.close) return r.text
	return `${r.text.replace(/\.$/, "")}, ${fmtPct(r.close.got)} sure. This lookout keeps clips from ${fmtPct(r.close.needs)}, so it was a close call.`
}

const Verdicts = ({
	d,
	lookouts,
	onChange
}: {
	d: ClipDetail
	lookouts: LookoutDto[] | null
	onChange: (d: ClipDetail) => void
}) => {
	const { toast } = useFeedback()
	const [busy, setBusy] = useState<string | null>(null)
	// Every lookout that judged this clip, plus enabled ones, so a miss can still be labeled.
	const rows = useMemo(() => {
		const ids = new Set(d.verdicts.map(v => v.lookoutId))
		const extra = (lookouts ?? []).filter(l => !ids.has(l.id) && (l.enabled || d.labels.some(x => x.lookoutId === l.id)))
		// what kept the clip first, then the close calls, then the clear "no"s
		const rank = (v: ClipDetail["verdicts"][number]) => (v.match ? (keeps(v, v.threshold) ? 2 : 1) : 0)
		const judged = [...d.verdicts].sort((a, b) => rank(b) - rank(a) || b.confidence - a.confidence)
		return [
			...judged.map(v => ({ id: v.lookoutId, name: v.lookoutName, threshold: v.threshold, verdict: v })),
			...extra.map(l => ({ id: l.id, name: l.name, threshold: l.threshold, verdict: null }))
		]
	}, [d, lookouts])

	const setLabel = async (lookoutId: string, truth: boolean | null) => {
		setBusy(lookoutId)
		// "Not this" on a verdict that made the clip a sighting takes it out of the feed and the lookout's chip
		const v = d.verdicts.find(x => x.lookoutId === lookoutId)
		const hides = truth === false && d.status !== "rejected" && !!v && keeps(v, v.threshold)
		try {
			onChange(await api.label(d.id, { lookoutId, truth }))
			toast(truth === null ? "Label cleared" : hides ? "Hidden from Sightings" : "Thanks! That makes look4 sharper.", { tone: "good" })
		} catch (e) {
			toast(errorMessage(e), { tone: "bad" })
		} finally {
			setBusy(null)
		}
	}

	// Lookouts the judge never looked at (and nobody labeled) are one quiet line, not a wall of identical thumbs.
	const shown = rows.filter(r => r.verdict || d.labels.some(l => l.lookoutId === r.id))
	const unchecked = rows.filter(r => !shown.includes(r))
	const [open, setOpen] = useState(false)
	const waiting = d.status === "pending" || d.status === "processing"
	const listed = open ? rows : shown

	return (
		<section className="panel panel-verdicts">
			<h2 className="panel-title">Lookouts</h2>
			{rows.length === 0 && <p className="muted">No lookouts yet, so nothing checked this clip.</p>}
			{shown.length === 0 && unchecked.length > 0 && !open && (
				<p className="verdicts-none muted">
					{waiting ? "The spotter hasn't looked at this clip yet." : d.status === "error" ? "The spotter didn't get to look at this clip." : "No lookout got as far as the spotter."}
				</p>
			)}
			{listed.length > 0 && (
			<ul className="verdicts">
				{listed.map(r => {
					const v = r.verdict
					const label = d.labels.find(l => l.lookoutId === r.id)
					const kept = v ? keeps(v, r.threshold) : false
					const detectorOnly = v?.model === DETECTOR_ONLY
					return (
						<li key={r.id} className="verdict" style={toneStyle(r.id, lookouts)}>
							<div className="verdict-head">
								<span className="chip chip-lookout" title={r.name}>
									{humanize(r.name)}
								</span>
								{v ? (
									<span className={`verdict-call ${kept ? "is-yes" : "is-no"}`}>
										<Icon name={kept ? "check" : "x"} size={16} />
										{kept ? "Match" : v.match ? "Too unsure" : "No match"}
									</span>
								) : (
									<span className="verdict-call is-none">Not checked</span>
								)}
							</div>
							{v && (
								<>
									{(v.species || v.label) && (
										<div className="verdict-label">
											{v.species ?? v.label}
											{v.species && v.speciesConfidence != null && <span className="muted"> · {fmtPct(v.speciesConfidence)} sure</span>}
										</div>
									)}
									{detectorOnly ? (
										// no judge: the detector's score is on its own scale, and its match alone keeps the clip
										<div className="verdict-conf">
											<span>
												<strong>{fmtPct(v.confidence)}</strong>
												<span className="muted"> detector score · with no spotter, every detector match is kept</span>
											</span>
										</div>
									) : v.match ? (
										<div className="verdict-conf">
											<Meter value={v.confidence} threshold={r.threshold} label={`${humanize(r.name)} confidence`} />
											<span>
												<strong>{fmtPct(v.confidence)}</strong>
												<span className="muted"> sure · needs {fmtPct(r.threshold)}</span>
											</span>
										</div>
									) : (
										// a "no" answer's confidence is how sure the judge is that it is NOT there; a threshold bar would read backwards
										<div className="verdict-conf">
											<span>
												<strong>{fmtPct(v.confidence)}</strong>
												<span className="muted"> sure it isn't</span>
											</span>
										</div>
									)}
									{v.rationale && <p className="verdict-why">“{v.rationale}”</p>}
									<div className="verdict-model muted" title={v.model}>
										{modelLabel(v.model)}
									</div>
								</>
							)}
							<div className="label-row" role="group" aria-label={`Is this ${humanize(r.name)}?`}>
								<span className="label-q">{label ? "You said:" : "Is it?"}</span>
								<button
									type="button"
									className="label-btn is-yes"
									aria-pressed={label?.truth === true}
									disabled={busy === r.id}
									onClick={() => setLabel(r.id, label?.truth === true ? null : true)}
								>
									<Icon name="thumbUp" size={16} />
									Yes, that's it
								</button>
								<button
									type="button"
									className="label-btn is-no"
									aria-pressed={label?.truth === false}
									disabled={busy === r.id}
									onClick={() => setLabel(r.id, label?.truth === false ? null : false)}
								>
									<Icon name="thumbDown" size={16} />
									Not this
								</button>
							</div>
						</li>
					)
				})}
			</ul>
			)}
			{unchecked.length > 0 && (
				<button type="button" className="verdicts-more" aria-expanded={open} onClick={() => setOpen(o => !o)}>
					<span>
						Not {waiting ? "checked yet" : "checked"} for {unchecked.map(r => humanize(r.name)).join(", ")}
					</span>
					<span className="verdicts-more-cta">
						{open ? "Hide" : "Label it"}
						<Icon name="chevronDown" size={14} />
					</span>
				</button>
			)}
		</section>
	)
}

const Actions = ({ d, onReprocessed }: { d: ClipDetail; onReprocessed: () => void }) => {
	const { toast, confirm } = useFeedback()
	const [busy, setBusy] = useState(false)
	const reprocess = async () => {
		setBusy(true)
		try {
			await api.reprocess(d.id)
			onReprocessed()
			toast("Queued for another look", { tone: "good" })
		} catch (e) {
			toast(errorMessage(e), { tone: "bad" })
		} finally {
			setBusy(false)
		}
	}
	const remove = async () => {
		const ok = await confirm({
			title: "Delete this clip?",
			body: "The video, its close-ups and what each lookout decided are removed from disk. This can't be undone.",
			confirmLabel: "Delete clip",
			danger: true
		})
		if (!ok) return
		try {
			await api.deleteClip(d.id)
			toast("Clip deleted")
			navigate("/")
		} catch (e) {
			toast(errorMessage(e), { tone: "bad" })
		}
	}
	return (
		<section className="panel actions">
			<button type="button" className="btn btn-ghost" onClick={reprocess} disabled={busy || !d.media.original || d.status === "processing"}>
				<Icon name="refresh" size={18} />
				Look again
			</button>
			{d.media.original && (
				<a className="btn btn-ghost" href={d.media.original} download={d.clip.originalName}>
					<Icon name="download" size={18} />
					Original
				</a>
			)}
			{/* destructive and rare: a quiet link-weight control, not a third big button */}
			<button type="button" className="btn-quiet btn-delete" onClick={remove}>
				<Icon name="trash" size={16} />
				Delete clip
			</button>
		</section>
	)
}

const CostPanel = ({ d }: { d: ClipDetail }) => {
	const timings = STAGES.filter(s => d.clip.timings[s] !== undefined).map(s => ({ stage: s, ms: d.clip.timings[s] ?? 0 }))
	const max = Math.max(1, ...timings.map(t => t.ms))
	// A clip still in the queue, or one that failed before the judge billed anything, has no cost to show;
	// "$0.00 · 0 · 0 / 0" there reads as broken. A finished clip's $0.00 is real (motion or detector said no for free).
	const unfinished = d.status !== "kept" && d.status !== "rejected" && d.usage.calls === 0
	return (
		<section className="panel panel-cost">
			<h2 className="panel-title">Cost and time</h2>
			{unfinished ? (
				<p className="cost-none muted">
					{d.status === "error" ? "Nothing spent: it stopped before the spotter was paid to look." : "Nothing spent yet. The cost shows up here once the spotter has looked."}
				</p>
			) : (
			<dl className="facts">
				<div>
					<dt>Spotter cost</dt>
					<dd title={`${fmtTokens(d.usage.inputTokens)} tokens in, ${fmtTokens(d.usage.outputTokens)} out`}>{fmtCostExact(d.usage.costUsd)}</dd>
				</div>
				<div>
					<dt>Looks</dt>
					<dd>{d.usage.calls}</dd>
				</div>
			</dl>
			)}
			{timings.length > 0 && (
				<ul className="timings">
					{timings.map(t => (
						<li key={t.stage}>
							<span className="timing-name">{t.stage === "detect" ? "Detector" : t.stage[0]?.toUpperCase() + t.stage.slice(1)}</span>
							<span className="timing-bar" aria-hidden="true">
								<span style={{ width: `${(t.ms / max) * 100}%` }} />
							</span>
							<span className="timing-ms">{fmtMs(t.ms)}</span>
						</li>
					))}
				</ul>
			)}
			{/* camera file names (RecM07_20261014_093012_…_1E2F3A.mp4) have no break points; let them wrap anywhere */}
			<p className="fine muted clip-file" title={d.clip.originalName}>
				{d.clip.originalName}
				{d.clip.width && d.clip.height ? ` · ${d.clip.width}×${d.clip.height}` : ""}
			</p>
		</section>
	)
}

const DetailSkeleton = () => (
	<div aria-busy="true" aria-label="Loading clip">
		<Skeleton style={{ width: 80, height: 18, marginBottom: 16 }} />
		<Skeleton style={{ width: "40%", height: 36, marginBottom: 24 }} />
		<div className="detail">
			<div className="detail-main">
				<Skeleton className="skeleton-video" />
			</div>
			<div className="detail-side">
				<Skeleton style={{ height: 220 }} />
				<Skeleton style={{ height: 120 }} />
			</div>
		</div>
	</div>
)
