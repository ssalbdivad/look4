import { type FormEvent, type ReactNode, useState } from "react"
import type { RtspTestResult, SourceDto } from "../../../src/api-types.ts"
import type { RtspSourceConfig } from "../../../src/config.ts"
import { api, errorMessage } from "../api.ts"
import { Icon } from "../components/Icon.tsx"
import { ErrorNote } from "../components/ui.tsx"
import { FlowActions, HelpMascot, HelpTitle, NameField, StepHead, SuccessCard, Tips } from "./ui.tsx"

const EXAMPLES = [
	{ brand: "Reolink", url: "rtsp://admin:PASSWORD@ADDRESS:554/h264Preview_01_main" },
	{ brand: "Hikvision", url: "rtsp://admin:PASSWORD@ADDRESS:554/Streaming/Channels/101" },
	{ brand: "Amcrest, Dahua", url: "rtsp://admin:PASSWORD@ADDRESS:554/cam/realmonitor?channel=1&subtype=0" },
	{ brand: "TP-Link Tapo", url: "rtsp://USERNAME:PASSWORD@ADDRESS:554/stream1" },
	{ brand: "Wyze (RTSP firmware)", url: "rtsp://USERNAME:PASSWORD@ADDRESS/live" }
]

const SEGMENTS = [
	{ value: 15, label: "15 seconds" },
	{ value: 30, label: "30 seconds" },
	{ value: 60, label: "1 minute" }
]

/**
 * Any IP camera by its RTSP address. "Test" grabs one frame through POST /api/setup/test-rtsp and shows
 * it before anything is saved, so a wrong address never becomes a broken source.
 */
