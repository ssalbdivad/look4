import { type FormEvent, type ReactNode, useEffect, useState } from "react"
import type { SetupStatus, SourceDto } from "../../../src/api-types.ts"
import type { NormBox, SourceStatus } from "../../../src/types.ts"
import { api, errorMessage, sourceSnapshotUrl } from "../api.ts"
import { armFirstSighting, firstSightingWaiting, pinFirstSighting } from "../components/Celebrate.tsx"
import { Icon, type IconName } from "../components/Icon.tsx"
import { Mascot } from "../components/Mascot.tsx"
import { CompilePreview, useCompilePreview } from "../components/LookoutPreview.tsx"
import { RoiEditor } from "../components/RoiEditor.tsx"
import { Dot, ErrorNote, LoadError, Skeleton } from "../components/ui.tsx"
import { useFeedback } from "../feedback.tsx"
import { fmtPct, humanize, lookoutTitle, plural } from "../format.ts"
import { useDocumentTitle, useResource } from "../hooks.ts"
import { useLive, useLiveEvents } from "../live.tsx"
import { Link, navigate, useLocation } from "../router.tsx"
import { useUpload } from "../upload.tsx"
import { hasJudge, JudgeKeyForm, judgeVia, modelName } from "../setup/JudgeKey.tsx"
import { ConnectFlow, type SourceKind, SourceKindChoice } from "../setup/SourceKinds.tsx"
import { FlowActions, HelpTitle, StepHead, SuccessCard } from "../setup/ui.tsx"

// The first-run wizard: one decision per screen, every step reachable by URL (/setup?step=zone) so the
// browser's Back button works and a reload lands on the same screen.

type Step = "welcome" | "source" | "reolink" | "rtsp" | "folder" | "zone" | "lookout" | "judge" | "done"
const STEPS: Step[] = ["welcome", "source", "reolink", "rtsp", "folder", "zone", "lookout", "judge", "done"]

const PHASES: { label: string; steps: Step[] }[] = [
	{ label: "Hello", steps: ["welcome"] },
	{ label: "Videos", steps: ["source", "reolink", "rtsp", "folder"] },
	{ label: "Feeder zone", steps: ["zone"] },
	{ label: "Lookout", steps: ["lookout"] },
	{ label: "Spotter", steps: ["judge"] },
	{ label: "Done", steps: ["done"] }
]

type Wizard = { kind: SourceKind | null; source: string | null; uploadOnly: boolean; rtspHost: string | null }
const BLANK: Wizard = { kind: null, source: null, uploadOnly: false, rtspHost: null }
const STORE = "look4:setup"

/** Wizard answers live in sessionStorage so a reload mid-setup keeps them. */
const useWizard = () => {
	const [w, setW] = useState<Wizard>(() => {
		try {
			return { ...BLANK, ...(JSON.parse(sessionStorage.getItem(STORE) ?? "{}") as Partial<Wizard>) }
		} catch {
			return BLANK
		}
	})
	const update = (patch: Partial<Wizard>) =>
		setW(prev => {
			const next = { ...prev, ...patch }
			sessionStorage.setItem(STORE, JSON.stringify(next))
			return next
		})
	return [w, update] as const
}

const go = (step: Step) => navigate(`/setup?step=${step}`)

