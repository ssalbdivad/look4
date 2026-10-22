// Tiny leveled logger. LOOK4_LOG=debug|info|warn|error (default info).

type Level = "debug" | "info" | "warn" | "error"
const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 }
const color: Record<Level, string> = { debug: "\x1b[90m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" }

const threshold = () => order[(process.env.LOOK4_LOG as Level) ?? "info"] ?? 1

const write = (level: Level, scope: string, msg: string, extra?: unknown) => {
	if (order[level] < threshold()) return
	const time = new Date().toTimeString().slice(0, 8)
	const tag = process.stderr.isTTY ? `${color[level]}${scope}\x1b[0m` : scope
	const tail = extra === undefined ? "" : ` ${extra instanceof Error ? (extra.stack ?? extra.message) : JSON.stringify(extra)}`
	process.stderr.write(`${time} ${tag} ${msg}${tail}\n`)
}

export type Logger = Record<Level, (msg: string, extra?: unknown) => void>

export const logger = (scope: string): Logger => ({
	debug: (m, e) => write("debug", scope, m, e),
	info: (m, e) => write("info", scope, m, e),
	warn: (m, e) => write("warn", scope, m, e),
	error: (m, e) => write("error", scope, m, e)
})
