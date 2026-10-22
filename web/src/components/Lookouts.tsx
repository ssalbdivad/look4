import { type FormEvent, useEffect, useRef, useState } from "react"
import type { LookoutDto } from "../../../src/api-types.ts"
import { api, errorMessage } from "../api.ts"
import { Dialog, useFeedback } from "../feedback.tsx"
import { fmtPct, fmtRelative, lookoutTitle, plural } from "../format.ts"
import { useDebounced, useResource } from "../hooks.ts"
import { toneStyle } from "../tone.ts"
import { Icon } from "./Icon.tsx"
import { CompilePreview, useCompilePreview } from "./LookoutPreview.tsx"
import { ErrorNote, Range, Skeleton, Switch, Thumb } from "./ui.tsx"

// The lookouts live on the Sightings page, because the feed is nothing but what they kept: a compact
// row of tiles sits above it, each tile is also the feed's filter, and picking one opens its tuning
// (threshold, how it's doing) in a panel under the row. Nothing about a lookout pushes the feed down
// until you ask about that lookout.

export const EXAMPLES = [
	"a cardinal or blue jay at the feeder",
	"a hawk or any bird of prey",
	"a squirrel on the feeder pole",
	"a woodpecker on the suet cage"
]

export type Editing = { mode: "new"; prompt?: string } | { mode: "edit"; lookout: LookoutDto } | null

/** Example prompts as one-click starts for the new-lookout editor. */
export const LookoutExamples = ({ onPick }: { onPick: (prompt: string) => void }) => (
	<div className="examples" role="list" aria-label="Examples">
		{EXAMPLES.map(x => (
			<button key={x} role="listitem" type="button" className="example" onClick={() => onPick(x)}>
				<Icon name="sparkle" size={16} />“{x}”
			</button>
		))}
	</div>
)

/** The toggle, look-back and delete a lookout's tile and panel both reach for. */
const useLookoutActions = (l: LookoutDto, { onChange, onDeleted, rejectedDays }: { onChange: (l: LookoutDto) => void; onDeleted: () => void; rejectedDays: number }) => {
	const { toast, confirm } = useFeedback()
	const [backfilling, setBackfilling] = useState(false)

	const toggle = async (enabled: boolean) => {
		onChange({ ...l, enabled })
		try {
			onChange(await api.updateLookout(l.id, { enabled }))
		} catch (e) {
			onChange(l)
			toast(errorMessage(e), { tone: "bad" })
		}
	}

	const backfill = async () => {
		setBackfilling(true)
		try {
			const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString()
			const { queued } = await api.backfill(l.id, { since })
			toast(
				queued ? `Looking back through ${plural(queued, "clip")} for “${lookoutTitle(l)}”` : "No clips from the last 7 days are still on disk",
				{ tone: queued ? "good" : "info" }
			)
		} catch (e) {
			toast(errorMessage(e), { tone: "bad" })
		} finally {
			setBackfilling(false)
		}
	}

	const remove = async () => {
		const ok = await confirm({
			title: `Delete “${lookoutTitle(l)}”?`,
			body: `Clips only this lookout kept leave Sightings and are deleted after ${plural(rejectedDays, "day")}, unless you labeled them. What it decided and your labels are removed. Disable it instead to keep them.`,
			confirmLabel: "Delete lookout",
			danger: true
		})
		if (!ok) return
		try {
			await api.deleteLookout(l.id)
			onDeleted()
			toast(`Deleted “${lookoutTitle(l)}”`)
		} catch (e) {
			toast(errorMessage(e), { tone: "bad" })
		}
	}

	return { toggle, backfill, backfilling, remove }
}

type CardProps = {
	lookout: LookoutDto
	all: LookoutDto[]
	rejectedDays: number
	onChange: (l: LookoutDto) => void
	onEdit: () => void
	onDeleted: () => void
}

/**
 * The row of lookouts over the feed. Picking a tile filters the feed to it (picking it again clears the
 * filter); with two or more there is an "All" tile too. On phones the row scrolls sideways, one tile high.
 */
