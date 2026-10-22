// `pnpm dev-desktop` (alias `dd`): the dev server and the desktop window onto it, in one terminal.
//
// The window is pinned to Vite's port rather than left to search, since the search prefers a running
// `pnpm start` and, on WSL, would otherwise show it until the dev server is up. A pinned window waits
// for its server. Closing the window stops the server; the server exiting leaves the window, which
// shows look4 again as soon as one is back.
import { spawn, type ChildProcess } from "node:child_process"
import { resolve } from "node:path"
import { loopbackOrigin, VITE_PORT } from "../desktop/src/server.ts"

const repo = resolve(import.meta.dirname, "..")
const extra = process.argv.slice(2).filter(arg => arg !== "--")
// Run directly rather than through a package manager, so it works under pnpm, npm and nub alike.
const node = (...args: string[]) => spawn(process.execPath, args, { cwd: repo, stdio: "inherit" })
const server = node("--disable-warning=ExperimentalWarning", "scripts/dev.ts")
const desktop = node("desktop/scripts/dev.ts", `--url=${loopbackOrigin(VITE_PORT)}`, ...extra)
const children: ChildProcess[] = [server, desktop]

let stopping = false
const stop = (code: number) => {
	if (stopping) return
	stopping = true
	for (const child of children) if (child.exitCode === null) child.kill("SIGINT")
	process.exitCode = code
}
desktop.on("exit", code => stop(code ?? 0))
process.on("SIGINT", () => stop(130))
process.on("SIGTERM", () => stop(143))
