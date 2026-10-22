// Camera control behind one interface, so the live page drives any camera the
// same way and shows only what that camera can do. A driver claims the sources
// it understands; today that is Reolink's HTTP API. An ONVIF driver would slot in
// here for other brands.

import type { CameraControls, CameraSettingBody, CameraState, LightBody, PresetBody, PtzBody } from "../api-types.ts"
import type { SourceConfig } from "../config.ts"

/** A control request that failed, with a sentence for the user and the HTTP status to answer with. */
export class ControlError extends Error {
	readonly status: number
	constructor(status: number, message: string) {
		super(message)
		this.status = status
	}
}

export type CameraControl = {
	/** What the camera can do right now, with each control's current state. May sign in to the camera. */
	controls(signal?: AbortSignal): Promise<CameraControls>
	/** Cheap enough to poll every few seconds: moving or not, at Home or not, zoom and focus. */
	state(signal?: AbortSignal): Promise<CameraState>
	/** Starts (or stops) a move, goes to a view or Home, frames a box. Continuous moves run until `stop`; drivers stop them on their own after a while. */
	ptz(body: PtzBody): Promise<void>
	setLight(body: LightBody): Promise<CameraControls>
	setting(body: CameraSettingBody): Promise<CameraControls>
	/** Saves, renames or deletes a saved view. */
	preset(body: PresetBody): Promise<CameraControls>
	/** The thumbnail of saved view `id` (a JPEG); ControlError 404 when there is none. */
	presetImage(id: number, signal?: AbortSignal): Promise<Buffer>
	/** One burst of the camera's siren. */
	siren(): Promise<void>
	/** A full-resolution still from the camera itself. */
	snapshot(signal?: AbortSignal): Promise<Buffer>
	close(): Promise<void>
}

export type ControlDriver = {
	name: string
	/** The driver for this source, or null when it doesn't apply. */
	create(cfg: SourceConfig, env: NodeJS.ProcessEnv): CameraControl | null
}

/** Tried in order; the first that claims a source controls it. */
export const createControl = (drivers: ControlDriver[], cfg: SourceConfig, env: NodeJS.ProcessEnv = process.env): CameraControl | null => {
	for (const d of drivers) {
		const c = d.create(cfg, env)
		if (c) return c
	}
	return null
}
