import { join } from "node:path"
import type { RtspSourceConfig } from "../config.ts"
import { logger } from "../log.ts"
import { createPoller, createStatus, type SourceAdapter, type SourceContext } from "./common.ts"
import { createSegmentRecorder, createStreamCapture } from "./recorder.ts"

export { maskUrl, maskWith } from "./recorder.ts"

/**
 * Records any ffmpeg-readable stream (RTSP from almost every IP camera, but also
 * HTTP/RTMP/files) as fixed-length segments; each finished segment is ingested
 * and the motion gate throws away the empty ones. There is no camera motion
 * signal here, so nothing is skipped up front.
 */
export const createRtspSource = (
	cfg: RtspSourceConfig,
	ctx: SourceContext,
	opts: { ffmpeg?: string; /** Footage kept for Record after it is finished; tests with file inputs pass 0. */ holdMs?: number } = {}
): SourceAdapter => {
	const log = logger(`source:${cfg.name}`)
	const status = createStatus(ctx, cfg.name, "rtsp")
	let stopping = true

	const recorder = createSegmentRecorder({
		name: cfg.name,
		dir: join(ctx.paths.partial, `rtsp-${cfg.name}`),
		url: () => cfg.url ?? (cfg.urlEnv ? process.env[cfg.urlEnv] : undefined) ?? null,
		missing: () => `set ${cfg.urlEnv ?? "url"} in .env`,
		segmentSeconds: cfg.segmentSeconds,
		// kept when it's AAC (or anything else MP4 holds), so a clip saved from Live has sound
		audio: true,
		ffmpeg: opts.ffmpeg,
		log,
		onState: (state, detail) => status.state(state, detail)
	})
	const capture = createStreamCapture({
		name: cfg.name,
		ctx,
		recorder,
		segmentSeconds: cfg.segmentSeconds,
		holdMs: opts.holdMs,
		ffmpeg: opts.ffmpeg,
		log,
		onClip: () => status.ingested()
	})
	const poller = createPoller({
		intervalMs: () => Math.min(10_000, Math.max(2000, (cfg.segmentSeconds * 1000) / 3)),
		cycle: async signal => {
			status.polled()
			await capture.cycle(signal)
		},
		onError: e => log.error("poll failed", e)
	})

	return {
		name: cfg.name,
		type: "rtsp",
		start: () => {
			if (!stopping) return
			stopping = false
			recorder.start()
			poller.start()
		},
		stop: async () => {
			stopping = true
			await poller.stop()
			await recorder.stop()
			// ffmpeg is gone, so every segment on disk is final; take them now
			await capture.flush()
			status.state("stopped", "stopped")
		},
		status: status.get,
		pollNow: async () => {
			recorder.resume()
			await poller.pollNow()
		},
		liveRecorder: () => (stopping ? null : capture.live)
	}
}
