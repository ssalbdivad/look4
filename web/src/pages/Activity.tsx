import { useEffect, useMemo, useRef, useState } from "react"
import type { ClipSummary, Funnel, LookoutDto, StatsResponse } from "../../../src/api-types.ts"
import type { SourceStatus } from "../../../src/types.ts"
import { api, errorMessage } from "../api.ts"
import { Icon, type IconName } from "../components/Icon.tsx"
import { Mascot } from "../components/Mascot.tsx"
import { SourceDetail, sourceProblem } from "../components/SourceDetail.tsx"
import { Dot, EmptyState, ErrorNote, LoadError, PageHead, Skeleton, StatusChip, Thumb } from "../components/ui.tsx"
import { useFeedback } from "../feedback.tsx"
import {
	dayKey,
	dayLabel,
	diskState,
	fmtBytes,
	fmtCost,
	fmtCostExact,
	fmtCount,
	fmtGb,
	fmtPct,
	fmtRelative,
	fmtTime,
	fmtWhen,
	humanize,
	lookoutTitle,
	modelLabel,
	plural,
	readFailure,
	readReason,
	readRetry,
	STAGE_HELP
} from "../format.ts"
import { useDocumentTitle, useNow, useResource } from "../hooks.ts"
import { useLive, useLiveEvents } from "../live.tsx"
import { Link } from "../router.tsx"
import { toneStyle } from "../tone.ts"
import { DropZone, useUpload } from "../upload.tsx"

type Range = "today" | "week" | "all"
const RANGES: { id: Range; label: string }[] = [
	{ id: "today", label: "Today" },
	{ id: "week", label: "7 days" },
	{ id: "all", label: "All time" }
]

export const ActivityPage = () => {
	useDocumentTitle("Activity")
	const now = useNow()
	const { version } = useUpload()
	const stats = useResource(s => api.stats(s), [version])
	// bumped when a clip is passed over, so the list refetches (a burst of events is one cheap refetch each)
	const [rejected, setRejected] = useState(0)
	const errors = useResource(s => api.clips({ status: "error", limit: 5 }, s), [version])
	const lookouts = useResource(s => api.lookouts(s), [])
	const [range, setRange] = useState<Range>("today")
	const { queue } = useLive()

	// Server events arrive in bursts while a clip moves through the cascade; refetching on each is cheap.
	useLiveEvents(e => {
		if (e.event === "clip") {
			stats.reload()
			if (e.data.status === "rejected") setRejected(n => n + 1)
			if (e.data.status === "error") errors.reload()
		}
		if (e.event === "source") stats.setData(s => (s ? { ...s, sources: upsertSource(s.sources, e.data) } : s))
	})

	const s = stats.data
	const q = queue ?? s?.queue
	const head = <PageHead title="Activity" sub="What came in, what each stage let through, and what it cost." />
	if (stats.error && !s)
		return (
			<>
				{head}
				<LoadError message={stats.error} status={stats.errorStatus} onRetry={stats.reload} what="activity" />
			</>
		)
	// A fresh install has no clips at all: a dashboard of zeros reads as unfinished, so it gets one warm
	// empty state, plus the Pipeline card (setup status worth seeing before the first clip).
	if (s && s.funnel.all.ingested === 0) {
		// the uploads inbox is always there; only a camera or folder counts as something being watched
		const feeds = s.sources.filter(x => x.type !== "inbox")
		const waiting = q ? q.pending + q.processing : 0
		return (
			<>
				{head}
				<EmptyState
					title={waiting ? "Looking at your first clips…" : feeds.length ? "Waiting for the first clip" : "Nothing has come in yet"}
					// looking, not sleepy: Sightings naps when it's empty, so Activity keeps an eye out instead
					mascot="looking"
					actions={
						feeds.length ? null : (
							<Link to="/setup?step=source" className="btn btn-primary">
								<Icon name="camera" size={18} />
								Connect a camera
							</Link>
						)
					}
				>
					{waiting > 0 && <p className="empty-status">{plural(waiting, "clip")} waiting for a look right now.</p>}
					<p>
						Activity shows up once clips start arriving: how many came in, what each step let through, and what the spotter cost.
						{feeds.length > 0 && ` look4 is watching ${feeds.map(x => `“${humanize(x.name)}”`).join(" and ")}.`}
					</p>
				</EmptyState>
				<div className={feeds.length ? "two-col" : "activity-solo"}>
					{feeds.length > 0 && <Sources sources={s.sources} now={now} onPolled={stats.reload} />}
					<Pipeline s={s} />
				</div>
			</>
		)
	}
	return (
		<>
			{head}
			<section className="panel">
				<div className="panel-head">
					<h2 className="panel-title">The funnel</h2>
					<div className="segmented" role="radiogroup" aria-label="Time range">
						{RANGES.map(r => (
							<button
								key={r.id}
								type="button"
								role="radio"
								aria-checked={range === r.id}
								className="segment"
								onClick={() => setRange(r.id)}
							>
								{r.label}
							</button>
						))}
					</div>
				</div>
				{s ? <FunnelView f={s.funnel[range]} /> : <Skeleton style={{ height: 200 }} />}
			</section>
			<div className="tiles">
				<Tile icon="coin" label="Spent today" value={s ? fmtCost(s.cost.todayUsd) : null} note={s ? `${plural(s.cost.callsToday, "spotter look")}${s.cost.todayUsd > 0 && s.cost.todayUsd < 0.01 ? `, ${fmtCostExact(s.cost.todayUsd)}` : ""}` : ""} />
				<Tile icon="coin" label="This month" value={s ? fmtCost(s.cost.monthUsd) : null} note={s ? `${fmtCostExact(s.cost.allUsd)} all time` : ""} />
				<Tile
					icon="layers"
					label="Queue"
					value={q ? fmtCount(q.pending + q.processing) : null}
					note={q ? (q.processing ? `${q.processing} being looked at` : q.pending ? "waiting" : "all caught up") : ""}
				/>
				<Tile
					icon="disk"
					label="Disk"
					value={s ? fmtBytes(s.diskBytes) : null}
					note={s ? diskNote(s) : ""}
					warn={!!s && diskLow(s)}
					title={s && diskLow(s) ? diskState(s).text : undefined}
				/>
			</div>
			<div className="two-col">
				<Sources sources={s?.sources ?? null} now={now} onPolled={stats.reload} />
				<Pipeline s={s} />
			</div>
			<Rejects lookouts={lookouts.data ?? []} now={now} bump={rejected + version} />
			{errors.data && errors.data.items.length > 0 && (
				<section className="panel">
					{/* a busy judge's clips wait here for their retry too, so not "errors" */}
					<h2 className="panel-title">{errors.data.items.every(c => readRetry(c)) ? "Waiting to retry" : "Recent hiccups"}</h2>
					<ul className="clip-rows">
						{errors.data.items.map(c => (
							<ClipRow key={c.id} c={c} now={now} />
						))}
					</ul>
				</section>
			)}
		</>
	)
}

