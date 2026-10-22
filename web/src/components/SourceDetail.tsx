import { Icon } from "./Icon.tsx"

// A source's status detail is one line of " · "-joined facts from the adapter (src/sources/reolink.ts).
// Two of them deserve more than grey text: a camera clock that is off (its clips land under the wrong
// time) and recordings waiting for another download.

const CLOCK = /^camera clock is (\d+) min (behind|ahead of) this computer/
const RETRY = /^(\d+) recordings? to retry: (.*)$/s
const DISK = /^disk nearly full: ([\d.]+ GB) free/

/** What kind of trouble a source's detail describes, so "Fix it" can point at the right thing. */
export const sourceProblem = (detail: string): "disk" | "login" | null =>
	DISK.test(detail) ? "disk" : /turned down look4's sign-in/.test(detail) ? "login" : null

/** Words for "What's wrong", in terms of what the person can do about it. */
export const whatsWrong = (detail: string) => {
	const disk = DISK.exec(detail)
	if (disk)
		return `This isn't the camera: the disk look4 saves clips to has only ${disk[1]} free, so it paused pulling clips. Free up some space, or lower “Keep at least this much disk free” under Retention, and it picks up where it left off.`
	return detail
}

export const SourceDetail = ({ detail, className = "" }: { detail: string; className?: string }) => {
	const plain: string[] = []
	const notes: { tone: "warn" | "soft"; icon: "clock" | "history"; text: string; title?: string }[] = []
	for (const part of detail.split(" · ")) {
		const clock = CLOCK.exec(part)
		const retry = RETRY.exec(part)
		if (clock)
			notes.push({
				tone: "warn",
				icon: "clock",
				text: `Camera clock is ${clock[1]} min ${clock[2]} this computer, so clip times are off. Check its time zone and daylight saving in the Reolink app.`
			})
		else if (retry)
			notes.push({ tone: "soft", icon: "history", text: `${retry[1]} ${retry[1] === "1" ? "recording" : "recordings"} to fetch again`, title: retry[2] })
		else plain.push(part)
	}
	return (
		<span className={`src-detail-wrap ${className}`.trim()}>
			{plain.length > 0 && <span>{plain.join(" · ")}</span>}
			{notes.map(n => (
				<span key={n.text} className={`src-note is-${n.tone}`} title={n.title}>
					<Icon name={n.icon} size={14} />
					<span>{n.text}</span>
				</span>
			))}
		</span>
	)
}