export const SetupPage = () => {
	useDocumentTitle("Set up")
	const { query } = useLocation()
	const raw = query.get("step") as Step | null
	const step: Step = raw && STEPS.includes(raw) ? raw : "welcome"
	const status = useResource(s => api.setup(s), [])
	const [w, update] = useWizard()
	const { toast } = useFeedback()

	const s = status.data
	// a first run of the wizard is a new install: its first sighting gets the party, even when it lands
	// during setup (Sightings shows it once "Go to sightings" opens the feed)
	useEffect(() => {
		if (s && !s.completed) armFirstSighting()
	}, [s])
	const taken = s?.sources.map(x => x.config.name) ?? []
	// After a reload the wizard may have forgotten which source it just added; the newest one is it.
	const source = w.source ?? s?.sources.at(-1)?.config.name ?? null

	const leave = async () => {
		if (!s?.completed) {
			try {
				await api.completeSetup({ skipped: true })
			} catch (e) {
				toast(errorMessage(e), { tone: "bad" })
			}
		}
		sessionStorage.removeItem(STORE)
		navigate("/")
	}

	const saved = (dto: SourceDto) => {
		update({ source: dto.config.name, uploadOnly: false })
		status.reload()
		go("zone")
	}

	const phase = PHASES.findIndex(p => p.steps.includes(step))
	let body: ReactNode
	if (!s && step !== "welcome")
		body = status.error ? <LoadError message={status.error} status={status.errorStatus} onRetry={status.reload} what="setup" /> : <Skeleton style={{ height: 320 }} />
	else if (step === "welcome") body = <Welcome again={s?.completed ?? false} onStart={() => go("source")} onSkip={leave} />
	else if (step === "source")
		body = (
			<SourceStep
				initial={w.kind}
				hasSources={taken.length > 0}
				onNext={kind => {
					update({ kind, uploadOnly: kind === "upload", rtspHost: null })
					go(kind === "upload" ? "lookout" : kind === "watch" ? "folder" : kind)
				}}
			/>
		)
	else if (step === "reolink" || step === "rtsp" || step === "folder")
		body = (
			<ConnectFlow
				key={step}
				kind={step === "folder" ? "watch" : step}
				takenNames={taken}
				rtspHost={w.rtspHost ?? undefined}
				onBack={() => go("source")}
				onSaved={saved}
				onUseRtsp={host => {
					update({ kind: "rtsp", rtspHost: host ?? null })
					go("rtsp")
				}}
			/>
		)
	else if (step === "zone") body = <ZoneStep source={source} onBack={() => go("source")} onNext={() => go("lookout")} />
	else if (step === "lookout")
		body = <LookoutStep onBack={() => go(w.uploadOnly ? "source" : "zone")} onNext={() => go("judge")} />
	else if (step === "judge") body = <JudgeStep status={s!} onStatus={next => status.setData(() => next)} onBack={() => go("lookout")} onNext={() => go("done")} />
	else body = <DoneStep status={s!} source={w.uploadOnly ? null : source} uploadOnly={w.uploadOnly} onFinish={() => {
		sessionStorage.removeItem(STORE)
		navigate("/")
	}} />

	return (
		<div className="setup">
			<header className="setup-top">
				<Link to="/" className="brand" aria-label="look4 home" onClick={e => {
					if (!s?.completed) {
						e.preventDefault()
						leave()
					}
				}}>
					<img className="brand-mark" src="/logo-mark.svg" alt="" width={36} height={36} />
					<span className="wordmark">
						look<span className="wordmark-4">4</span>
					</span>
				</Link>
				{step !== "welcome" && step !== "done" && (
					<button type="button" className="btn btn-ghost btn-sm" onClick={leave}>
						{s?.completed ? "Exit setup" : "Skip setup"}
					</button>
				)}
			</header>
			{step !== "welcome" && <Progress current={phase} skipZone={w.uploadOnly} />}
			{/* one width for every step, so the frame never jumps sideways between questions */}
			<main id="main" className="setup-card">
				{body}
			</main>
		</div>
	)
}

const Progress = ({ current, skipZone }: { current: number; skipZone: boolean }) => (
	<ol className="progress" aria-label="Setup progress">
		{PHASES.map((p, i) => {
			const skipped = skipZone && p.label === "Feeder zone"
			const state = i < current ? "is-done" : i === current ? "is-now" : ""
			return (
				<li key={p.label} className={`${state}${skipped ? " is-skipped" : ""}`} aria-current={i === current ? "step" : undefined}>
					<span className="progress-dot">{i < current && !skipped && <Icon name="check" size={12} />}</span>
					<span className="progress-label">{p.label}</span>
				</li>
			)
		})}
	</ol>
)

// ---------- 1. welcome ----------

const Welcome = ({ again, onStart, onSkip }: { again: boolean; onStart: () => void; onSkip: () => void }) => (
	<div className="welcome">
		<Mascot pose="hello" size={168} className="welcome-mark" />
		<StepHead title={again ? "Let's set things up again" : "Hi! I'm look4."}>
			<p>
				I watch your camera's video clips and keep only the ones that show what you care about, like a cardinal at the
				feeder. The rest are cleared away for you.
			</p>
		</StepHead>
		<ul className="welcome-list">
			<WelcomeItem n={1} icon="camera" title="Connect your camera" body="or a folder of videos" />
			<WelcomeItem n={2} icon="target" title="Say what to look for" body="in plain words" />
			<WelcomeItem n={3} icon="sparkle" title="Meet the spotter" body="and see what it costs" />
		</ul>
		<div className="welcome-actions">
			{/* no autoFocus: StepHead puts focus on the heading, and a focused button scrolls the page to itself */}
			<button type="button" className="btn btn-primary btn-lg" onClick={onStart}>
				Let's set it up
				<Icon name="arrowLeft" size={18} className="flip" />
			</button>
			<button type="button" className="btn btn-ghost" onClick={onSkip}>
				{again ? "Back to look4" : "Skip for now"}
			</button>
		</div>
		<p className="fine muted">It takes a few minutes. You can change everything later in Settings.</p>
	</div>
)

