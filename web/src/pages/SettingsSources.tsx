import { useEffect, useState } from "react"
import type { SettingsDto, SourceDto } from "../../../src/api-types.ts"
import type { ReolinkSourceConfig, SourceConfig } from "../../../src/config.ts"
import { api, errorMessage } from "../api.ts"
import { Icon, type IconName } from "../components/Icon.tsx"
import { SourceDetail, sourceProblem, whatsWrong } from "../components/SourceDetail.tsx"
import { Dot, ErrorNote, Skeleton, Switch } from "../components/ui.tsx"
import { Dialog, useFeedback } from "../feedback.tsx"
import { fmtRelative, humanize, plural } from "../format.ts"
import { useNow, useResource } from "../hooks.ts"
import { useLiveEvents } from "../live.tsx"
import { Link, navigate, useLocation } from "../router.tsx"
import { ConnectFlow, type SourceKind, SourceKindChoice } from "../setup/SourceKinds.tsx"
import { ChoiceCards, FlowActions, FlowLevel } from "../setup/ui.tsx"

type Open = { mode: "add" } | { mode: "edit" | "fix"; name: string } | null

const KIND_LABEL: Record<SourceConfig["type"], string> = { reolink: "Reolink camera", rtsp: "Camera stream", watch: "Folder" }
const KIND_ICON: Record<SourceConfig["type"], IconName> = { reolink: "camera", rtsp: "camera", watch: "folder" }

/** Where a source points, in one line: the camera's address, the folder, or the (masked) stream URL. */
const where = (c: SourceConfig) =>
	c.type === "reolink"
		? `${c.host} · ${c.stream === "main" ? "full quality" : "smaller, faster stream"}${c.capture === "sd" ? " · from the SD card" : c.capture === "stream" ? " · from the live stream" : ""}`
		: c.type === "watch"
			? `${c.dir} · ${c.move ? "moves" : "copies"} new videos`
			: (c.url ?? "stream address saved privately")

/**
 * Settings → Sources: every configured source with its live state, and add / edit / fix / pause / remove,
 * all through the same flows as the setup wizard. `?add=1` and `?fix=<name>` open the dialogs directly
 * (Activity's "Fix it" links here).
 */
