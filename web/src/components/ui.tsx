import { type CSSProperties, type ReactNode, useState } from "react"
import type { ClipStatus, Stage } from "../../../src/types.ts"
import { fmtPct, retryText, STAGE_HELP, STAGE_LABEL } from "../format.ts"
import { Icon } from "./Icon.tsx"
import { Mascot, type MascotPose } from "./Mascot.tsx"

export const Skeleton = ({ className = "", style }: { className?: string; style?: CSSProperties }) => (
	<span className={`skeleton ${className}`} style={style} aria-hidden="true" />
)

export const EmptyState = ({
	title,
	children,
	mascot = "sleepy",
	actions
}: {
	title: string
	children?: ReactNode
	/**
	 * Sleepy when there's nothing yet, looking while something is on its way, puzzled when it's gone.
	 * Pages vary it (Lookouts thinks, Activity looks) so the eagle never becomes wallpaper.
	 */
	mascot?: MascotPose
	actions?: ReactNode
}) => (
	<div className="empty">
		<Mascot pose={mascot} size={128} className="empty-art" />
		<h2 className="empty-title">{title}</h2>
		{children && <div className="empty-body">{children}</div>}
		{actions && <div className="empty-actions">{actions}</div>}
	</div>
)

/** An inline problem (a form that didn't save): a short line and an optional retry. */
export const ErrorNote = ({ message, onRetry }: { message: string; onRetry?: () => void }) => (
	<div className="note note-bad" role="alert">
		<Icon name="alert" size={18} />
		<span>{message}</span>
		{onRetry && (
			<button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
				Try again
			</button>
		)}
	</div>
)

/**
 * A page that couldn't load: the puzzled eagle, what happened in plain words, a big "Try again", and
 * the raw error underneath for whoever needs it. `status` 0 means the server never answered.
 */
export const LoadError = ({
	message,
	status,
	onRetry,
	what = "this"
}: {
	message: string
	status: number | null
	onRetry: () => void
	/** "your sightings", "your lookouts"… */
	what?: string
}) => {
	const unreachable = !status
	return (
		<div className="empty empty-error" role="alert">
			<Mascot pose="puzzled" size={120} className="empty-art" />
			<h2 className="empty-title">{unreachable ? "look4 can't reach its server right now" : `Couldn't load ${what}`}</h2>
			<div className="empty-body">
				<p>
					{unreachable
						? "It may be restarting, or this computer lost its connection. Your clips are safe."
						: "Something went wrong on look4's side. It's usually a hiccup, so give it another go."}
				</p>
			</div>
			<div className="empty-actions">
				<button type="button" className="btn btn-primary" onClick={onRetry} data-autofocus>
					<Icon name="refresh" size={18} />
					Try again
				</button>
			</div>
			<p className="empty-raw fine muted">{message}</p>
		</div>
	)
}

export const Switch = ({
	checked,
	onChange,
	label,
	disabled
}: {
	checked: boolean
	onChange: (v: boolean) => void
	label: string
	disabled?: boolean
}) => (
	<button
		type="button"
		role="switch"
		aria-checked={checked}
		aria-label={label}
		disabled={disabled}
		className="switch"
		onClick={() => onChange(!checked)}
	>
		<span className="switch-knob" />
	</button>
)

/** Confidence as a bar, with the lookout's threshold marked so "close call" is visible at a glance. */
export const Meter = ({ value, threshold, label }: { value: number; threshold?: number; label?: string }) => {
	const pass = threshold === undefined || value >= threshold
	return (
		<div
			className={`meter ${pass ? "is-pass" : "is-fail"}`}
			role="meter"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={Math.round(value * 100)}
			aria-label={label ?? "Confidence"}
		>
			<span className="meter-fill" style={{ width: `${Math.max(2, value * 100)}%` }} />
			{threshold !== undefined && (
				<span className="meter-tick" style={{ left: `${threshold * 100}%` }} title={`Threshold ${fmtPct(threshold)}`} />
			)}
		</div>
	)
}

/** Points above a lookout's threshold that still count as a close call. */
export const CLOSE_CALL = 0.05

