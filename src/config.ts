import { type } from "arktype"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"

const unit = "0 <= number <= 1"

export const NormBox = type({
	x: unit,
	y: unit,
	w: "0 < number <= 1",
	h: "0 < number <= 1"
})

const sourceName = /^[a-z0-9][a-z0-9-]*$/

export const ReolinkSource = type({
	type: "'reolink'",
	name: sourceName,
	/** false = keep the entry but do not run the adapter (paused from the UI). */
	enabled: "boolean = true",
	/** Camera IP or hostname on the LAN. */
	host: "string > 0",
	username: "string = 'admin'",
	/** Name of the env var holding the camera password (put it in `.env`). */
	passwordEnv: "string = 'REOLINK_PASSWORD'",
	channel: "number.integer >= 0 = 0",
	/** `main` = full-resolution recordings, `sub` = the low-res "fluent" stream. */
	stream: "'main' | 'sub' = 'main'",
	/** `auto` tries HTTPS, then HTTP. */
	protocol: "'auto' | 'http' | 'https' = 'auto'",
	/** The camera's RTSP port, for live view (Settings → Network → Advanced → Server Settings). */
	rtspPort: "1 <= number.integer <= 65535 = 554",
	pollSeconds: "number >= 10 = 60",
	/** On first start, how far back to pull existing recordings from the SD card. */
	lookbackHours: "number >= 0 = 24",
	/**
	 * Where clips come from. `stream`: look4 records the camera's live stream and keeps the footage
	 * around motion (see `motionGate`). `sd`: download the camera's SD-card recordings. `auto`:
	 * stream when RTSP answers and a password is saved, else SD.
	 */
	capture: "'auto' | 'stream' | 'sd' = 'auto'",
	/** Length of the short pieces the stream is recorded in; clips are assembled from them. */
	segmentSeconds: "2 <= number <= 30 = 6",
	/**
	 * Which stream footage becomes clips. `both`: footage around motion seen by look4's own watch of
	 * the camera's preview stream or by the camera's own detection. `camera`: only the camera's
	 * motion/AI detections. `all`: every piece is checked.
	 */
	motionGate: "'both' | 'camera' | 'all' = 'both'",
	/**
	 * Close-ups: when look4's motion watch sees something move and the detector finds a bird there,
	 * the camera zooms in on it (optically, `Set3DPos`), keeps the sharpest of a few full-resolution
	 * stills for the clip, and goes back Home. Needs the live stream with `motionGate: "both"`, a
	 * saved Home view, and a camera that can frame a box. Changing it never restarts the source.
	 */
	closeUps: "boolean = false"
})

export const WatchSource = type({
	type: "'watch'",
	name: sourceName,
	/** false = keep the entry but do not run the adapter (paused from the UI). */
	enabled: "boolean = true",
	/** Directory something else writes clips into (FTP upload target, NVR export, phone sync). */
	dir: "string > 0",
	extensions: type("string[]").default(() => [".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"]),
	pollSeconds: "number > 0 = 5",
	/** A file is ingested once its size and mtime have not changed for this long. */
	stableSeconds: "number >= 0 = 5",
	/** Move files out of `dir` instead of copying them. */
	move: "boolean = false"
})

export const RtspSource = type({
	type: "'rtsp'",
	name: sourceName,
	/** false = keep the entry but do not run the adapter (paused from the UI). */
	enabled: "boolean = true",
	/** e.g. rtsp://admin:pass@192.168.1.50:554/h264Preview_01_sub. Prefer `urlEnv` so the password stays in `.env`. */
	"url?": "string > 0",
	"urlEnv?": "string > 0",
	segmentSeconds: "5 <= number <= 600 = 30"
})

export const SourceConfig = ReolinkSource.or(WatchSource).or(RtspSource)
export type SourceConfig = typeof SourceConfig.infer
export type ReolinkSourceConfig = typeof ReolinkSource.infer
export type WatchSourceConfig = typeof WatchSource.infer
export type RtspSourceConfig = typeof RtspSource.infer

