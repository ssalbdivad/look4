import { EventEmitter } from "node:events"
import type { SightingEvent } from "./api-types.ts"
import type { NormBox, SourceStatus } from "./types.ts"

/** Everything the UI streams live over SSE. */
export type Look4Events = {
	/** A clip row was created or changed (status, verdicts, media). */
	clip: [{ clipId: string; status: string }]
	/** A lookout matched: the moment worth a notification. */
	sighting: [SightingEvent]
	source: [SourceStatus]
	/** Worker queue changed. */
	queue: [{ pending: number; processing: number }]
	lookout: [{ lookoutId: string }]
	/** A species was added to or removed from the life list. */
	lifelist: [{ species: string }]
	/**
	 * Internal, never streamed: look4's watch of a camera's preview stream saw something move.
	 * `at` is the frame's wall-clock ms, `blobs` its moving areas (full frame, largest first).
	 */
	motion: [{ source: string; at: number; blobs: NormBox[] }]
	/** Internal, never streamed: a stream capture made this clip from its footage between `start` and `end` (wall-clock ms). */
	captured: [{ source: string; clipId: string; start: number; end: number }]
}

export class Bus extends EventEmitter<Look4Events> {}

export const createBus = () => {
	const bus = new Bus()
	bus.setMaxListeners(100)
	return bus
}
