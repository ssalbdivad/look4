// `pnpm desktop`: the Electron window onto look4, rebuilt and relaunched on every edit to desktop/.
//
// Two reload loops, and they never overlap. The UI hot-reloads itself under `pnpm dev` — the window
// shows the page the server serves, so Vite HMR reaches it exactly as it reaches a browser tab, and this
// script has nothing to do with it. The SHELL (desktop/src) is bundled here with esbuild in watch mode,
// and a rebuild restarts Electron, because a main process cannot be swapped in place. The window
// reopens where it was (main.ts keeps its bounds and path).
//
// Bundled rather than run as TypeScript because Electron's own Node does not strip types. The preload
// is CommonJS because a sandboxed preload cannot be an ES module.
//
// On WSL it runs the WINDOWS build of Electron, natively, rather than the Linux one through WSLg
// (scripts/windows.ts); `--wslg` runs the Linux one there instead. The first Windows launch registers a
// Start Menu shortcut, which is what "Pin to taskbar" pins; the pinned look4 then opens without this
// script, from the copy under %LOCALAPPDATA%\look4\desktop, and this script refreshes that copy.
//
// Pass `--url=http://127.0.0.1:<port>` to show a particular look4 (LOOK4_DESKTOP_URL); without it the
// window joins whichever look4 answers (server.ts). Extra arguments go to Electron.
import { spawn, type ChildProcess } from "node:child_process"
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { context, type BuildOptions, type Plugin } from "esbuild"
import type { ServerLaunch } from "../src/launch.ts"
import { isWsl, prepareWindowsElectron } from "./windows.ts"

const pkg = resolve(import.meta.dirname, "..")
const repo = resolve(pkg, "..")
const dist = join(pkg, "dist")
// The `electron` package's main export is the path of its binary, which it downloads on first use.
const electronBinary = createRequire(import.meta.url)("electron") as string

const urlFlag = process.argv.find(arg => arg.startsWith("--url="))
const pinnedUrl = urlFlag?.slice("--url=".length)
const onWindows = isWsl() && !process.argv.includes("--wslg")
// `pnpm desktop -- …` passes its own `--` through, and Electron would read everything after it as app
// arguments rather than Chromium switches.
const electronArgs = process.argv.slice(2).filter(arg => arg !== urlFlag && arg !== "--" && arg !== "--wslg")
const env: NodeJS.ProcessEnv = { ...process.env, ...(pinnedUrl ? { LOOK4_DESKTOP_URL: pinnedUrl } : {}) }
// Set by `electron` when run from a terminal that is itself inside an Electron app (VS Code's); with it,
// the binary runs as plain Node and no window ever opens.
delete env.ELECTRON_RUN_AS_NODE

const windows = onWindows ? await prepareWindowsElectron() : undefined
if (windows) console.log(`[desktop] Windows Electron onto ${pinnedUrl ?? "whichever look4 answers"}`)

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
// The window icon: look4's mark. A PNG for Linux and the macOS Dock; an ICO for Windows, whose taskbar,
// title bar and Alt-Tab each ask for their own size. Both are written by brand/render.ts, so neither can
// drift from the favicon.
copyFileSync(join(repo, "brand", "logo-512.png"), join(dist, "icon.png"))
copyFileSync(join(pkg, "icon.ico"), join(dist, "icon.ico"))
// Where look4 lives, for the window to start it when none is running (src/launch.ts). Not written for a
// Windows Electron outside a named distro, which would have nowhere to start it.
const distro = process.env.WSL_DISTRO_NAME
if (!windows || distro) {
	const launch: ServerLaunch = { repo, node: process.execPath, ...(windows ? { distro } : {}) }
	writeFileSync(join(dist, "server.json"), JSON.stringify(launch))
}

let electron: ChildProcess | undefined
let quitting = false
let pendingRestart: NodeJS.Timeout | undefined

const launch = () => {
	const child = windows
		? windows.start(dist, [...(pinnedUrl ? [`--look4-url=${pinnedUrl}`] : []), ...electronArgs])
		: spawn(electronBinary, [pkg, ...electronArgs], { env, stdio: "inherit" })
	electron = child
	child.on("exit", (code, signal) => {
		if (electron !== child) return
		electron = undefined
		// Closing the window ends the loop — there is nothing left to show the rebuild in.
		if (!quitting) {
			// main.ts ALREADY_OPEN: another look4 window holds the profile (a pinned one, often), and was
			// raised instead.
			if (code === 75)
				console.log("[desktop] a look4 window is already open (brought to the front); pass --user-data-dir=<dir> to open a second")
			else console.log(`[desktop] Electron exited (${signal ?? code}); stopping the watcher`)
			void shutdown()
		}
	})
}

// Set from a restart's stop until its relaunch. A second rebuild inside that window (a Windows stop
// takes seconds) would otherwise find `electron` already cleared and launch at once, beside the window
// still closing: the new one loses the single-instance lock, quits, and takes the whole loop with it.
let relaunching = false

const restart = () => {
	// The pending relaunch copies whatever was built last, so this rebuild rides on it.
	if (relaunching) return
	const previous = electron
	if (!previous) return launch()
	electron = undefined
	relaunching = true
	previous.once("exit", () => {
		relaunching = false
		if (!quitting) launch()
	})
	void stop(previous)
}

const stop = async (child: ChildProcess) => {
	if (windows) await windows.stop(child)
	else child.kill("SIGTERM")
}

/** Both bundles report through this; the first build launches, every later one restarts once. */
let builds = 0
const relaunchOnRebuild: Plugin = {
	name: "relaunch",
	setup(build) {
		build.onEnd(result => {
			if (result.errors.length) return console.error("[desktop] build failed; keeping the running window")
			builds += 1
			if (builds < 2) return
			clearTimeout(pendingRestart)
			pendingRestart = setTimeout(() => {
				if (builds === 2) launch()
				else {
					console.log("[desktop] shell rebuilt; restarting Electron")
					restart()
				}
			}, 50)
		})
	}
}

const shared: BuildOptions = {
	bundle: true,
	platform: "node",
	target: "node24",
	external: ["electron"],
	absWorkingDir: pkg,
	logLevel: "warning",
	sourcemap: "inline",
	plugins: [relaunchOnRebuild]
}
const main = await context({
	...shared,
	entryPoints: ["src/main.ts"],
	outfile: join(dist, "main.mjs"),
	format: "esm",
	banner: {
		js: 'import { createRequire as __look4CreateRequire } from "node:module"; const require = __look4CreateRequire(import.meta.url);'
	}
})
const preload = await context({ ...shared, entryPoints: ["src/preload.ts"], outfile: join(dist, "preload.cjs"), format: "cjs" })
await Promise.all([main.watch(), preload.watch()])

const shutdown = async () => {
	quitting = true
	clearTimeout(pendingRestart)
	if (electron) await stop(electron)
	await Promise.all([main.dispose(), preload.dispose()])
	process.exit(0)
}
process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())