const upsertSource = (list: SourceStatus[], s: SourceStatus) =>
	list.some(x => x.name === s.name) ? list.map(x => (x.name === s.name ? s : x)) : [...list, s]

const FunnelView = ({ f }: { f: Funnel }) => {
	if (!f.ingested)
		return (
			<p className="muted funnel-empty">
				No clips in this window yet. When clips arrive, you'll see how many each stage lets through.
			</p>
		)
	const steps = [
		{ label: "Came in", n: f.ingested, drop: null as string | null },
		{ label: "Had motion", n: f.passed.motion, drop: dropText(f.droppedAt.motion + f.droppedAt.probe, "nothing moved, or unreadable") },
		{ label: "Detector found something", n: f.passed.detect, drop: dropText(f.droppedAt.detect, "nothing a lookout cares about") },
		{ label: "Kept", n: f.kept, drop: dropText(f.droppedAt.judge, "the spotter said no") }
	]
	return (
		<>
			<ol className="funnel">
				{steps.map((st, i) => (
					<li key={st.label} className={`funnel-step step-${i}`}>
						<div className="funnel-label">
							<span>{st.label}</span>
							<span className="funnel-n">
								<strong>{fmtCount(st.n)}</strong>
								{i > 0 && <span className="muted"> {fmtPct(st.n / f.ingested)}</span>}
							</span>
						</div>
						<div className="funnel-track" aria-hidden="true">
							<span style={{ width: `${Math.max(st.n ? 1.5 : 0, (st.n / f.ingested) * 100)}%` }} />
						</div>
						{st.drop && <div className="funnel-drop muted">{st.drop}</div>}
					</li>
				))}
			</ol>
			{(f.pending > 0 || f.processing > 0 || f.errors > 0) && (
				<p className="fine muted">
					{[f.processing && `${f.processing} processing`, f.pending && `${f.pending} waiting`, f.errors && plural(f.errors, "error")]
						.filter(Boolean)
						.join(" · ")}
				</p>
			)}
		</>
	)
}