export const SourcesManager = ({ s }: { s: SettingsDto }) => {
	const { toast, confirm } = useFeedback()
	const { query } = useLocation()
	const list = useResource(sig => api.sources(sig), [])
	const [open, setOpen] = useState<Open>(null)
	const [busy, setBusy] = useState<string | null>(null)
	const now = useNow()

	useEffect(() => {
		const fix = query.get("fix")
		if (fix) setOpen({ mode: "fix", name: fix })
		else if (query.get("add") === "1") setOpen({ mode: "add" })
		else return
		navigate("/settings", { replace: true })
	}, [query])

	useLiveEvents(e => {
		if (e.event === "source") list.setData(xs => xs?.map(x => (x.config.name === e.data.name ? { ...x, status: e.data } : x)) ?? xs)
	})

	const sources = list.data ?? []
	const names = sources.map(x => x.config.name)
	const current = open && open.mode !== "add" ? sources.find(x => x.config.name === open.name) : undefined

	const upsert = (dto: SourceDto) =>
		list.setData(xs => (xs?.some(x => x.config.name === dto.config.name) ? xs.map(x => (x.config.name === dto.config.name ? dto : x)) : [...(xs ?? []), dto]))

	const setEnabled = async (src: SourceDto, enabled: boolean) => {
		setBusy(src.config.name)
		try {
			upsert(await api.updateSource(src.config.name, { enabled }))
			toast(enabled ? `${humanize(src.config.name)} is back on` : `${humanize(src.config.name)} is paused. Clips it already brought in stay.`, { tone: "good" })
		} catch (e) {
			toast(errorMessage(e), { tone: "bad" })
		} finally {
			setBusy(null)
		}
	}

	const poll = async (name: string) => {
		setBusy(name)
		try {
			await api.pollSource(name)
			toast(`Checked ${humanize(name)} for new clips`, { tone: "good" })
		} catch (e) {
			toast(errorMessage(e), { tone: "bad" })
		} finally {
			setBusy(null)
		}
	}

	const remove = async (src: SourceDto) => {
		const ok = await confirm({
			title: `Remove “${humanize(src.config.name)}”?`,
			body: "look4 stops collecting from it. Clips it already brought in, and your sightings, stay.",
			confirmLabel: "Remove",
			danger: true
		})
		if (!ok) return
		try {
			await api.deleteSource(src.config.name)
			list.setData(xs => xs?.filter(x => x.config.name !== src.config.name) ?? xs)
			toast(`Removed ${humanize(src.config.name)}`)
		} catch (e) {
			toast(errorMessage(e), { tone: "bad" })
		}
	}

	return (
		<section className="panel" id="sources" aria-labelledby="sources-title">
			<div className="panel-head">
				<h2 className="panel-title" id="sources-title">
					Sources
				</h2>
				<button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen({ mode: "add" })}>
					<Icon name="plus" size={16} />
					Add a source
				</button>
			</div>
			<p className="muted section-blurb">
				Where look4 gets video. Uploads and anything dropped into <code>{s.dataDir}/inbox</code> always work too.
			</p>
			{list.error && !list.data && <ErrorNote message={list.error} onRetry={list.reload} />}
			{!list.data && !list.error && <Skeleton style={{ height: 96 }} />}
			{list.data && sources.length === 0 && (
				<p className="note">
					<Icon name="camera" size={18} />
					<span>
						No camera or folder connected yet. <button type="button" className="linkish" onClick={() => setOpen({ mode: "add" })}>Add a source</button> and
						look4 starts collecting clips on its own.
					</span>
				</p>
			)}
			{sources.length > 0 && (
				<ul className="src-list">
					{sources.map(src => {
						const st = src.status
						const paused = !src.config.enabled
						const err = st.state === "error"
						const name = src.config.name
						return (
							<li key={name} className={`src${err ? " is-error" : ""}${paused ? " is-paused" : ""}`}>
								<span className="src-icon">
									<Icon name={KIND_ICON[src.config.type]} size={20} />
								</span>
								<div className="src-main">
									<div className="src-name">
										<Dot tone={err ? "bad" : paused ? "idle" : st.state === "ok" ? "good" : st.state === "starting" ? "warn" : "idle"} pulse={st.state === "starting"} />
										<strong>{humanize(name)}</strong>
										<span className="chip chip-soft">{KIND_LABEL[src.config.type]}</span>
										{humanize(name).toLowerCase() !== name && <code className="src-slug">{name}</code>}
										{paused && <span className="chip chip-soft">Paused</span>}
									</div>
									<span className="src-what muted">{where(src.config)}</span>
									<SourceDetail detail={st.detail} className="src-detail" />
									<span className="fine muted">
										{/* a paused source's status starts fresh, so "never" would be wrong */}
										{st.lastPollAt ? `Checked ${fmtRelative(st.lastPollAt, now)} · ` : paused ? "" : "Not checked yet · "}
										{plural(st.clipsIngested, "clip")} so far
										{st.lastClipAt && ` · newest ${fmtRelative(st.lastClipAt, now)}`}
									</span>
									<div className="src-actions">
										{err && sourceProblem(st.detail) === "disk" ? (
											// a full disk is fixed here, not in the camera's sign-in
											<a href="#sec-retention" className="btn btn-primary btn-sm">
												<Icon name="disk" size={16} />
												Disk settings
											</a>
										) : (
											err && (
												<button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen({ mode: "fix", name })}>
													<Icon name="sparkle" size={16} />
													Fix it
												</button>
											)
										)}
										{!paused && (
											<button type="button" className="btn btn-ghost btn-sm src-check" onClick={() => poll(name)} disabled={busy === name}>
												{busy === name ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" size={16} />}
												Check now
											</button>
										)}
										<button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen({ mode: "edit", name })}>
											<Icon name="pencil" size={16} />
											Edit
											{src.config.type === "reolink" && <span className="hide-phone"> or change password</span>}
										</button>
										<button type="button" className="btn btn-ghost btn-sm btn-danger-ghost" onClick={() => remove(src)} aria-label={`Remove ${name}`}>
											<Icon name="trash" size={16} />
										</button>
									</div>
								</div>
								<div className="src-side">
									<span className="fine muted">{paused ? "Paused" : "On"}</span>
									<Switch checked={!paused} onChange={v => setEnabled(src, v)} label={`Collect clips from ${name}`} disabled={busy === name} />
								</div>
							</li>
						)
					})}
				</ul>
			)}
			<div className="src-foot">
				<Link to="/setup" className="btn btn-ghost btn-sm">
					<Icon name="history" size={16} />
					Run setup again
				</Link>
				<span className="fine muted">
					Saved in <code>{s.configPath ?? "look4.config.json"}</code>. Passwords are kept separately in a private <code>.env</code> file.
				</span>
			</div>
			{open?.mode === "add" && (
				<AddSourceDialog
					taken={names}
					onClose={() => setOpen(null)}
					onSaved={dto => {
						upsert(dto)
						setOpen(null)
						toast(`${humanize(dto.config.name)} is connected. Clips will start arriving shortly.`, { tone: "good" })
					}}
				/>
			)}
			{open && open.mode !== "add" && (
				<Dialog open title={open.mode === "fix" ? `Fix ${humanize(open.name)}` : `Edit ${humanize(open.name)}`} onClose={() => setOpen(null)} size="lg">
					{!current ? (
						list.data ? (
							<p className="muted">There's no source called “{open.name}” any more.</p>
						) : (
							<Skeleton style={{ height: 200 }} />
						)
					) : (
						<FlowLevel value={3}>
							{open.mode === "edit" && current.config.type === "reolink" && (
								<CaptureSettings source={current} keepDays={s.retention.motionlessDays} onSaved={upsert} />
							)}
							<ConnectFlow
								kind={current.config.type}
								existing={current.config}
								takenNames={names}
								// a camera that already refused the saved password would only count another failed
								// sign-in toward its lockout; the notice says what's wrong and the form waits for a new one
								autoTest={open.mode === "fix" && sourceProblem(current.status.detail) === null}
								onBack={() => setOpen(null)}
								onSaved={dto => {
									upsert(dto)
									setOpen(null)
									toast(`Saved ${humanize(dto.config.name)}`, { tone: "good" })
								}}
								notice={
									current.status.state === "error" && (
										<p className="note note-bad">
											<Icon name="alert" size={18} />
											<span>
												<strong>What's wrong:</strong> {whatsWrong(current.status.detail)}
											</span>
										</p>
									)
								}
							/>
						</FlowLevel>
					)}
				</Dialog>
			)}
		</section>
	)
}

