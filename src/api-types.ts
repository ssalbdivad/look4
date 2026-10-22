// The HTTP contract between src/server and web/. Both sides import this file.

import type { SourceConfig } from "./config.ts"
import type { Funnel } from "./db.ts"
import type {
	Clip,
	ClipStatus,
	CompiledLookout,
	Detection,
	Label,
	LifeListEntry,
	Lookout,
	NormBox,
	SourceStatus,
	Stage,
	Verdict
} from "./types.ts"

export type { Funnel }

/** Absolute URL paths (`/media/<id>/poster.jpg`), or null when the file does not exist. */
export type MediaUrls = {
	poster: string | null
	/** Browser-safe H.264 preview; null for clips that were not kept. */
	preview: string | null
	/** The original file as recorded; null once retention deleted it. */
	original: string | null
	crops: string[]
	/** Stills the camera zoomed in for while this clip was recorded (`closeUps` on its source), first taken first. */
	closeUps: string[]
}

export type ClipMatch = {
	lookoutId: string
	lookoutName: string
	label: string | null
	/** The bird's species, when the judge named one. */
	species: string | null
	/** How sure the judge is of `species`, 0 to 1; null without one and on older verdicts. */
	speciesConfidence: number | null
	confidence: number
}

export type ClipSummary = {
	id: string
	source: string
	recordedAt: string
	durationS: number | null
	status: ClipStatus
	droppedAt: Stage | null
	reason: string | null
	media: MediaUrls
	/** Verdicts that kept the clip (match and at/above threshold), best first. */
	matches: ClipMatch[]
	/** A species a keeping verdict named that is not on the life list yet, or is on it without a clip: one to confirm. */
	newSpecies: string | null
	/** Someone confirmed it (a "yes, that's it" label on any lookout). */
	confirmed: boolean
}

/** GET /api/sightings/unseen?since=<iso>: sightings ingested after `since`, newest first, at most 100. */
export type UnseenSightingsResponse = { ids: string[] }

export type Page<t> = {
	items: t[]
	/** Pass back as `before` for the next page; null at the end. */
	nextBefore: string | null
}

export type ClipDetail = ClipSummary & {
	clip: Clip
	verdicts: Array<Verdict & { lookoutName: string; threshold: number }>
	detections: Detection[]
	labels: Label[]
	usage: { calls: number; inputTokens: number; outputTokens: number; costUsd: number }
}

export type LookoutStats = {
	/** Clips kept for this lookout. */
	kept: number
	/** Clips the judge looked at for this lookout. */
	judged: number
	/** Clips a human labeled for this lookout. */
	labeled: number
	/** From labels: of kept clips labeled, the fraction that were right. Null with no labels. */
	precision: number | null
	/** From labels: of clips labeled true, the fraction kept. Null with no positive labels. */
	recall: number | null
	lastSeenAt: string | null
}

export type LookoutDto = Lookout & { stats: LookoutStats }

export type CreateLookoutBody = {
	prompt: string
	/** Defaults to a slug of the compiled summary. */
	name?: string
	threshold?: number
	enabled?: boolean
}

export type UpdateLookoutBody = {
	name?: string
	prompt?: string
	threshold?: number
	enabled?: boolean
	/** Overrides the compiled detector nouns (sets compiler to "manual"). */
	queries?: string[]
}

export type CompilePreviewBody = { prompt: string }
export type CompilePreviewResponse = CompiledLookout

export type BackfillBody = {
	/** Only clips recorded at or after this ISO time. Default: every clip whose file still exists. */
	since?: string
}
export type BackfillResponse = { queued: number }

export type LabelBody = {
	lookoutId: string
	/** true = this clip shows it, false = it does not, null = clear the label. */
	truth: boolean | null
}

export type ReprocessBody = { lookoutIds?: string[] }

export type ComponentStatus = { ok: boolean; detail: string }

export type StatsResponse = {
	funnel: { today: Funnel; week: Funnel; all: Funnel }
	cost: { todayUsd: number; monthUsd: number; allUsd: number; callsToday: number }
	queue: { pending: number; processing: number }
	sources: SourceStatus[]
	pipeline: {
		judge: ComponentStatus & { provider: string; model: string }
		detector: ComponentStatus & { enabled: boolean; model: string }
		roi: NormBox | null
	}
	/** Bytes used under the data directory (clips + kept + media). */
	diskBytes: number
	/** Free bytes on the disk holding the data directory (`freeBytes(dataDir)` in src/retention.ts). */
	diskFreeBytes?: number
	/** `retention.minFreeGb` in bytes: below it new clips are refused and rejected clips are deleted early. 0 = no floor. */
	diskFloorBytes?: number
	version: string
}

