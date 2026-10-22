import { type FormEvent, Fragment, type ReactNode, useEffect, useRef, useState } from "react"
import type { SettingsDto, SettingsPatch, StatsResponse } from "../../../src/api-types.ts"
import type { NormBox } from "../../../src/types.ts"
import { AlertsPanel } from "../alerts.tsx"
import { api, errorMessage } from "../api.ts"
import { Icon, type IconName } from "../components/Icon.tsx"
import { RoiEditor } from "../components/RoiEditor.tsx"
import { Dot, LoadError, PageHead, Skeleton, Switch } from "../components/ui.tsx"
import { useFeedback } from "../feedback.tsx"
import { diskState, fmtPct } from "../format.ts"
import { useDocumentTitle, useResource } from "../hooks.ts"
import { JudgeKeyForm } from "../setup/JudgeKey.tsx"
import { SourcesManager } from "./SettingsSources.tsx"

type Section = "motion" | "detector" | "judge" | "retention"

type Field = {
	key: string
	label: string
	help: string
	kind: "number" | "percent" | "switch" | "text" | "select"
	min?: number
	max?: number
	step?: number
	unit?: string
	/** `current`: listed only while it is the saved value (config-file-only choices like the test judge). */
	options?: { value: string; label: string; current?: true }[]
	/** Hidden when the server doesn't send it (an older look4). */
	optional?: true
	/** Text fields: an empty box means null. */
	nullable?: boolean
	placeholder?: string
	/** Folded under the section's "Advanced": the raw numbers its presets set. */
	advanced?: true
}

/** One of a section's three settings bundles; `says` is the plain-language line shown while it is the one in effect. */
type Preset = { id: string; label: string; values: Record<string, number | boolean>; says: string }

const SECTION_ICON: Record<Section, IconName> = { motion: "pulse", detector: "eye", judge: "sparkle", retention: "history" }

/**
 * Model ids as people know them. A saved id that isn't listed (an alias, an older model) is kept as its own option,
 * so opening Settings never silently changes the judge.
 */
const JUDGE_MODELS = [
	{ value: "claude-haiku-5-5", label: "Haiku 5.5: cheap and fast" },
	{ value: "claude-sonnet-5-5", label: "Sonnet 5.5: sharper, pricier" },
	{ value: "claude-opus-5-5", label: "Opus 5.5: sharpest, priciest" }
]
const SECOND_OPINIONS = [
	{ value: "", label: "Never ask for one" },
	{ value: "claude-sonnet-5-5", label: "Sonnet 5.5: sharper, for close calls" },
	{ value: "claude-opus-5-5", label: "Opus 5.5: sharpest, for close calls" }
]

