// The browser-side magnification saved with each of a camera's views and with Home.
// The camera stores where it points; how far the picture was magnified on top of that
// is look4's to keep, so going to a view brings back the whole picture that was saved.

import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { DigitalView } from "../api-types.ts"

type Saved = { home: DigitalView | null; views: Record<string, DigitalView> }

const isView = (v: any): v is DigitalView => !!v && [v.z, v.cx, v.cy].every(n => Number.isFinite(n))

/** Nothing worth restoring: a view at 1× is the camera's picture as it is. */
const worthKeeping = (v: DigitalView | null | undefined): v is DigitalView => !!v && v.z > 1.001

/** `<dir>/digital.json`, or memory only when there is no directory. */
export const createDigitalStore = (dir: string | null) => {
	const file = dir ? join(dir, "digital.json") : null
	let loading: Promise<Saved> | null = null

	const load = (): Promise<Saved> =>
		(loading ??= (async () => {
			if (file) {
				try {
					const m = JSON.parse(await readFile(file, "utf8"))
					const views: Record<string, DigitalView> = {}
					for (const [id, v] of Object.entries(m?.views ?? {})) if (isView(v)) views[id] = { z: v.z, cx: v.cx, cy: v.cy }
					return { home: isView(m?.home) ? { z: m.home.z, cx: m.home.cx, cy: m.home.cy } : null, views }
				} catch {}
			}
			return { home: null, views: {} }
		})())

	let writing: Promise<void> = Promise.resolve()
	/** Writes are queued, so two quick saves never race on the temp file. */
	const save = (s: Saved) => {
		const next = writing.then(async () => {
			if (!file) return
			await mkdir(dir!, { recursive: true })
			const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`
			await writeFile(tmp, `${JSON.stringify(s)}\n`)
			await rename(tmp, file)
		})
		writing = next.catch(() => {})
		return next
	}

	return {
		home: async () => (await load()).home,
		view: async (id: number) => (await load()).views[id] ?? null,
		setHome: async (v: DigitalView | null | undefined) => {
			const s = await load()
			s.home = worthKeeping(v) ? v : null
			await save(s)
		},
		/** A view saved (or overwritten) with this magnification; null or 1× forgets it, as does deleting the view. */
		setView: async (id: number, v: DigitalView | null | undefined) => {
			const s = await load()
			if (worthKeeping(v)) s.views[id] = v
			else delete s.views[id]
			await save(s)
		}
	}
}

export type DigitalStore = ReturnType<typeof createDigitalStore>
