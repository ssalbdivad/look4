/**
 * The screens this app draws itself: while it looks for look4, while none is up, and when the page
 * crashes. Everything else in the window is the server's own page. Plain HTML in a data: URL, so there
 * is nothing to bundle, in the brand's colours (web/src/brand.css), following the OS theme as the UI does.
 */

const STYLE = `
	:root { color-scheme: light dark; --bg: #f7f3ea; --fg: #1b2a40; --dim: #5a6577; --line: #e2d9c7; --accent: #f6b52e; }
	@media (prefers-color-scheme: dark) { :root { --bg: #111823; --fg: #eef1f6; --dim: #a3afc2; --line: #2e3b50; } }
	html, body { height: 100%; margin: 0; background: var(--bg); color: var(--fg); }
	body { display: grid; place-items: center; font: 14px/1.5 ui-rounded, system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-user-select: text; }
	main { max-width: 560px; padding: 32px; }
	h1 { font-size: 16px; font-weight: 600; margin: 0 0 6px; }
	p { margin: 0 0 10px; color: var(--dim); overflow-wrap: anywhere; }
	code { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
	.actions { display: flex; gap: 8px; margin-top: 18px; }
	button { font: inherit; color: var(--fg); background: transparent; border: 1px solid var(--line); border-radius: 12px; padding: 5px 14px; cursor: pointer; }
	button.primary { border-color: var(--accent); }
`

const page = (title: string, body: string) => {
	const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`
	return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

export const escapeHtml = (text: string) => text.replace(/[&<>"']/gu, ch => `&#${ch.charCodeAt(0)};`)

export const loadingPage = () => page("look4", `<h1>Connecting…</h1>`)

/** No look4 is up yet. The app keeps looking and opens it the moment one answers. */
export const waitingPage = (url?: string) => {
	const where = url
		? `<p>Waiting for <code>${escapeHtml(url)}</code> to answer.</p>`
		: `<p>Start it with <code>pnpm start</code> in the look4 folder. It opens here as soon as it is up.</p>`
	return page("look4", `<h1>look4 isn't running</h1>${where}`)
}

/** This app started look4 (launch.ts), which takes a few seconds and longer after a reboot. */
export const startingPage = () => page("look4", `<h1>Starting look4…</h1><p>It opens here as soon as it is up.</p>`)

/** The look4 this app started exited before it answered. The app keeps looking regardless. */
export const startFailedPage = (log: string) =>
	page(
		"look4",
		`<h1>look4 couldn't start</h1><p>Its output is in <code>${escapeHtml(log)}</code>.</p>` +
			`<div class="actions"><button class="primary" onclick="look4Desktop.retry()">Try again</button></div>`
	)

export const errorPage = (options: { title: string; message: string }) =>
	page(
		"look4",
		`<h1>${escapeHtml(options.title)}</h1><p>${escapeHtml(options.message)}</p>` +
			`<div class="actions"><button class="primary" onclick="look4Desktop.retry()">Try again</button></div>`
	)
