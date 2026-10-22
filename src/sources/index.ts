import type { SourceConfig } from "../config.ts"
import type { SourceAdapter, SourceContext } from "./common.ts"
import { createReolinkSource } from "./reolink.ts"
import { createRtspSource } from "./rtsp.ts"
import { createWatchSource } from "./watch.ts"

export type { SourceAdapter, SourceContext } from "./common.ts"
export { VIDEO_EXTENSIONS } from "./common.ts"
export { createInboxSource } from "./watch.ts"
export { maskUrl } from "./rtsp.ts"
export { reolinkCheck } from "./reolink.ts"

/** One adapter per configured source. Nothing runs until `start()`. */
export const createSource = (cfg: SourceConfig, ctx: SourceContext): SourceAdapter => {
	switch (cfg.type) {
		case "reolink":
			return createReolinkSource(cfg, ctx)
		case "watch":
			return createWatchSource(cfg, ctx)
		case "rtsp":
			return createRtspSource(cfg, ctx)
	}
}