export const LookoutStrip = ({
	lookouts,
	loading,
	active,
	now,
	onPick,
	...card
}: Omit<CardProps, "lookout" | "all" | "onEdit" | "onDeleted"> & {
	lookouts: LookoutDto[]
	loading: boolean
	active: string
	now: number
	onPick: (id: string) => void
	onEdit: (l: LookoutDto) => void
	onDeleted: (l: LookoutDto) => void
}) => {
	if (loading)
		return (
			<div className="lookout-strip" aria-hidden="true">
				{[0, 1].map(i => (
					<div key={i} className="card lookout-tile">
						<Skeleton style={{ width: 40, height: 40, borderRadius: 12 }} />
						<Skeleton style={{ width: "60%", height: 18 }} />
					</div>
				))}
			</div>
		)
	return (
		<div className="lookout-strip" role="group" aria-label="Lookouts: pick one to filter the feed">
			{lookouts.length > 1 && (
				<button type="button" className="card lookout-tile lookout-tile-all" aria-pressed={!active} onClick={() => onPick("")}>
					<span className="lookout-tile-badge" aria-hidden="true">
						<Icon name="binoculars" size={20} />
					</span>
					<span className="lookout-tile-name">All</span>
				</button>
			)}
			{lookouts.map(l => (
				<LookoutTile
					key={l.id}
					{...card}
					lookout={l}
					all={lookouts}
					now={now}
					active={active === l.id}
					onPick={() => onPick(active === l.id ? "" : l.id)}
					onEdit={() => card.onEdit(l)}
					onDeleted={() => card.onDeleted(l)}
				/>
			))}
		</div>
	)
}

const LookoutTile = ({
	lookout: l,
	all,
	now,
	active,
	onPick,
	rejectedDays,
	onChange,
	onEdit,
	onDeleted
}: CardProps & { now: number; active: boolean; onPick: () => void }) => {
	const { toggle, backfill, remove } = useLookoutActions(l, { onChange, onDeleted, rejectedDays })
	const title = lookoutTitle(l)
	const s = l.stats
	return (
		<div className={`card lookout-tile${l.enabled ? "" : " is-off"}${active ? " is-active" : ""}`} style={toneStyle(l.id, all)}>
			{/* the pick button is the tile's body; the switch and the menu sit beside it, not inside it */}
			<button type="button" className="lookout-tile-pick" aria-pressed={active} onClick={onPick} title={l.prompt}>
				<LatestThumb lookout={l} />
				<span className="lookout-tile-text">
					<span className="lookout-tile-name">{title}</span>
					<span className="lookout-tile-meta">
						{s.kept > 0 && (
							<>
								<RollingCount n={s.kept} /> kept
								{s.lastSeenAt && <> · {fmtRelative(s.lastSeenAt, now)}</>}
							</>
						)}
						{s.kept === 0 && (l.enabled ? "Watching, nothing yet" : "Paused")}
					</span>
				</span>
			</button>
			<Switch checked={l.enabled} onChange={toggle} label={`Watch for ${title}`} />
			<LookoutMenu title={title} onEdit={onEdit} onBackfill={backfill} onDelete={remove} />
		</div>
	)
}

/** A count that rolls up when it changes after the first render (not on arrival: nothing changed then). */
const RollingCount = ({ n }: { n: number }) => {
	const first = useRef(n)
	return (
		<span key={n} className={`filter-count${n === first.current ? "" : " is-rolled"}`}>
			{n}
		</span>
	)
}

