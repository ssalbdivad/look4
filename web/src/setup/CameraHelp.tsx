import { type ReactNode, useEffect, useRef, useState } from "react"
import { api } from "../api.ts"
import type { CameraTestResult, DevicePorts } from "../../../src/api-types.ts"
import { Icon } from "../components/Icon.tsx"
import { AdvancedScreen, LiveViewScreen, NetworkScreen, ServerScreen, SettingsScreen, UserScreen } from "./ReolinkAppMock.tsx"
import { HelpMascot, HelpTitle, Tips } from "./ui.tsx"

// What to do when "Test connection" doesn't work, one panel per CameraProblem. Written for someone
// who has only ever used the Reolink phone app.

export const RECHECK_SECONDS = 5

/**
 * The star of setup: newer Reolink cameras ship with their web and video servers off, so look4 can see
 * the camera but can't talk to it. Five drawn phone screens walk through switching them on, and look4
 * keeps re-checking on its own (the check only knocks on the doors; it does not try a password until
 * HTTPS or HTTP answers).
 */
export const HttpDisabledHelp = ({
	host,
	cameraName,
	ports,
	testing,
	nextCheckIn,
	checks,
	onCheck
}: {
	host: string
	cameraName?: string
	/** What the last check found, for the checklist. */
	ports?: DevicePorts
	testing: boolean
	/** Seconds until the automatic re-check, or null while one is running. */
	nextCheckIn: number | null
	checks: number
	onCheck: () => void
}) => (
	<div className="help help-warn">
		<div className="help-head">
			<span className="help-icon">
				<Icon name="gear" size={22} />
			</span>
			<div>
				<HelpTitle>Found it! It just needs a couple of settings switched on.</HelpTitle>
				<p>
					Your camera is answering at <strong>{host}</strong>, but the “doors” look4 uses are closed. New Reolink cameras
					ship that way. Opening them doesn't change your recordings or how the Reolink app works.
				</p>
			</div>
		</div>
		{ports && <PortChecklist ports={ports} />}
		<ServerSwitchSteps cameraName={cameraName} on={["HTTPS", "RTSP"]} last={<>Switch on <strong>HTTPS</strong> (or <strong>HTTP</strong>) and <strong>RTSP</strong>, then tap <strong>Save</strong>.</>} />
		<HttpsNote />
		<Recheck what="the camera's settings" testing={testing} nextCheckIn={nextCheckIn} checks={checks} onCheck={onCheck} />
	</div>
)

