import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react"
import { Icon, type IconName } from "../components/Icon.tsx"
import { Mascot, type MascotPose } from "../components/Mascot.tsx"
import { humanize } from "../format.ts"

// Building blocks shared by the setup wizard and the Settings → Sources dialogs.

/** Heading level for flow screens: the wizard uses h1 (one screen = one page), dialogs use h3. */
export const FlowLevel = createContext<1 | 3>(1)

export const StepHead = ({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) => {
	const level = useContext(FlowLevel)
	const ref = useRef<HTMLHeadingElement>(null)
	// Each new screen moves focus to its heading so keyboard and screen-reader users start at the top.
	useEffect(() => {
		if (level === 1) ref.current?.focus({ preventScroll: true })
	}, [level, title])
	const H = level === 1 ? "h1" : "h3"
	return (
		<header className="step-head">
			{eyebrow && <p className="step-eyebrow">{eyebrow}</p>}
			<H ref={ref} tabIndex={-1} className="step-title" data-page-title={level === 1 ? true : undefined}>
				{title}
			</H>
			{children && <div className="step-lead">{children}</div>}
		</header>
	)
}

export const FlowActions = ({ onBack, backLabel = "Back", children }: { onBack?: () => void; backLabel?: string; children?: ReactNode }) => (
	<div className="flow-actions">
		{onBack && (
			<button type="button" className="btn btn-ghost" onClick={onBack}>
				<Icon name="arrowLeft" size={18} />
				{backLabel}
			</button>
		)}
		<span className="flow-actions-end">{children}</span>
	</div>
)

export type ChoiceOption<v extends string> = {
	value: v
	title: string
	body: ReactNode
	icon?: IconName
	badge?: string
}

/** Radio buttons drawn as cards: one decision, a sentence of explanation each. */
export const ChoiceCards = <v extends string>({
	name,
	value,
	onChange,
	options,
	label,
	columns = 2
}: {
	name: string
	value: v | null
	onChange: (v: v) => void
	options: ChoiceOption<v>[]
	label: string
	columns?: 1 | 2 | 4
}) => (
	<fieldset className={`choices choices-${columns}`}>
		<legend className="sr-only">{label}</legend>
		{options.map(o => (
			<label key={o.value} className={value === o.value ? "choice is-on" : "choice"}>
				<input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
				{o.icon && (
					<span className="choice-icon">
						<Icon name={o.icon} size={22} />
					</span>
				)}
				<span className="choice-text">
					<span className="choice-title">
						{o.title}
						{o.badge && <span className="chip chip-pick">{o.badge}</span>}
					</span>
					<span className="choice-body">{o.body}</span>
				</span>
				<span className="choice-tick" aria-hidden="true">
					<Icon name="check" size={14} />
				</span>
			</label>
		))}
	</fieldset>
)

/** A password box with a show/hide eye, so people can check what they typed before the camera counts a wrong try. */
export const PasswordInput = ({
	value,
	onChange,
	id,
	placeholder,
	autoFocus,
	describedBy
}: {
	value: string
	onChange: (v: string) => void
	id: string
	placeholder?: string
	autoFocus?: boolean
	describedBy?: string
}) => {
	const [shown, setShown] = useState(false)
	return (
		<span className="pw">
			<input
				id={id}
				type={shown ? "text" : "password"}
				value={value}
				onChange={e => onChange(e.target.value)}
				placeholder={placeholder}
				autoComplete="off"
				spellCheck={false}
				autoFocus={autoFocus}
				aria-describedby={describedBy}
			/>
			<button type="button" className="icon-btn pw-eye" aria-label={shown ? "Hide password" : "Show password"} aria-pressed={shown} onClick={() => setShown(s => !s)}>
				<Icon name="eye" size={18} />
			</button>
		</span>
	)
}

/** look4 source names: lowercase letters, numbers and dashes. Typing "Front Porch" becomes "front-porch". */
export const toSourceName = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+/, "")
		.replace(/-{2,}/g, "-")
		.slice(0, 32)

/**
 * The source's name, typed the way people say it ("Front porch"); look4 stores the slug
 * ("front-porch"), so `value`/`onChange` are slugs and the field keeps its own words. A name set from
 * outside (the camera's own, after a test) shows in humanized form.
 */
export const NameField = ({ value, onChange, id, taken }: { value: string; onChange: (v: string) => void; id: string; taken?: string[] }) => {
	const [text, setText] = useState(() => humanize(value))
	useEffect(() => {
		if (toSourceName(text) !== value) setText(value ? humanize(value) : "")
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [value])
	const slug = value.replace(/-+$/, "")
	const clash = taken?.includes(slug)
	return (
		<label className="field" htmlFor={id}>
			<span className="field-label">Name</span>
			<input
				id={id}
				value={text}
				onChange={e => {
					setText(e.target.value)
					onChange(toSourceName(e.target.value))
				}}
				spellCheck={false}
				aria-describedby={`${id}-help`}
			/>
			<span className={clash ? "field-help is-bad" : "field-help"} id={`${id}-help`}>
				{clash ? "You already have a source with this name. Pick another." : "What look4 calls it on sightings, like “Backyard”."}
			</span>
		</label>
	)
}

/** A help panel's title: one level below the screen's heading (h2 in the wizard, h4 in a dialog). */
export const HelpTitle = ({ children }: { children: ReactNode }) => {
	const H = useContext(FlowLevel) === 1 ? "h2" : "h4"
	return <H className="help-title">{children}</H>
}

/** A "something worked" card: the eagle, delighted, with a tick. */
export const SuccessCard = ({ title, children }: { title: string; children?: ReactNode }) => (
	<div className="success-card" role="status">
		<span className="success-art">
			<Mascot pose="found" size={72} />
			<span className="success-tick">
				<Icon name="check" size={14} />
			</span>
		</span>
		<div>
			<p className="success-title">{title}</p>
			{children}
		</div>
	</div>
)

/** The eagle in a help panel's corner: puzzled by a problem, sleepy while a camera makes us wait. */
export const HelpMascot = ({ pose }: { pose: MascotPose }) => (
	<span className="help-icon help-mascot">
		<Mascot pose={pose} size={64} />
	</span>
)

/** A lettered tip list for the "something went wrong" panels. */
export const Tips = ({ items }: { items: ReactNode[] }) => (
	<ol className="tips">
		{items.map((t, i) => (
			<li key={i}>
				<span className="step-n">{i + 1}</span>
				<div>{t}</div>
			</li>
		))}
	</ol>
)
