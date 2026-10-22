import type { ReactNode } from "react"
import type { LiveSourceDto, LiveStream } from "../../../src/api-types.ts"
import type { PlayerState } from "../components/LivePlayer.tsx"
import { Icon } from "../components/Icon.tsx"
import { clock } from "./layout.ts"
import { type BadgeKind, LiveBadge } from "./Toolbar.tsx"

// What sits on the picture, and only while it applies: the camera is off its Home view, the picture is
// magnified, a recording is running, the stream is switching, Aim is on. Plus the centre states:
// connecting, the reason there's no picture, a failed stream. Never controls or explanations.

export type Notice = { id: number; text: string; tone: "good" | "bad" | "info"; action?: { label: string; run: () => void } }

const Chip = ({ children, tone, live }: { children: ReactNode; tone?: "rec" | "warn"; live?: boolean }) => (
	<div className={`lv-chip${tone ? ` is-${tone}` : ""}`} role={live ? "status" : undefined}>
		{children}
	</div>
)

// Not a countdown: the camera restarts its timer on every move, including ones made from its own app.
const roughWait = (s: number) => (s < 60 ? `${s} s` : `${s % 60 ? "~" : ""}${Math.round(s / 60)} min`)

export const StageChips = ({
	moved,
	returnAfterS,
	moving,
	onHome,
	zoom,
	onResetZoom,
	onZoomCamera,
	rec,
	switching,
	aiming,
	onStopAim,
	notice,
	badge,
	compact
}: {
	/** The camera is away from its Home view (and has one). */
	moved: boolean
	/** The camera goes home by itself this long after it last moved; null when it won't. */
	returnAfterS: number | null
	moving: boolean
	onHome: () => void
	/** Digital magnification; 1 = none. */
	zoom: number
	onResetZoom: () => void
	/** Null when the camera can't frame a box. */
	onZoomCamera: (() => void) | null
	rec: { phase: "starting" | "on" | "saving"; seconds: number } | null
	switching: LiveStream | null
	aiming: boolean
	onStopAim: () => void
	/** A message for where toasts can't be seen (full screen, the pop-out). */
	notice: Notice | null
	/** On a phone the LIVE badge sits on the picture, leaving the toolbar to the buttons. */
	badge?: BadgeKind | null
	compact?: boolean
}) => (
	<div className={`lv-chips${compact ? " is-compact" : ""}`}>
		<div className="lv-chips-tl">
			{badge && <LiveBadge kind={badge} />}
			{rec && (
				<Chip tone="rec" live>
					<span className="lv-rec-dot" aria-hidden="true" />
					{rec.phase === "starting" ? "Starting…" : rec.phase === "saving" ? "Saving…" : <>REC {clock(rec.seconds)}</>}
				</Chip>
			)}
			{switching && (
				<Chip live>
					<span className="spinner" aria-hidden="true" />
					Switching to {switching === "main" ? "Sharp" : "Quick"}…
				</Chip>
			)}
			{aiming && (
				<Chip live>
					<Icon name="aim" size={16} />
					Aiming
					<button type="button" className="lv-chip-btn" onClick={onStopAim}>
						Cancel
					</button>
				</Chip>
			)}
			{notice && (
				<Chip tone={notice.tone === "bad" ? "warn" : undefined} live>
					{notice.text}
					{notice.action && (
						<button type="button" className="lv-chip-btn" onClick={notice.action.run}>
							{notice.action.label}
						</button>
					)}
				</Chip>
			)}
		</div>
		<div className="lv-chips-tr">
			{(moved || moving) && (
				<Chip tone={moving ? undefined : "warn"} live>
					{moving ? (
						<>
							<span className="spinner" aria-hidden="true" />
							Moving…
						</>
					) : (
						<>
							{returnAfterS === null ? "Moved" : `Moved · ${compact ? "home" : "returns home"} after ${roughWait(returnAfterS)}`}
							<button type="button" className="lv-chip-btn" onClick={onHome}>
								<Icon name="home" size={15} />
								{returnAfterS === null || compact ? "Back home" : "Back home now"}
							</button>
						</>
					)}
				</Chip>
			)}
		</div>
		<div className="lv-chips-br">
			{zoom > 1.01 && (
				<Chip>
					<span className="lv-zoom-x">{zoom.toFixed(1)}×</span>
					<button type="button" className="lv-chip-btn" onClick={onResetZoom}>
						Reset
					</button>
					{onZoomCamera && (
						<button type="button" className="lv-chip-btn is-strong" onClick={onZoomCamera} title="Point and zoom the camera itself at what you see">
							<Icon name="aim" size={15} />
							Zoom camera here
						</button>
					)}
				</Chip>
			)}
		</div>
	</div>
)

/** The middle of the picture when there's nothing (yet) to see. */
export const StageOverlay = ({
	src,
	state,
	switching,
	onRetry,
	compact
}: {
	src: LiveSourceDto
	state: PlayerState
	/** The old picture is still showing: no connecting overlay. */
	switching: boolean
	onRetry: () => void
	compact?: boolean
}) => {
	if (!src.feed)
		return (
			<div className="lv-center is-scrim">
				<Icon name="video" size={compact ? 22 : 32} />
				<p>{compact ? "No live picture" : (src.detail ?? "This camera has no live picture right now.")}</p>
			</div>
		)
	if (state.phase === "connecting" && !switching)
		return (
			<div className="lv-center" role="status">
				<span className="lv-connecting">
					<span className="spinner" aria-hidden="true" />
					{compact ? "Connecting…" : "Connecting to the camera…"}
				</span>
			</div>
		)
	if (state.phase === "error")
		return (
			<div className="lv-center is-scrim" role="alert">
				<Icon name="alert" size={compact ? 22 : 30} />
				<p>{state.message}</p>
				{state.retrying && <p className="lv-connecting">Trying again by itself…</p>}
				<button type="button" className="btn btn-sm lv-retry" onClick={onRetry}>
					<Icon name="refresh" size={16} />
					Try again
				</button>
			</div>
		)
	return null
}
