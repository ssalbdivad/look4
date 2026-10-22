// Opens a URL in the user's browser. Best effort: a machine with no browser
// (a server, a container) just keeps the printed URL.

import { spawn } from "node:child_process"
import { isWsl } from "../setup/discover.ts"
import { onPath } from "../llm/index.ts"

/** The command that opens `url` here, or null when there is none. */
export const openerFor = (url: string, platform = process.platform, wsl = isWsl()): [string, string[]] | null => {
	if (platform === "darwin") return ["open", [url]]
	if (platform === "win32") return ["cmd", ["/c", "start", "", url]]
	if (wsl) {
		// wslview (wslu) hands the URL to the Windows default browser; explorer.exe does the same without wslu
		if (onPath("wslview")) return ["wslview", [url]]
		if (onPath("explorer.exe")) return ["explorer.exe", [url]]
	}
	if (onPath("xdg-open")) return ["xdg-open", [url]]
	return null
}

export const openBrowser = (url: string): boolean => {
	const cmd = openerFor(url)
	if (!cmd) return false
	try {
		const child = spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true })
		child.on("error", () => {})
		child.unref()
		return true
	} catch {
		return false
	}
}
