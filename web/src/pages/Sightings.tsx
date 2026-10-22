import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react"
import type { ClipSummary, LookoutDto } from "../../../src/api-types.ts"
import { api, errorMessage } from "../api.ts"
import { FirstSightingCelebration, useFirstSighting } from "../components/Celebrate.tsx"
import { FeedSkeleton, SightingCard } from "../components/ClipCard.tsx"
import { Icon } from "../components/Icon.tsx"
import { LifeListPanel } from "../components/LifeList.tsx"
import { type Editing, LookoutEditor, LookoutExamples, LookoutPanel, LookoutStrip } from "../components/Lookouts.tsx"
import { EmptyState, LoadError, PageHead } from "../components/ui.tsx"
import { useFeedback } from "../feedback.tsx"
import { dayKey, dayLabel, humanize, plural } from "../format.ts"
import { useDocumentTitle, useNow, useResource } from "../hooks.ts"
import { useLive, useLiveEvents } from "../live.tsx"
import { Link, navigate, useLocation } from "../router.tsx"
import { DropZone, useUpload } from "../upload.tsx"

const PAGE = 24

/** How long a deleted sighting can be brought back: as long as its toast shows. */
const UNDO_MS = 7000

export const SightingsPage = () => {
	useDocumentTitle("Sightings")
	const { query } = useLocation()
	const lookout = query.get("lookout") ?? ""
	const now = useNow()
	const { toast } = useFeedback()
	const { version } = useUpload()
	const lookouts = useResource(s => api.lookouts(s), [])
	const lifeList = useResource(s => api.lifeList(s), [])
	// what the threshold slider means depends on the judge, and the delete warning on retention
	const stats = useResource(s => api.stats(s), [])
	const settings = useResource(s => api.settings(s), [])
	const noJudge = stats.data?.pipeline.judge.provider === "none"
	const rejectedDays = settings.data?.retention.rejectedDays ?? 7
	const [editing, setEditing] = useState<Editing>(null)
	const first = useResource(s => api.sightings({ lookout, limit: PAGE }, s), [lookout])
	const [items, setItems] = useState<ClipSummary[]>([])
	const [nextBefore, setNextBefore] = useState<string | null>(null)
	const [more, setMore] = useState(false)
	const [fresh, setFresh] = useState<Set<string>>(new Set())

	// `?new=1` (and the old /lookouts?new=1, redirected here) opens the new-lookout editor once
	useEffect(() => {
		if (query.get("new") !== "1") return
		setEditing({ mode: "new" })
		navigate(lookout ? `/?lookout=${encodeURIComponent(lookout)}` : "/", { replace: true })
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [query.get("new")])

	useEffect(() => {
		if (!first.data) return
		setItems(first.data.items.filter(c => !deleting.current.has(c.id)))
		setNextBefore(first.data.nextBefore)
	}, [first.data])

	// Uploads can produce sightings a few seconds later; SSE covers that, this covers a missed event.
	useEffect(() => {
		if (version) first.reload()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [version])

	// A landed sighting (or a clip re-decided either way) moves the chips' counts; a burst is one refetch.
	const countsTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
	useEffect(() => () => clearTimeout(countsTimer.current), [])
	const refreshCounts = () => {
		clearTimeout(countsTimer.current)
		countsTimer.current = setTimeout(() => {
			lookouts.reload()
			lifeList.reload()
		}, 600)
	}

	useLiveEvents(e => {
		if (e.event === "lookout") lookouts.reload()
		// the cards' "New species" badges follow the list
		if (e.event === "lifelist") {
			lifeList.reload()
			first.reload()
		}
		if (e.event === "sighting" || (e.event === "clip" && (e.data.status === "kept" || e.data.status === "rejected"))) refreshCounts()
		if (e.event !== "sighting") return
		if (lookout && e.data.lookoutId !== lookout) return
		const id = e.data.clipId
		api.clip(id).then(
			c => {
				// by recording time, not arrival: an uploaded old clip belongs under its own day, not on top of today
				setItems(xs => insertByTime(xs.filter(x => x.id !== id), c))
				setFresh(f => new Set(f).add(id))
				setTimeout(() => setFresh(f => {
					const n = new Set(f)
					n.delete(id)
					return n
				}), 8000)
			},
			() => {}
		)
	})

	// A delete waits out its Undo before the file goes; leaving the page carries out the ones still waiting.
	const deleting = useRef(new Map<string, ReturnType<typeof setTimeout>>())
	const reallyDelete = (c: ClipSummary) => {
		deleting.current.delete(c.id)
		api.deleteClip(c.id).catch(e => {
			setItems(xs => insertByTime(xs.filter(x => x.id !== c.id), c))
			toast(errorMessage(e), { tone: "bad" })
		})
	}
	useEffect(
		() => () => {
			for (const t of deleting.current.values()) clearTimeout(t)
			// the timers are gone, so these run now rather than never
			for (const id of deleting.current.keys()) api.deleteClip(id).catch(() => {})
		},
		[]
	)
	const remove = (c: ClipSummary) => {
		setItems(xs => xs.filter(x => x.id !== c.id))
		deleting.current.set(c.id, setTimeout(() => reallyDelete(c), UNDO_MS))
		toast("Sighting deleted", {
			action: {
				label: "Undo",
				run: () => {
					clearTimeout(deleting.current.get(c.id))
					deleting.current.delete(c.id)
					setItems(xs => insertByTime(xs.filter(x => x.id !== c.id), c))
				}
			}
		})
	}

	const loadMore = async () => {
		if (!nextBefore) return
		setMore(true)
		try {
			const page = await api.sightings({ lookout, before: nextBefore, limit: PAGE })
			setItems(xs => [...xs, ...page.items.filter(p => !xs.some(x => x.id === p.id))])
			setNextBefore(page.nextBefore)
		} catch (e) {
			toast(errorMessage(e), { tone: "bad" })
		} finally {
			setMore(false)
		}
	}

	const groups = useMemo(() => {
		const out: { key: string; label: string; items: ClipSummary[] }[] = []
		for (const c of items) {
			const key = dayKey(c.recordedAt)
			const last = out[out.length - 1]
			if (last?.key === key) last.items.push(c)
			else out.push({ key, label: dayLabel(c.recordedAt, now), items: [c] })
		}
		return out
	}, [items, now])

	const loading = first.loading && !first.data
	const ls = lookouts.data ?? []
	const picked = lookout ? ls.find(l => l.id === lookout) ?? null : null
	const filterTo = (id: string) => navigate(id ? `/?lookout=${encodeURIComponent(id)}` : "/", { replace: true })
	const replace = (l: LookoutDto) => lookouts.setData(xs => (xs ? xs.map(x => (x.id === l.id ? l : x)) : xs))
	const card = {
		rejectedDays,
		onChange: replace,
		onEdit: (l: LookoutDto) => setEditing({ mode: "edit", lookout: l }),
		onDeleted: (l: LookoutDto) => {
			lookouts.setData(xs => (xs ? xs.filter(x => x.id !== l.id) : xs))
			if (lookout === l.id) filterTo("")
		}
	}
	const newLookout = (prompt?: string) => setEditing({ mode: "new", prompt })
	// Only the unfiltered feed can say "nothing has ever been spotted".
	const [celebrate, closeCelebration] = useFirstSighting(!lookout && !!first.data && items.length === 0, items[0])

	return (
		<>
			<PageHead
				title="Sightings"
				sub="Clips your lookouts kept, newest first. Pick a lookout to see only its clips and tune it."
				actions={
					ls.length > 0 && (
						<button type="button" className="btn btn-primary" onClick={() => newLookout()}>
							<Icon name="plus" size={18} />
							New lookout
						</button>
					)
				}
			/>
			{lookouts.error && !lookouts.data && <LoadError message={lookouts.error} status={lookouts.errorStatus} onRetry={lookouts.reload} what="your lookouts" />}
			{(ls.length > 0 || (lookouts.loading && !lookouts.data)) && (
				<LookoutStrip
					lookouts={ls}
					loading={lookouts.loading && !lookouts.data}
					active={lookout}
					now={now}
					onPick={filterTo}
					rejectedDays={rejectedDays}
					onChange={replace}
					onEdit={card.onEdit}
					onDeleted={card.onDeleted}
				/>
			)}
			{ls.length > 0 && noJudge && (
				<div className="note note-warn">
					<Icon name="alert" size={18} />
					<span>
						No spotter is on, so every detector match is kept and the “sure” thresholds have no effect. <Link to="/settings">Add one in Settings</Link>.
					</span>
				</div>
			)}
			{picked && (
				<LookoutPanel
					key={picked.id}
					lookout={picked}
					all={ls}
					noJudge={noJudge}
					rejectedDays={rejectedDays}
					onChange={replace}
					onEdit={() => card.onEdit(picked)}
					onDeleted={() => card.onDeleted(picked)}
				/>
			)}
			{lookouts.data && ls.length === 0 && items.length > 0 && (
				// the feed has clips from lookouts since deleted: say how to start a new one, without hiding them
				<section className="panel lookouts-empty">
					<h2>No lookouts yet</h2>
					<p className="muted">
						A lookout is a sentence describing what you want to catch. look4 turns it into things a local detector can spot, and a
						checklist the spotter confirms on close-ups.
					</p>
					<LookoutExamples onPick={newLookout} />
					<button type="button" className="btn btn-primary" onClick={() => newLookout()}>
						<Icon name="plus" size={18} />
						New lookout
					</button>
				</section>
			)}
			<LifeListPanel data={lifeList.data} now={now} onChange={next => lifeList.setData(() => next)} />
			{first.error && !first.data && <LoadError message={first.error} status={first.errorStatus} onRetry={first.reload} what="your sightings" />}
			{loading && <FeedSkeleton />}
			{!loading && first.data && items.length === 0 && (
				<NothingYet lookouts={ls} filtered={picked} loadingLookouts={lookouts.loading} onNew={newLookout} />
			)}
			{groups.length > 0 && (
				// A section per day, each its own subgrid: its header sits over its own cards and sticks under the
				// top bar while you scroll through that day, so which day you're looking at is never in doubt.
				<div className="feed">
					{groups.map(g => (
						// a quiet day only spans as many columns as it has cards, so the next day can sit beside it
						<section key={g.key} className="day" style={{ "--n": g.items.length } as CSSProperties} aria-labelledby={`day-${g.key}`}>
							<DayHead label={g.label} iso={g.items[0]!.recordedAt} count={g.items.length} id={`day-${g.key}`} />
							{g.items.map(c => (
								<SightingCard
									key={c.id}
									clip={c}
									fresh={fresh.has(c.id)}
									now={now}
									lookoutId={lookout || undefined}
									lookouts={ls}
									onConfirmed={next => setItems(xs => xs.map(x => (x.id === next.id ? next : x)))}
									onDelete={remove}
								/>
							))}
						</section>
					))}
				</div>
			)}
			{nextBefore && items.length > 0 && (
				<div className="load-more">
					<button type="button" className="btn btn-ghost" onClick={loadMore} disabled={more}>
						{more ? <span className="spinner" aria-hidden="true" /> : <Icon name="chevronDown" size={18} />}
						{more ? "Loading…" : "Load more"}
					</button>
				</div>
			)}
			{editing && (
				<LookoutEditor
					editing={editing}
					noJudge={noJudge}
					onClose={() => setEditing(null)}
					onSaved={l => {
						lookouts.setData(xs => {
							if (!xs) return [l]
							return xs.some(x => x.id === l.id) ? xs.map(x => (x.id === l.id ? l : x)) : [...xs, l]
						})
						setEditing(null)
					}}
				/>
			)}
			{celebrate && <FirstSightingCelebration clip={celebrate} onClose={closeCelebration} />}
		</>
	)
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

/** A day's header in the feed: a tiny calendar leaf with the date, the day's name and its count, in a pill that sticks. */
const DayHead = ({ label, iso, count, id }: { label: string; iso: string; count: number; id: string }) => {
	const d = new Date(iso)
	const named = label === "Today" || label === "Yesterday"
	return (
		<h2 className={`day-head${label === "Today" ? " is-today" : ""}`} id={id} aria-label={`${label}, ${plural(count, "sighting")}`}>
			<span className="day-pill" aria-hidden="true">
				<span className="day-leaf">
					<span className="day-month">{MONTHS[d.getMonth()]}</span>
					<span className="day-num">{d.getDate()}</span>
				</span>
				<span className="day-name">{named ? label : WEEKDAYS[d.getDay()]}</span>
				{/* one card says "1 sighting" by itself, and a one-column day has no room to spare */}
				{count > 1 && <span className="day-count">{plural(count, "sighting")}</span>}
			</span>
		</h2>
	)
}

/** Newest first, the feed's order. */
const insertByTime = (xs: ClipSummary[], c: ClipSummary) => {
	const i = xs.findIndex(x => x.recordedAt < c.recordedAt)
	return i === -1 ? [...xs, c] : [...xs.slice(0, i), c, ...xs.slice(i)]
}

const NothingYet = ({
	lookouts,
	filtered,
	loadingLookouts,
	onNew
}: {
	lookouts: LookoutDto[]
	filtered: LookoutDto | null
	loadingLookouts: boolean
	onNew: (prompt?: string) => void
}) => {
	const sources = useResource(s => api.sources(s), [])
	const { queue } = useLive()
	if (filtered)
		return (
			<EmptyState title={`No ${humanize(filtered.name).toLowerCase()} yet`} mascot="looking">
				<p>
					Nothing has matched <em>“{filtered.prompt}”</em> so far. Clips that come close show up in{" "}
					<Link to="/activity">Activity</Link> under recent passes, where you can mark a miss.
				</p>
			</EmptyState>
		)
	if (loadingLookouts) return null
	const hasLookouts = lookouts.some(l => l.enabled)
	const enabled = (sources.data ?? []).filter(x => x.config.enabled)
	const feeds = enabled.map(x => humanize(x.config.name))
	// While the first clips are coming in or being checked, the eagle is on the lookout rather than napping.
	const waiting = queue ? queue.pending + queue.processing : 0
	const busy = waiting > 0 || enabled.some(x => x.status.state === "starting")
	return (
		<EmptyState title={busy ? "Looking at your first clips…" : "Nothing spotted yet"} mascot={busy ? "looking" : "sleepy"}>
			{busy && waiting > 0 && <p className="empty-status">{plural(waiting, "clip")} waiting for a look right now.</p>}
			{hasLookouts ? (
				<p>
					Your lookouts are on watch. When a clip matches, it lands here with the best close-up.{" "}
					<span className="say-fine">Drop in an old clip to see it work now.</span>
					<span className="say-coarse">Add an old clip to see it work now.</span>
				</p>
			) : (
				<p>Tell look4 what you are hoping to see, then let your camera do the waiting.</p>
			)}
			<ol className="steps">
				<li className={hasLookouts ? "is-done" : ""}>
					<span className="step-n">{hasLookouts ? <Icon name="check" size={16} /> : 1}</span>
					<div>
						<strong>Describe a lookout</strong> in plain words, like “a cardinal or blue jay at the feeder”.{" "}
						{!hasLookouts && (
							<Link to="/?new=1" replace>
								Add your first lookout
							</Link>
						)}
						{lookouts.length === 0 && <LookoutExamples onPick={onNew} />}
					</div>
				</li>
				{feeds.length ? (
					<li className="is-done">
						<span className="step-n">
							<Icon name="check" size={16} />
						</span>
						<div>
							<strong>Bring in video.</strong> Clips come in from {feeds.map(n => `“${n}”`).join(" and ")} by themselves.
							You can also <span className="say-fine">drop</span>
							<span className="say-coarse">add</span> older clips here:
						</div>
					</li>
				) : (
					<li>
						<span className="step-n">2</span>
						<div>
							<strong>Bring in video.</strong> <Link to="/setup?step=source">Connect your camera</Link> or a folder, or{" "}
							<span className="say-fine">drop clips right here:</span>
							<span className="say-coarse">add clips right here:</span>
						</div>
					</li>
				)}
			</ol>
			<DropZone />
		</EmptyState>
	)
}
