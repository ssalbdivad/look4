import type { ReactNode } from "react"
import { Icon } from "../components/Icon.tsx"

// Little drawings of the Reolink phone app, one per step of "turn on HTTPS". They are pictures,
// not controls: everything is aria-hidden and the step text carries the instructions.

type Row = { label: string; sub?: string; hot?: boolean; toggle?: boolean }

const Phone = ({ title, back = true, gear, children }: { title: string; back?: boolean; gear?: boolean; children: ReactNode }) => (
	<div className="phone" aria-hidden="true">
		<div className="phone-notch" />
		<div className="phone-bar">
			<span className="phone-back">{back ? "‹" : ""}</span>
			<span className="phone-title">{title}</span>
			<span className={gear ? "phone-gear is-hot" : "phone-gear"}>{gear && <Icon name="gear" size={15} />}</span>
		</div>
		<div className="phone-body">{children}</div>
	</div>
)

const Rows = ({ rows }: { rows: Row[] }) => (
	<ul className="phone-rows">
		{rows.map(r => (
			<li key={r.label} className={r.hot ? "is-hot" : undefined}>
				<span className="phone-row-text">
					<span>{r.label}</span>
					{r.sub && <span className="phone-row-sub">{r.sub}</span>}
				</span>
				{r.toggle === undefined ? <span className="phone-chev">›</span> : <span className={r.toggle ? "phone-toggle is-on" : "phone-toggle"} />}
			</li>
		))}
	</ul>
)

export const LiveViewScreen = ({ name = "Backyard" }: { name?: string }) => (
	<Phone title={name} gear>
		<div className="phone-live">
			<span className="phone-live-tag">LIVE</span>
			<span className="phone-feeder" />
		</div>
		<div className="phone-tools">
			<span />
			<span />
			<span />
			<span />
		</div>
	</Phone>
)

export const SettingsScreen = () => (
	<Phone title="Settings">
		<Rows rows={[{ label: "Display" }, { label: "Audio" }, { label: "Network", hot: true }, { label: "Recording" }, { label: "Push notifications" }]} />
	</Phone>
)

export const NetworkScreen = () => (
	<Phone title="Network">
		<Rows rows={[{ label: "Network information" }, { label: "Wi-Fi" }, { label: "Advanced", hot: true }]} />
	</Phone>
)

export const AdvancedScreen = () => (
	<Phone title="Advanced">
		<Rows rows={[{ label: "Server Settings", sub: "or “Port Settings”", hot: true }, { label: "UPnP" }, { label: "DNS" }]} />
	</Phone>
)

type Server = "HTTPS" | "HTTP" | "RTSP"

/** The Server Settings screen: the switches in `on` are drawn on, and those in `hot` highlighted as the ones to flip. */
export const ServerScreen = ({ on = ["HTTPS", "RTSP"], hot = on }: { on?: Server[]; hot?: Server[] }) => (
	<Phone title="Server Settings">
		<Rows
			rows={[
				...(["HTTPS", "HTTP", "RTSP"] as const).map(label => ({ label, hot: hot.includes(label), toggle: on.includes(label) })),
				{ label: "ONVIF", toggle: false }
			]}
		/>
		<span className="phone-save is-hot">Save</span>
	</Phone>
)

export const UserScreen = () => (
	<Phone title="User Management">
		<Rows rows={[{ label: "admin", sub: "Administrator · no password", hot: true }, { label: "Add user" }]} />
	</Phone>
)