export const RtspFlow = ({
	existing,
	initialHost,
	takenNames = [],
	onBack,
	onSaved,
	notice
}: {
	existing?: RtspSourceConfig
	initialHost?: string
	takenNames?: string[]
	onBack: () => void
	onSaved: (s: SourceDto) => void
	/** Shown under the heading, e.g. what is wrong with an existing source. */
	notice?: ReactNode
}) => {
	const [url, setUrl] = useState(initialHost ? `rtsp://admin:PASSWORD@${initialHost}:554/` : "")
	const [name, setName] = useState(existing?.name ?? "")
	const [segment, setSegment] = useState(existing?.segmentSeconds ?? 30)
	const [testing, setTesting] = useState(false)
	const [tested, setTested] = useState<{ url: string; result: RtspTestResult } | null>(null)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const trimmed = url.trim()
	const placeholders = /PASSWORD|ADDRESS|USERNAME/.test(url)
	// the same schemes the server accepts: some cameras share an HTTP (FLV/MJPEG) or RTMP stream instead
	const wellFormed = /^(rtsps?|rtmps?|https?):\/\/\S+$/i.test(trimmed)
	const valid = wellFormed && !placeholders
	// a result only counts for the address it was taken with
	const result = tested?.url === trimmed ? tested.result : null
	const nameClash = !existing && takenNames.includes(name)

	const test = async () => {
		if (!valid) return
		setTesting(true)
		setError(null)
		try {
			setTested({ url: trimmed, result: await api.testRtsp({ url: trimmed }) })
		} catch (err) {
			setError(errorMessage(err))
		} finally {
			setTesting(false)
		}
	}

	const save = async () => {
		setSaving(true)
		setError(null)
		try {
			onSaved(
				existing
					? await api.updateSource(existing.name, { url: trimmed })
					: await api.addSource({ type: "rtsp", name: name || undefined, url: trimmed, segmentSeconds: segment })
			)
		} catch (err) {
			setError(errorMessage(err))
		} finally {
			setSaving(false)
		}
	}

	const submit = (e: FormEvent) => {
		e.preventDefault()
		if (result?.ok) save()
		else test()
	}

	return (
		<form onSubmit={submit}>
			<StepHead eyebrow="Another camera" title={existing ? `New address for ${existing.name}` : "Connect any camera by its stream"}>
				<p>
					Most network cameras share live video through <strong>RTSP</strong>, a standard “stream address” that starts with{" "}
					<code>rtsp://</code>. look4 records that stream in short clips and checks each one.
				</p>
			</StepHead>
			{notice}
			<UrlField url={url} setUrl={setUrl} autoFocus />
			{placeholders && <p className="field-help is-warn">Replace the CAPITAL words with your camera's details.</p>}
			{trimmed && !wellFormed && (
				<p className="field-help is-warn">
					A stream address starts with <code>rtsp://</code> (or <code>http://</code> for some cameras).
				</p>
			)}
			{!result && (
				<details className="examples-box">
					<summary>Not sure of the address? How to find it, with examples by brand</summary>
					<Tips
						items={[
							<>
								<strong>Turn it on first.</strong> Many cameras keep their stream switched off. Look in the camera's app
								or web page for a setting called <strong>RTSP</strong> (sometimes under Network, Advanced or Port
								Settings) and switch it on.
							</>,
							<>
								<strong>Find the address.</strong> Search the camera's manual or app for “RTSP” or “stream URL”. It
								starts with <code>rtsp://</code>; paste the whole thing here.
							</>,
							<>
								<strong>Login included.</strong> Put the camera's username and password in the address, like{" "}
								<code>rtsp://admin:yourpassword@192.168.1.50:554/…</code>. Many cameras refuse to stream until they
								have a password.
							</>
						]}
					/>
					<p className="muted fine">
						Or tap an example to start from it, then put in your camera's details:
					</p>
					<ul className="url-examples">
						{EXAMPLES.map(x => (
							<li key={x.brand}>
								<button type="button" onClick={() => setUrl(initialHost ? x.url.replace("ADDRESS", initialHost) : x.url)}>
									<span className="url-brand">{x.brand}</span>
									<code>{x.url}</code>
								</button>
							</li>
						))}
					</ul>
				</details>
			)}
			{result?.ok && (
				<div className="stream-check">
					{result.preview && (
						<div className="stream-frame">
							<img src={result.preview} alt="A frame from the camera's stream" />
						</div>
					)}
					<SuccessCard title="That's the camera. look4 can record this stream.">
						{(result.width || result.codec) && (
							<dl className="facts facts-inline">
								{result.width && result.height && (
									<div>
										<dt>Picture</dt>
										<dd>
											{result.width} × {result.height}
										</dd>
									</div>
								)}
								{result.codec && (
									<div>
										<dt>Video format</dt>
										<dd>{result.codec.toUpperCase()}</dd>
									</div>
								)}
							</dl>
						)}
					</SuccessCard>
				</div>
			)}
			{result && !result.ok && (
				<div className="help help-bad stream-help" role="alert">
					<div className="help-head">
						<HelpMascot pose="puzzled" />
						<div>
							<HelpTitle>No picture from that address yet</HelpTitle>
							<p>{result.detail}</p>
						</div>
					</div>
					<Tips
						items={[
							<>Check the username and password in the address. They're the camera's own, not your Wi-Fi's.</>,
							<>Make sure the camera has RTSP switched on. Many cameras keep it off until you enable it in their app.</>,
							<>Compare the end of the address with your camera's manual: every brand uses a different path.</>
						]}
					/>
				</div>
			)}
			{!existing && (
				<div className="field-row">
					<NameField id="rt-name" value={name} onChange={setName} taken={takenNames} />
					<label className="field" htmlFor="rt-seg">
						<span className="field-label">Cut the stream into clips of</span>
						<select id="rt-seg" value={segment} onChange={e => setSegment(Number(e.target.value))}>
							{SEGMENTS.map(o => (
								<option key={o.value} value={o.value}>
									{o.label}
								</option>
							))}
						</select>
						<span className="field-help">Shorter clips show up sooner; 30 seconds suits a feeder.</span>
					</label>
				</div>
			)}
			{error && <ErrorNote message={error} />}
			<FlowActions onBack={onBack}>
				{result && !result.ok && (
					<button type="button" className="btn btn-ghost" onClick={save} disabled={saving || nameClash}>
						Save it anyway
					</button>
				)}
				{result?.ok ? (
					<button type="submit" className="btn btn-primary" disabled={saving || nameClash}>
						{saving && <span className="spinner" aria-hidden="true" />}
						{existing ? "Save the new address" : "Save and start recording"}
					</button>
				) : (
					<button type="submit" className="btn btn-primary" disabled={!valid || testing}>
						{testing ? <span className="spinner" aria-hidden="true" /> : <Icon name="sparkle" size={18} />}
						{testing ? "Grabbing a frame…" : result ? "Test again" : "Test the stream"}
					</button>
				)}
			</FlowActions>
		</form>
	)
}

const UrlField = ({ url, setUrl, autoFocus }: { url: string; setUrl: (s: string) => void; autoFocus?: boolean }) => (
	<label className="field" htmlFor="rt-url">
		<span className="field-label">Stream address</span>
		<input
			id="rt-url"
			value={url}
			onChange={e => setUrl(e.target.value)}
			placeholder="rtsp://admin:password@192.168.1.50:554/stream1"
			spellCheck={false}
			autoComplete="off"
			autoFocus={autoFocus}
			aria-describedby="rt-url-help"
		/>
		<span className="field-help" id="rt-url-help">
			It usually includes the camera's username and password. look4 keeps it in a private file on this computer and never
			shows it again.
		</span>
	</label>
)
