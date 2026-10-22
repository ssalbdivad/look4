import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"

/**
 * Starting look4 when the window finds none running, so a window pinned to the taskbar is one click
 * after a reboot. scripts/dev.ts writes where look4 lives into dist/server.json, since the app copy a
 * Windows Electron runs from (%LOCALAPPDATA%) has no other way to know: the repo, the Node that runs
 * it (nvm's, which a non-interactive WSL shell would not find on PATH) and, from WSL, the distro.
 *
 * The server is started detached and outlives the window: it is what pulls clips off the camera all
 * day, and closing a window must not stop that. Its output goes to data/desktop-server.log.
 */
export type ServerLaunch = {
	repo: string
	node: string
	/** Set when the window runs on Windows and look4 in this WSL distro. */
	distro?: string
}

export const SERVER_LOG = "data/desktop-server.log"

export const readServerLaunch = (path: string): ServerLaunch | undefined => {
	try {
		const launch = JSON.parse(readFileSync(path, "utf8")) as Partial<ServerLaunch>
		if (typeof launch.repo !== "string" || typeof launch.node !== "string") return undefined
		return { repo: launch.repo, node: launch.node, ...(typeof launch.distro === "string" ? { distro: launch.distro } : {}) }
	} catch {
		return undefined
	}
}

/** The command, run in the repo: `look4 start --no-open`, its output appended to SERVER_LOG. */
export const serverCommand = (launch: ServerLaunch): [command: string, args: string[]] => {
	const shell = [
		"sh",
		"-c",
		`mkdir -p data && exec "$0" "$@" >> ${SERVER_LOG} 2>&1`,
		launch.node,
		"--disable-warning=ExperimentalWarning",
		"src/cli/main.ts",
		"start",
		"--no-open"
	]
	return launch.distro ? ["wsl.exe", ["-d", launch.distro, "--cd", launch.repo, "--exec", ...shell]] : [shell[0]!, shell.slice(1)]
}

/** One argument as Windows' command-line parsing (CommandLineToArgvW) reads it back. */
export const quoteWindowsArg = (arg: string) => {
	if (arg !== "" && !/[\s"]/u.test(arg)) return arg
	return `"${arg.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`
}

/**
 * Start look4, calling `onFailed` if it could not be. It must outlive the window, and each platform
 * makes that its own problem.
 *
 * On Linux the server is spawned detached, out of the window's process group, and its exit before it
 * answers is the failure.
 *
 * On Windows, libuv puts every attached child in a job that ends it with the window, and a detached
 * console program (wsl.exe) gets a console of its own, which Windows 11 shows as a Windows Terminal
 * window whatever windowsHide says. So a hidden, attached PowerShell starts wsl.exe with
 * `Start-Process -WindowStyle Hidden`: a grandchild leaves libuv's job silently, and a console created
 * hidden stays hidden. PowerShell exits at once, so only its own failure is seen; a server that dies
 * after starting leaves the window on "Starting look4…".
 */
export const startServer = (launch: ServerLaunch, onFailed: () => void): void => {
	const [command, args] = serverCommand(launch)
	if (!launch.distro) {
		const child = spawn(command, args, { cwd: launch.repo, detached: true, stdio: "ignore" })
		child.on("error", onFailed)
		child.on("exit", onFailed)
		child.unref()
		return
	}
	const argumentList = args.map(quoteWindowsArg).join(" ").replaceAll("'", "''")
	const script = `Start-Process -FilePath ${command} -WindowStyle Hidden -ArgumentList '${argumentList}'`
	const child = spawn(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
		{ stdio: "ignore", windowsHide: true }
	)
	child.on("error", onFailed)
	child.on("exit", code => {
		if (code !== 0) onFailed()
	})
}
