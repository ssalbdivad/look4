// Serving files from disk: Range requests for video, and the built web UI.

import { createReadStream, existsSync, statSync } from "node:fs"
import { extname, join, relative, resolve, sep } from "node:path"
import { Readable } from "node:stream"

const TYPES: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".webp": "image/webp",
	".gif": "image/gif",
	".mp4": "video/mp4",
	".m4v": "video/mp4",
	".mov": "video/quicktime",
	".mkv": "video/x-matroska",
	".webm": "video/webm",
	".avi": "video/x-msvideo",
	".ts": "video/mp2t",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".webmanifest": "application/manifest+json",
	".txt": "text/plain; charset=utf-8",
	".woff2": "font/woff2",
	".woff": "font/woff"
}

export const contentType = (path: string) => TYPES[extname(path).toLowerCase()] ?? "application/octet-stream"

/**
 * For clip media, whose names come from outside (an upload, a camera's file
 * list): only video and raster image types, never one a browser would run as
 * a page (.html, .svg, .js). Anything else downloads as bytes.
 */
export const mediaContentType = (path: string) => {
	const type = contentType(path)
	return /^video\/|^image\/(jpeg|png|webp|gif)$/.test(type) ? type : "application/octet-stream"
}

/** RFC 6266 `filename` (ASCII, for old clients) plus RFC 5987 `filename*` (the real UTF-8 name). */
export const contentDisposition = (name: string) => {
	const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_")
	const utf8 = encodeURIComponent(name.toWellFormed()).replace(/['()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
	return `inline; filename="${ascii}"; filename*=UTF-8''${utf8}`
}

export type ByteRange = { start: number; end: number }

/**
 * Parses a single-range `Range` header against a file size. `null` = serve the
 * whole file (no header, or a form we do not support such as multiple ranges);
 * `"unsatisfiable"` = 416.
 */
export const parseRange = (header: string | undefined, size: number): ByteRange | "unsatisfiable" | null => {
	if (!header) return null
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
	if (!m) return null
	const [, a = "", b = ""] = m
	if (a === "" && b === "") return null
	if (a === "") {
		// suffix range: the last N bytes
		const n = Number(b)
		if (n === 0 || size === 0) return "unsatisfiable"
		return { start: Math.max(0, size - n), end: size - 1 }
	}
	const start = Number(a)
	const end = b === "" ? size - 1 : Math.min(Number(b), size - 1)
	if (start >= size || end < start) return "unsatisfiable"
	return { start, end }
}

/** A file response honoring `Range`, streamed (never buffered). */
export const sendFile = (
	path: string,
	req: Request,
	opts: {
		cacheControl: string
		contentType?: string
		download?: string
		/** Clip media: even if a file slipped through as something a browser would render, it gets no origin and no script. */
		sandbox?: boolean
	}
): Response => {
	const stat = statSync(path, { throwIfNoEntry: false })
	if (!stat?.isFile()) return Response.json({ error: "not found" }, { status: 404 })
	const headers = new Headers({
		"Content-Type": opts.contentType ?? contentType(path),
		"X-Content-Type-Options": "nosniff",
		"Accept-Ranges": "bytes",
		"Cache-Control": opts.cacheControl,
		"Last-Modified": stat.mtime.toUTCString()
	})
	if (opts.sandbox) headers.set("Content-Security-Policy", "sandbox; default-src 'none'")
	if (opts.download) headers.set("Content-Disposition", contentDisposition(opts.download))
	const range = parseRange(req.headers.get("range") ?? undefined, stat.size)
	if (range === "unsatisfiable") {
		headers.set("Content-Range", `bytes */${stat.size}`)
		return new Response(null, { status: 416, headers })
	}
	const { start, end } = range ?? { start: 0, end: stat.size - 1 }
	const length = stat.size === 0 ? 0 : end - start + 1
	headers.set("Content-Length", String(length))
	if (range) headers.set("Content-Range", `bytes ${start}-${end}/${stat.size}`)
	const status = range ? 206 : 200
	// HEAD is dispatched to GET handlers; skip opening a stream nobody reads
	if (req.method === "HEAD" || length === 0) return new Response(null, { status, headers })
	const body = Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream
	return new Response(body, { status, headers })
}

/** Resolves a URL path inside `root`, or null if it escapes it. */
export const safeJoin = (root: string, urlPath: string): string | null => {
	let decoded: string
	try {
		decoded = decodeURIComponent(urlPath)
	} catch {
		return null
	}
	if (decoded.includes("\0")) return null
	const full = resolve(root, `.${sep}${decoded}`)
	const rel = relative(root, full)
	if (rel.startsWith("..") || resolve(root, rel) !== full) return null
	return full
}

const MISSING_UI = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>look4</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1rem;color:#233}code{background:#eef;padding:.1em .3em;border-radius:4px}</style>
</head><body>
<h1>look4 is running</h1>
<p>The API is up, but the web UI has not been built yet. Run <code>pnpm build</code> (or <code>nub run build</code>) in the look4 folder, then reload this page.</p>
<p>For UI development, <code>pnpm dev</code> serves it with live reload.</p>
</body></html>`

/** Serves `web/dist`, falling back to `index.html` for client-side routes. */
export const serveStatic = (distDir: string, urlPath: string, req: Request): Response => {
	const index = join(distDir, "index.html")
	if (!existsSync(index)) return new Response(MISSING_UI, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } })
	const file = urlPath === "/" ? index : safeJoin(distDir, urlPath)
	if (!file) return Response.json({ error: "not found" }, { status: 404 })
	if (statSync(file, { throwIfNoEntry: false })?.isFile()) {
		// Vite content-hashes everything under assets/; index.html must always revalidate
		const immutable = relative(distDir, file).startsWith(`assets${sep}`)
		return sendFile(file, req, { cacheControl: immutable ? "public, max-age=31536000, immutable" : "no-cache" })
	}
	// a missing file with an extension is a real 404, not a client route
	if (extname(urlPath)) return Response.json({ error: "not found" }, { status: 404 })
	return sendFile(index, req, { cacheControl: "no-cache" })
}