const dropText = (n: number, why: string) => (n ? `${fmtCount(n)} dropped: ${why}` : null)

const diskLow = (s: StatsResponse) => diskState(s).low
/** Under the bytes look4 uses: how much room is left, which is what runs out. */
const diskNote = (s: StatsResponse) =>
	s.diskFreeBytes === undefined ? "clips and close-ups" : diskLow(s) ? `only ${fmtGb(s.diskFreeBytes)} free: paused` : `${fmtGb(s.diskFreeBytes)} free`

const Tile = ({
	icon,
	label,
	value,
	note,
	warn,
	title
}: {
	icon: IconName
	label: string
	value: string | null
	note: string
	warn?: boolean
	title?: string
}) => (
	<div className={`tile${warn ? " is-warn" : ""}`} title={title}>
		<span className="tile-icon">
			<Icon name={icon} size={18} />
		</span>
		<span className="tile-label">{label}</span>
		{value === null ? <Skeleton style={{ width: 70, height: 30 }} /> : <span className="tile-value">{value}</span>}
		<span className={`tile-note${warn ? "" : " muted"}`}>
			{warn && <Icon name="alert" size={13} />}
			{note}
		</span>
	</div>
)

const SOURCE_KIND: Record<string, string> = { reolink: "Reolink camera", rtsp: "camera stream", watch: "folder", inbox: "uploads" }
const SOURCE_ICON: Record<string, IconName> = { reolink: "camera", rtsp: "camera", watch: "folder", inbox: "folder" }
const stateTone = (s: SourceStatus["state"]): "good" | "bad" | "warn" | "idle" =>
	s === "ok" ? "good" : s === "error" ? "bad" : s === "starting" ? "warn" : "idle"

