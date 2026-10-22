// Numbers and times formatted for people, not machines.

import type { StatsResponse } from "../../src/api-types.ts"
import { canonicalModel } from "../../src/pricing.ts"

export const fmtCost = (usd: number) => {
	if (usd <= 0) return "$0.00"
	if (usd < 0.01) return "<$0.01"
	if (usd < 100) return `$${usd.toFixed(2)}`
	return `$${Math.round(usd).toLocaleString()}`
}

/** Sub-cent amounts with enough digits to compare ("$0.0021"); a feeder's daily spend often lives there. */
export const fmtCostExact = (usd: number) => (usd > 0 && usd < 0.01 ? `$${usd.toPrecision(2)}` : fmtCost(usd))

export const fmtPct = (x: number) => `${Math.round(x * 100)}%`

export const fmtCount = (n: number) => n.toLocaleString()

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const startOfDay = (t: number) => {
	const d = new Date(t)
	d.setHours(0, 0, 0, 0)
	return d.getTime()
}

/** Whole local calendar days between two instants (0 = same day). */
const daysBetween = (a: number, b: number) => Math.round((startOfDay(b) - startOfDay(a)) / DAY)

export const fmtTime = (iso: string) =>
	new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** "Mon Oct 12", plus the year when it is not this year. */
export const fmtDay = (iso: string, now = Date.now()) => {
	const d = new Date(iso)
	const base = `${WEEKDAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`
	return d.getFullYear() === new Date(now).getFullYear() ? base : `${base}, ${d.getFullYear()}`
}

/** Section heading for a day: "Today", "Yesterday", "Mon Oct 12". */
export const dayLabel = (iso: string, now = Date.now()) => {
	const days = daysBetween(new Date(iso).getTime(), now)
	if (days === 0) return "Today"
	if (days === 1) return "Yesterday"
	return fmtDay(iso, now)
}

export const dayKey = (iso: string) => {
	const d = new Date(iso)
	return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

export const fmtRelative = (iso: string | null, now = Date.now()) => {
	if (!iso) return "never"
	const t = new Date(iso).getTime()
	const diff = now - t
	if (diff < -MIN) return `in ${fmtSpan(-diff)}`
	if (diff < 45_000) return "just now"
	if (diff < HOUR) return `${Math.round(diff / MIN)}m ago`
	if (diff < 12 * HOUR || daysBetween(t, now) === 0) return `${Math.round(diff / HOUR)}h ago`
	const days = daysBetween(t, now)
	if (days === 1) return `yesterday ${fmtTime(iso)}`
	if (days < 7) return `${days} days ago`
	return fmtDay(iso, now)
}

const fmtSpan = (ms: number) => {
	if (ms < HOUR) return `${Math.max(1, Math.round(ms / MIN))}m`
	if (ms < DAY) return `${Math.round(ms / HOUR)}h`
	return `${Math.round(ms / DAY)}d`
}

/** "When" for a clip: "3:12 PM" today, "Yesterday 3:12 PM", "Mon Oct 12, 3:12 PM". */
export const fmtWhen = (iso: string, now = Date.now()) => {
	const label = dayLabel(iso, now)
	return label === "Today" ? fmtTime(iso) : `${label}, ${fmtTime(iso)}`
}

export const fmtDuration = (s: number | null) => {
	if (s === null || !Number.isFinite(s)) return "—"
	const total = Math.round(s)
	if (total < 60) return `${total}s`
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

export const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`)

export const fmtBytes = (n: number) => {
	if (n < 1024) return `${n} B`
	const units = ["KB", "MB", "GB", "TB"]
	let v = n / 1024
	let i = 0
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024
		i++
	}
	return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

export const fmtTokens = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`)

export const STAGE_LABEL: Record<string, string> = {
	probe: "Unreadable",
	motion: "No motion",
	detect: "Detector",
	judge: "Spotter"
}

export const STAGE_HELP: Record<string, string> = {
	probe: "ffmpeg could not read the file",
	motion: "nothing moved enough in the zone",
	detect: "the detector found none of the lookout's nouns",
	judge: "the spotter said it was not a match"
}

export const plural = (n: number, one: string, many = `${one}s`) => `${fmtCount(n)} ${n === 1 ? one : many}`

/** The clip's reason, unless it only repeats its stage chip ("No motion" / "no motion"): then the stage's explanation. */
export const clipReason = (reason: string | null, droppedAt: string | null) => {
	const help = droppedAt ? STAGE_HELP[droppedAt] : undefined
	const said = reason ? sentence(reason) : ""
	if (said && said.replace(/\.$/, "").toLowerCase() !== STAGE_LABEL[droppedAt ?? ""]?.toLowerCase()) return said
	return help ? sentence(help) : said || "No reason recorded."
}

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s)

