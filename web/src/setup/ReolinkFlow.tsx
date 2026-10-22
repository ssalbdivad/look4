import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react"
import type { CameraTestResult, DiscoveredCamera, DiscoverResponse, SourceDto } from "../../../src/api-types.ts"
import type { ReolinkSourceConfig } from "../../../src/config.ts"
import { api, errorMessage } from "../api.ts"
import { Icon } from "../components/Icon.tsx"
import { Mascot } from "../components/Mascot.tsx"
import { ErrorNote } from "../components/ui.tsx"
import { useFeedback } from "../feedback.tsx"
import {
	BadCredentialsHelp,
	HttpDisabledHelp,
	isLoginProblem,
	LockedOutHelp,
	NeedsPasswordHelp,
	NotReolinkHelp,
	RECHECK_SECONDS,
	RtspOffHelp,
	UnknownHelp,
	UnreachableHelp,
	useCountdown,
	usePortWatch
} from "./CameraHelp.tsx"
import { ChoiceCards, FlowActions, NameField, PasswordInput, StepHead, SuccessCard, toSourceName } from "./ui.tsx"

type Phase = "find" | "login" | "help" | "details"

const LOOKBACK = [
	{ value: 0, label: "Only new clips from now on" },
	{ value: 1, label: "The last hour" },
	{ value: 24, label: "The last 24 hours" },
	{ value: 72, label: "The last 3 days" },
	{ value: 168, label: "The last week" }
]

/** How long the Test button waits after the camera says it is locking sign-ins. */
const LOCKOUT_WAIT_S = 60

/**
 * Connect a Reolink camera: find it (network scan or typed address), sign in, test, and fix whatever
 * the test finds, then name it and save. With `existing`, it edits that source instead (Settings → Fix it).
 */
