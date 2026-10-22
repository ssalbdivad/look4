// Where the camera's Home view (its guard point) actually is. Cameras let you save
// and go to a guard point but don't say where it is, so look4 remembers the
// camera's pan/tilt/zoom when Home is saved or reached and compares the current
// position with it: that is what "Moved · Back home" on the live page reads.

import { mkdir, readFile, writeFile, rename } from "node:fs/promises"
import { join } from "node:path"

/** Motor positions in the camera's own units (Reolink `GetPtzCurPos`: Ppos, Tpos, Zpos). */
export type PtzPosition = { pan: number; tilt: number; zoom: number }

/**
 * How far (in motor steps, per axis) still counts as Home. A guard return lands within a step or
 * two of where it was saved; a deliberate nudge moves tens of steps.
 */
export const HOME_TOLERANCE = 5

export const samePosition = (a: PtzPosition, b: PtzPosition, tolerance = HOME_TOLERANCE) =>
	Math.abs(a.pan - b.pan) <= tolerance && Math.abs(a.tilt - b.tilt) <= tolerance && Math.abs(a.zoom - b.zoom) <= tolerance

const isPosition = (v: any): v is PtzPosition => v && [v.pan, v.tilt, v.zoom].every(n => Number.isFinite(n))

/** `<dir>/home.json`, or memory only when there is no directory (tests, a camera without a data dir). */
export const createHomeStore = (dir: string | null) => {
	const file = dir ? join(dir, "home.json") : null
	let cached: PtzPosition | null | undefined

	const get = async (): Promise<PtzPosition | null> => {
		if (cached !== undefined) return cached
		if (!file) return (cached = null)
		try {
			const v = JSON.parse(await readFile(file, "utf8"))
			cached = isPosition(v) ? { pan: v.pan, tilt: v.tilt, zoom: v.zoom } : null
		} catch {
			cached = null
		}
		return cached
	}

	const set = async (pos: PtzPosition) => {
		cached = pos
		if (!file) return
		await mkdir(dir!, { recursive: true })
		const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
		await writeFile(tmp, `${JSON.stringify({ ...pos, savedAt: new Date().toISOString() })}\n`)
		await rename(tmp, file)
	}

	return { get, set }
}

export type HomeStore = ReturnType<typeof createHomeStore>