/** "Which should I pick?" for HTTPS vs HTTP, in one breath. */
const HttpsNote = () => (
	<p className="fine muted help-aside">
		<strong>HTTPS or HTTP?</strong> Either works. HTTPS is the safer choice, and look4 is fine with the camera's own
		security certificate (your browser may call it “not trusted”; that's normal for cameras). Plain HTTP is also
		OK on a home network. Using the Reolink program on a computer? The same switches are under the camera's{" "}
		<strong>Settings → Network → Advanced → Server Settings</strong>.
	</p>
)

/** The five phone screens from the live view to the Server Settings switches. */
export const ServerSwitchSteps = ({
	cameraName,
	on,
	last
}: {
	cameraName?: string
	on: Array<"HTTPS" | "HTTP" | "RTSP">
	last: ReactNode
}) => (
	<ol className="phone-steps">
		<li>
			<LiveViewScreen name={cameraName} />
			<p>
				<span className="step-n">1</span>
				Open the <strong>Reolink app</strong> on your phone, tap this camera, then tap the <strong>gear</strong>.
			</p>
		</li>
		<li>
			<SettingsScreen />
			<p>
				<span className="step-n">2</span>
				Tap <strong>Network</strong>.
			</p>
		</li>
		<li>
			<NetworkScreen />
			<p>
				<span className="step-n">3</span>
				Tap <strong>Advanced</strong>.
			</p>
		</li>
		<li>
			<AdvancedScreen />
			<p>
				<span className="step-n">4</span>
				Tap <strong>Server Settings</strong>. Some versions call it <strong>Port Settings</strong>.
			</p>
		</li>
		<li>
			<ServerScreen on={on} />
			<p>
				<span className="step-n">5</span>
				{last}
			</p>
		</li>
	</ol>
)

/** "Keep this page open, look4 checks again by itself", with a manual Check again. */
const Recheck = ({
	what,
	testing,
	nextCheckIn,
	checks,
	onCheck
}: {
	what: string
	testing: boolean
	nextCheckIn: number | null
	checks: number
	onCheck: () => void
}) => (
	<div className="recheck" role="status" aria-live="polite">
		<span className="recheck-radar" aria-hidden="true" />
		<span className="recheck-text">
			{testing ? (
				<>Checking the camera now…</>
			) : nextCheckIn !== null ? (
				<>
					<strong>Keep this page open.</strong> look4 looks at {what} again by itself in {nextCheckIn} s, and moves on
					the moment they're on.
				</>
			) : (
				<>When you've saved the change in the app, check again.</>
			)}
			{checks > 1 && <span className="muted"> Checked {checks} times.</span>}
		</span>
		<button type="button" className="btn btn-ghost btn-sm" onClick={onCheck} disabled={testing}>
			{testing ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" size={16} />}
			Check again
		</button>
	</div>
)

/**
 * Which of the camera's doors answer, in words: found at all (the app port), web access (HTTPS, HTTP:
 * one is enough), live video (RTSP). Port numbers stay in the tooltips.
 */
export const PortChecklist = ({ ports }: { ports: DevicePorts }) => {
	const web = ports.https || ports.http
	const rows: Array<{ ok: boolean; title: string; body: string; port: string }> = [
		{
			ok: ports.reolinkApp || web || ports.rtsp,
			title: "Camera found on your network",
			body: ports.reolinkApp ? "It answers the Reolink app." : "Something answers at this address.",
			port: "port 9000"
		},
		{
			ok: web,
			title: "Web access (HTTPS or HTTP)",
			body: ports.https && ports.http ? "Both are on." : ports.https ? "HTTPS is on." : ports.http ? "HTTP is on." : "Off. look4 needs one of them to sign in and fetch clips.",
			port: "ports 443 / 80"
		},
		{
			ok: ports.rtsp,
			title: "Live video (RTSP)",
			body: ports.rtsp ? "On." : "Off. Needed to watch the camera live in look4.",
			port: "port 554"
		}
	]
	return (
		<ul className="port-list" aria-label="What look4 can reach on the camera">
			{rows.map(r => (
				<li key={r.title} className={r.ok ? "is-ok" : "is-off"} title={r.port}>
					<span className="port-mark">
						<Icon name={r.ok ? "check" : "x"} size={14} />
					</span>
					<span>
						<strong>{r.title}</strong>
						<span className="muted"> {r.body}</span>
					</span>
				</li>
			))}
		</ul>
	)
}

/**
 * Live video needs RTSP; recordings don't. Shown after a successful sign-in when RTSP is off, and on the
 * Live page. Checks only knock on the port, so repeating them is harmless.
 */
export const RtspOffHelp = ({
	host,
	cameraName,
	ports,
	checking,
	nextCheckIn,
	checks,
	onCheck,
	collapsed,
	children
}: {
	host: string
	cameraName?: string
	ports?: DevicePorts
	/** Fold the phone screens behind "Show me how" (the Live page's side column has little room). */
	collapsed?: boolean
	checking: boolean
	nextCheckIn: number | null
	checks: number
	onCheck: () => void
	children?: ReactNode
}) => (
	<div className="help help-warn">
		<div className="help-head">
			<span className="help-icon">
				<Icon name="video" size={22} />
			</span>
			<div>
				<HelpTitle>One more switch for live video</HelpTitle>
				<p>
					look4 can fetch clips from the camera at <strong>{host}</strong>, but its live video (called <strong>RTSP</strong>)
					is switched off. Turn it on to watch the camera live in look4, and so look4 can record it (steadier than the SD card). Until then, the Live page shows a fresh picture
					every second.
				</p>
			</div>
		</div>
		{ports && <PortChecklist ports={ports} />}
		{collapsed ? (
			<details className="help-steps">
				<summary>Show me how (five taps in the Reolink app)</summary>
				<ServerSwitchSteps cameraName={cameraName} on={["RTSP"]} last={<>Switch <strong>RTSP</strong> on, then tap <strong>Save</strong>.</>} />
			</details>
		) : (
			<ServerSwitchSteps cameraName={cameraName} on={["RTSP"]} last={<>Switch <strong>RTSP</strong> on, then tap <strong>Save</strong>.</>} />
		)}
		<Recheck what="the camera" testing={checking} nextCheckIn={nextCheckIn} checks={checks} onCheck={onCheck} />
		{children}
	</div>
)

/** Reolink's RTSP refuses every login while the camera has no password, so live video needs one set first. */
export const NeedsPasswordHelp = ({ children }: { children?: ReactNode }) => (
	<div className="help help-warn">
		<div className="help-head">
			<span className="help-icon">
				<Icon name="video" size={22} />
			</span>
			<div>
				<HelpTitle>Live video needs a camera password</HelpTitle>
				<p>
					Reolink cameras only share live video once the camera has a password. Yours has none yet, so look4 can fetch
					clips but not stream. Setting one takes a minute:
				</p>
			</div>
		</div>
		<ol className="phone-steps phone-steps-short">
			<li>
				<LiveViewScreen />
				<p>
					<span className="step-n">1</span>
					In the <strong>Reolink app</strong>, tap this camera, then the <strong>gear</strong>.
				</p>
			</li>
			<li>
				<UserScreen />
				<p>
					<span className="step-n">2</span>
					Tap <strong>Advanced → User Management</strong> (some versions: <strong>Device Password</strong>), pick{" "}
					<strong>admin</strong> and set a password. Write it down.
				</p>
			</li>
		</ol>
		<p className="fine muted help-aside">
			Then type the same password in look4 (Settings → Sources → Edit). The Reolink app will ask for it once too.
		</p>
		{children}
	</div>
)

export const BadCredentialsHelp = ({ attemptsLeft }: { attemptsLeft?: number }) => (
	<div className="help help-bad" role="alert">
		<div className="help-head">
			<HelpMascot pose="puzzled" />
			<div>
				<HelpTitle>The camera didn't accept that username or password</HelpTitle>
				<p>
					look4 won't try again by itself. Double-check before you press Try again: after too many wrong tries, Reolink
					cameras lock sign-ins for a while.
				</p>
				{attemptsLeft !== undefined && (
					<p className={attemptsLeft <= 3 ? "attempts is-low" : "attempts"}>
						<Icon name="alert" size={16} />
						<span>
							The camera allows <strong>{attemptsLeft === 0 ? "no more" : attemptsLeft} wrong {attemptsLeft === 1 ? "try" : "tries"}</strong>{" "}
							before it locks.{attemptsLeft <= 3 && " Look the password up in the Reolink app first."}
						</span>
					</p>
				)}
			</div>
		</div>
		<Tips
			items={[
				<>
					<strong>It's the camera's own password</strong>, the one the Reolink app asked for when you first added the
					camera. It's not your Reolink cloud account or Wi-Fi password.
				</>,
				<>
					<strong>Never set a password?</strong> Reolink cameras come with the username <code>admin</code> and{" "}
					<em>no</em> password: leave the password box empty. (To watch live video in look4, you'll want to set one
					later; Reolink only streams with a password.)
				</>,
				<>
					<strong>Forgot it?</strong> In the Reolink app, open the camera's <strong>gear → Advanced → User Management</strong>{" "}
					(on some versions <strong>Device Password</strong>) to set a new one. As a last resort, holding the camera's reset
					button for about 10 seconds restores factory settings, including no password, but also erases its other
					settings.
				</>
			]}
		/>
	</div>
)

/** Reolink blocks logins for a few minutes after repeated failures; the Test button waits with it. */
export const LockedOutHelp = ({ detail, waitLeft }: { detail: string; waitLeft: number }) => (
	<div className="help help-warn" role="alert">
		<div className="help-head">
			<HelpMascot pose="sleepy" />
			<div>
				<HelpTitle>The camera is taking a short break from sign-ins</HelpTitle>
				<p>{detail}</p>
				<p>
					It's a safety feature, and nothing is broken. Give it a few minutes, then try once more with the right
					password.
					{waitLeft > 0 && <strong> You can try again in {fmtWait(waitLeft)}.</strong>}
				</p>
			</div>
		</div>
	</div>
)

const fmtWait = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`

export const UnreachableHelp = ({
	host,
	testing,
	onRetry,
	onRescan,
	onChangeAddress
}: {
	host: string
	testing: boolean
	onRetry: () => void
	onRescan?: () => void
	onChangeAddress: () => void
}) => (
	<div className="help help-bad">
		<div className="help-head">
			<HelpMascot pose="puzzled" />
			<div>
				<HelpTitle>Nothing answered at {host}</HelpTitle>
				<p>look4 couldn't reach anything at that address. It's usually one of these:</p>
			</div>
		</div>
		<Tips
			items={[
				<>
					<strong>Is this computer on the same home network as the camera?</strong> A guest Wi-Fi, a phone hotspot or a
					VPN can hide the camera.
				</>,
				<>
					<strong>Is the camera on?</strong> If the Reolink app shows live video from it right now, it is.
				</>,
				<>
					<strong>Did its address change?</strong> Routers sometimes hand out new addresses after a power cut. The Reolink
					app shows the current one under the camera's <strong>gear → Network → Network information</strong>.
				</>
			]}
		/>
		<div className="help-actions">
			<button type="button" className="btn btn-ghost btn-sm" onClick={onRetry} disabled={testing}>
				{testing ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" size={16} />}
				Try again
			</button>
			{onRescan && (
				<button type="button" className="btn btn-ghost btn-sm" onClick={onRescan}>
					<Icon name="binoculars" size={16} />
					Look for my camera
				</button>
			)}
			<button type="button" className="btn btn-ghost btn-sm" onClick={onChangeAddress}>
				<Icon name="pencil" size={16} />
				Change the address
			</button>
		</div>
	</div>
)

export const NotReolinkHelp = ({ host, onUseRtsp, onChangeAddress }: { host: string; onUseRtsp?: () => void; onChangeAddress: () => void }) => (
	<div className="help help-warn">
		<div className="help-head">
			<HelpMascot pose="puzzled" />
			<div>
				<HelpTitle>That doesn't look like a Reolink camera</HelpTitle>
				<p>
					Something answered at <strong>{host}</strong>, but it isn't a Reolink camera. It may be your router or another
					device. If it's a camera from another brand, connect it with its stream address (RTSP) instead.
				</p>
			</div>
		</div>
		<div className="help-actions">
			{onUseRtsp && (
				<button type="button" className="btn btn-ghost btn-sm" onClick={onUseRtsp}>
					<Icon name="camera" size={16} />
					Connect it as another camera
				</button>
			)}
			<button type="button" className="btn btn-ghost btn-sm" onClick={onChangeAddress}>
				<Icon name="pencil" size={16} />
				Change the address
			</button>
		</div>
	</div>
)

export const UnknownHelp = ({ detail, testing, onRetry }: { detail: string; testing: boolean; onRetry: () => void }) => (
	<div className="help help-bad" role="alert">
		<div className="help-head">
			<HelpMascot pose="puzzled" />
			<div>
				<HelpTitle>Something unexpected happened</HelpTitle>
				<p>{detail}</p>
				<p className="muted">Trying again often works. If it keeps happening, restarting the camera from the Reolink app can help.</p>
			</div>
		</div>
		<div className="help-actions">
			<button type="button" className="btn btn-ghost btn-sm" onClick={onRetry} disabled={testing}>
				{testing ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" size={16} />}
				Try again
			</button>
		</div>
	</div>
)

/** Counts down to zero once a second; restarts whenever `from` or `key` changes. */
export const useCountdown = (from: number | null, key: unknown) => {
	const [left, setLeft] = useState(from ?? 0)
	useEffect(() => {
		if (from === null) return
		setLeft(from)
		const started = Date.now()
		const id = setInterval(() => {
			const l = Math.max(0, from - Math.floor((Date.now() - started) / 1000))
			setLeft(l)
			if (l === 0) clearInterval(id)
		}, 250)
		return () => clearInterval(id)
	}, [from, key])
	return left
}

/**
 * Re-probes a camera's ports every RECHECK_SECONDS while `active` and `done(ports)` is false. Probing
 * never signs in, so it cannot count toward the camera's lockout.
 */
export const usePortWatch = (host: string, active: boolean, done: (p: DevicePorts) => boolean) => {
	const [ports, setPorts] = useState<DevicePorts | null>(null)
	const [checking, setChecking] = useState(false)
	const [checks, setChecks] = useState(0)
	const finished = !!ports && done(ports)
	const waiting = active && !finished && !checking
	const nextCheckIn = useCountdown(waiting ? RECHECK_SECONDS : null, checks)
	const check = async () => {
		setChecking(true)
		try {
			setPorts((await api.probe(host)).ports)
		} catch {
			// a failed probe just waits for the next one
		} finally {
			setChecks(n => n + 1)
			setChecking(false)
		}
	}
	const latest = useRef(check)
	latest.current = check
	useEffect(() => {
		if (!waiting) return
		const id = setTimeout(() => latest.current(), RECHECK_SECONDS * 1000)
		return () => clearTimeout(id)
	}, [waiting, checks])
	return { ports, checking, checks, nextCheckIn: waiting ? nextCheckIn : null, check }
}

export const isLoginProblem = (r: CameraTestResult | null) => r?.problem === "bad-credentials" || r?.problem === "locked-out"