const SECTIONS: { id: Section; title: string; blurb: string; fields: Field[]; presets: Preset[] }[] = [
	{
		id: "motion",
		title: "Motion gate",
		blurb: "The free first pass. Clips where nothing moves inside the zone stop here.",
		presets: [
			{
				id: "relaxed",
				label: "Relaxed",
				values: { sampleFps: 3, pixelThreshold: 14, minArea: 0.0003, maxArea: 0.85, maxFrames: 8 },
				says: "Notices small, distant visitors. More clips reach the detector, and a breeze sometimes does too."
			},
			{
				id: "balanced",
				label: "Balanced",
				values: { sampleFps: 2, pixelThreshold: 22, minArea: 0.0008, maxArea: 0.7, maxFrames: 6 },
				says: "Ignores swaying branches and light changes, and still notices a sparrow."
			},
			{
				id: "picky",
				label: "Picky",
				values: { sampleFps: 2, pixelThreshold: 32, minArea: 0.002, maxArea: 0.5, maxFrames: 4 },
				says: "Only clear, close movement gets through. The fewest clips, but tiny birds can slip by."
			}
		],
		fields: [
			{ key: "sampleFps", label: "Frames checked per second", help: "2 is plenty for a feeder. Raise it for fast visitors; it costs CPU.", kind: "number", min: 0.1, max: 10, step: 0.1, unit: "fps", advanced: true },
			{ key: "pixelThreshold", label: "Pixel sensitivity", help: "How much a pixel's brightness must change (0–255) to count. Lower notices subtler motion, and more noise.", kind: "number", min: 1, max: 255, step: 1, advanced: true },
			{ key: "minArea", label: "Smallest movement that counts", help: "Share of the zone that must change. A small bird far away might be 0.1%.", kind: "percent", min: 0, max: 100, step: 0.01, unit: "% of zone", advanced: true },
			{ key: "maxArea", label: "Ignore changes bigger than", help: "When most of the frame changes at once, it's light, an IR switch or a shake, not an animal.", kind: "percent", min: 0, max: 100, step: 1, unit: "% of zone", advanced: true },
			{ key: "maxFrames", label: "Frames passed on", help: "How many of the most active frames the detector gets to look at. Long clips get at least one per 10 seconds.", kind: "number", min: 1, max: 24, step: 1, advanced: true }
		]
	},
	{
		id: "detector",
		title: "Local detector",
		blurb: "Runs on this machine for free and looks for the nouns in your lookouts (bird, squirrel…).",
		presets: [
			{ id: "relaxed", label: "Relaxed", values: { threshold: 0.08, zoom: true }, says: "Finds small or half-hidden subjects. More close-ups go to the spotter, so a little more cost." },
			{ id: "balanced", label: "Balanced", values: { threshold: 0.15, zoom: true }, says: "Finds birds and squirrels down to feeder size, and zooms in on small movement." },
			{ id: "picky", label: "Picky", values: { threshold: 0.25, zoom: false }, says: "Only clear, close subjects reach the spotter. The cheapest, but small birds get missed." }
		],
		fields: [
			{ key: "enabled", label: "Use the detector", help: "Off sends motion close-ups straight to the spotter: more looks, more cost.", kind: "switch" },
			{ key: "threshold", label: "Detector confidence", help: "Lower finds small or blurry subjects but lets more junk through to the spotter.", kind: "percent", min: 0, max: 100, step: 1, unit: "%", advanced: true },
			{ key: "zoom", label: "Zoom into motion", help: "Also searches a close crop around the movement. Finds small, distant birds.", kind: "switch", advanced: true },
			{ key: "model", label: "Model", help: "Which Hugging Face detector to use. Downloaded once into data/models.", kind: "text", advanced: true }
		]
	},
	{
		id: "judge",
		title: "Spotter",
		blurb: "Claude takes a close look at a few close-ups and decides whether the clip matches. This is the only step that costs money.",
		presets: [
			{ id: "thrifty", label: "Thrifty", values: { maxCrops: 2, cropSize: 384 }, says: "Two small close-ups per clip. The cheapest; fine for big, obvious visitors." },
			{ id: "balanced", label: "Balanced", values: { maxCrops: 4, cropSize: 512 }, says: "Four close-ups per clip, enough to tell most species apart." },
			{ id: "thorough", label: "Thorough", values: { maxCrops: 6, cropSize: 768 }, says: "Six big close-ups. Best for look-alike species, at about twice the cost." }
		],
		fields: [
			{
				key: "provider",
				label: "Backend",
				help: "Auto uses an Anthropic API key when one is set, else the Claude Code CLI, else no spotter.",
				kind: "select",
				options: [
					{ value: "auto", label: "Auto" },
					{ value: "anthropic", label: "Anthropic API" },
					{ value: "claude-code", label: "Claude Code CLI" },
					{ value: "mock", label: "Mock (testing)", current: true },
					{ value: "none", label: "None (detector only)" }
				]
			},
			{ key: "model", label: "Which Claude", help: "Haiku is good at this, at about $0.0003 a clip. Sonnet costs about 20× that, Opus about 40×.", kind: "select", options: JUDGE_MODELS },
			{ key: "escalateModel", label: "Second opinion", help: "A sharper Claude re-checks only the close calls, so it adds little cost.", kind: "select", nullable: true, options: SECOND_OPINIONS },
			{ key: "escalateBelow", label: "Close call below", help: "Answers between this minus 30 points and this get a second opinion.", kind: "percent", min: 0, max: 100, step: 1, unit: "%", advanced: true },
			{ key: "maxCrops", label: "Close-ups per clip", help: "Plus one wide frame for context. More close-ups help with species; each adds cost.", kind: "number", min: 1, max: 8, step: 1, advanced: true },
			{ key: "cropSize", label: "Close-up size", help: "Long edge in pixels. Bigger helps tell similar species apart.", kind: "number", min: 128, max: 1568, step: 32, unit: "px", advanced: true }
		]
	},
	{
		id: "retention",
		title: "Retention",
		blurb: "Passed-over clips are kept for a while so you can spot misses. Kept and labeled clips are never deleted.",
		presets: [
			{ id: "tidy", label: "Tidy", values: { rejectedDays: 3, motionlessDays: 0 }, says: "Passed-over clips go after 3 days, motionless ones right away. The least disk." },
			{ id: "balanced", label: "Balanced", values: { rejectedDays: 7, motionlessDays: 2 }, says: "A week to review what look4 passed over; motionless clips go after 2 days." },
			{ id: "roomy", label: "Keep more", values: { rejectedDays: 30, motionlessDays: 7 }, says: "A month to look back for misses. Uses the most disk." }
		],
		fields: [
			{ key: "rejectedDays", label: "Keep passed-over clips for", help: "Long enough to review what look4 skipped.", kind: "number", min: 0, max: 365, step: 1, unit: "days", advanced: true },
			{ key: "motionlessDays", label: "Keep motionless clips for", help: "Clips where nothing moved. 0 deletes them right away.", kind: "number", min: 0, max: 365, step: 1, unit: "days", advanced: true },
			{
				key: "minFreeGb",
				label: "Keep at least this much disk free",
				help: "Below it, look4 stops taking new clips and clears passed-over ones early. 0 turns the floor off.",
				kind: "number",
				min: 0,
				max: 10000,
				step: 1,
				unit: "GB",
				optional: true,
				advanced: true
			}
		]
	}
]