/** Source config with secrets elided (a password env var NAME is fine; a URL with credentials is masked). */
export type SettingsDto = {
	configPath: string | null
	dataDir: string
	server: { host: string; port: number }
	roi: NormBox | null
	motion: { sampleFps: number; pixelThreshold: number; minArea: number; maxArea: number; maxFrames: number }
	detector: { enabled: boolean; model: string; threshold: number; zoom: boolean }
	judge: {
		provider: string
		model: string
		escalateModel: string | null
		escalateBelow: number
		maxCrops: number
		cropSize: number
	}
	retention: { rejectedDays: number; motionlessDays: number; minFreeGb?: number; uncheckedGb?: number }
	/** Desktop notifications when a lookout spots something (each browser also has to allow them). */
	alerts: { desktop: boolean }
	sources: SourceConfig[]
}

export type SettingsPatch = {
	roi?: NormBox | null
	motion?: Partial<SettingsDto["motion"]>
	detector?: Partial<SettingsDto["detector"]>
	judge?: Partial<SettingsDto["judge"]>
	retention?: Partial<SettingsDto["retention"]>
	alerts?: Partial<SettingsDto["alerts"]>
}

export type UploadResponse = { clips: ClipSummary[] }

export type ApiError = { error: string }

/** A lookout matched: what a notification needs to say without another request. */
export type SightingEvent = {
	clipId: string
	lookoutId: string
	lookoutName: string
	label: string | null
	confidence: number
	/** The source (camera) the clip came from. */
	source: string
	/** ISO time the clip starts. */
	recordedAt: string
	/** URL of the first close-up, else the best crop, else the poster; null when none exists yet. */
	image: string | null
	/** Found by re-checking past footage (a lookout's backfill): it updates the feed but notifies no one. */
	recheck?: true
}

/** Server-sent events on GET /api/events: `event: <name>` with `data: <json>`. */
export type SseEvent =
	| { event: "clip"; data: { clipId: string; status: string } }
	| { event: "sighting"; data: SightingEvent }
	| { event: "source"; data: SourceStatus }
	| { event: "queue"; data: { pending: number; processing: number } }
	| { event: "lookout"; data: { lookoutId: string } }
	| { event: "lifelist"; data: { species: string } }

// ---- life list ----

export type LifeListEntryDto = LifeListEntry & {
	/** Clips the judge has named this species in (kept or not). */
	sightings: number
	lastSeenAt: string | null
	/** A close-up from the confirmed clip, while it exists. */
	image: string | null
}

export type LifeListResponse = { entries: LifeListEntryDto[] }

/** Confirm a sighting's species (`clipId`, first seen when it was recorded) or add one by hand (`seenAt`, optional). */
export type AddLiferBody = { species: string; clipId?: string; seenAt?: string }

/** Confirm a sighting: "yes" on each lookout that kept it, and its bird onto the life list if it isn't there. */
export type ConfirmClipBody = {
	/** The bird's species; defaults to the one the spotter named. */
	species?: string
}

/** "Wrong bird": the sighting is not what the spotter said. */
export type WrongBirdBody = {
	/** What it really was, when known. */
	species?: string | null
}

export type WrongBirdResponse = {
	clip: ClipSummary
	/** The lookouts it said "no" for: clearing their labels undoes it. */
	undo: string[]
}

export type ConfirmClipResponse = {
	clip: ClipSummary
	/** The species this added to the life list; null when it was already there or none was named. */
	added: string | null
}

// ---- guided setup (first-run wizard + source management) ----

/** Which services a device answers on. */
export type DevicePorts = {
	https: boolean
	http: boolean
	rtsp: boolean
	/** Reolink's proprietary app/media port (9000). Open on every Reolink camera, even with HTTP/HTTPS off. */
	reolinkApp: boolean
	onvif: boolean
}

export type DiscoveredCamera = {
	host: string
	mac: string | null
	/** From the MAC vendor prefix, an HTTP banner, or the Reolink app port. */
	vendor: "reolink" | "unknown"
	ports: DevicePorts
	/** Name of the configured source already pointing at this host, if any. */
	configuredAs: string | null
}