const Sources = ({ sources, now, onPolled }: { sources: SourceStatus[] | null; now: number; onPolled: () => void }) => {
	const { toast } = useFeedback()
	const [polling, setPolling] = useState<string | null>(null)
	const poll = async (name: string) => {
		setPolling(name)
		try {
			await api.pollSource(name)
			toast(`Checked ${humanize(name)}`, { tone: "good" })
			onPolled()
		} catch (e) {
			toast(errorMessage(e), { tone: "bad" })
		} finally {
			setPolling(null)
		}
	}
	return (
		<section className="panel">
			<h2 className="panel-title">Sources</h2>
			{!sources && <Skeleton style={{ height: 120 }} />}
			{sources?.length === 0 && (
				<p className="muted">
					No sources yet. <Link to="/settings?add=1">Connect your camera or a folder</Link>, or upload videos with the Upload button.
				</p>
			)}
			<ul className="sources">
				{sources?.map(s => (
					<li key={s.name} className="source">
						<span className="source-icon">
							<Icon name={SOURCE_ICON[s.type] ?? "film"} size={18} />
						</span>
						<div className="source-main">
							<div className="source-name">
								<Dot tone={stateTone(s.state)} pulse={s.state === "starting"} />
								<strong>{humanize(s.name)}</strong>
								<span className="muted">{SOURCE_KIND[s.type] ?? s.type}</span>
							</div>
							<SourceDetail detail={s.detail} className="source-detail" />
							<div className="source-meta muted">
								Checked {fmtRelative(s.lastPollAt, now)} · {plural(s.clipsIngested, "clip")}
								{s.lastClipAt && ` · last ${fmtRelative(s.lastClipAt, now)}`}
							</div>
						</div>
						{s.state === "error" && sourceProblem(s.detail) === "disk" ? (
							<Link to="/settings#sec-retention" className="btn btn-primary btn-sm">
								<Icon name="disk" size={16} />
								Free up space
							</Link>
						) : s.state === "error" && s.type !== "inbox" ? (
							<Link to={`/settings?fix=${encodeURIComponent(s.name)}`} className="btn btn-primary btn-sm">
								<Icon name="sparkle" size={16} />
								Fix it
							</Link>
						) : (
							<button type="button" className="btn btn-ghost btn-sm" onClick={() => poll(s.name)} disabled={polling === s.name}>
								{polling === s.name ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" size={16} />}
								Check now
							</button>
						)}
					</li>
				))}
			</ul>
		</section>
	)
}

const Pipeline = ({ s }: { s: StatsResponse | null }) => (
	<section className="panel">
		<h2 className="panel-title">On watch</h2>
		{!s ? (
			<Skeleton style={{ height: 120 }} />
		) : (
			<ul className="components">
				<li>
					<Dot tone={s.pipeline.detector.enabled ? (s.pipeline.detector.ok ? "good" : "bad") : "idle"} />
					<div>
						<strong>Detector</strong>{" "}
						<span className="muted" title={s.pipeline.detector.model}>
							{s.pipeline.detector.enabled ? modelLabel(s.pipeline.detector.model) : "off"}
						</span>
						<div className="muted fine">{s.pipeline.detector.detail}</div>
					</div>
				</li>
				<li>
					<Dot tone={s.pipeline.judge.ok ? "good" : "bad"} />
					<div>
						<strong>Spotter</strong>{" "}
						<span className="muted" title={`${s.pipeline.judge.provider} · ${s.pipeline.judge.model}`}>
							{s.pipeline.judge.provider === "none" ? "off" : modelLabel(s.pipeline.judge.model, s.pipeline.judge.provider)}
						</span>
						<div className="muted fine">{s.pipeline.judge.detail}</div>
					</div>
				</li>
				<li>
					<Dot tone={s.pipeline.roi ? "good" : "idle"} />
					<div>
						<strong>Detection zone</strong>{" "}
						<span className="muted">{s.pipeline.roi ? `${fmtPct(s.pipeline.roi.w * s.pipeline.roi.h)} of the frame` : "whole frame"}</span>
						<div className="muted fine">
							<Link to="/settings">Draw it around the feeder</Link> to ignore swaying branches.
						</div>
					</div>
				</li>
			</ul>
		)}
		{s && <p className="fine muted version">look4 v{s.version}</p>}
	</section>
)

type StageFilter = "judge" | "detect" | "motion" | "all"
const STAGE_FILTERS: { id: StageFilter; label: string; icon: IconName; empty: string }[] = [
	// labelled like the rows it shows (their stage chip says "Spotter"); its close calls are tagged within it
	{ id: "judge", label: "Spotter", icon: "sparkle", empty: "Nothing the spotter turned down lately. Clips it says no to, and the near-misses, show up here." },
	{ id: "detect", label: "Detector", icon: "eye", empty: "The detector hasn't turned anything away lately." },
	{ id: "motion", label: "No motion", icon: "pulse", empty: "No still clips lately: everything that came in had something moving." },
	{ id: "all", label: "All", icon: "list", empty: "Clips that don't match any lookout show up here for a while, so you can check look4's work." }
]
const PAGE = 20

/**
 * What look4 passed over, so a miss can be labeled. Starts on the judge's drops, where the misses
 * worth labeling live; motion drops pile up by the hundred on a windy day, so their runs fold away.
 */
const Rejects = ({ lookouts, now, bump }: { lookouts: LookoutDto[]; now: number; bump: number }) => {
	const { toast } = useFeedback()
	const [stage, setStage] = useState<StageFilter>("judge")
	const first = useResource(s => api.clips({ status: "rejected", droppedAt: stage === "all" ? undefined : stage, limit: PAGE }, s), [stage, bump])
	const [items, setItems] = useState<ClipSummary[] | null>(null)
	const [nextBefore, setNextBefore] = useState<string | null>(null)
	const [more, setMore] = useState(false)
	useEffect(() => {
		if (!first.data) return
		setItems(first.data.items)
		setNextBefore(first.data.nextBefore)
	}, [first.data])
	const loadMore = async () => {
		if (!nextBefore) return
		setMore(true)
		try {
			const page = await api.clips({ status: "rejected", droppedAt: stage === "all" ? undefined : stage, before: nextBefore, limit: PAGE })
			setItems(xs => [...(xs ?? []), ...page.items.filter(p => !xs?.some(x => x.id === p.id))])
			setNextBefore(page.nextBefore)
		} catch (e) {
			toast(errorMessage(e), { tone: "bad" })
		} finally {
			setMore(false)
		}
	}
	const filter = STAGE_FILTERS.find(f => f.id === stage)!
	// a stage switch shows the old list until the new one lands; dimmed, so it's clear it's changing
	const stale = first.loading && items !== null
	const days = useMemo(() => groupRejects(items ?? [], now), [items, now])
	return (
		<section className="panel rejects" aria-labelledby="rejects-title">
			<div className="panel-head rejects-head">
				<div>
					<h2 className="panel-title" id="rejects-title">
						Recently passed over
					</h2>
					<p className="muted fine rejects-sub">
						Spot a miss? Give it a <Icon name="thumbUp" size={14} className="inline-icon" /> and it counts toward what each lookout catches.
					</p>
				</div>
				<div className="filter-chips stage-chips" role="group" aria-label="Which passes to show">
					{STAGE_FILTERS.map(f => (
						<button key={f.id} type="button" className="filter-chip" aria-pressed={stage === f.id} onClick={() => setStage(f.id)}>
							<Icon name={f.icon} size={15} />
							{f.label}
						</button>
					))}
				</div>
			</div>
			{first.error && !items && <ErrorNote message={first.error} onRetry={first.reload} />}
			{!items && !first.error && <Skeleton style={{ height: 160 }} />}
			{items?.length === 0 && !stale && (
				<div className="rejects-empty">
					<Mascot pose="looking" size={84} />
					<p className="muted">{filter.empty}</p>
					{stage === "all" && <DropZone compact />}
				</div>
			)}
			{items && items.length > 0 && (
				<div className={`reject-days${stale ? " is-stale" : ""}`} aria-busy={stale}>
					{days.map(d => (
						<div key={d.key} className="reject-day">
							<h3 className="reject-day-name">
								{d.label}
								<span className="muted"> · {plural(d.count, "clip")}</span>
							</h3>
							<ul className="clip-rows">
								{d.parts.map(p =>
									p.kind === "one" ? (
										<ClipRow key={p.clip.id} c={p.clip} now={now} lookouts={lookouts} dated />
									) : (
										<StillRun key={p.clips[0]!.id} clips={p.clips} now={now} lookouts={lookouts} />
									)
								)}
							</ul>
						</div>
					))}
				</div>
			)}
			{nextBefore && items && items.length > 0 && (
				<div className="load-more">
					<button type="button" className="btn btn-ghost btn-sm" onClick={loadMore} disabled={more}>
						{more ? <span className="spinner" aria-hidden="true" /> : <Icon name="chevronDown" size={16} />}
						{more ? "Loading…" : "Show older"}
					</button>
				</div>
			)}
		</section>
	)
}

type RejectPart = { kind: "one"; clip: ClipSummary } | { kind: "still"; clips: ClipSummary[] }

/** Rows by day, with each run of three or more motionless clips folded into one row. */
const groupRejects = (items: ClipSummary[], now: number) => {
	const days: { key: string; label: string; count: number; parts: RejectPart[] }[] = []
	for (const c of items) {
		const key = dayKey(c.recordedAt)
		let day = days.at(-1)
		if (day?.key !== key) days.push((day = { key, label: dayLabel(c.recordedAt, now), count: 0, parts: [] }))
		day.count++
		const last = day.parts.at(-1)
		const still = c.droppedAt === "motion"
		if (still && last?.kind === "still") last.clips.push(c)
		else if (still && last?.kind === "one" && last.clip.droppedAt === "motion") day.parts[day.parts.length - 1] = { kind: "still", clips: [last.clip, c] }
		else day.parts.push({ kind: "one", clip: c })
	}
	// a "run" of two reads better as two rows
	for (const d of days) d.parts = d.parts.flatMap(p => (p.kind === "still" && p.clips.length < 3 ? p.clips.map(clip => ({ kind: "one" as const, clip })) : [p]))
	return days
}

const StillRun = ({ clips, now, lookouts }: { clips: ClipSummary[]; now: number; lookouts: LookoutDto[] }) => {
	const [open, setOpen] = useState(false)
	if (open) return clips.map(c => <ClipRow key={c.id} c={c} now={now} lookouts={lookouts} dated />)
	const newest = clips[0]!
	const oldest = clips.at(-1)!
	return (
		<li className="clip-row still-run">
			<button type="button" className="still-run-btn" onClick={() => setOpen(true)} aria-expanded={false}>
				<span className="still-stack" aria-hidden="true">
					{clips.slice(0, 3).map((c, i) => (
						<Thumb key={c.id} src={c.media.poster} alt="" className={`still-thumb still-${i}`} />
					))}
				</span>
				<span className="clip-row-main">
					<span className="still-run-title">{plural(clips.length, "clip")} with nothing moving</span>
					<span className="muted fine">
						{fmtTime(oldest.recordedAt)} – {fmtTime(newest.recordedAt)} · wind, light changes and empty frames
					</span>
				</span>
				<span className="still-run-show">
					Show
					<Icon name="chevronDown" size={16} />
				</span>
			</button>
		</li>
	)
}

/** `dated`: the row sits under a day heading, so the time alone says when. */
const ClipRow = ({ c, now, lookouts, dated }: { c: ClipSummary; now: number; lookouts?: LookoutDto[]; dated?: boolean }) => {
	const r = readReason(c)
	// a failure in plain words ("The judge was busy."); the raw error is on the clip's page under Details
	const failure = c.status === "error" ? readFailure(c) : null
	const retry = readRetry(c)
	const text = failure ? `${failure.text}.` : r.text
	return (
		<li className={`clip-row${r.close ? " is-close" : ""}`}>
			<Link to={`/clips/${c.id}`} className="clip-row-link">
				<Thumb src={c.media.poster} alt="" className="clip-row-thumb" />
				<div className="clip-row-main">
					<div className="clip-row-top">
						{r.close ? (
							<span className="chip chip-close" title={`The spotter said yes, ${fmtPct(r.close.got)} sure, but this lookout keeps from ${fmtPct(r.close.needs)}`}>
								<Icon name="sparkle" size={12} />
								Close call · {fmtPct(r.close.got)} of {fmtPct(r.close.needs)}
							</span>
						) : (
							<StatusChip status={c.status} droppedAt={c.droppedAt} retry={retry} />
						)}
						<span className="muted">{dated ? fmtTime(c.recordedAt) : fmtWhen(c.recordedAt, now)}</span>
						<span className="muted clip-row-src">{humanize(c.source)}</span>
					</div>
					<div className="clip-row-reason" title={failure?.raw ?? (c.droppedAt ? STAGE_HELP[c.droppedAt] : undefined)}>
						{text}
					</div>
				</div>
			</Link>
			{lookouts && lookouts.length > 0 && <ShouldHaveMatched clip={c} lookouts={lookouts} />}
		</li>
	)
}

/** Labels a passed-over clip as a true match for a lookout: the raw material for recall. */
const ShouldHaveMatched = ({ clip, lookouts }: { clip: ClipSummary; lookouts: LookoutDto[] }) => {
	const { toast } = useFeedback()
	const [open, setOpen] = useState(false)
	const [done, setDone] = useState<string | null>(null)
	const wrap = useRef<HTMLDivElement>(null)
	useEffect(() => {
		if (!open) return
		const close = (e: PointerEvent) => {
			if (!wrap.current?.contains(e.target as Node)) setOpen(false)
		}
		document.addEventListener("pointerdown", close)
		return () => document.removeEventListener("pointerdown", close)
	}, [open])
	const mark = async (l: LookoutDto) => {
		setOpen(false)
		try {
			await api.label(clip.id, { lookoutId: l.id, truth: true })
			setDone(humanize(l.name))
			toast(`Marked as a miss for “${humanize(l.name)}”. It won't be deleted.`, { tone: "good" })
		} catch (e) {
			toast(errorMessage(e), { tone: "bad" })
		}
	}
	if (done)
		return (
			<span className="miss-done" title={`You said this was a miss for ${done}`}>
				<Icon name="check" size={16} />
				<span className="miss-done-name">{done}</span>
			</span>
		)
	const one = lookouts.length === 1 ? lookouts[0] : null
	const tip = one ? `This should have matched “${humanize(one.name)}”` : "This should have matched"
	return (
		<div className="menu-wrap miss" ref={wrap}>
			<button
				type="button"
				className="miss-btn"
				aria-label={tip}
				data-tip={tip}
				aria-expanded={one ? undefined : open}
				aria-haspopup={one ? undefined : "menu"}
				onClick={() => (one ? mark(one) : setOpen(o => !o))}
			>
				<Icon name="thumbUp" size={18} />
			</button>
			{open && (
				<div
					className="menu"
					role="menu"
					onKeyDown={e => {
						if (e.key === "Escape") setOpen(false)
					}}
				>
					<div className="menu-title">Which lookout missed it?</div>
					{lookouts.map((l, i) => (
						<button key={l.id} type="button" role="menuitem" className="menu-item" autoFocus={i === 0} onClick={() => mark(l)} style={toneStyle(l.id, lookouts)}>
							<span className="filter-dot" aria-hidden="true" />
							{lookoutTitle(l)}
						</button>
					))}
				</div>
			)}
		</div>
	)
}