/** The picked lookout's tuning, under the row: its prompt, threshold, numbers and checklist. */
export const LookoutPanel = ({
	lookout: l,
	all,
	noJudge,
	rejectedDays,
	onChange,
	onEdit,
	onDeleted
}: CardProps & { noJudge: boolean }) => {
	const { toast } = useFeedback()
	const { backfill, backfilling } = useLookoutActions(l, { onChange, onDeleted, rejectedDays })
	const [threshold, setThreshold] = useState(l.threshold)
	const saved = useRef(l.threshold)
	const [tuning, setTuning] = useState(false)

	useEffect(() => {
		saved.current = l.threshold
		setThreshold(l.threshold)
	}, [l.threshold])

	// Save the slider once it settles, not on every pixel of a drag.
	const settled = useDebounced(threshold, 500)
	useEffect(() => {
		if (Math.abs(settled - saved.current) < 0.001) return
		saved.current = settled
		api.updateLookout(l.id, { threshold: settled }).then(onChange, e => toast(errorMessage(e), { tone: "bad" }))
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [settled])

	const s = l.stats
	const c = l.compiled
	return (
		<section
			className={`card lookout lookout-panel${l.enabled ? "" : " is-off"}${tuning ? " is-tuning" : ""}`}
			aria-label={`${lookoutTitle(l)}: tuning`}
			style={toneStyle(l.id, all)}
		>
			<div className="lookout-panel-says">
				<p className="lookout-prompt" title={l.prompt}>“{l.prompt}”</p>
				<div className="lookout-chips">
					<ul className="lookout-counts" aria-label="So far">
						<li>
							<strong>{s.kept}</strong> kept
						</li>
						<li>
							<strong>{s.judged}</strong> checked
						</li>
					</ul>
					{/* phones: the threshold is a chip that opens its slider */}
					<button type="button" className="lookout-sure" aria-expanded={tuning} onClick={() => setTuning(t => !t)} aria-label={`Keep at ${fmtPct(threshold)} sure: adjust`}>
						<strong>{fmtPct(threshold)}</strong> sure
						<Icon name="chevronDown" size={14} />
					</button>
					<span className="lookout-panel-actions">
						<button type="button" className="btn btn-ghost btn-sm" onClick={onEdit}>
							<Icon name="pencil" size={16} />
							Edit
						</button>
						<button type="button" className="btn btn-ghost btn-sm" onClick={backfill} disabled={backfilling} title="Check the clips from the last 7 days that are still on disk">
							{backfilling ? <span className="spinner" aria-hidden="true" /> : <Icon name="history" size={16} />}
							Look back 7 days
						</button>
					</span>
				</div>
			</div>
			<label className={`slider${noJudge ? " is-moot" : ""}`}>
				<span className="slider-head">
					<span>Keep when the spotter is at least</span>
					<strong>{fmtPct(threshold)} sure</strong>
				</span>
				<Range min={0.05} max={0.99} step={0.01} value={threshold} onChange={setThreshold} valueText={`${fmtPct(threshold)} sure`} />
				<span className="slider-scale muted" aria-hidden="true">
					<span>catch more</span>
					<span>fewer false alarms</span>
				</span>
			</label>
			<details className="lookout-more">
				<summary>
					<Icon name="chevronDown" size={16} className="disclosure-chevron" />
					How it's doing
				</summary>
				<div className="lookout-more-body">
					<dl className="stats stats-quiet">
						<div title={s.precision === null ? "Label a few kept clips to see how often it's right" : "Of the kept clips you labeled, how many were right"}>
							<dt>Right when it keeps one</dt>
							<dd>{s.precision === null ? "—" : fmtPct(s.precision)}</dd>
						</div>
						<div title={s.recall === null ? "Mark a clip “Yes, that's it” to see what it misses" : "Of the clips you said were a match, how many it kept"}>
							<dt>Catches</dt>
							<dd>{s.recall === null ? "—" : fmtPct(s.recall)}</dd>
						</div>
						<div>
							<dt>You labeled</dt>
							<dd>{s.labeled}</dd>
						</div>
					</dl>
					{s.precision === null && s.recall === null && (
						<p className="fine muted">Tell look4 “Yes, that's it” or “Not this” on a few clips and these fill in.</p>
					)}
					{c ? (
						<div className="lookout-compiled">
							<div className="kv">
								<span className="kv-k">Looks for</span>
								<span className="nouns">
									{c.queries.map(q => (
										<span key={q} className="chip chip-noun">
											{q}
										</span>
									))}
								</span>
							</div>
							{c.rubric && (
								<div className="kv">
									<span className="kv-k">Spotter checks</span>
									{/* the summary is only a title; the rubric is what the judge is actually told */}
									<span className="rubric">{c.rubric}</span>
								</div>
							)}
						</div>
					) : (
						<p className="muted fine">Not worked out yet. look4 does it on the next clip.</p>
					)}
					{!noJudge && (
						<p className="lookouts-foot fine muted">
							<Icon name="history" size={14} />
							<span>
								Moving the threshold re-sorts clips already checked too: past near-misses that now clear it become sightings, and weaker ones leave the
								feed. Nothing is sent to the spotter again, so it costs nothing.
							</span>
						</p>
					)}
				</div>
			</details>
		</section>
	)
}

/** Edit / Look back / Delete behind one button, so a tile stays one line high. */
const LookoutMenu = ({ title, onEdit, onBackfill, onDelete }: { title: string; onEdit: () => void; onBackfill: () => void; onDelete: () => void }) => {
	const [open, setOpen] = useState(false)
	const wrap = useRef<HTMLDivElement>(null)
	useEffect(() => {
		if (!open) return
		const close = (e: PointerEvent) => {
			if (!wrap.current?.contains(e.target as Node)) setOpen(false)
		}
		document.addEventListener("pointerdown", close)
		return () => document.removeEventListener("pointerdown", close)
	}, [open])
	const pick = (f: () => void) => () => {
		setOpen(false)
		f()
	}
	return (
		<div className="menu-wrap lookout-menu" ref={wrap}>
			<button type="button" className="icon-btn" aria-label={`More for ${title}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>
				<Icon name="dots" size={20} />
			</button>
			{open && (
				<div
					className="menu"
					role="menu"
					onKeyDown={e => {
						if (e.key === "Escape") setOpen(false)
					}}
				>
					<button type="button" role="menuitem" className="menu-item" autoFocus onClick={pick(onEdit)}>
						<Icon name="pencil" size={16} />
						Edit
					</button>
					<button type="button" role="menuitem" className="menu-item" onClick={pick(onBackfill)}>
						<Icon name="history" size={16} />
						Look back 7 days
					</button>
					<button type="button" role="menuitem" className="menu-item is-danger" onClick={pick(onDelete)}>
						<Icon name="trash" size={16} />
						Delete
					</button>
				</div>
			)}
		</div>
	)
}

/** The lookout's newest sighting as its avatar, so each tile shows what it actually catches. */
const LatestThumb = ({ lookout: l }: { lookout: LookoutDto }) => {
	const latest = useResource(sig => (l.stats.lastSeenAt ? api.sightings({ lookout: l.id, limit: 1 }, sig) : Promise.resolve(null)), [l.id, l.stats.lastSeenAt])
	const clip = latest.data?.items[0]
	const src = clip ? (clip.media.closeUps[0] ?? clip.media.crops[0] ?? clip.media.poster) : null
	return (
		<span className="lookout-badge lookout-tile-badge" aria-hidden="true">
			{src ? <Thumb src={src} alt="" className="lookout-badge-img" /> : <Icon name="target" size={20} />}
		</span>
	)
}

export const LookoutEditor = ({
	editing,
	noJudge,
	onClose,
	onSaved
}: {
	editing: NonNullable<Editing>
	noJudge: boolean
	onClose: () => void
	onSaved: (l: LookoutDto) => void
}) => {
	const { toast } = useFeedback()
	const existing = editing.mode === "edit" ? editing.lookout : null
	const [prompt, setPrompt] = useState(existing?.prompt ?? (editing.mode === "new" ? editing.prompt ?? "" : ""))
	const [name, setName] = useState(existing?.name ?? "")
	const [threshold, setThreshold] = useState(existing?.threshold ?? 0.6)
	const [nouns, setNouns] = useState(existing?.compiled?.queries.join(", ") ?? "")
	const [nounsTouched, setNounsTouched] = useState(false)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const { preview, typing } = useCompilePreview(
		prompt,
		existing?.compiled ? { prompt: existing.prompt, result: existing.compiled, error: null } : null,
		result => {
			if (!nounsTouched) setNouns(result.queries.join(", "))
		}
	)

	const save = async (e: FormEvent) => {
		e.preventDefault()
		if (!prompt.trim()) return
		setSaving(true)
		setError(null)
		try {
			const queries = nouns
				.split(",")
				.map(s => s.trim())
				.filter(Boolean)
			const saved = existing
				? await api.updateLookout(existing.id, {
						prompt: prompt.trim() !== existing.prompt ? prompt.trim() : undefined,
						name: name.trim() && name.trim() !== existing.name ? name.trim() : undefined,
						threshold: threshold !== existing.threshold ? threshold : undefined,
						queries: nounsTouched && queries.length ? queries : undefined
					})
				: await api.createLookout({ prompt: prompt.trim(), name: name.trim() || undefined, threshold })
			toast(existing ? `Saved “${lookoutTitle(saved)}”` : `“${lookoutTitle(saved)}” is on watch`, { tone: "good" })
			onSaved(saved)
		} catch (err) {
			setError(errorMessage(err))
		} finally {
			setSaving(false)
		}
	}

	const result = preview?.result
	return (
		<Dialog open title={existing ? "Edit lookout" : "New lookout"} onClose={onClose} size="lg">
			<form className="editor" onSubmit={save}>
				<div className="editor-fields">
					<label className="field">
						<span className="field-label">What are you looking for?</span>
						<textarea
							value={prompt}
							onChange={e => setPrompt(e.target.value)}
							rows={3}
							required
							autoFocus
							placeholder="a cardinal or blue jay at the feeder"
							onKeyDown={e => {
								if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit()
							}}
						/>
						<span className="field-help">Plain English. Name a species, a behavior, or a place in the frame.</span>
					</label>
					<div className="field-row">
						<label className="field">
							<span className="field-label">Short name</span>
							<input value={name} onChange={e => setName(e.target.value)} placeholder={result ? slug(result.summary) : "cardinal-or-jay"} spellCheck={false} />
							<span className="field-help">A tag for links and scripts. Optional; look4 makes one up.</span>
						</label>
						<label className="field">
							<span className="field-label">
								Keep at <strong>{fmtPct(threshold)}</strong> sure
							</span>
							<Range min={0.05} max={0.99} step={0.01} value={threshold} onChange={setThreshold} valueText={fmtPct(threshold)} />
							<span className="field-help">
								{noJudge
									? "No spotter is on, so every detector match is kept and this has no effect yet."
									: existing
										? "Lower catches more; higher means fewer false alarms. A change re-sorts clips already checked (near-misses become sightings, weaker ones leave), with no extra spotter cost."
										: "Lower catches more; higher means fewer false alarms."}
							</span>
						</label>
					</div>
					{existing && (
						<label className="field">
							<span className="field-label">Detector nouns</span>
							<input
								value={nouns}
								onChange={e => {
									setNouns(e.target.value)
									setNounsTouched(true)
								}}
								placeholder="bird, squirrel"
							/>
							<span className="field-help">Comma-separated, generic objects. Edit only to override the compiler.</span>
						</label>
					)}
				</div>
				<CompilePreview prompt={prompt} preview={preview} typing={typing} />
				{error && <ErrorNote message={error} />}
				<div className="dialog-actions">
					<button type="button" className="btn btn-ghost" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn btn-primary" disabled={saving || !prompt.trim()}>
						{saving && <span className="spinner" aria-hidden="true" />}
						{existing ? "Save" : "Start looking"}
					</button>
				</div>
			</form>
		</Dialog>
	)
}

const slug = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 32) || "lookout"