const WelcomeItem = ({ n, icon, title, body }: { n: number; icon: IconName; title: string; body: string }) => (
	<li>
		<span className="welcome-icon">
			<Icon name={icon} size={22} />
			<span className="welcome-n" aria-hidden="true">
				{n}
			</span>
		</span>
		<strong>{title}</strong>
		<span className="muted">{body}</span>
	</li>
)

// ---------- 2. where videos come from ----------

const SourceStep = ({ initial, hasSources, onNext }: { initial: SourceKind | null; hasSources: boolean; onNext: (k: SourceKind) => void }) => {
	const [kind, setKind] = useState<SourceKind | null>(initial)
	return (
		<form
			onSubmit={e => {
				e.preventDefault()
				if (kind) onNext(kind)
			}}
		>
			<StepHead title="Where do your videos come from?">
				<p>Pick the one that fits best. You can add more sources later in Settings.</p>
			</StepHead>
			{hasSources && (
				<p className="note">
					<Icon name="check" size={18} />
					<span>
						You already have a source connected. Add another here, or <Link to="/setup?step=zone">skip to the feeder zone</Link>.
					</span>
				</p>
			)}
			<SourceKindChoice value={kind} onChange={setKind} withUpload />
			<FlowActions onBack={() => go("welcome")}>
				<button type="submit" className="btn btn-primary" disabled={!kind}>
					Next
				</button>
			</FlowActions>
		</form>
	)
}

// ---------- 4. feeder zone ----------

const sameBox = (a: NormBox | null, b: NormBox | null) =>
	a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)

const ZoneStep = ({ source, onBack, onNext }: { source: string | null; onBack: () => void; onNext: () => void }) => {
	const { toast } = useFeedback()
	const settings = useResource(s => api.settings(s), [])
	const [box, setBox] = useState<NormBox | null>(null)
	const [bust, setBust] = useState(() => Date.now())
	const [frame, setFrame] = useState<"loading" | "ok" | "bad">("loading")
	const [saving, setSaving] = useState(false)
	const saved = settings.data?.roi ?? null
	useEffect(() => setBox(saved), [saved])
	const snapshot = source ? sourceSnapshotUrl(source, bust) : `/api/snapshot?t=${bust}`

	const save = async () => {
		if (!box || sameBox(box, saved)) return onNext()
		setSaving(true)
		try {
			// no "saved" toast: it would still be up a step or two later, and the Done summary says it
			await api.patchSettings({ roi: box })
			onNext()
		} catch (e) {
			toast(errorMessage(e), { tone: "bad" })
		} finally {
			setSaving(false)
		}
	}

	return (
		<>
			<StepHead eyebrow="Optional" title="Where's the feeder?">
				<p>
					Drag a box around the feeder. look4 then ignores movement outside it, like swaying branches or a passing car, and
					looks closer at what's inside.
				</p>
			</StepHead>
			<div className="zone-wrap">
				{/* load the frame off-screen first so a failure can show a friendly note instead of a broken image */}
				<img className="sr-only" src={snapshot} alt="" onLoad={() => setFrame("ok")} onError={() => setFrame("bad")} />
				{frame === "loading" ? (
					<div className="zone-wait">
						<span className="spinner" aria-hidden="true" />
						Getting a picture from {source ? humanize(source) : "your camera"}…
					</div>
				) : frame === "bad" ? (
					// nothing to draw on, so no pretend canvas: say so, and offer the two ways forward
					<div className="zone-nopic" role="status">
						<Mascot pose="sleepy" size={104} />
						<div>
							<p className="zone-nopic-title">No picture from the camera yet</p>
							<p className="muted">
								It can take a minute after connecting. Try again in a moment, or skip this: you can draw the zone any time in
								Settings.
							</p>
							<div className="zone-nopic-actions">
								<button
									type="button"
									className="btn btn-ghost btn-sm"
									onClick={() => {
										setFrame("loading")
										setBust(Date.now())
									}}
								>
									<Icon name="refresh" size={16} />
									Try again
								</button>
								<button type="button" className="btn btn-ghost btn-sm" onClick={onNext}>
									Skip for now
								</button>
							</div>
						</div>
					</div>
				) : (
					<RoiEditor box={box} onChange={setBox} snapshot={snapshot} onSnapshotError={() => setFrame("bad")} />
				)}
				{frame !== "bad" && <p className="fine muted zone-tip">
					{box
						? `The box covers ${fmtPct(box.w * box.h)} of the picture. Drag its edges to adjust, or drag inside it to move it.`
						: "Tip: leave a little room around the feeder so birds landing on the edge still count."}
				</p>}
			</div>
			<FlowActions onBack={onBack}>
				{frame !== "bad" && (
					<button type="button" className="btn btn-ghost" onClick={onNext}>
						Skip for now
					</button>
				)}
				{frame !== "bad" && (
					<button type="button" className="btn btn-primary" onClick={save} disabled={!box || saving}>
						{saving && <span className="spinner" aria-hidden="true" />}
						Save zone
					</button>
				)}
			</FlowActions>
		</>
	)
}