/** A machine name for people: "cardinal-or-jay" → "Cardinal or jay", "front-porch" → "Front porch". */
export const humanize = (slug: string) =>
	capitalize(
		slug
			.replace(/[-_]+/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			// vowel-less words are initialisms: "nvr-export" → "NVR export"
			.replace(/\b[b-df-hj-np-tv-xz]{2,5}\b/gi, w => w.toUpperCase())
	) || slug

/**
 * A lookout's title: the person's own words ("A cardinal or blue jay at the feeder"), which is what
 * they'll recognise. The slug stays for links and the CLI; it's never the headline.
 */
export const lookoutTitle = (l: { prompt: string; name: string }) => capitalize(l.prompt.trim().replace(/[.\s]+$/, "")) || humanize(l.name)

/**
 * The judge's reason as a sentence: no "judge:" prefix (the stage chip already says where it stopped),
 * a capital letter, and a full stop.
 */
export const sentence = (s: string) => {
	const t = capitalize(s.trim().replace(/^(judge|detector|detect|motion|probe)\s*:\s*/i, "").trim())
	return !t || /[.!?…]$/.test(t) ? t : `${t}.`
}

/** The spotter's name for a bird without its hedge: "Mourning Dove (likely)" → "Mourning Dove"; "(male)" stays. */
export const birdName = (label: string) =>
	label.replace(/\s*\((?:likely|probably|possibly|maybe|perhaps|uncertain|tentative|not confirmed)[^)]*\)/gi, "").trim() || label

/** What a kept clip shows: the species the spotter named, else its label, else the lookout that kept it. */
export const matchName = (m: { species: string | null; label: string | null; lookoutName: string }) =>
	m.species ?? (m.label ? birdName(m.label) : humanize(m.lookoutName))

