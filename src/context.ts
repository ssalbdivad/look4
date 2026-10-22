import type { LoadedConfig } from "./config.ts"
import type { Store } from "./db.ts"
import type { Bus } from "./events.ts"
import type { VisionLLM } from "./llm/types.ts"
import type { DataPaths } from "./paths.ts"
import type { Detector } from "./pipeline/types.ts"
import type { LiveRecorder } from "./sources/recorder.ts"
import type { Clip, CompiledLookout, SourceStatus } from "./types.ts"

export type IngestInput = {
	/** Path to a complete video file. */
	file: string
	/** Source name: a configured source, or "inbox", "upload", "scan". */
	source: string
	sourceRef?: string | null
	/** Defaults to the file's basename. */
	originalName?: string
	/** ISO time of the event. Default: parsed from the name (Reolink, common NVR patterns), else the file mtime. */
	recordedAt?: string
	/** `move` takes the file (inbox, uploads, temp downloads); `copy` leaves the original. */
	mode: "copy" | "move"
	/**
	 * A stream capture's motion gate made this clip: the camera's own detection, look4's watch of
	 * its preview stream, or both. Stored as kv `gate:<id>`; the pipeline's motion stage never
	 * drops such a clip, since the gate already saw something move (docs/decisions.md §12).
	 */
	gate?: "camera" | "look4" | "both"
}

export type IngestResult = {
	clip: Clip
	/** The same bytes were already ingested (sha256 match); nothing new was stored. */
	duplicate: boolean
}

/** Everything a long-running look4 process shares. Built by src/app.ts. */
export type AppContext = {
	config: LoadedConfig
	paths: DataPaths
	store: Store
	bus: Bus
	/** The judge backend; null when the provider is "none" or nothing usable was found. */
	llm: VisionLLM | null
	/** What `createLlm` resolved, for status displays: provider ("anthropic", "claude-code", "mock", "none") and a sentence. */
	judge: { provider: string; detail: string }
	detector: Detector
	ingest(input: IngestInput): Promise<IngestResult>
	/** Prompt → detector nouns + judge rubric (LLM when available, keyword fallback otherwise). */
	compile(prompt: string): Promise<CompiledLookout>
	/** Wakes the worker after clips become pending. */
	kick(): void
	sourceStatuses(): SourceStatus[]
	/** Runs one poll of the named source now (the UI's "Check now"). Rejects for an unknown name. */
	pollSource(name: string): Promise<void>
	/** Re-reads the config file after a settings change and applies what can change live (thresholds, ROI). */
	reloadConfig(): LoadedConfig
	/** Makes the running source adapters match `config.sources` (after a source is added, edited or removed). */
	applySources(): Promise<void>
	/** Re-resolves the judge backend (after an API key is saved) and updates `llm` and `judge` in place. */
	reloadJudge(): Promise<void>
	/**
	 * Saves clips of this camera from Live: the named source's own stream recorder, or that of
	 * another running source that is the same camera (an RTSP source folded into a Reolink entry).
	 * Null when nothing is recording the camera's stream (an SD-card Reolink, a paused source).
	 */
	liveRecorder(name: string): LiveRecorder | null
	/** Something records this camera's stream, so a clip can be saved from Live (`LiveSourceDto.recording`). */
	isRecording(name: string): boolean
}
