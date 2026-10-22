import type {
	AddSourceBody,
	CameraControls,
	CameraSettingBody,
	CameraState,
	LightBody,
	LiveRecordBody,
	LiveRecordSaved,
	LiveRecordStarted,
	LiveSourceDto,
	LiveStream,
	PresetBody,
	ProbeResult,
	PtzBody,
	BackfillBody,
	CameraTestBody,
	CameraTestResult,
	BackfillResponse,
	ClipDetail,
	ClipSummary,
	CompilePreviewBody,
	CompilePreviewResponse,
	CompleteSetupBody,
	CreateLookoutBody,
	DiscoverResponse,
	FolderListing,
	JudgeKeyBody,
	LabelBody,
	LifeListResponse,
	AddLiferBody,
	ConfirmClipBody,
	ConfirmClipResponse,
	LookoutDto,
	Page,
	ReprocessBody,
	RtspTestBody,
	RtspTestResult,
	SettingsDto,
	SettingsPatch,
	SetupStatus,
	SourceDto,
	StatsResponse,
	UnseenSightingsResponse,
	UpdateLookoutBody,
	UpdateSourceBody,
	UploadResponse
} from "../../src/api-types.ts"

export class ApiError extends Error {
	status: number
	constructor(message: string, status: number) {
		super(message)
		this.status = status
	}
}

type RequestOpts = { method?: string; body?: unknown; signal?: AbortSignal }

export const request = async <t>(path: string, opts: RequestOpts = {}): Promise<t> => {
	let res: Response
	try {
		res = await fetch(path, {
			method: opts.method ?? "GET",
			headers: opts.body === undefined ? undefined : { "content-type": "application/json" },
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
			signal: opts.signal
		})
	} catch (e) {
		if (opts.signal?.aborted) throw e
		throw new ApiError("Can't reach look4. Is look4 running (pnpm start)?", 0)
	}
	const text = await res.text()
	let data: any = null
	try {
		data = text ? JSON.parse(text) : null
	} catch {
		if (res.ok) throw new ApiError(`Unexpected response from ${path}`, res.status)
	}
	if (!res.ok) throw new ApiError(data?.error ?? `${res.status} ${res.statusText}`, res.status)
	return data as t
}

const qs = (q: Record<string, string | number | null | undefined>) => {
	const p = new URLSearchParams()
	for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v))
	const s = p.toString()
	return s ? `?${s}` : ""
}

export type ClipQuery = {
	status?: string
	droppedAt?: string
	source?: string
	lookout?: string
	before?: string | null
	limit?: number
}

const enc = encodeURIComponent