/**
 * The judge's confidence as a ring that fills up, for the corner of a photo. Its colour is relative to
 * the lookout's threshold, not fixed bands: a kept clip is green, and only one that scraped past
 * (within CLOSE_CALL) is amber. A kept match under the threshold can only be a detector-only call
 * (no judge), whose score is on another scale, so it stays neutral.
 */
export const ConfBadge = ({ value, threshold, className = "" }: { value: number; threshold?: number; className?: string }) => {
	const tone = threshold === undefined || value < threshold ? "plain" : value - threshold < CLOSE_CALL ? "close" : "good"
	return (
		<span
			className={`conf-badge is-${tone} ${className}`}
			style={{ "--p": Math.max(0.02, Math.min(1, value)) } as CSSProperties}
			title={
				tone === "plain"
					? "How sure look4 is"
					: tone === "close"
						? `A close call: this lookout keeps clips from ${fmtPct(threshold!)}`
						: `Comfortably past this lookout's ${fmtPct(threshold!)}`
			}
		>
			<span className="conf-ring" aria-hidden="true" />
			{fmtPct(value)}
			<span className="sr-only"> sure</span>
		</span>
	)
}

const STATUS_TEXT: Record<ClipStatus, string> = {
	pending: "In the queue",
	processing: "Taking a look",
	kept: "Kept",
	rejected: "Passed over",
	error: "Error"
}

/**
 * A clip's status in a word or two. `retry` (format.ts readRetry) turns a failed clip that look4 will
 * try again by itself into a calm amber "Retrying at 2:00 PM": red "Error" is only for clips that won't.
 */
export const StatusChip = ({ status, droppedAt, retry }: { status: ClipStatus; droppedAt?: Stage | null; retry?: { at: string | null } | null }) =>
	status === "error" && retry ? (
		<span className="chip chip-status is-retry" title="look4 tries this clip again by itself">
			<Icon name="history" size={12} />
			{retryText(retry)}
		</span>
	) : (
		<span className={`chip chip-status is-${status}`} title={droppedAt ? STAGE_HELP[droppedAt] : undefined}>
			{status === "processing" && <span className="spinner" aria-hidden="true" />}
			{status === "rejected" && droppedAt ? `${STAGE_LABEL[droppedAt]}` : STATUS_TEXT[status]}
		</span>
	)

/** An image that degrades to a calm placeholder when the file is missing or fails to load. */
export const Thumb = ({
	src,
	alt,
	className = "",
	eager
}: {
	src: string | null | undefined
	alt: string
	className?: string
	eager?: boolean
}) => {
	const [failed, setFailed] = useState<string | null>(null)
	const [loaded, setLoaded] = useState<string | null>(null)
	if (!src || failed === src)
		return (
			<span className={`thumb thumb-empty ${className}`} role="img" aria-label={alt}>
				<img src="/logo-mark.svg" alt="" />
			</span>
		)
	return (
		<span className={`thumb ${loaded === src ? "is-loaded" : ""} ${className}`}>
			<img
				src={src}
				alt={alt}
				loading={eager ? "eager" : "lazy"}
				decoding="async"
				onLoad={() => setLoaded(src)}
				onError={() => setFailed(src)}
			/>
		</span>
	)
}

export const PageHead = ({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) => (
	<header className="page-head">
		<div>
			<h1 tabIndex={-1} data-page-title>
				{title}
			</h1>
			{sub && <p className="page-sub">{sub}</p>}
		</div>
		{actions && <div className="page-actions">{actions}</div>}
	</header>
)

export const Dot = ({ tone, pulse }: { tone: "good" | "bad" | "warn" | "idle"; pulse?: boolean }) => (
	<span className={`dot dot-${tone}${pulse ? " is-pulse" : ""}`} aria-hidden="true" />
)

/** A range input whose track fills up to the thumb (the fill is a CSS variable the track reads). */
export const Range = ({
	value,
	min,
	max,
	step,
	onChange,
	label,
	valueText
}: {
	value: number
	min: number
	max: number
	step: number
	onChange: (v: number) => void
	label?: string
	valueText?: string
}) => (
	<input
		type="range"
		min={min}
		max={max}
		step={step}
		value={value}
		aria-label={label}
		aria-valuetext={valueText}
		style={{ "--fill": `${((value - min) / (max - min)) * 100}%` } as CSSProperties}
		onChange={e => onChange(Number(e.target.value))}
	/>
)
