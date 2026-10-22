// `look4 start`: sources + worker + web UI in one process.

import { spawn } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { startApp } from "../app.ts"
import { CONFIG_FILE, loadConfig } from "../config.ts"
import { setupCompleted } from "../setup/sources.ts"
import { args, UsageError } from "./cli.ts"
import { openBrowser } from "./open.ts"
import { banner, c, cmd, err, out } from "./ui.ts"

const ROOT = fileURLToPath(new URL("../../", import.meta.url))

/** What the UI bundle is built from: a change to any of these means web/dist is out of date. */
const WEB_INPUTS = ["web/src", "web/public", "web/index.html", "vite.config.ts", "pnpm-lock.yaml"]

const newestMtime = (path: string): number => {
	const st = statSync(path, { throwIfNoEntry: false })
	if (!st) return 0
	if (!st.isDirectory()) return st.mtimeMs
	let newest = 0
	for (const entry of readdirSync(path)) newest = Math.max(newest, newestMtime(join(path, entry)))
	return newest
}

/** `missing`: never built; `stale`: a source is newer than the last build (a git pull, a UI edit). */
export const webBuildState = (root: string): "missing" | "stale" | "fresh" => {
	const built = statSync(join(root, "web", "dist", "index.html"), { throwIfNoEntry: false })
	if (!built) return "missing"
	const newest = Math.max(...WEB_INPUTS.map(p => newestMtime(join(root, p))))
	return newest > built.mtimeMs ? "stale" : "fresh"
}

/** Builds web/dist when it is missing or older than its sources, so `pnpm install && pnpm start` is all it takes. */
const ensureWebBuild = async () => {
	const state = webBuildState(ROOT)
	if (state === "fresh") return
	const vite = join(ROOT, "node_modules", "vite", "bin", "vite.js")
	if (!existsSync(vite)) {
		err(
			state === "missing"
				? `${c.yellow("!")} web/dist is missing and vite is not installed; the UI will not load until you run pnpm install && pnpm build`
				: `${c.yellow("!")} the web UI is older than its sources and vite is not installed; run pnpm install && pnpm build to update it`
		)
		return
	}
	err(c.dim(state === "missing" ? "building the web UI (first start only)…" : "rebuilding the web UI (its sources changed)…"))
	const code = await new Promise<number | null>(resolve => {
		const child = spawn(process.execPath, [vite, "build"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] })
		child.on("close", resolve)
		child.on("error", () => resolve(1))
	})
	if (code !== 0)
		err(
			`${c.yellow("!")} vite build failed (exit ${code}); the API still runs, but fix the build to get the current UI`
		)
}

export const startCmd = async (argv: string[]) => {
	const { values } = args(argv, { "no-sources": { type: "boolean" }, port: { type: "string" }, "no-open": { type: "boolean" } }, false)
	let config = loadConfig()
	if (values.port !== undefined) {
		const port = Number(values.port)
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError(`--port must be 1–65535 (got "${values.port}")`)
		config = { ...config, server: { ...config.server, port } }
	}
	await ensureWebBuild()
	const app = await startApp(config, { sources: !values["no-sources"] })
	out(banner(app.url))
	// there is no login: on a LAN bind, anything on the network can change settings and sources
	if (app.url && !/^(127\.0\.0\.1|localhost|::1|\[::1\])$/.test(config.server.host))
		out(`   ${c.yellow("!")} listening on ${config.server.host}: every device on your network can use look4, with no password`)
	const n = app.ctx.store.listLookouts().filter(l => l.enabled).length
	out(
		c.dim(
			`   ${n} lookout${n === 1 ? "" : "s"} on · ${config.sources.length && !values["no-sources"] ? `${config.sources.length} source${config.sources.length === 1 ? "" : "s"}` : "no camera sources"} · drop clips in ${app.ctx.paths.inbox}`
		)
	)
	// a first run straight after `pnpm install`: the browser's setup wizard is the next step, so say so (and open it)
	const firstRun = !setupCompleted(app.ctx.store, config.sources)
	if (firstRun && app.url) {
		out(`   ${c.yellow("→")} Open ${c.cyan(app.url)} — setup walks you through connecting your camera`)
		// only for a person at a terminal: a service or a script has nobody to look at the browser
		if (!values["no-open"] && process.stdout.isTTY && openBrowser(app.url)) out(c.dim("     (opening it in your browser)"))
	} else if (!config.configPath)
		out(`   ${c.yellow("!")} no ${CONFIG_FILE} here, so every default applies. Open ${c.cyan(app.url ?? "the web UI")} → Settings → Sources to connect a camera`)
	if (!n && !firstRun) out(`   ${c.yellow("!")} nothing to look for yet: add a lookout in the web UI, or ${c.cyan(cmd('lookout add "a cardinal at the feeder"'))}`)
	out(c.dim("   Ctrl-C to stop"))
	// startApp's signal handler stops everything and exits
	return new Promise<number>(() => {})
}
