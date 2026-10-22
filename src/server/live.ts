// The camera-control API: what a camera can do, its state, and its controls (PTZ,
// saved views, Home, lights, picture, siren), for cameras with a control driver.

import { type } from "arktype"
import { Hono } from "hono"
import type { CameraControls, CameraSettingBody, CameraState, LightBody, PresetBody, PtzBody } from "../api-types.ts"
import type { Live } from "../live/manager.ts"
import { HttpError, intParam, readBody } from "./http.ts"
import { answer } from "./live-http.ts"

const direction = "'up' | 'down' | 'left' | 'right' | 'upLeft' | 'upRight' | 'downLeft' | 'downRight'"
const speed = "1 <= number <= 64"
const viewId = "0 <= number.integer <= 255"
const unit = "0 <= number <= 1"
const digital = type({ z: "1 <= number <= 8", cx: unit, cy: unit, "+": "delete" }).or("null")

const Ptz = type({ op: "'move'", direction, "speed?": speed, "slow?": "boolean", "+": "delete" })
	.or({ op: "'zoom'", direction: "'in' | 'out'", "speed?": speed, "slow?": "boolean", "+": "delete" })
	.or({ op: "'focus'", direction: "'near' | 'far'", "speed?": speed, "slow?": "boolean", "+": "delete" })
	.or({ op: "'stop'", "+": "delete" })
	.or({ op: "'home'", "+": "delete" })
	.or({ op: "'preset'", id: viewId, "+": "delete" })
	.or({ op: "'zoomTo'", pos: "number", "aim?": { x: unit, y: unit, "+": "delete" }, "settle?": "true", "+": "delete" })
	.or({ op: "'focusTo'", pos: "number", "+": "delete" })
	.or({ op: "'box'", x: unit, y: unit, w: unit, h: unit, "speed?": speed, "+": "delete" })

const Light = type({ id: "'ir' | 'spotlight'", "on?": "boolean", "brightness?": "0 <= number <= 100", "+": "delete" })

const Setting = type({ setting: "'dayNight'", mode: "'auto' | 'color' | 'bw'", "+": "delete" })
	.or({ setting: "'tracking'", on: "boolean", "+": "delete" })
	.or({ setting: "'microphone'", on: "boolean", "+": "delete" })
	.or({ setting: "'autofocus'", on: "boolean", "+": "delete" })
	.or({ setting: "'home'", "saveHere?": "boolean", "digital?": digital, "autoReturn?": "boolean", "timeoutS?": "1 <= number.integer <= 3600", "+": "delete" })

const Preset = type({ op: "'save'", name: "string", "id?": viewId, "digital?": digital, "+": "delete" })
	.or({ op: "'rename'", id: viewId, name: "string", "+": "delete" })
	.or({ op: "'delete'", id: viewId, "+": "delete" })

const NO_CONTROLS: CameraControls = { ptz: null, lights: [], dayNight: null, siren: false, microphone: null, snapshot: false, model: null }
const NO_STATE: CameraState = { moving: false, atHome: null, zoom: null, focus: null }

export const liveRoutes = (live: Live, opts: { /** Someone steered this camera (moved it, chose a view, changed a setting): close-ups give way. */ onSteer?: (name: string) => void } = {}) => {
	const api = new Hono()

	/** The camera's control driver, or a 400 saying what can't be done. */
	const control = (name: string, cant: string) => {
		const c = live.controlFor(name)
		if (!c) throw new HttpError(400, cant)
		return c
	}

	api.get("/live/:name/controls", c =>
		answer(async () => {
			const ctl = live.controlFor(c.req.param("name"))
			const body: CameraControls = ctl ? await ctl.controls(AbortSignal.timeout(15_000)) : NO_CONTROLS
			return c.json(body)
		})
	)

	api.get("/live/:name/state", c =>
		answer(async () => {
			const ctl = live.controlFor(c.req.param("name"))
			const body: CameraState = ctl ? await ctl.state(AbortSignal.timeout(10_000)) : NO_STATE
			return c.json(body)
		})
	)

	api.post("/live/:name/ptz", async c => {
		const body: PtzBody = await readBody(c, Ptz)
		opts.onSteer?.(c.req.param("name"))
		return answer(async () => {
			await control(c.req.param("name"), "look4 can't steer this camera.").ptz(body)
			return c.json({ ok: true as const })
		})
	})

	api.post("/live/:name/light", async c => {
		const body: LightBody = await readBody(c, Light)
		return answer(async () => c.json(await control(c.req.param("name"), "look4 can't switch this camera's lights.").setLight(body)))
	})

	api.post("/live/:name/setting", async c => {
		const body: CameraSettingBody = await readBody(c, Setting)
		opts.onSteer?.(c.req.param("name"))
		return answer(async () => c.json(await control(c.req.param("name"), "look4 can't change this camera's settings.").setting(body)))
	})

	api.post("/live/:name/preset", async c => {
		const body: PresetBody = await readBody(c, Preset)
		opts.onSteer?.(c.req.param("name"))
		return answer(async () => c.json(await control(c.req.param("name"), "look4 can't save views on this camera.").preset(body)))
	})

	api.get("/live/:name/presets/:id/image", c =>
		answer(async () => {
			const id = intParam(c.req.param("id"), 0, 0, 255)
			const jpeg = await control(c.req.param("name"), "This camera has no saved views.").presetImage(id, AbortSignal.timeout(15_000))
			// the URL's ?v= changes whenever the picture does
			return new Response(new Uint8Array(jpeg), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" } })
		})
	)

	api.post("/live/:name/siren", c =>
		answer(async () => {
			await control(c.req.param("name"), "This camera has no siren.").siren()
			return c.json({ ok: true as const })
		})
	)

	return api
}
