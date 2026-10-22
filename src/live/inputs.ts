// Where a source's live picture comes from: the RTSP address of a Reolink camera
// (built from its saved login), or an RTSP source's own URL, switched between the
// camera's full ("main") and light ("sub") stream when the URL says which it is.

import type { LiveStream } from "../api-types.ts"
import type { ReolinkSourceConfig } from "../config.ts"
import { hostOf } from "../setup/discover.ts"

/**
 * URL shapes that name their stream, per brand: [pattern, main, sub]. The
 * pattern's first group is kept, its second is the stream marker.
 */
const VARIANTS: Array<{ re: RegExp; main: string; sub: string }> = [
	// Reolink: /h264Preview_01_main, /h265Preview_01_sub, /Preview_01_main
	{ re: /(Preview_\d{2}_)(main|sub)(?=$|[/?#])/i, main: "main", sub: "sub" },
	// Hikvision: /Streaming/Channels/101 (channel 1, stream 01) and /102
	{ re: /(\/Streaming\/Channels\/\d+0)([12])(?=$|[/?#])/i, main: "1", sub: "2" },
	// Dahua and Amcrest: /cam/realmonitor?channel=1&subtype=0
	{ re: /([?&]subtype=)([01])(?=$|&|#)/i, main: "0", sub: "1" },
	// TP-Link Tapo: /stream1 and /stream2
	{ re: /(\/stream)([12])$/i, main: "1", sub: "2" }
]

/** The same camera's other stream, or null when the URL's brand isn't recognised. */
export const streamVariant = (url: string, stream: LiveStream): string | null => {
	for (const v of VARIANTS) {
		if (!v.re.test(url)) continue
		return url.replace(v.re, (_m, keep: string) => keep + v[stream])
	}
	return null
}

/** Which stream a URL is now, when its brand says. */
export const streamOf = (url: string): LiveStream | null => {
	for (const v of VARIANTS) {
		const m = v.re.exec(url)
		if (m) return m[2]!.toLowerCase() === v.sub ? "sub" : "main"
	}
	return null
}

/** The host (bracketed when IPv6) a Reolink source points at, without scheme, port or path. */
export const reolinkHostname = (cfg: Pick<ReolinkSourceConfig, "host">) => {
	const h = hostOf(cfg.host)
	if (!h) return null
	return h.includes(":") ? `[${h}]` : h
}

/**
 * `rtsp://user:pass@host:554/h264Preview_01_sub`. The path names H.264 but
 * Reolink serves whatever the stream is encoded as (4K main streams are HEVC).
 */
export const reolinkRtspUrl = (
	cfg: Pick<ReolinkSourceConfig, "host" | "username" | "channel" | "rtspPort">,
	password: string,
	stream: LiveStream
): string | null => {
	const host = reolinkHostname(cfg)
	if (!host) return null
	const ch = String(cfg.channel + 1).padStart(2, "0")
	return `rtsp://${encodeURIComponent(cfg.username)}:${encodeURIComponent(password)}@${host}:${cfg.rtspPort}/h264Preview_${ch}_${stream}`
}