const AddSourceDialog = ({ taken, onClose, onSaved }: { taken: string[]; onClose: () => void; onSaved: (s: SourceDto) => void }) => {
	const [kind, setKind] = useState<Exclude<SourceKind, "upload"> | null>(null)
	const [picked, setPicked] = useState<Exclude<SourceKind, "upload"> | null>(null)
	const [rtspHost, setRtspHost] = useState<string | undefined>()
	return (
		<Dialog open title="Add a source" onClose={onClose} size="lg">
			<FlowLevel value={3}>
				{!picked ? (
					<form
						onSubmit={e => {
							e.preventDefault()
							if (kind) setPicked(kind)
						}}
					>
						<p className="muted add-kinds">Where should look4 collect videos from?</p>
						<SourceKindChoice value={kind} onChange={k => k !== "upload" && setKind(k)} withUpload={false} />
						<FlowActions onBack={onClose} backLabel="Cancel">
							<button type="submit" className="btn btn-primary" disabled={!kind}>
								Next
							</button>
						</FlowActions>
					</form>
				) : (
					<ConnectFlow
						key={picked}
						kind={picked}
						takenNames={taken}
						rtspHost={rtspHost}
						onBack={() => setPicked(null)}
						onSaved={onSaved}
						onUseRtsp={host => {
							setRtspHost(host)
							setKind("rtsp")
							setPicked("rtsp")
						}}
					/>
				)}
			</FlowLevel>
		</Dialog>
	)
}

type Capture = ReolinkSourceConfig["capture"]
type Gate = ReolinkSourceConfig["motionGate"]

/**
 * Where a Reolink camera's clips come from, and how much of its live stream look4 checks. Saved as
 * soon as it changes (the source restarts with it), apart from the sign-in form below.
 */