// ---------- 5. first lookout ----------

const IDEAS = [
	{ label: "Cardinals", prompt: "a northern cardinal at the feeder" },
	{ label: "Blue jays", prompt: "a blue jay at the feeder" },
	{ label: "Any squirrel", prompt: "any squirrel on the feeder or the pole" },
	{ label: "Hawks or other raptors", prompt: "a hawk or any other bird of prey" }
]

const LookoutStep = ({ onBack, onNext }: { onBack: () => void; onNext: () => void }) => {
	const existing = useResource(s => api.lookouts(s), [])
	const [prompt, setPrompt] = useState("")
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const { preview, typing } = useCompilePreview(prompt)
	const have = existing.data ?? []

	const save = async (e: FormEvent) => {
		e.preventDefault()
		if (!prompt.trim()) return onNext()
		setSaving(true)
		setError(null)
		try {
			// no "on watch" toast: it outlived the judge step and covered Done's main button; Done lists it
			await api.createLookout({ prompt: prompt.trim() })
			onNext()
		} catch (err) {
			setError(errorMessage(err))
		} finally {
			setSaving(false)
		}
	}

	return (
		<form onSubmit={save}>
			<StepHead title="What should look4 look for?">
				<p>Describe it the way you'd tell a friend. This is your first “lookout”; you can add as many as you like later.</p>
			</StepHead>
			{have.length > 0 && (
				<p className="note">
					<Icon name="check" size={18} />
					<span>
						Already on watch: {have.map(l => `“${lookoutTitle(l)}”`).join(", ")}. Add another, or skip ahead.
					</span>
				</p>
			)}
			<div className="ideas" role="group" aria-label="Ideas">
				{IDEAS.map(x => (
					<button key={x.label} type="button" className={prompt === x.prompt ? "example is-on" : "example"} onClick={() => setPrompt(x.prompt)}>
						<Icon name="sparkle" size={16} />
						{x.label}
					</button>
				))}
			</div>
			<div className="editor lookout-step">
				<label className="field">
					<span className="field-label">I'm hoping to see…</span>
					<textarea
						value={prompt}
						onChange={e => setPrompt(e.target.value)}
						rows={4}
						placeholder="a cardinal or a blue jay at the feeder"
						onKeyDown={e => {
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit()
						}}
					/>
					<span className="field-help">
						Plain English is perfect. Name a bird or animal, and where or what it's doing if that matters (“on the suet
						cage”, “two at once”).
					</span>
				</label>
				<CompilePreview prompt={prompt} preview={preview} typing={typing} />
			</div>
			{error && <ErrorNote message={error} />}
			<FlowActions onBack={onBack}>
				{have.length > 0 && !prompt.trim() ? (
					<button type="submit" className="btn btn-primary">
						Next
					</button>
				) : (
					<button type="submit" className="btn btn-primary" disabled={!prompt.trim() || saving}>
						{saving && <span className="spinner" aria-hidden="true" />}
						Start looking for this
					</button>
				)}
			</FlowActions>
		</form>
	)
}

// ---------- 6. AI judge ----------

