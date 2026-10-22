// Edits `<rootDir>/.env`, where look4 keeps secrets (camera passwords, stream
// URLs with credentials, the Anthropic API key). Every other line, comments
// included, is left exactly as it was.

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const envPath = (rootDir: string) => join(rootDir, ".env")

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * A value Node's own `.env` parser (`process.loadEnvFile`) reads back verbatim.
 * Unquoted values end at `#`, single and backtick quotes are literal, and double
 * quotes expand `\n`, so the first quote style the value cannot break wins.
 */
export const envValue = (v: string) => {
	if (/[\r\n]/.test(v)) throw new Error("a value in .env cannot contain a line break")
	if (/^[\w.@%+:/,=~-]*$/.test(v)) return v
	if (!v.includes("'")) return `'${v}'`
	if (!v.includes("`")) return `\`${v}\``
	if (!v.includes('"') && !v.includes("\\")) return `"${v}"`
	throw new Error("this value mixes every kind of quote, so it cannot be stored in .env")
}

const lineFor = (key: string) => new RegExp(`^\\s*(export\\s+)?${key}\\s*=`)

/**
 * Sets (string) or removes (null) variables in `<rootDir>/.env` and in
 * `process.env`. The file is created owner-only and rewritten atomically, so a
 * crash never leaves it half-written.
 */
export const updateEnvFile = (rootDir: string, changes: Record<string, string | null>) => {
	if (!Object.keys(changes).length) return
	const path = envPath(rootDir)
	for (const key of Object.keys(changes)) if (!KEY.test(key)) throw new Error(`"${key}" is not a valid environment variable name`)
	const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : []
	if (lines.length && lines.at(-1) === "") lines.pop()
	let out = lines
	for (const [key, value] of Object.entries(changes)) {
		const match = lineFor(key)
		const at = out.findIndex(l => match.test(l))
		// a key defined twice would leave the first one (which Node reads) stale, so drop the rest
		out = out.filter((l, i) => i === at || !match.test(l))
		if (value === null) {
			if (at >= 0) out = out.filter(l => !match.test(l))
			continue
		}
		const line = `${key}=${envValue(value)}`
		if (at >= 0) out[out.findIndex(l => match.test(l))] = line
		else out.push(line)
	}
	const tmp = `${path}.tmp-${process.pid}`
	writeFileSync(tmp, out.length ? out.join("\n") + "\n" : "", { mode: 0o600 })
	chmodSync(tmp, 0o600)
	renameSync(tmp, path)
	for (const [key, value] of Object.entries(changes)) {
		if (value === null) delete process.env[key]
		else process.env[key] = value
	}
}

export const setEnvVar = (rootDir: string, key: string, value: string) => updateEnvFile(rootDir, { [key]: value })