export const ReolinkFlow = ({
	existing,
	takenNames = [],
	onBack,
	onSaved,
	onUseRtsp,
	notice,
	autoTest
}: {
	existing?: ReolinkSourceConfig
	takenNames?: string[]
	onBack: () => void
	onSaved: (s: SourceDto) => void
	onUseRtsp?: (host?: string) => void
	/** Shown above the sign-in form, e.g. what is wrong with an existing source. */
	notice?: ReactNode
	/** Test right away with the saved login (Fix it), so the matching walkthrough opens by itself. */
	autoTest?: boolean
}) => {
	const { toast } = useFeedback()
	const [phase, setPhase] = useState<Phase>(existing ? "login" : "find")
	const [findMode, setFindMode] = useState<"scan" | "type">("scan")
	const [scan, setScan] = useState<{ busy: boolean; result: DiscoverResponse | null; error: string | null }>({ busy: false, result: null, error: null })
	const [host, setHost] = useState(existing?.host ?? "")
	const [typedHost, setTypedHost] = useState(existing?.host ?? "")
	const [username, setUsername] = useState(existing?.username ?? "admin")
	const [password, setPassword] = useState("")
	const [noPassword, setNoPassword] = useState(false)
	const [testing, setTesting] = useState(false)
	const [result, setResult] = useState<CameraTestResult | null>(null)
	const [testError, setTestError] = useState<string | null>(null)
	const [checks, setChecks] = useState(0)
	const [lockedAt, setLockedAt] = useState<number | null>(null)
	const [name, setName] = useState(existing?.name ?? "")
	const [lookback, setLookback] = useState(24)
	const [stream, setStream] = useState<"main" | "sub">(existing?.stream ?? "main")
	const [saving, setSaving] = useState(false)
	const [saveError, setSaveError] = useState<string | null>(null)
	const scanAbort = useRef<AbortController | null>(null)

	const runScan = async () => {
		scanAbort.current?.abort()
		const ac = new AbortController()
		scanAbort.current = ac
		setScan(s => ({ ...s, busy: true, error: null }))
		try {
			const result = await api.discover(ac.signal)
			if (!ac.signal.aborted) setScan({ busy: false, result, error: null })
		} catch (e) {
			if (!ac.signal.aborted) setScan(s => ({ ...s, busy: false, error: errorMessage(e) }))
		}
	}

	// Start looking as soon as the screen opens: most people have exactly one camera and it shows up.
	useEffect(() => {
		if (phase === "find" && findMode === "scan" && !scan.result && !scan.busy && !scan.error) runScan()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [phase, findMode])
	useEffect(() => () => scanAbort.current?.abort(), [])

	// Editing a saved camera with the password box left empty means "use the saved password": the
	// server tests with it, so nobody has to remember or retype it. Only at the address it was saved
	// for, though: the server never sends a saved password to a new address, so a moved camera needs it typed.
	const newAddress = !!existing && host !== existing.host
	const keepSaved = !!existing && !newAddress && password === "" && !noPassword
	const needsPassword = newAddress && password === "" && !noPassword

	const test = async () => {
		setTesting(true)
		setTestError(null)
		try {
			const user = username.trim() || "admin"
			const r = await api.testCamera(keepSaved && existing ? { host, username: user, source: existing.name } : { host, username: user, password })
			setResult(r)
			setChecks(n => n + 1)
			if (r.ok) {
				if (!existing) setName(n => n || toSourceName(r.name ?? "") || "camera")
				if (phase === "help") toast("It worked! look4 can talk to your camera now.", { tone: "good" })
				setPhase("details")
			} else if (r.problem === "locked-out") {
				setLockedAt(Date.now())
				setPhase("login")
			} else if (r.problem === "bad-credentials") setPhase("login")
			else setPhase("help")
		} catch (e) {
			setTestError(errorMessage(e))
		} finally {
			setTesting(false)
		}
	}

	// While the HTTPS walkthrough is open, re-check every few seconds so it turns green by itself.
	const waiting = phase === "help" && result?.problem === "http-disabled" && !testing
	const nextCheckIn = useCountdown(waiting ? RECHECK_SECONDS : null, checks)
	const latestTest = useRef(test)
	latestTest.current = test
	useEffect(() => {
		if (!waiting) return
		const id = setTimeout(() => latestTest.current(), RECHECK_SECONDS * 1000)
		return () => clearTimeout(id)
	}, [waiting, checks])

	// once only (StrictMode runs effects twice): every extra login attempt counts toward the camera's lockout
	const autoRan = useRef(false)
	useEffect(() => {
		if (!autoTest || autoRan.current) return
		autoRan.current = true
		latestTest.current()
	}, [autoTest])

	// after a successful sign-in: is live video (RTSP) on? Only knocks on the port, so it re-checks freely.
	const rtspOff = phase === "details" && !!result?.ok && !result.ports.rtsp
	const portWatch = usePortWatch(host, rtspOff, ports => ports.rtsp)
	const blankPassword = !keepSaved && password === ""

	const lockWait = useCountdown(lockedAt === null ? null : (result?.retryAfterSeconds ?? LOCKOUT_WAIT_S), lockedAt)
	const locked = result?.problem === "locked-out" && lockWait > 0

	const pick = (cam: DiscoveredCamera) => {
		if (cam.vendor !== "reolink" && onUseRtsp) return onUseRtsp(cam.host)
		setHost(cam.host)
		setTypedHost(cam.host)
		setResult(null)
		setPhase("login")
	}

	const submitTyped = (e: FormEvent) => {
		e.preventDefault()
		const h = cleanHost(typedHost)
		if (!h) return
		setHost(h)
		setResult(null)
		setPhase("login")
	}

	const submitLogin = (e: FormEvent) => {
		e.preventDefault()
		if (!locked && !testing && !needsPassword) test()
	}

	const save = async (e: FormEvent) => {
		e.preventDefault()
		setSaving(true)
		setSaveError(null)
		try {
			const saved = existing
				? await api.updateSource(existing.name, { host, username: username.trim() || "admin", password: keepSaved ? undefined : password, stream })
				: await api.addSource({ type: "reolink", name: name || undefined, host, username: username.trim() || "admin", password, stream, lookbackHours: lookback })
			onSaved(saved)
		} catch (err) {
			setSaveError(errorMessage(err))
		} finally {
			setSaving(false)
		}
	}

	const changeAddress = () => {
		setFindMode("type")
		setResult(null)
		setPhase("find")
	}

	if (phase === "find")
		return (
			<>
				<StepHead eyebrow="Reolink camera" title="Let's find your camera">
					<p>Your camera and this computer need to be on the same home network. look4 can look for it, or you can type its address.</p>
				</StepHead>
				<div className="seg" role="tablist" aria-label="How to find the camera">
					<button type="button" role="tab" aria-selected={findMode === "scan"} className={findMode === "scan" ? "seg-btn is-on" : "seg-btn"} onClick={() => setFindMode("scan")}>
						<Icon name="binoculars" size={18} />
						Find it for me
					</button>
					<button type="button" role="tab" aria-selected={findMode === "type"} className={findMode === "type" ? "seg-btn is-on" : "seg-btn"} onClick={() => setFindMode("type")}>
						<Icon name="pencil" size={18} />
						Type the address
					</button>
				</div>
				{findMode === "scan" ? (
					<ScanResults scan={scan} onPick={pick} onRescan={runScan} onType={() => setFindMode("type")} canUseRtsp={!!onUseRtsp} />
				) : (
					<form id="reolink-type" className="type-host" onSubmit={submitTyped}>
						<label className="field" htmlFor="rl-host">
							<span className="field-label">Camera address</span>
							<input id="rl-host" value={typedHost} onChange={e => setTypedHost(e.target.value)} placeholder="192.168.1.31" inputMode="decimal" spellCheck={false} autoFocus aria-describedby="rl-host-help" />
							<span className="field-help" id="rl-host-help">
								Four numbers with dots, like 192.168.1.31. To see it in the Reolink app, tap the camera, then the{" "}
								<strong>gear → Network → Network information</strong> (IP address).
							</span>
						</label>
					</form>
				)}
				<FlowActions onBack={onBack}>
					{findMode === "type" && (
						<button type="submit" form="reolink-type" className="btn btn-primary" disabled={!cleanHost(typedHost)}>
							Next
						</button>
					)}
				</FlowActions>
			</>
		)

	if (phase === "login" || (phase === "help" && !result))
		return (
			<form onSubmit={submitLogin}>
				<StepHead eyebrow="Reolink camera" title={existing ? `Sign in to ${existing.name}` : "Sign in to the camera"}>
					<p>
						This is the camera's own username and password, the ones the Reolink app asked for when you added it. look4
						only uses them to collect clips and to show and steer the camera on the Live page.
					</p>
				</StepHead>
				{notice}
				<div className="login-card">
					<div className="login-host">
						<Icon name="camera" size={20} />
						<span>
							<span className="muted fine">Camera at</span>
							<strong>{host}</strong>
						</span>
						<button type="button" className="btn btn-ghost btn-sm push-end" onClick={changeAddress}>
							Change
						</button>
					</div>
					<div className="field-row">
						<label className="field" htmlFor="rl-user">
							<span className="field-label">Username</span>
							<input id="rl-user" value={username} onChange={e => setUsername(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby="rl-user-help" />
							<span className="field-help" id="rl-user-help">
								Almost always <code>admin</code>.
							</span>
						</label>
						<div className="field">
							<label className="field-label" htmlFor="rl-pass">
								Password
							</label>
							<PasswordInput
								id="rl-pass"
								value={password}
								onChange={v => {
									setPassword(v)
									if (v) setNoPassword(false)
								}}
								placeholder={existing && !noPassword && !newAddress ? "Saved password" : undefined}
								autoFocus={result?.problem === "bad-credentials" || newAddress}
								describedBy="rl-pass-help"
							/>
							<span className="field-help" id="rl-pass-help">
								{newAddress
									? "This is a new address, so type the camera's password again."
									: existing
										? "Leave it empty to keep the saved password, or type a new one."
										: "Leave it empty if you never set one. Reolink cameras come without a password."}
							</span>
							{existing && (
								<label className="check-line">
									<input type="checkbox" checked={noPassword} onChange={e => {
											setNoPassword(e.target.checked)
											if (e.target.checked) setPassword("")
										}}
									/>
									This camera has no password
								</label>
							)}
						</div>
					</div>
				</div>
				{result?.problem === "bad-credentials" && <BadCredentialsHelp attemptsLeft={result.attemptsLeft} />}
				{result?.problem === "locked-out" && <LockedOutHelp detail={result.detail} waitLeft={lockWait} />}
				{testError && <ErrorNote message={testError} />}
				<FlowActions onBack={existing ? onBack : () => setPhase("find")}>
					<button type="submit" className="btn btn-primary" disabled={testing || locked || needsPassword}>
						{testing ? <span className="spinner" aria-hidden="true" /> : <Icon name="sparkle" size={18} />}
						{testing
							? "Saying hello…"
							: isLoginProblem(result)
								? result?.attemptsLeft !== undefined
									? `Try again (${result.attemptsLeft} ${result.attemptsLeft === 1 ? "try" : "tries"} left)`
									: "Try again"
								: "Test connection"}
					</button>
				</FlowActions>
			</form>
		)

	if (phase === "help" && result) {
		const p = result.problem
		return (
			<>
				<StepHead eyebrow="Reolink camera" title={p === "http-disabled" ? "A couple of switches to flip" : "Let's sort this out"} />
				{p === "http-disabled" ? (
					<HttpDisabledHelp host={host} ports={result.ports} testing={testing} nextCheckIn={waiting ? nextCheckIn : null} checks={checks} onCheck={test} />
				) : p === "unreachable" ? (
					<UnreachableHelp
						host={host}
						testing={testing}
						onRetry={test}
						onChangeAddress={changeAddress}
						onRescan={() => {
							setFindMode("scan")
							setPhase("find")
							runScan()
						}}
					/>
				) : p === "not-reolink" ? (
					<NotReolinkHelp host={host} onChangeAddress={changeAddress} onUseRtsp={onUseRtsp && (() => onUseRtsp(host))} />
				) : (
					<UnknownHelp detail={result.detail} testing={testing} onRetry={test} />
				)}
				{testError && <ErrorNote message={testError} />}
				<FlowActions onBack={() => setPhase("login")} />
			</>
		)
	}

	return (
		<form onSubmit={save}>
			<StepHead eyebrow="Reolink camera" title={existing ? "Connected" : "Connected! A few choices"} />
			<SuccessCard title={`look4 can see ${result?.name ? `“${result.name}”` : "your camera"}`}>
				<dl className="facts facts-inline">
					{result?.model && (
						<div>
							<dt>Model</dt>
							<dd>{result.model}</dd>
						</div>
					)}
					<div>
						<dt>Address</dt>
						<dd>{host}</dd>
					</div>
					{result?.firmware && (
						<div>
							<dt>Firmware</dt>
							<dd>{result.firmware}</dd>
						</div>
					)}
				</dl>
			</SuccessCard>
			{rtspOff && !portWatch.ports?.rtsp && (
				<RtspOffHelp
					host={host}
					cameraName={result?.name}
					ports={portWatch.ports ?? result?.ports}
					checking={portWatch.checking}
					nextCheckIn={portWatch.nextCheckIn}
					checks={portWatch.checks}
					onCheck={portWatch.check}
				>
					<p className="fine muted help-aside">
						You can save now and switch it on later. Until then look4 downloads the clips the camera saves to its SD card;
						once the stream is on, it records that instead and keeps what the camera's motion detection flags.
					</p>
				</RtspOffHelp>
			)}
			{rtspOff && portWatch.ports?.rtsp && (
				<p className="note note-good" role="status">
					<Icon name="check" size={18} />
					<span>Live video is on. You'll be able to watch the camera on look4's Live page.</span>
				</p>
			)}
			{blankPassword && <NeedsPasswordHelp />}
			<div className="detail-fields">
				{!existing && (
					<div className="field-row">
						<NameField id="rl-name" value={name} onChange={setName} taken={takenNames} />
						<label className="field" htmlFor="rl-lookback">
							<span className="field-label">Start with clips from</span>
							<select id="rl-lookback" value={lookback} onChange={e => setLookback(Number(e.target.value))} aria-describedby="rl-lookback-help">
								{LOOKBACK.map(o => (
									<option key={o.value} value={o.value}>
										{o.label}
									</option>
								))}
							</select>
							<span className="field-help" id="rl-lookback-help">
								When clips come from the camera's SD card, what's already on it. New clips arrive within a minute either way.
							</span>
						</label>
					</div>
				)}
				<div className="field">
					<span className="field-label">Video quality</span>
					<ChoiceCards
						name="rl-stream"
						label="Video quality"
						value={stream}
						onChange={setStream}
						options={[
							{
								value: "main",
								title: "Full quality",
								badge: "Recommended",
								body: "The camera's sharpest recording (its “main stream”). Best for telling a cardinal from a house finch. Bigger files."
							},
							{
								value: "sub",
								title: "Smaller and faster",
								body: "The camera's lighter copy (its “sub stream”). Fine for “is that a squirrel?”, and easier on a slow network."
							}
						]}
					/>
				</div>
			</div>
			{saveError && <ErrorNote message={saveError} />}
			<FlowActions onBack={() => setPhase("login")}>
				<button type="submit" className="btn btn-primary" disabled={saving || (!existing && takenNames.includes(name))}>
					{saving && <span className="spinner" aria-hidden="true" />}
					{existing ? "Save changes" : "Save and start collecting clips"}
				</button>
			</FlowActions>
		</form>
	)
}

/** Accepts "192.168.1.31", " 192.168.1.31 " or a pasted "https://192.168.1.31/" and returns the bare host. */
const cleanHost = (s: string) =>
	s
		.trim()
		.replace(/^[a-z]+:\/\//i, "")
		.replace(/[/?#].*$/, "")

const ScanResults = ({
	scan,
	onPick,
	onRescan,
	onType,
	canUseRtsp
}: {
	scan: { busy: boolean; result: DiscoverResponse | null; error: string | null }
	onPick: (c: DiscoveredCamera) => void
	onRescan: () => void
	onType: () => void
	canUseRtsp: boolean
}) => {
	if (scan.busy || (!scan.result && !scan.error))
		return (
			<div className="scanning" role="status">
				<span className="scanning-art">
					<span className="scanning-ring" />
					<span className="scanning-ring scanning-ring-2" />
					<Mascot pose="looking" size={136} />
				</span>
				<p className="scanning-title">Looking around your network…</p>
				<p className="muted">This takes a few seconds.</p>
			</div>
		)
	if (scan.error && !scan.result) return <ErrorNote message={scan.error} onRetry={onRescan} />
	const r = scan.result!
	const cams = r.cameras.filter(c => c.vendor === "reolink" || canUseRtsp || c.configuredAs)
	return (
		<div className="scan-results">
			{r.note && (
				<p className="note">
					<Icon name="alert" size={18} />
					<span>{r.note}</span>
				</p>
			)}
			{cams.length === 0 ? (
				<div className="scan-empty">
					<Mascot pose="puzzled" size={88} />
					<div>
						<p className="scan-empty-title">No cameras turned up</p>
						<p className="muted">
							Check that the camera is powered and that this computer is on the same home network (not a guest Wi-Fi or
							VPN). Or type its address if you know it.
						</p>
					</div>
				</div>
			) : (
				<>
					<div className="scan-found">
						<Mascot pose="found" size={76} />
						<div>
							<p className="scan-found-title">{foundTitle(cams)}</p>
							<p className="muted fine">
								On {r.scannedSubnets.join(", ") || "your network"}{others(cams)}. Pick yours:
							</p>
						</div>
					</div>
					<ul className="cams">
						{cams.map(c => (
							<li key={c.host}>
								<button type="button" className="cam" onClick={() => onPick(c)} disabled={!!c.configuredAs}>
									<span className="cam-icon">
										<Icon name="camera" size={22} />
									</span>
									<span className="cam-text">
										<span className="cam-title">{c.vendor === "reolink" ? "Reolink camera" : "Camera or other device"}</span>
										<span className="cam-host" title={c.mac ? `Hardware address ${c.mac}` : undefined}>
											{c.host}
										</span>
									</span>
									<CamBadge c={c} />
									{!c.configuredAs && <Icon name="chevronDown" size={18} className="cam-go" />}
								</button>
							</li>
						))}
					</ul>
				</>
			)}
			<div className="scan-more">
				<button type="button" className="btn btn-ghost btn-sm" onClick={onRescan}>
					<Icon name="refresh" size={16} />
					Look again
				</button>
				<button type="button" className="btn btn-ghost btn-sm" onClick={onType}>
					<Icon name="pencil" size={16} />
					Type the address instead
				</button>
			</div>
		</div>
	)
}

/** "Found 2 Reolink cameras!": the wizard's happiest moment gets a proper headline. */
const foundTitle = (cams: DiscoveredCamera[]) => {
	const reolinks = cams.filter(c => c.vendor === "reolink").length
	if (reolinks) return reolinks === 1 ? "Found a Reolink camera!" : `Found ${reolinks} Reolink cameras!`
	return cams.length === 1 ? "Found a camera" : `Found ${cams.length} cameras`
}

/** The others found alongside the Reolinks, as a clause: "plus 1 other device". */
const others = (cams: DiscoveredCamera[]) => {
	const n = cams.filter(c => c.vendor !== "reolink").length
	return n && n < cams.length ? `, plus ${n === 1 ? "1 other device" : `${n} other devices`}` : ""
}

const CamBadge = ({ c }: { c: DiscoveredCamera }) => {
	if (c.configuredAs) return <span className="badge badge-soft">Already added as {c.configuredAs}</span>
	if (c.vendor === "reolink" && (c.ports.https || c.ports.http)) return <span className="badge badge-good">Ready to connect</span>
	if (c.vendor === "reolink") return <span className="badge badge-warn">Needs one setting changed</span>
	if (c.ports.rtsp) return <span className="badge badge-soft">Other brand · connect by stream</span>
	return <span className="badge badge-soft">Unknown device</span>
}
