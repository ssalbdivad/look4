/**
 * Where a URL the page tries to open belongs.
 *
 * A browser tab gets this for free: a link to the Anthropic console opens another tab of the operator's
 * own browser, signed in and with their extensions. A bare BrowserWindow has no tabs, so without a
 * policy every `target=_blank` link opens a chromeless Electron window on an anonymous profile. So the
 * window only ever shows the look4 server's own origin, and everything else is handed to the OS.
 *
 * Only http(s) and mailto are handed to the OS opener; a `file:`, `javascript:` or custom-scheme link
 * is dropped rather than launched.
 */
export type NavigationTarget = "app" | "external" | "blocked"

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"])

export const classifyNavigation = (rawUrl: string, appOrigin: string | undefined): NavigationTarget => {
	let url: URL
	try {
		url = new URL(rawUrl)
	} catch {
		return "blocked"
	}
	if (appOrigin !== undefined && url.origin === appOrigin) return "app"
	return EXTERNAL_PROTOCOLS.has(url.protocol) ? "external" : "blocked"
}

/**
 * The in-app part of an address — what is remembered across launches. Only a path on the server's own
 * origin is kept, because the next launch may find look4 on another port (`pnpm start` vs `pnpm dev`).
 */
export const appPath = (rawUrl: string, appOrigin: string): string | undefined => {
	let url: URL
	try {
		url = new URL(rawUrl)
	} catch {
		return undefined
	}
	if (url.origin !== appOrigin) return undefined
	return `${url.pathname}${url.search}${url.hash}`
}

/**
 * Where a launch opens: the remembered in-app path on this launch's server, or the server's root. The
 * path is resolved AGAINST the origin and then checked, because a remembered `//host/…` would otherwise
 * resolve to another host entirely.
 */
export const startAddress = (savedPath: string | undefined, serverOrigin: string): string => {
	const root = `${serverOrigin}/`
	if (!savedPath) return root
	try {
		const url = new URL(savedPath, serverOrigin)
		return url.origin === serverOrigin ? url.toString() : root
	} catch {
		return root
	}
}