const sameValue = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-9 : a === b)
const presetIn = (presets: Preset[], draft: Record<string, unknown>) => presets.find(p => Object.entries(p.values).every(([k, v]) => sameValue(draft[k], v)))

type Drafts = Record<Section, Record<string, unknown>>
const draftsOf = (s: SettingsDto): Drafts => ({ motion: s.motion, detector: s.detector, judge: s.judge, retention: s.retention })

export const SettingsPage = () => {
	useDocumentTitle("Settings")
	const { toast } = useFeedback()
	const settings = useResource(s => api.settings(s), [])
	const stats = useResource(s => api.stats(s), [])
	const s = settings.data
	// One draft for every section and one save bar for all of them: change anything, and a bar slides up.
	const [drafts, setDrafts] = useState<Drafts | null>(null)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	// New settings from the server (a save, or the zone panel saving its own) keep any edits still pending.
	const base = useRef<SettingsDto | null>(null)
	useEffect(() => {
		const prev = base.current
		base.current = s
		setDrafts(d => {
			if (!s) return null
			const fresh = draftsOf(s)
			if (!d || !prev) return fresh
			for (const sec of SECTIONS)
				for (const [k, v] of Object.entries(d[sec.id]))
					if (v !== (prev[sec.id] as Record<string, unknown>)[k]) fresh[sec.id] = { ...fresh[sec.id], [k]: v }
			return fresh
		})
	}, [s])

	// links like /settings#sec-retention (Activity's "Free up space") land on their section once it renders
	const loaded = !!s && !!drafts
	useEffect(() => {
		if (!loaded || !location.hash) return
		// after the sources list and the zone picture settle, or the section moves out from under the scroll
		const t = setTimeout(() => document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start", behavior: "smooth" }), 400)
		return () => clearTimeout(t)
	}, [loaded])

	const patch: SettingsPatch = {}
	if (s && drafts)
		for (const sec of SECTIONS) {
			const saved = s[sec.id] as Record<string, unknown>
			const changed = Object.fromEntries(Object.entries(drafts[sec.id]).filter(([k, v]) => v !== saved[k]))
			if (Object.keys(changed).length) (patch as Record<string, unknown>)[sec.id] = changed
		}
	const dirty = Object.keys(patch).length > 0

	const save = async (e?: FormEvent) => {
		e?.preventDefault()
		if (!dirty || saving) return
		setSaving(true)
		setError(null)
		try {
			const next = await api.patchSettings(patch)
			// what the server kept, so a value it normalised doesn't leave the bar up
			setDrafts(draftsOf(next))
			settings.setData(() => next)
			const names = SECTIONS.filter(x => x.id in patch).map(x => x.title)
			toast(`Saved: ${names.join(", ")}`, { tone: "good" })
		} catch (err) {
			setError(errorMessage(err))
		} finally {
			setSaving(false)
		}
	}
	const discard = () => {
		if (s) setDrafts(draftsOf(s))
		setError(null)
	}

	const head = (
		<PageHead
			title="Settings"
			sub="Your camera, the feeder zone, and how picky each step is. Changes count from the next clip; switching the detector on or off, or changing its model, needs a restart."
		/>
	)
	if (settings.error && !s)
		return (
			<>
				{head}
				<LoadError message={settings.error} status={settings.errorStatus} onRetry={settings.reload} what="settings" />
			</>
		)
	return (
		<>
			{head}
			{!s && <Skeleton style={{ height: 420 }} />}
			{s && drafts && (
				<>
					<ZonePanel roi={s.roi} onSaved={next => settings.setData(() => next)} />
					<SourcesManager s={s} />
					<AlertsPanel s={s} onSaved={next => settings.setData(() => next)} />
					<h2 className="settings-heading">How picky each step is</h2>
					<div className="settings-grid">
						{/* Two stacked columns in cascade order; a plain grid would leave a hole beside the tall judge form. */}
						{[SECTIONS.slice(0, 2), SECTIONS.slice(2)].map((col, i) => (
							<div key={i} className="settings-col">
								{col.map(sec => (
									<Fragment key={sec.id}>
										<SectionForm
											section={sec}
											draft={drafts[sec.id]}
											saved={s[sec.id] as Record<string, unknown>}
											onChange={values => setDrafts(d => (d ? { ...d, [sec.id]: { ...d[sec.id], ...values } } : d))}
											onSubmit={save}
										>
											{sec.id === "judge" && stats.data && <StatusLine ok={stats.data.pipeline.judge.ok} text={`${stats.data.pipeline.judge.provider} · ${stats.data.pipeline.judge.detail}`} />}
											{sec.id === "retention" && stats.data && <DiskLine stats={stats.data} />}
											{sec.id === "detector" && stats.data && (
												<StatusLine ok={stats.data.pipeline.detector.ok} idle={!stats.data.pipeline.detector.enabled} text={stats.data.pipeline.detector.detail} />
											)}
										</SectionForm>
										{/* its own form: a <form> can't sit inside the judge section's form */}
										{sec.id === "judge" && stats.data && !stats.data.pipeline.judge.ok && (
											<section className="panel" aria-label="Anthropic API key">
												<p className="muted section-blurb">No spotter is on duty. Paste an Anthropic API key to bring one in; no restart needed.</p>
												<JudgeKeyForm compact onSaved={() => stats.reload()} />
											</section>
										)}
									</Fragment>
								))}
							</div>
						))}
					</div>
				</>
			)}
			{(dirty || saving || error) && (
				<div className="save-bar" role="region" aria-label="Unsaved changes">
					<span className="save-bar-dot" aria-hidden="true" />
					<span className="save-bar-text">
						{error ? <span className="save-bar-error">{error}</span> : saving ? "Saving…" : "Unsaved changes"}
					</span>
					<button type="button" className="btn btn-ghost btn-sm" onClick={discard} disabled={saving}>
						Discard
					</button>
					<button type="button" className="btn btn-primary btn-sm" onClick={() => save()} disabled={!dirty || saving}>
						{saving && <span className="spinner" aria-hidden="true" />}
						Save changes
					</button>
				</div>
			)}
		</>
	)
}

const StatusLine = ({ ok, idle, text }: { ok: boolean; idle?: boolean; text: string }) => (
	<div className="status-line">
		<Dot tone={idle ? "idle" : ok ? "good" : "bad"} />
		<span>{text}</span>
	</div>
)

const DiskLine = ({ stats }: { stats: StatsResponse }) => {
	const d = diskState(stats)
	return (
		<div className={`status-line${d.low ? " is-warn" : ""}`}>
			<Dot tone={d.low ? "warn" : "good"} />
			<span>{d.text}</span>
		</div>
	)
}

const sameBox = (a: NormBox | null, b: NormBox | null) =>
	a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)

