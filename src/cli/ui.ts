// Terminal output helpers: color (TTY only, honoring NO_COLOR), tables, units.

const useColor = () => !!process.stdout.isTTY && !process.env.NO_COLOR

const paint = (code: string) => (s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s)

export const c = {
	bold: paint("1"),
	dim: paint("2"),
	green: paint("32"),
	red: paint("31"),
	yellow: paint("33"),
	cyan: paint("36")
}

/**
 * A look4 command written the way it was invoked, so every hint works when
 * pasted. A private package's bin is never linked, so right after
 * `pnpm install` there is no `look4` on PATH: run through a package script it
 * is `pnpm look4 …` (and `pnpm start`); only a linked install answers to `look4`.
 */
export const cmd = (sub: string, env: NodeJS.ProcessEnv = process.env) => {
	if (!env.npm_lifecycle_event) return `look4 ${sub}`
	const agent = env.npm_config_user_agent ?? ""
	const pm = agent.startsWith("npm/") ? "npm" : agent.startsWith("yarn/") ? "yarn" : "pnpm"
	const [name = "", ...rest] = sub.split(" ")
	const script = name === "start" ? "start" : "look4"
	const args = (name === "start" ? rest : [name, ...rest]).join(" ")
	if (!args) return `${pm} ${script}`
	// pnpm and yarn pass arguments straight through to the script; npm needs `--` first
	return pm === "npm" ? `npm ${script === "start" ? "start" : "run look4"} -- ${args}` : `${pm} ${script} ${args}`
}

export const out = (s = "") => process.stdout.write(s + "\n")
export const err = (s = "") => process.stderr.write(s + "\n")

export const ok = (label: string, detail = "") => out(`${c.green("✓")} ${label}${detail ? c.dim(`  ${detail}`) : ""}`)
export const bad = (label: string, detail = "", fix = "") => {
	out(`${c.red("✗")} ${label}${detail ? c.dim(`  ${detail}`) : ""}`)
	if (fix) out(`  ${c.yellow("→")} ${fix}`)
}
export const warn = (label: string, detail = "", fix = "") => {
	out(`${c.yellow("!")} ${label}${detail ? c.dim(`  ${detail}`) : ""}`)
	if (fix) out(`  ${c.yellow("→")} ${fix}`)
}

const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`)

/** Left-aligned columns. `max` caps a column's width (the reason column, say). */
export const table = (headers: string[], rows: string[][], max: Record<number, number> = {}) => {
	const cells = rows.map(r => r.map((v, i) => (max[i] ? clip(v, max[i]) : v)))
	const widths = headers.map((h, i) => Math.max(h.length, ...cells.map(r => visible(r[i] ?? ""))))
	const line = (r: string[]) =>
		r
			.map((v, i) => (i === r.length - 1 ? v : v + " ".repeat(Math.max(0, widths[i]! - visible(v)))))
			.join("  ")
			.trimEnd()
	out(c.dim(line(headers)))
	for (const r of cells) out(line(r))
}

export const usd = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`)

export const bytes = (n: number) => {
	const units = ["B", "KB", "MB", "GB", "TB"]
	let i = 0
	while (n >= 1000 && i < units.length - 1) {
		n /= 1000
		i++
	}
	return `${n.toFixed(i && n < 10 ? 1 : 0)} ${units[i]}`
}

export const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(0)}%`)

/** "7d", "12h", "30m", "2w" → that long ago, as ISO; an ISO date passes through. */
export const parseSince = (s: string, now = Date.now()): string | null => {
	const m = /^(\d+(?:\.\d+)?)\s*([mhdw])$/.exec(s.trim())
	if (m) {
		const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as "m" | "h" | "d" | "w"]
		return new Date(now - Number(m[1]) * unit).toISOString()
	}
	const t = Date.parse(s)
	return Number.isNaN(t) ? null : new Date(t).toISOString()
}

/** The brand's terminal mark (brand/README.md, "Terminal banner") plus the URL. */
export const banner = (url: string | null) => {
	const eye = useColor() ? "\x1b[38;2;246;181;46m(@)\x1b[0m" : "(@)"
	const four = useColor() ? "\x1b[38;2;47;111;182m4\x1b[0m" : "4"
	return [
		"    ,--^-.",
		`   / ${eye}  \`--.`,
		`  |      .--. )   ${c.bold("look")}${four}`,
		`   \\     /   v    ${c.dim("keep the clips worth watching")}`,
		`    \`~~~'         ${url ? c.cyan(url) : c.dim("(web UI off)")}`
	].join("\n")
}