const JudgeStep = ({
	status,
	onStatus,
	onBack,
	onNext
}: {
	status: SetupStatus
	onStatus: (s: SetupStatus) => void
	onBack: () => void
	onNext: () => void
}) => {
	const j = status.judge
	const ok = hasJudge(j)
	const [justSaved, setJustSaved] = useState(false)
	return (
		<>
			<StepHead title="Meet the spotter">
				<p>
					look4 checks each clip in three steps. The first two are free and run on this computer: <em>did something move?</em>{" "}
					and <em>is there a bird or animal in the picture?</em> Only clips that pass both get a quick look from the spotter:
					Claude, with an eye sharp enough to tell a cardinal from a house finch.
				</p>
			</StepHead>
			<ol className="cascade" aria-label="How a clip is checked">
				<li>
					<span className="cascade-icon">
						<Icon name="pulse" size={20} />
					</span>
					<strong>Motion</strong>
					<span className="muted">free</span>
				</li>
				<li>
					<span className="cascade-icon">
						<Icon name="box" size={20} />
					</span>
					<strong>Detector</strong>
					<span className="muted">free, on this computer</span>
				</li>
				<li className={ok ? "is-ok" : "is-missing"}>
					<span className="cascade-icon">
						<Icon name="sparkle" size={20} />
					</span>
					<strong>Spotter</strong>
					<span className="muted">{ok ? "about $0.0003 a clip" : "not set up yet"}</span>
				</li>
			</ol>
			{ok ? (
				<SuccessCard title={`${modelName(j.model)} is ready, ${judgeVia(j.provider)}`}>
					<p className="muted">
						{justSaved ? "Key saved. " : ""}
						Each look costs about <strong>$0.0003</strong>, so a hundred checked clips come to about 3 cents. Most clips
						never get this far.
						{j.provider === "claude-code" && " It runs on your Claude plan, so there's no separate bill; look4 still shows what it would cost."}
					</p>
				</SuccessCard>
			) : (
				<div className="judge-missing">
					<div className="help help-warn">
						<div className="help-head">
							<span className="help-icon">
								<Icon name="sparkle" size={22} />
							</span>
							<div>
								<HelpTitle>The spotter isn't here yet</HelpTitle>
								<p>{j.detail}</p>
								<p>
									Add an Anthropic API key to switch it on. It's pay-as-you-go: about $0.0003 a clip, so a busy feeder
									with 100 checked clips a day costs around a dollar a month.
								</p>
							</div>
						</div>
						<JudgeKeyForm
							onSaved={next => {
								setJustSaved(true)
								onStatus(next)
							}}
						/>
					</div>
					<p className="fine muted judge-without">
						<strong>Or continue without one.</strong> look4 will then keep every clip where the detector spots the kind of
						thing you named (any bird, any squirrel) but can't tell species apart, so expect clips that aren't quite what
						you asked for. You can add a key later in Settings.
					</p>
				</div>
			)}
			<FlowActions onBack={onBack}>
				<button type="button" className={ok ? "btn btn-primary" : "btn btn-ghost"} onClick={onNext}>
					{ok ? "Next" : "Continue without a spotter"}
				</button>
			</FlowActions>
		</>
	)
}

// ---------- 7. all set ----------