const ZonePanel = ({ roi, onSaved }: { roi: NormBox | null; onSaved: (s: SettingsDto) => void }) => {
	const { toast } = useFeedback()
	const [box, setBox] = useState<NormBox | null>(roi)
	const [snapshot, setSnapshot] = useState<string | null>(`/api/snapshot?t=${Date.now()}`)
	const [saving, setSaving] = useState(false)
	useEffect(() => setBox(roi), [roi])
	const dirty = !sameBox(box, roi)

	const save = async (next: NormBox | null) => {
		setSaving(true)
		try {
			onSaved(await api.patchSettings({ roi: next }))
			setBox(next)
			toast(next ? "Zone saved. Motion outside it is ignored now." : "Zone cleared. The whole frame counts.", { tone: "good" })
		} catch (e) {
			toast(errorMessage(e), { tone: "bad" })
		} finally {
			setSaving(false)
		}
	}

	return (
		<section className="panel zone">
			<div className="zone-copy">
				<h2 className="panel-title">Detection zone</h2>
				<p>
					Draw a box around the feeder. Motion outside it, like swaying branches or a neighbor's car, is ignored, and
					the detector looks closer at what's inside.
				</p>
				{!snapshot && (
					<p className="note">
						<Icon name="camera" size={18} />
						<span>No clip on disk yet, so there's no frame to draw on. You can still set a zone; it'll match up once clips arrive.</span>
					</p>
				)}
				<dl className="facts">
					<div>
						<dt>Zone</dt>
						<dd>{box ? `${fmtPct(box.w * box.h)} of the frame` : "Whole frame"}</dd>
					</div>
					{box && (
						<div>
							<dt>Position</dt>
							<dd>
								{fmtPct(box.x)}, {fmtPct(box.y)} · {fmtPct(box.w)} × {fmtPct(box.h)}
							</dd>
						</div>
					)}
				</dl>
				<div className="zone-actions">
					<button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={() => save(box)}>
						{saving && <span className="spinner" aria-hidden="true" />}
						Save zone
					</button>
					{dirty && (
						<button type="button" className="btn btn-ghost" onClick={() => setBox(roi)}>
							Undo
						</button>
					)}
					{roi && !dirty && (
						<button type="button" className="btn btn-ghost" onClick={() => save(null)} disabled={saving}>
							Clear zone
						</button>
					)}
				</div>
				<p className="fine muted">Drag on the image to draw. Arrow keys move the box; Shift+arrows resize it.</p>
			</div>
			<RoiEditor box={box} onChange={setBox} snapshot={snapshot} onSnapshotError={() => setSnapshot(null)} />
		</section>
	)
}

