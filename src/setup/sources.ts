// Source bookkeeping shared by the app (which runs adapters) and the setup API
// (which edits the config): secret env var names, the fingerprint that says
// whether a running adapter is out of date, and the setup-completed flag.

import { createHash } from "node:crypto"
import type { SourceConfig } from "../config.ts"
import type { Store } from "../db.ts"
import type { SourceStatus } from "../types.ts"

/** The env var holding this source's secret: a camera password, or a stream URL with credentials in it. */
export const secretEnvOf = (cfg: SourceConfig): string | null =>
	cfg.type === "reolink" ? cfg.passwordEnv : cfg.type === "rtsp" ? (cfg.urlEnv ?? null) : null

/**
 * Changes whenever the adapter would behave differently: its config, or the
 * secret it reads from the environment (a new password must restart it, or a
 * Reolink adapter would sit out its login backoff with the old one). Close-ups
 * are left out: they are read live (src/live/closeup.ts), and switching them
 * shouldn't cost a restart of the recording and the motion watch's warm-up.
 */
export const sourceSignature = (cfg: SourceConfig, env: NodeJS.ProcessEnv = process.env) => {
	const key = secretEnvOf(cfg)
	const secret = key ? env[key] : undefined
	const digest = secret === undefined ? "unset" : createHash("sha256").update(secret).digest("hex")
	const { closeUps: _, ...rest } = cfg as SourceConfig & { closeUps?: boolean }
	return `${JSON.stringify(rest)}\n${digest}`
}

export const idleStatus = (cfg: SourceConfig, state: SourceStatus["state"], detail: string, clipsIngested = 0): SourceStatus => ({
	name: cfg.name,
	type: cfg.type,
	state,
	detail,
	lastPollAt: null,
	lastClipAt: null,
	clipsIngested
})

/** The status detail of a source switched off with `enabled: false`. */
export const PAUSED_DETAIL = "paused"

/** Set when the setup wizard is finished or skipped. */
export const SETUP_KEY = "setup:completed"
export type SetupFlag = { at: string; skipped: boolean; uploadOnly: boolean }

/** An install that already has sources or lookouts counts as set up, so existing users never get the wizard forced on them. */
export const setupCompleted = (store: Store, sources: SourceConfig[]) =>
	store.getKv<SetupFlag>(SETUP_KEY) !== null || sources.length > 0 || store.listLookouts().length > 0
