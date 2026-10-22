import { useState } from "react"
import { Icon } from "../components/Icon.tsx"
import { Switch } from "../components/ui.tsx"
import { useFeedback } from "../feedback.tsx"
import { releaseAfterClick, useShortcutLabel, withShortcut } from "../keyboard.tsx"
import { RailSection } from "./Rail.tsx"
import type { Camera } from "./useCamera.ts"

// Home: the view look4 watches (the camera's guard point), and the camera going back there by itself.

const RETURN_AFTER_S = [60, 120, 180, 300]

const fmtWait = (s: number) => (s % 60 === 0 ? `${s / 60} min` : `${s} s`)

/** The choices for "return after", within what the camera allows, plus whatever it is set to now. */
export const returnChoices = (current: number, minS: number, maxS: number) => {
	const all = RETURN_AFTER_S.filter(s => s >= minS && s <= maxS)
	if (!all.includes(current)) all.push(current)
	return all.sort((a, b) => a - b)
}

export const HomeSection = ({ camera }: { camera: Camera }) => {
	const { confirm } = useFeedback()
	const g = camera.controls!.ptz!.guard!
	const homeKey = useShortcutLabel("cam.home")
	const [busy, setBusy] = useState(false)
	const change = async (body: { saveHere?: boolean; autoReturn?: boolean; timeoutS?: number }) => {
		setBusy(true)
		await camera.setting({ setting: "home", ...body })
		setBusy(false)
	}
	return (
		<RailSection title="Home" className="rail-home">
			<p className="rail-note">The detection zone assumes the camera points at the feeder.</p>
			<div className="rail-btns">
				<button type="button" className="btn btn-sm btn-ghost" disabled={!g.set} title={g.set ? withShortcut("Back home", homeKey) : "No Home yet"} onClick={() => void camera.home()}>
					<Icon name="home" size={16} />
					Back home
				</button>
				<button
					type="button"
					className="btn btn-sm btn-ghost"
					disabled={busy}
					onClick={async () => {
						const ok = await confirm({
							title: "Make this view Home?",
							body: "Back home and the automatic return will bring the camera here.",
							confirmLabel: "Make it Home"
						})
						if (ok) await change({ saveHere: true })
					}}
				>
					<Icon name="pin" size={16} />
					Make this view Home
				</button>
			</div>
			<div className="rail-row">
				<span className="rail-row-label">Return home by itself</span>
				<Switch checked={g.autoReturn} label="Return home by itself" disabled={!g.set || busy} onChange={on => void change({ autoReturn: on })} />
			</div>
			{g.autoReturn && (
				<div className="rail-row is-end">
					<div className="segmented rail-seg" role="radiogroup" aria-label="Return home after">
						{returnChoices(g.timeoutS, g.minS, g.maxS).map(s => (
							<button
								key={s}
								type="button"
								role="radio"
								className="segment"
								aria-checked={g.timeoutS === s}
								disabled={busy}
								onClick={e => {
									releaseAfterClick(e)
									if (g.timeoutS !== s) void change({ timeoutS: s })
								}}
							>
								{fmtWait(s)}
							</button>
						))}
					</div>
				</div>
			)}
		</RailSection>
	)
}