const CaptureSettings = ({ source, keepDays, onSaved }: { source: SourceDto; keepDays: number; onSaved: (s: SourceDto) => void }) => {
	const { toast } = useFeedback()
	const cfg = source.config as ReolinkSourceConfig
	const [capture, setCapture] = useState<Capture>(cfg.capture)
	const [gate, setGate] = useState<Gate>(cfg.motionGate)
	const [saving, setSaving] = useState(false)
	const detail = source.status.detail
	const rest = keepDays > 0 ? `The rest waits in an “unchecked” folder for ${plural(keepDays, "day")}, in case you want to scan it.` : "The rest is deleted right away."
	// what "Automatic" settled on when the source started, from its status line
	const now = /SD card/.test(detail) ? "the SD card" : /Recording the camera's stream/.test(detail) ? "the live stream" : null

	const save = async (patch: { capture?: Capture; motionGate?: Gate }) => {
		const before = { capture, gate }
		if (patch.capture) setCapture(patch.capture)
		if (patch.motionGate) setGate(patch.motionGate)
		setSaving(true)
		try {
			onSaved(await api.updateSource(cfg.name, patch))
			toast("Saved. The camera's source restarts with it.", { tone: "good" })
		} catch (e) {
			setCapture(before.capture)
			setGate(before.gate)
			toast(errorMessage(e), { tone: "bad" })
		} finally {
			setSaving(false)
		}
	}

	return (
		<div className="detail-fields capture-settings" aria-busy={saving}>
			<div className="field">
				<span className="field-label">Clips from</span>
				<ChoiceCards
					name="rl-capture"
					label="Clips from"
					columns={1}
					value={capture}
					onChange={v => void save({ capture: v })}
					options={[
						{
							value: "auto",
							title: "Automatic",
							badge: "Recommended",
							body: `The live stream when the camera shares it, otherwise the SD card.${now ? ` Right now: ${now}.` : ""}`
						},
						{
							value: "stream",
							title: "Live stream",
							body: "look4 records the stream and keeps the moments where it or the camera sees motion. Also lets you save clips from Live."
						},
						{ value: "sd", title: "SD card", body: "look4 downloads the motion clips the camera saves to its memory card." }
					]}
				/>
			</div>
			{capture !== "sd" && (
				<div className="field">
					<span className="field-label">Check</span>
					<ChoiceCards
						name="rl-gate"
						label="Check"
						columns={1}
						value={gate}
						onChange={v => void save({ motionGate: v })}
						options={[
							{
								value: "both",
								title: "Anything that moves",
								badge: "Recommended",
								body: `look4 watches the camera's small preview stream for movement anywhere in view (about 2% of one CPU core) and also uses the camera's own motion detection. look4's full checks then run on every moment that moved, which on a busy, windy day is most of it. ${rest}`
							},
							{
								value: "camera",
								title: "Only what the camera flags as motion",
								body: `Nothing extra runs on this computer, but the camera misses most small birds. ${rest}`
							},
							{
								value: "all",
								title: "Everything",
								body: "look4's full checks run on every moment of the stream. Nothing is skipped, but its own motion check drops most moments with only a small bird in them."
							}
						]}
					/>
				</div>
			)}
			{capture !== "sd" && <CloseUpSetting source={source} gate={gate} onSaved={onSaved} />}
		</div>
	)
}

/**
 * Close-ups: the camera zooms in on a bird for a sharp still, then goes back Home. Only offered
 * when the camera says it can frame a part of the picture and zoom. Saved at once, without
 * restarting the source.
 */
const CloseUpSetting = ({ source, gate, onSaved }: { source: SourceDto; gate: Gate; onSaved: (s: SourceDto) => void }) => {
	const { toast } = useFeedback()
	const cfg = source.config as ReolinkSourceConfig
	const controls = useResource(sig => api.controls(cfg.name, sig), [cfg.name])
	const [on, setOn] = useState(cfg.closeUps)
	const [saving, setSaving] = useState(false)
	const ptz = controls.data?.ptz
	if (!ptz?.box || !ptz.zoom) return null

	const save = async (next: boolean) => {
		setOn(next)
		setSaving(true)
		try {
			onSaved(await api.updateSource(cfg.name, { closeUps: next }))
			toast(next ? "Saved. The camera zooms in on the next bird it spots." : "Saved. The camera stays put from now on.", { tone: "good" })
		} catch (e) {
			setOn(!next)
			toast(errorMessage(e), { tone: "bad" })
		} finally {
			setSaving(false)
		}
	}

	const help =
		gate !== "both"
			? "Needs “Anything that moves” above: that's how look4 sees a bird arrive."
			: !ptz.guard?.set
				? "Save a Home view on the Live page first, so the camera knows where to come back to."
				: "When look4 spots a bird, the camera zooms in for a sharp close-up photo, then swings back to its Home view. The photo shows first on the clip. It waits while you're steering the camera on the Live page."
	return (
		<div className="field field-switch">
			<span className="field-label" id="rl-closeups-label">
				Zoom in on birds
			</span>
			<Switch checked={on} onChange={v => void save(v)} label="Zoom in on birds" disabled={saving} />
			<span className="field-help">{help}</span>
		</div>
	)
}