export type DiscoverResponse = {
	cameras: DiscoveredCamera[]
	/** e.g. ["192.168.1.0/24"]. */
	scannedSubnets: string[]
	/** A plain sentence when the scan could not run fully ("couldn't read this PC's network, enter the address by hand"). */
	note: string | null
}

export type CameraTestBody = {
	host: string
	username?: string
	/** Empty string = a camera with no password (Reolink's factory default). */
	password?: string
	protocol?: "auto" | "http" | "https"
	/** Name of a configured source whose saved username/password to use when `password` is omitted (Fix it / Edit without retyping). */
	source?: string
}

/** What went wrong, so the UI can show the matching walkthrough. */
export type CameraProblem =
	| "unreachable" // nothing answers at that address
	| "http-disabled" // the camera answers (app port) but its HTTP/HTTPS servers are off
	| "bad-credentials"
	| "locked-out" // too many failed logins; the camera blocks logins for a while
	| "not-reolink" // something answers HTTP but it is not a Reolink camera API
	| "unknown"

export type CameraTestResult = {
	ok: boolean
	problem: CameraProblem | null
	/** One plain-language sentence for a non-technical user. */
	detail: string
	model?: string
	firmware?: string
	/** The camera's own name ("Backyard"), when it reports one. */
	name?: string
	protocol?: "http" | "https"
	ports: DevicePorts
	/** For `locked-out`: seconds until the camera accepts logins again, when known. */
	retryAfterSeconds?: number
	/** For `bad-credentials`: wrong passwords the camera still allows before it locks sign-ins, when it says. */
	attemptsLeft?: number
}

/** Test an RTSP (or any ffmpeg-readable) URL before saving: grabs one frame. */
export type RtspTestBody = { url: string }

export type RtspTestResult = {
	ok: boolean
	/** One plain-language sentence ("Got a picture from the camera", "Wrong username or password in the address", "Nothing answered at that address"). */
	detail: string
	width?: number
	height?: number
	codec?: string
	/** A data: URL (image/jpeg) of the grabbed frame, so the UI can show it before saving. */
	preview?: string
}

export type AddSourceBody =
	| {
			type: "reolink"
			name?: string
			host: string
			username?: string
			/** Stored in `.env`, never in look4.config.json. Empty string = no password. */
			password?: string
			stream?: "main" | "sub"
			lookbackHours?: number
	  }
	| { type: "watch"; name?: string; dir: string; move?: boolean }
	| {
			type: "rtsp"
			name?: string
			/** Stored in `.env` (it usually embeds credentials); the config keeps only the env var name. */
			url: string
			segmentSeconds?: number
	  }

export type UpdateSourceBody = {
	host?: string
	username?: string
	password?: string
	stream?: "main" | "sub"
	dir?: string
	move?: boolean
	url?: string
	/** false = keep the config entry but stop the adapter. */
	enabled?: boolean
	/** Reolink only: where clips come from. */
	capture?: "auto" | "stream" | "sd"
	/** Reolink only: with clips from the stream, check what look4's watch or the camera sees move, only what the camera flags, or everything. */
	motionGate?: "both" | "camera" | "all"
	/** Reolink only: zoom in on birds for a close-up still, then go back Home. Takes effect without restarting the source. */
	closeUps?: boolean
}

/** A configured source with secrets elided, plus its live status. */
export type SourceDto = {
	config: SourceConfig
	status: SourceStatus
}

export type SetupStatus = {
	/** The wizard was finished or skipped (or the app was already configured before the wizard existed). */
	completed: boolean
	steps: {
		/** At least one configured source (or the user chose "just upload"). */
		source: boolean
		zone: boolean
		lookout: boolean
		judge: boolean
	}
	sources: SourceDto[]
	judge: ComponentStatus & { provider: string; model: string }
	detector: ComponentStatus & { enabled: boolean; model: string }
	/** Where settings are written; null until the first save creates look4.config.json. */
	configPath: string | null
}

export type CompleteSetupBody = { skipped?: boolean; uploadOnly?: boolean }

export type JudgeKeyBody = { apiKey: string }