const SectionForm = ({
	section,
	draft,
	saved,
	onChange,
	onSubmit,
	children
}: {
	section: (typeof SECTIONS)[number]
	draft: Record<string, unknown>
	saved: Record<string, unknown>
	onChange: (values: Record<string, unknown>) => void
	onSubmit: (e: FormEvent) => void
	children?: ReactNode
}) => {
	const edited = Object.entries(draft).some(([k, v]) => v !== saved[k])
	const visible = section.fields.filter(f => !f.optional || saved[f.key] !== undefined)
	const advanced = visible.filter(f => f.advanced)
	const active = presetIn(section.presets, draft)
	// a hand-tuned section opens on its numbers; React never re-sets `open`, so typing a preset's exact value won't snap it shut
	const [openAdvanced] = useState(() => !active)
	// with the detector off, its sensitivity has nothing to act on
	const moot = section.id === "detector" && draft.enabled === false
	const field = (f: Field) => <FieldInput key={f.key} field={f} value={draft[f.key]} onChange={v => onChange({ [f.key]: v })} id={`${section.id}-${f.key}`} />
	return (
		// Enter in any field saves everything that changed, the same as the save bar.
		<form className={`panel settings-form${edited ? " is-edited" : ""}`} onSubmit={onSubmit} aria-labelledby={`sec-${section.id}`}>
			<h2 className="panel-title settings-title" id={`sec-${section.id}`}>
				<span className="settings-icon" aria-hidden="true">
					<Icon name={SECTION_ICON[section.id]} size={18} />
				</span>
				{section.title}
				{edited && <span className="edited-dot" title="Changed, not saved yet" />}
			</h2>
			<p className="muted section-blurb">{section.blurb}</p>
			{children}
			<div className="fields">
				{visible.filter(f => !f.advanced).map(field)}
				<div className={`preset${moot ? " is-moot" : ""}`}>
					<div className="segmented preset-picker" role="radiogroup" aria-label={`${section.title}: how picky`}>
						{section.presets.map(p => (
							<button
								key={p.id}
								type="button"
								role="radio"
								aria-checked={active?.id === p.id}
								className="segment"
								disabled={moot}
								onClick={() => onChange(p.values)}
							>
								{p.label}
							</button>
						))}
					</div>
					<p className="preset-says" aria-live="polite">
						{moot ? (
							"The detector is off, so motion close-ups go straight to the spotter."
						) : active ? (
							active.says
						) : (
							<>
								<span className="chip chip-soft">Custom</span> Your own mix. The numbers are under Advanced.
							</>
						)}
					</p>
				</div>
			</div>
			{advanced.length > 0 && (
				<details className="advanced" open={openAdvanced}>
					<summary>
						Advanced
						{advanced.some(f => draft[f.key] !== saved[f.key]) && <span className="edited-dot" title="Changed, not saved yet" />}
					</summary>
					<div className="fields">{advanced.map(field)}</div>
				</details>
			)}
		</form>
	)
}

