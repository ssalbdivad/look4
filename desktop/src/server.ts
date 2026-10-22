/**
 * Finding the look4 server to show. This app never starts or runs it: `pnpm start` (or `pnpm dev`)
 * already serves the UI, and the window is a client of it exactly as a browser tab is. Electron's
 * embedded Node could not host it anyway: onnxruntime and sharp are built for the system Node.
 *
 * Unlike a browser tab, the window can be opened from the Windows taskbar, where nothing on the Linux
 * side tells it a port, so the search is by well-known port alone. WSL forwards Windows' loopback into
 * the distro, so the same probe works from either side.
 */

/** `look4 start`'s default port (src/config.ts). */
export const LOOK4_PORT = 4040
/** Vite's, which `pnpm dev` serves the UI on and proxies /api from. */
export const VITE_PORT = 5173

export type LocateOptions = {
	ports?: number[]
	answers?: (origin: string) => Promise<boolean>
}

/** A look4 answering at this origin, by its health handshake: answering at all is not enough. */
export const look4Answers = async (origin: string, timeoutMs = 1_500): Promise<boolean> => {
	try {
		const response = await fetch(new URL("/api/health", origin), { signal: AbortSignal.timeout(timeoutMs) })
		if (!response.ok) return false
		const health = (await response.json()) as { ok?: unknown; app?: unknown }
		return health.ok === true && health.app === "look4"
	} catch {
		return false
	}
}

/**
 * The origin of the look4 to show, or undefined when none is up. The real server comes FIRST: this is
 * the window kept open all day, and a dev server beside it is the exception. A dev loop that wants its
 * own pins it (`--url=`).
 */
export const locateServer = async (options: LocateOptions = {}): Promise<string | undefined> => {
	const answers = options.answers ?? look4Answers
	for (const port of options.ports ?? [LOOK4_PORT, VITE_PORT]) {
		const origin = loopbackOrigin(port)
		if (await answers(origin)) return origin
	}
	return undefined
}

export const loopbackOrigin = (port: number) => `http://127.0.0.1:${port}`