/** Read-only folder browser for picking a watch folder without typing a path. */
export type FolderListing = {
	path: string
	parent: string | null
	/** Handy starting points: home, Windows drives under /mnt on WSL, Desktop/Videos/Downloads. */
	shortcuts: Array<{ label: string; path: string }>
	dirs: Array<{ name: string; path: string }>
	/** Video files directly in `path`. */
	videoCount: number
}

// ---- live view + camera control ----

export type LiveStream = "main" | "sub"

/**
 * Why a source has no smooth live video, so the UI can say what to do:
 * `rtsp-off` the camera's RTSP switch is off (or its port is wrong); `needs-password`
 * a Reolink camera with no password, whose RTSP refuses every login; `login-refused`
 * the camera turned down the saved password; `no-address` an RTSP source with no URL saved.
 */
export type LiveProblem = "rtsp-off" | "needs-password" | "login-refused" | "no-address"

/**
 * A configured source that can show live video. Folder sources have no live view and are left out.
 * Several sources that are the same camera (a Reolink source plus an RTSP source at the same host)
 * are one entry: the Reolink one, since it can be steered.
 */
export type LiveSourceDto = {
	name: string
	type: "reolink" | "rtsp"
	/** `stream`: real video; `stills`: a fresh picture every second or so (the camera's stream is off, but its web API answers); null: nothing to show. */
	feed: "stream" | "stills" | null
	/** The streams to choose between: Reolink (and cameras with a recognisable URL) offer a light `sub` and a full `main`. Empty = one stream only. */
	streams: LiveStream[]
	/** The stream the page opens on: `main` ("Sharp") whenever the camera has one. */
	defaultStream: LiveStream
	problem: LiveProblem | null
	/** One plain sentence about `problem`. */
	detail: string | null
	/** A control driver exists for this camera (PTZ, lights); GET /api/live/:name/controls says which controls it has. */
	controllable: boolean
	/** The camera's address, for the "turn on RTSP" walkthrough. */
	host: string | null
	/** Other configured sources folded into this entry because they are the same camera. */
	aliases: string[]
	/** look4 is recording this camera's stream, so POST /api/live/:name/record can save a clip. */
	recording: boolean
}

export type PtzDirection = "up" | "down" | "left" | "right" | "upLeft" | "upRight" | "downLeft" | "downRight"

/**
 * One camera move. Continuous ops (`move`, `zoom`, `focus`) run until `stop`; the server stops them
 * by itself after a few seconds if the release never arrives. `speed` is 1–64 in camera units; left
 * out, the server picks one from the current zoom (slower when zoomed in).
 */
export type PtzBody =
	| { op: "move"; direction: PtzDirection; speed?: number; /** Half the automatic speed (Shift held). */ slow?: boolean }
	| { op: "zoom"; direction: "in" | "out"; speed?: number; slow?: boolean }
	| { op: "focus"; direction: "near" | "far"; speed?: number; slow?: boolean }
	| { op: "stop" }
	| { op: "preset"; id: number }
	/**
	 * Absolute optical zoom, within `CameraControls.ptz.zoomRange`. `aim` first centres that point of the
	 * picture (normalized, as it is now; needs `box`), then zooms. `settle`: answers once the camera's position
	 * has stopped changing (at most about 3 s), so the caller knows the camera's view is where it was sent.
	 */
	| { op: "zoomTo"; pos: number; aim?: { x: number; y: number }; settle?: true }
	/** Absolute focus, within `CameraControls.ptz.focusRange`. */
	| { op: "focusTo"; pos: number }
	/** Back to the Home view: the camera's guard point. */
	| { op: "home" }
	/**
	 * Frame this part of the picture: centre the box (Reolink `Set3DPos` with a point) and zoom optically so it
	 * fills the view (`ZoomPos`, by the lens's measured curve, as far as it goes). Normalized 0–1 full-frame
	 * coordinates, top-left corner plus size; w = h = 0 only centres on the point.
	 */
	| { op: "box"; x: number; y: number; w: number; h: number; speed?: number }

/** A light the camera can switch. `on` for IR means "automatic at night", off means never. */
export type CameraLight = {
	id: "ir" | "spotlight"
	label: string
	on: boolean
	detail: string
	/** Spotlight brightness 0–100, when the camera can dim it. */
	brightness?: number
}

/**
 * How far the picture is magnified in the browser on top of the camera's own view: `z` (1 = not at all,
 * up to 8) and the point of the full frame (normalized, top-left origin) at the picture's centre.
 */