/** "Oct 21", plus the year when it isn't this year. */
export const fmtDate = (iso: string, now = Date.now()) => {
	const d = new Date(iso)
	const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`
	return d.getFullYear() === new Date(now).getFullYear() ? base : `${base}, ${d.getFullYear()}`
}

// "judge: Blue Jay for cardinal-or-jay, below its threshold (0.52 < 0.60)" (src/pipeline/process.ts judgeReason)
const CLOSE_CALL_RE = /^(?:judge|detector):\s*(.+?) for (\S+), below its threshold \(([\d.]+) < ([\d.]+)\)/
// " (retry 2/3 at 14:05)" or " (retry 4 at 14:00)" (src/pipeline/worker.ts)
const RETRY_RE = /\s*\(retry (\d+)(?:\/(\d+))? at ([^)]+)\)\s*$/

/** What a passed-over or failed clip's reason says, split into the sentence and any badge it deserves. */
export const readReason = (c: { reason: string | null; droppedAt: string | null }) => {
	const close = c.reason ? CLOSE_CALL_RE.exec(c.reason) : null
	if (close) {
		const [, what, lookout, got, needs] = close
		return {
			text: `${sentence(what!).replace(/\.$/, "")} for “${humanize(lookout!)}”.`,
			close: { got: Number(got), needs: Number(needs) },
			retry: null
		}
	}
	const retry = c.reason ? RETRY_RE.exec(c.reason) : null
	// the judge's "… (0.95)" is its confidence in the "no", which reads as noise next to a sentence
	const reason = (retry ? c.reason!.slice(0, retry.index) : c.reason)?.replace(/\s*\((?:0?\.\d+|1(?:\.0+)?)\)$/, "") ?? null
	return { text: clipReason(reason, c.droppedAt), close: null, retry: retry ? { at: fmtClock(retry[3]!) } : null }
}

/**
 * The worker writes retry times as a 24-hour "14:00" (src/pipeline/worker.ts); shown in the same
 * clock as every other time here ("2:00 PM"). A time already past today is tomorrow's.
 */
export const fmtClock = (hhmm: string, now = Date.now()) => {
	const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
	if (!m) return hhmm
	const d = new Date(now)
	d.setHours(Number(m[1]), Number(m[2]), 0, 0)
	if (d.getTime() < now - 30 * MIN) d.setDate(d.getDate() + 1)
	return fmtTime(d.toISOString())
}

// Known failures, said the way a person would; matched on the stored error text, like src/llm/errors.ts.
const FAILURES: { re: RegExp; text: string; transient: boolean }[] = [
	{ re: /overloaded|\b(?:500|502|503|504|529)\b/i, text: "The spotter was busy", transient: true },
	{ re: /rate.?limit|too many requests|\b429\b/i, text: "The spotter asked look4 to slow down", transient: true },
	{ re: /usage limit|hit your (?:\w+ )?limit|(?:session|weekly|opus) limit|out of (?:extra )?usage/i, text: "Your Claude plan hit its usage limit", transient: true },
	{ re: /timed out|timeout/i, text: "The spotter took too long to answer", transient: true },
	{ re: /could not reach|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed/i, text: "look4 couldn't reach the spotter", transient: true },
	{ re: /not logged in/i, text: "Claude Code isn't signed in, so the spotter couldn't look", transient: false },
	{ re: /could not read|invalid data|moov atom|no such file|ffprobe/i, text: "look4 couldn't read this video file", transient: false }
]

/**
 * A failed clip in plain words: what happened, whether look4 will retry by itself and when, and the
 * raw message for a Details disclosure. Unknown failures still get a calm sentence; the raw text stays one click away.
 */
export const readFailure = (c: { reason: string | null; droppedAt: string | null; error?: string | null }) => {
	const r = readReason(c)
	const raw = (c.error ?? c.reason ?? "").replace(RETRY_RE, "").trim() || null
	const known = raw ? FAILURES.find(f => f.re.test(raw)) : undefined
	const text = known?.text ?? (c.droppedAt === "probe" ? "look4 couldn't read this video file" : "look4 got stuck on this clip")
	return { text, transient: known?.transient ?? false, retryAt: r.retry?.at ?? null, raw }
}

/** Free space in decimal GB, the unit retention.minFreeGb and the camera's "disk nearly full" note use. */
export const fmtGb = (bytes: number) => `${Number((bytes / 1e9).toFixed(bytes < 10e9 ? 1 : 0))} GB`

/** How full the disk is, next to what look4 itself uses; a warning once free space drops under the floor. */
export const diskState = (s: StatsResponse) => {
	const free = s.diskFreeBytes
	const floor = s.diskFloorBytes ?? 0
	if (free === undefined) return { low: false, text: `look4 uses ${fmtBytes(s.diskBytes)}` }
	const low = floor > 0 && free < floor
	return {
		low,
		text: low
			? `Only ${fmtGb(free)} free, under the ${fmtGb(floor)} floor: new clips are paused and passed-over ones are cleared early. look4 uses ${fmtBytes(s.diskBytes)}.`
			: `${fmtGb(free)} free · look4 uses ${fmtBytes(s.diskBytes)}`
	}
}

/**
 * A failed clip that look4 will try again by itself (a busy or rate-limited judge, a dropped
 * connection): a calm scheduled wait, not an error. `at` is "2:00 PM" when the worker said when.
 * Null for clips that won't retry on their own, like an unreadable file. Mirrors `isRetryable`
 * (src/pipeline/process.ts): the worker only retries the judge, and never after it gave up.
 */
export const readRetry = (c: { status: string; reason: string | null; droppedAt: string | null; error?: string | null }) => {
	if (c.status !== "error" || !/failed at judge/.test(c.reason ?? "") || / \(gave up [^)]*\)$/.test(c.reason ?? "")) return null
	const f = readFailure(c)
	return f.retryAt || f.transient ? { at: f.retryAt, text: f.text } : null
}

/** "Retrying at 2:00 PM", or "Retrying soon" when the worker didn't say when. */
export const retryText = (r: { at: string | null }) => (r.at ? `Retrying at ${r.at}` : "Retrying soon")

const BACKENDS: Record<string, string> = { "claude-code": "Claude Code", anthropic: "the Anthropic API", mock: "test mode" }
const DETECTORS: [RegExp, string][] = [
	[/^owlv2/, "OWLv2"],
	[/^owlvit/, "OWL-ViT"]
]

/**
 * Any model id as people say it, so every page names the same thing the same way:
 *   "claude-haiku-5-5" → "Claude Haiku 5.5"; with provider "claude-code" → "Claude Haiku 5.5 via Claude Code"
 *   a verdict's "claude-code:haiku" or "anthropic:claude-haiku-5-5-20260101" → the same, its backend from the tag
 *   a detector's "Xenova/owlvit-base-patch32" (or "…:fp32") → "OWL-ViT (local)"
 * Anything unrecognised comes back as given; show the raw id in a tooltip next to it.
 */
export const modelLabel = (id: string, provider?: string) => {
	const raw = id.trim()
	if (raw.includes("/")) {
		const repo = raw.split(":")[0]!.split("/").at(-1)!.toLowerCase()
		return `${DETECTORS.find(([re]) => re.test(repo))?.[1] ?? repo} (local)`
	}
	if (raw === "detector-only") return "The detector alone"
	const tag = /^([a-z-]+):(.+)$/.exec(raw)
	// the server's own alias table ("haiku" → "claude-haiku-5-5"), so the two never drift apart
	const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(canonicalModel(raw))
	const name = m ? `Claude ${capitalize(m[1]!)} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}` : (tag?.[2] ?? raw)
	const via = BACKENDS[tag?.[1] ?? provider ?? ""]
	return via ? `${name} via ${via}` : name
}