export const Config = type({
	/** Where clips, the database, media and model weights live. Relative paths resolve against the config file. */
	dataDir: "string > 0 = './data'",
	server: type({
		/** 127.0.0.1 keeps the UI on this machine; 0.0.0.0 exposes it to the LAN. */
		host: "string = '127.0.0.1'",
		port: "1 <= number.integer <= 65535 = 4040"
	}).default(() => ({})),
	sources: SourceConfig.array().default(() => []),
	pipeline: type({
		/** Clips processed at once. */
		concurrency: "1 <= number.integer <= 8 = 1",
		/** The region worth watching (the feeder), in normalized full-frame coordinates. Null = whole frame. */
		roi: NormBox.or("null").default(null),
		/**
		 * Boxes around each feeder, in normalized full-frame coordinates. The detector always runs a
		 * zoomed view on each, motion or not: a bird clinging to a feeder barely moves, so the motion
		 * boxes land on a swaying feeder elsewhere and a ~40 px nuthatch is lost in the ROI view.
		 */
		feeders: NormBox.array().default(() => []),
		motion: type({
			/** Frames per second sampled for the motion gate. */
			sampleFps: "0 < number <= 10 = 2",
			/** Per-pixel luma change (0..255) that counts as "changed", after lighting compensation. */
			pixelThreshold: "1 <= number <= 255 = 22",
			/** Minimum fraction of the ROI that must change for a clip to pass. */
			minArea: `${unit} = 0.0008`,
			/** A frame changing more than this fraction is treated as a global change (light, IR switch, shake). */
			maxArea: `${unit} = 0.7`,
			/** Candidate frames handed to the detector; a long clip gets at least one per 10 s, up to 24. */
			maxFrames: "1 <= number.integer <= 24 = 6"
		}).default(() => ({})),
		detector: type({
			/** Off = skip the local detector; the judge gets motion-region crops instead. */
			enabled: "boolean = true",
			/** Hugging Face model id for transformers.js zero-shot object detection; a `:fp32` (or `:q4`, `:fp16`) suffix picks the weights, default q8. */
			model: "string = 'Xenova/owlvit-base-patch32'",
			// 0.15: an empty snowy feeder scored up to 0.105 as "squirrel"; every bird clip scored >= 0.49
			threshold: `${unit} = 0.15`,
			/** Also run detection on crops around motion regions, and tile the zone when a moving clip yields nothing; finds small, distant or half-hidden subjects. */
			zoom: "boolean = true"
		}).default(() => ({})),
		judge: type({
			/** `auto`: anthropic if ANTHROPIC_API_KEY is set, else claude-code if `claude` is on PATH, else none. */
			provider: "'auto' | 'anthropic' | 'claude-code' | 'mock' | 'none' = 'auto'",
			model: "string = 'claude-haiku-5-5'",
			/** Re-ask a stronger model when the first answer's confidence falls in [escalateBelow - 0.3, escalateBelow). Null = never. */
			escalateModel: "string | null = null",
			escalateBelow: `${unit} = 0.6`,
			/** Crops sent per clip, plus one context frame. */
			maxCrops: "1 <= number.integer <= 8 = 4",
			/** Long edge, in pixels, of each crop sent to the judge. */
			cropSize: "128 <= number.integer <= 1568 = 512"
		}).default(() => ({}))
	}).default(() => ({})),
	alerts: type({
		/** Desktop notifications when a lookout spots something (each browser must also allow them). */
		desktop: "boolean = true"
	}).default(() => ({})),
	retention: type({
		/** Rejected clips (and their media) are deleted after this many days. Labeled clips are never deleted. */
		rejectedDays: "number >= 0 = 7",
		/** Clips with no motion at all go sooner. 0 = delete as soon as they are rejected. */
		motionlessDays: "number >= 0 = 2",
		/**
		 * Free space (GB) to leave on the data disk. Below it new clips are refused (sources
		 * report why) and rejected clips are deleted ahead of schedule, soonest-to-expire first.
		 * Kept and labeled clips are never deleted for space. 0 = no floor.
		 */
		minFreeGb: "number >= 0 = 5",
		/**
		 * The most footage the camera didn't flag (`unchecked/`, from stream capture) to keep, in GB;
		 * the oldest goes first. A 4K main stream is about 20 GB a day, so `motionlessDays` alone
		 * could fill the disk. Under the disk floor it goes before any rejected clip. 0 = keep none.
		 */
		uncheckedGb: "number >= 0 = 10"
	}).default(() => ({}))
})

export type Config = typeof Config.infer
export type ConfigInput = typeof Config.inferIn

/** A loaded config plus where it came from. `dataDir` is absolute. */
export type LoadedConfig = Config & { configPath: string | null; rootDir: string }

export const CONFIG_FILE = "look4.config.json"

export const findConfigPath = (cwd = process.cwd()): string | null => {
	const fromEnv = process.env.LOOK4_CONFIG
	if (fromEnv) return resolve(cwd, fromEnv)
	const candidate = resolve(cwd, CONFIG_FILE)
	return existsSync(candidate) ? candidate : null
}

/** Loads `.env` next to the config (if any) into process.env without overriding what is already set. */
export const loadEnv = (rootDir: string) => {
	const envPath = resolve(rootDir, ".env")
	if (!existsSync(envPath)) return
	const before = { ...process.env }
	process.loadEnvFile(envPath)
	for (const [k, v] of Object.entries(before)) process.env[k] = v
}

export class ConfigError extends Error {}

export const parseConfig = (input: unknown, configPath: string | null, rootDir: string): LoadedConfig => {
	const out = Config(input)
	if (out instanceof type.errors)
		throw new ConfigError(`${configPath ?? "config"} is invalid:\n${out.summary}`)
	for (const s of out.sources) {
		if (s.type === "rtsp" && !s.url && !s.urlEnv)
			throw new ConfigError(`source "${s.name}": rtsp needs \`url\` or \`urlEnv\``)
	}
	const names = out.sources.map(s => s.name)
	const dupe = names.find((n, i) => names.indexOf(n) !== i)
	if (dupe) throw new ConfigError(`source name "${dupe}" is used twice`)
	return {
		...out,
		dataDir: isAbsolute(out.dataDir) ? out.dataDir : resolve(rootDir, out.dataDir),
		configPath,
		rootDir
	}
}

/** Reads and validates the config. With no config file, every default applies. */
export const loadConfig = (configPath = findConfigPath()): LoadedConfig => {
	const rootDir = configPath ? dirname(configPath) : process.cwd()
	loadEnv(rootDir)
	const raw = configPath ? JSON.parse(readFileSync(configPath, "utf8")) : {}
	return parseConfig(raw, configPath, rootDir)
}

/**
 * Applies a partial update to the config file on disk (the UI edits the ROI and
 * thresholds this way) and returns the re-validated result.
 */
export const updateConfigFile = (
	configPath: string,
	update: (raw: Record<string, any>) => void
): LoadedConfig => {
	const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {}
	update(raw)
	const loaded = parseConfig(raw, configPath, dirname(configPath))
	writeFileSync(configPath, JSON.stringify(raw, null, "\t") + "\n")
	return loaded
}

/** JSON Schema for editor autocomplete in look4.config.json (`$schema`). */
export const configJsonSchema = () =>
	Config.in.toJsonSchema({ fallback: { default: ctx => ctx.base } })