export type DigitalView = { z: number; cx: number; cy: number }

export type CameraPreset = {
	/** The camera's slot id (Reolink: 0-based). */
	id: number
	name: string
	/** GET URL of the view's thumbnail, or null when there is none. */
	image: string | null
	/** The magnification saved with the view, restored on going to it; null: none. */
	digital: DigitalView | null
}

export type PositionRange = { min: number; max: number; pos: number }

export type DayNightMode = "auto" | "color" | "bw"

/** What the camera reports it can do; a control the camera lacks is absent (null / false / empty), so the UI hides it. */
export type CameraControls = {
	ptz: {
		pan: boolean
		tilt: boolean
		zoom: boolean
		/** Focus near/far (and `focusRange` when it has a slider). */
		focus: boolean
		/** Absolute zoom and its current position, when the camera has a zoom slider. */
		zoomRange: PositionRange | null
		focusRange: PositionRange | null
		/** Autofocus on or off; null when it can't be switched. */
		autofocus: boolean | null
		/** Drag a box on the picture to frame it (`op: "box"`). */
		box: boolean
		/** The camera honours `speed`. */
		speed: boolean
		presets: CameraPreset[]
		/** Slots for saved views; 0 = the camera can't save new ones. */
		maxPresets: number
		/**
		 * The Home view (the camera's guard point): `set` once one is saved; `autoReturn` brings the
		 * camera back there after `timeoutS` seconds with nothing moving it. Null when the camera has none.
		 */
		guard: { set: boolean; autoReturn: boolean; timeoutS: number; minS: number; maxS: number; /** As for a preset. */ digital: DigitalView | null } | null
		/** The camera's own auto-tracking (it follows people, vehicles or animals); null when it has none. */
		tracking: { on: boolean } | null
	} | null
	lights: CameraLight[]
	/** Colour vs black-and-white picture at night; null when the camera can't switch. */
	dayNight: DayNightMode | null
	/** The camera can sound its siren. */
	siren: boolean
	/**
	 * The camera's microphone (Reolink `Enc.audio`). Null when it has none. Turning it on also adds
	 * sound to the camera's own recordings.
	 */
	microphone: boolean | null
	/** A full-resolution still straight from the camera (Reolink `Snap`). */
	snapshot: boolean
	/** e.g. "RLC-823S1", when known. */
	model: string | null
}

/** GET /api/live/:name/state, polled while the page is visible. */
export type CameraState = {
	/** The camera is moving right now. */
	moving: boolean
	/** At the Home view; null when unknown (no Home saved yet, or the camera can't say). */
	atHome: boolean | null
	zoom: number | null
	focus: number | null
}

export type LightBody = { id: CameraLight["id"]; on?: boolean; brightness?: number }

/** POST /api/live/:name/setting → CameraControls. Each changes a setting on the camera itself. */
export type CameraSettingBody =
	| { setting: "dayNight"; mode: DayNightMode }
	| { setting: "tracking"; on: boolean }
	| { setting: "microphone"; on: boolean }
	| { setting: "autofocus"; on: boolean }
	/**
	 * `saveHere` makes the camera's current view Home, with `digital` as its magnification; `autoReturn` /
	 * `timeoutS` change the return without moving Home.
	 */
	| { setting: "home"; saveHere?: boolean; digital?: DigitalView | null; autoReturn?: boolean; timeoutS?: number }

/**
 * POST /api/live/:name/preset → CameraControls. `save` stores the camera's current view (a new slot, or `id`
 * to overwrite) and `digital`, the picture's magnification at the time.
 */
export type PresetBody = { op: "save"; name: string; id?: number; digital?: DigitalView | null } | { op: "rename"; id: number; name: string } | { op: "delete"; id: number }

/** POST /api/live/:name/record: start keeps the last few seconds too; stop saves everything since as a kept clip. */
export type LiveRecordBody = { op: "start" } | { op: "stop"; id: string } | { op: "cancel"; id: string }
export type LiveRecordStarted = {
	id: string
	/** ISO time the clip will start at (a little before the press). */
	from: string
	/** Recording stops and saves by itself after this long. */
	maxSeconds: number
}
export type LiveRecordSaved = { clipId: string }

/** POST /api/setup/probe: which ports answer at an address. Never signs in. */
export type ProbeBody = { host: string }
export type ProbeResult = { host: string; ports: DevicePorts }