const FieldInput = ({ field: f, value, onChange, id }: { field: Field; value: unknown; onChange: (v: unknown) => void; id: string }) => {
	const help = <span className="field-help" id={`${id}-help`}>{f.help}</span>
	if (f.kind === "switch")
		return (
			<div className="field field-switch">
				<span className="field-label" id={`${id}-label`}>
					{f.label}
				</span>
				<Switch checked={value === true} onChange={onChange} label={f.label} />
				{help}
			</div>
		)
	return (
		<label className="field" htmlFor={id}>
			<span className="field-label">{f.label}</span>
			{f.kind === "select" ? (
				<select id={id} value={String(value ?? "")} onChange={e => onChange(f.nullable && !e.target.value ? null : e.target.value)} aria-describedby={`${id}-help`}>
					{selectOptions(f, value).map(o => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</select>
			) : f.kind === "text" ? (
				<input
					id={id}
					value={value === null || value === undefined ? "" : String(value)}
					placeholder={f.placeholder}
					spellCheck={false}
					onChange={e => onChange(f.nullable && !e.target.value.trim() ? null : e.target.value)}
					aria-describedby={`${id}-help`}
				/>
			) : (
				<NumberInput field={f} value={value as number} onChange={onChange} id={id} />
			)}
			{help}
		</label>
	)
}

/** The field's choices, plus the saved value when it isn't one of them (a model id set in the config file). */
const selectOptions = (f: Field, value: unknown) => {
	const listed = (f.options ?? []).filter(o => !o.current || o.value === value)
	const v = value === null || value === undefined ? "" : String(value)
	return listed.some(o => o.value === v) ? listed : [...listed, { value: v, label: v }]
}

/** Keeps the raw text while typing ("0.0", "") and only reports parsed numbers upward. */
const NumberInput = ({ field: f, value, onChange, id }: { field: Field; value: number; onChange: (v: unknown) => void; id: string }) => {
	const scale = f.kind === "percent" ? 100 : 1
	const shown = (v: number) => String(Math.round(v * scale * 10_000) / 10_000)
	const [text, setText] = useState(shown(value))
	useEffect(() => {
		if (Number(text) !== Math.round(value * scale * 10_000) / 10_000) setText(shown(value))
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [value])
	return (
		<span className="input-unit">
			<input
				id={id}
				type="number"
				inputMode="decimal"
				min={f.min}
				max={f.max}
				step={f.step}
				value={text}
				aria-describedby={`${id}-help`}
				onChange={e => {
					setText(e.target.value)
					const n = Number(e.target.value)
					if (e.target.value !== "" && Number.isFinite(n)) onChange(Math.round((n / scale) * 1e6) / 1e6)
				}}
			/>
			{f.unit && <span className="unit">{f.unit}</span>}
		</span>
	)
}