const DoneStep = ({
	status,
	source,
	uploadOnly,
	onFinish
}: {
	status: SetupStatus
	source: string | null
	uploadOnly: boolean
	onFinish: () => void
}) => {
	const { queue } = useLive()
	const { pick } = useUpload()
	const [done, setDone] = useState<SetupStatus | null>(null)
	const [live, setLive] = useState<SourceStatus | null>(() => status.sources.find(x => x.config.name === source)?.status ?? null)
	const [sighting, setSighting] = useState<{ clipId: string; label: string | null } | null>(null)
	const [settings, setSettings] = useState<{ roi: NormBox | null; lookouts: string[] } | null>(null)

	useEffect(() => {
		api.completeSetup(uploadOnly ? { uploadOnly: true } : {}).then(next => {
			setDone(next)
			// the status the wizard loaded is from before the first pull; a source only sends live
			// updates when its state changes, so take the fresh count from here
			const st = next.sources.find(x => x.config.name === source)?.status
			if (st) setLive(st)
		}, () => {})
		Promise.all([api.settings(), api.lookouts()]).then(
			([s, ls]) => setSettings({ roi: s.roi, lookouts: ls.filter(l => l.enabled).map(l => lookoutTitle(l).toLowerCase()) }),
			() => {}
		)
		// the first clips are often judged while the person is still on the judge step
		api.sightings({ limit: 1 }).then(
			p => {
				const c = p.items[0]
				if (c) setSighting(prev => prev ?? { clipId: c.id, label: c.matches[0]?.label ?? null })
			},
			() => {}
		)
	}, [uploadOnly, source])

	useLiveEvents(e => {
		if (e.event === "source" && e.data.name === source) setLive(e.data)
		if (e.event === "sighting" && !sighting) setSighting({ clipId: e.data.clipId, label: e.data.label })
	})

	const s = done ?? status
	const judgeOk = hasJudge(s.judge)
	// a first sighting that landed during setup: tease it here, and let the feed throw the party
	const first = sighting && firstSightingWaiting() ? sighting : null
	useEffect(() => {
		if (first) pinFirstSighting(first.clipId)
	}, [first?.clipId])
	const waiting = queue ? queue.pending + queue.processing : 0
	return (
		<div className="done">
			<Mascot pose="found" size={110} className="welcome-mark" />
			<StepHead title="You're all set!">
				<p>look4 is on watch. New sightings will show up on the Sightings page by themselves.</p>
			</StepHead>
			<ul className="summary">
				<SummaryRow
					ok
					icon={uploadOnly ? "upload" : "camera"}
					title={uploadOnly ? "Videos: you'll upload them" : source ? `Videos from ${humanize(source)}` : "Videos"}
					body={uploadOnly ? "Use the Upload button, or drag videos onto any page." : (live?.detail ?? "Starting…")}
				/>
				{!uploadOnly && (
					<SummaryRow
						ok={!!settings?.roi}
						icon="box"
						title={settings?.roi ? "Feeder zone drawn" : "No feeder zone"}
						body={settings?.roi ? `Covers ${fmtPct(settings.roi.w * settings.roi.h)} of the picture.` : "The whole picture counts. You can draw one in Settings."}
					/>
				)}
				<SummaryRow
					ok={!!settings?.lookouts.length}
					icon="target"
					title={settings?.lookouts.length ? `Looking for ${settings.lookouts.map(n => `“${n}”`).join(", ")}` : "No lookouts yet"}
					body={settings?.lookouts.length ? "Change or add more at the top of Sightings." : "Add one on the Sightings page so look4 knows what to keep."}
				/>
				<SummaryRow
					ok={judgeOk}
					icon="sparkle"
					title={judgeOk ? `Spotted by ${modelName(s.judge.model)}` : "No spotter"}
					body={judgeOk ? judgeVia(s.judge.provider).replace(/^./, c => c.toUpperCase()) + "." : "The detector decides alone. Add a key in Settings any time."}
				/>
			</ul>
			{source && live && (
				<div className="first-pull" role="status" aria-live="polite">
					<Dot tone={live.state === "error" ? "bad" : live.state === "ok" ? "good" : "warn"} pulse={live.state === "starting" || waiting > 0} />
					<div>
						<strong>
							{live.state === "error"
								? `${humanize(source)} has a problem`
								: live.clipsIngested
									? `${plural(live.clipsIngested, "clip")} collected so far`
									: "Collecting the first clips…"}
						</strong>
						<span className="muted">
							{live.state === "error" ? live.detail : waiting > 0 ? ` · ${plural(waiting, "clip")} waiting to be checked` : live.clipsIngested ? " · all checked" : ""}
						</span>
						{/* a teaser, not a link to the clip: the party for it waits on the Sightings page */}
						{first && (
							<p className="first-sighting">
								<Icon name="binoculars" size={16} />
								Already spotted: {first.label ?? "something"}!
							</p>
						)}
					</div>
				</div>
			)}
			<div className="welcome-actions">
				<button type="button" className="btn btn-primary btn-lg" onClick={onFinish}>
					<Icon name={first ? "sparkle" : "binoculars"} size={18} />
					{first ? "See your first sighting" : "Go to sightings"}
				</button>
				{uploadOnly && (
					<button type="button" className="btn btn-ghost" onClick={pick}>
						<Icon name="upload" size={18} />
						Upload videos now
					</button>
				)}
			</div>
		</div>
	)
}

const SummaryRow = ({ ok, icon, title, body }: { ok: boolean; icon: IconName; title: string; body: string }) => (
	<li className={ok ? "is-ok" : "is-skip"}>
		<span className="summary-icon">
			<Icon name={ok ? "check" : icon} size={18} />
		</span>
		<div>
			<strong>{title}</strong>
			<span className="muted">{body}</span>
		</div>
	</li>
)