export const api = {
	stats: (signal?: AbortSignal) => request<StatsResponse>("/api/stats", { signal }),
	sightings: (q: { lookout?: string; before?: string | null; limit?: number }, signal?: AbortSignal) =>
		request<Page<ClipSummary>>(`/api/sightings${qs(q)}`, { signal }),
	unseenSightings: (since: string, signal?: AbortSignal) =>
		request<UnseenSightingsResponse>(`/api/sightings/unseen${qs({ since })}`, { signal }),
	clips: (q: ClipQuery, signal?: AbortSignal) => request<Page<ClipSummary>>(`/api/clips${qs(q)}`, { signal }),
	clip: (id: string, signal?: AbortSignal) => request<ClipDetail>(`/api/clips/${enc(id)}`, { signal }),
	label: (id: string, body: LabelBody) =>
		request<ClipDetail>(`/api/clips/${enc(id)}/label`, { method: "POST", body }),
	reprocess: (id: string, body: ReprocessBody = {}) =>
		request<{ ok: true }>(`/api/clips/${enc(id)}/reprocess`, { method: "POST", body }),
	deleteClip: (id: string) => request<{ ok: true }>(`/api/clips/${enc(id)}`, { method: "DELETE" }),
	lifeList: (signal?: AbortSignal) => request<LifeListResponse>("/api/life-list", { signal }),
	addLifer: (body: AddLiferBody) => request<LifeListResponse>("/api/life-list", { method: "POST", body }),
	confirmClip: (id: string, body: ConfirmClipBody = {}) =>
		request<ConfirmClipResponse>(`/api/clips/${enc(id)}/confirm`, { method: "POST", body }),
	removeLifer: (species: string) => request<LifeListResponse>(`/api/life-list/${enc(species)}`, { method: "DELETE" }),
	lookouts: (signal?: AbortSignal) => request<LookoutDto[]>("/api/lookouts", { signal }),
	createLookout: (body: CreateLookoutBody) => request<LookoutDto>("/api/lookouts", { method: "POST", body }),
	updateLookout: (id: string, body: UpdateLookoutBody) =>
		request<LookoutDto>(`/api/lookouts/${enc(id)}`, { method: "PATCH", body }),
	deleteLookout: (id: string) => request<{ ok: true }>(`/api/lookouts/${enc(id)}`, { method: "DELETE" }),
	preview: (body: CompilePreviewBody, signal?: AbortSignal) =>
		request<CompilePreviewResponse>("/api/lookouts/preview", { method: "POST", body, signal }),
	backfill: (id: string, body: BackfillBody) =>
		request<BackfillResponse>(`/api/lookouts/${enc(id)}/backfill`, { method: "POST", body }),
	settings: (signal?: AbortSignal) => request<SettingsDto>("/api/settings", { signal }),
	patchSettings: (body: SettingsPatch) => request<SettingsDto>("/api/settings", { method: "PATCH", body }),
	pollSource: (name: string) => request<{ ok: true }>(`/api/sources/${enc(name)}/poll`, { method: "POST" }),

	// guided setup
	setup: (signal?: AbortSignal) => request<SetupStatus>("/api/setup", { signal }),
	completeSetup: (body: CompleteSetupBody = {}) => request<SetupStatus>("/api/setup/complete", { method: "POST", body }),
	discover: (signal?: AbortSignal) => request<DiscoverResponse>("/api/setup/discover", { method: "POST", signal }),
	testCamera: (body: CameraTestBody, signal?: AbortSignal) =>
		request<CameraTestResult>("/api/setup/test-camera", { method: "POST", body, signal }),
	testRtsp: (body: RtspTestBody, signal?: AbortSignal) =>
		request<RtspTestResult>("/api/setup/test-rtsp", { method: "POST", body, signal }),
	saveJudgeKey: (body: JudgeKeyBody) => request<SetupStatus>("/api/setup/judge-key", { method: "POST", body }),
	listFolder: (path: string | null, signal?: AbortSignal) => request<FolderListing>(`/api/fs/list${qs({ path })}`, { signal }),
	sources: (signal?: AbortSignal) => request<SourceDto[]>("/api/sources", { signal }),
	addSource: (body: AddSourceBody) => request<SourceDto>("/api/sources", { method: "POST", body }),
	updateSource: (name: string, body: UpdateSourceBody) =>
		request<SourceDto>(`/api/sources/${enc(name)}`, { method: "PATCH", body }),
	deleteSource: (name: string) => request<{ ok: true }>(`/api/sources/${enc(name)}`, { method: "DELETE" }),
	/** Which ports answer at an address; never signs in, so it is safe to repeat. */
	probe: (host: string, signal?: AbortSignal) => request<ProbeResult>("/api/setup/probe", { method: "POST", body: { host }, signal }),

	// live view
	live: (signal?: AbortSignal) => request<LiveSourceDto[]>("/api/live", { signal }),
	controls: (name: string, signal?: AbortSignal) => request<CameraControls>(`/api/live/${enc(name)}/controls`, { signal }),
	cameraState: (name: string, signal?: AbortSignal) => request<CameraState>(`/api/live/${enc(name)}/state`, { signal }),
	ptz: (name: string, body: PtzBody) => request<{ ok: true }>(`/api/live/${enc(name)}/ptz`, { method: "POST", body }),
	light: (name: string, body: LightBody) => request<CameraControls>(`/api/live/${enc(name)}/light`, { method: "POST", body }),
	cameraSetting: (name: string, body: CameraSettingBody) =>
		request<CameraControls>(`/api/live/${enc(name)}/setting`, { method: "POST", body }),
	preset: (name: string, body: PresetBody) => request<CameraControls>(`/api/live/${enc(name)}/preset`, { method: "POST", body }),
	/** One burst of the camera's siren. */
	siren: (name: string) => request<{ ok: true }>(`/api/live/${enc(name)}/siren`, { method: "POST", body: {} }),
	record: <body extends LiveRecordBody>(name: string, body: body) =>
		request<body extends { op: "start" } ? LiveRecordStarted : body extends { op: "stop" } ? LiveRecordSaved : { ok: true }>(
			`/api/live/${enc(name)}/record`,
			{ method: "POST", body }
		)
}

/** Live video URLs: `mp4` for Media Source Extensions, `mjpeg` for anything else (and still pictures). */
export const liveUrl = (name: string, kind: "mp4" | "mjpeg" | "snapshot", stream: LiveStream, extra = "") =>
	`/api/live/${enc(name)}/${kind}?stream=${stream}${extra}`

/** A live frame from one source; `bust` makes the browser fetch a fresh one. */
export const sourceSnapshotUrl = (name: string, bust: number = Date.now()) => `/api/sources/${enc(name)}/snapshot?t=${bust}`

/**
 * One request per file with the raw File as the body, so the server can stream
 * big videos to disk. XHR rather than fetch because only XHR reports upload progress.
 */
export const uploadFile = (
	file: File,
	onProgress: (fraction: number) => void
): { promise: Promise<UploadResponse>; abort: () => void } => {
	const xhr = new XMLHttpRequest()
	const promise = new Promise<UploadResponse>((resolve, reject) => {
		xhr.open("POST", `/api/upload?name=${enc(file.name)}&lastModified=${file.lastModified}`)
		xhr.setRequestHeader("content-type", file.type || "application/octet-stream")
		xhr.upload.onprogress = e => {
			if (e.lengthComputable) onProgress(e.loaded / e.total)
		}
		xhr.onload = () => {
			let data: any = null
			try {
				data = JSON.parse(xhr.responseText)
			} catch {}
			if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data as UploadResponse)
			else reject(new ApiError(data?.error ?? `Upload failed (${xhr.status})`, xhr.status))
		}
		xhr.onerror = () => reject(new ApiError("Upload failed: look4 is unreachable", 0))
		xhr.onabort = () => reject(new ApiError("Upload cancelled", 0))
		xhr.send(file)
	})
	return { promise, abort: () => xhr.abort() }
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))
