// Thumbnails for a camera's saved views. The camera keeps its own (Reolink
// `ExportImg`, the pictures the Reolink app shows); look4 caches them on disk and
// makes its own from a snapshot when the camera has none or can't take an upload.
//
// Each view's picture has a version that goes into its URL (`?v=`), so a browser
// can cache it for a day and still sees a new one the moment look4 changes it.
// The camera's own pictures are a cache of what it holds: a view re-saved in the
// Reolink app keeps its image name, so nothing in the view list says its picture
// changed, and look4 fetches each again once it is a day old (see `due`).

import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import sharp from "sharp"

/** The size of the thumbnails the Reolink app makes (169×95), and the camera web UI's upload cap. */
export const THUMBNAIL = { width: 169, height: 95, maxBytes: 14 * 1024 }

/** A view-sized JPEG from a full-size still, at the best quality that fits the camera's limit. */
export const makeThumbnail = async (jpeg: Buffer): Promise<Buffer> => {
	const resized = sharp(jpeg).rotate().resize(THUMBNAIL.width, THUMBNAIL.height, { fit: "cover" })
	let out: Buffer | null = null
	for (let q = 85; q >= 30; q -= 10) {
		out = await resized.clone().jpeg({ quality: q, mozjpeg: true }).toBuffer()
		if (out.length <= THUMBNAIL.maxBytes) return out
	}
	return out!
}

export const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8

/** How long a picture fetched from the camera is served before look4 asks the camera for it again. */
export const CAMERA_PICTURE_MAX_AGE_MS = 24 * 3600_000

/** `fetched`: when each view's stored picture was last fetched from the camera; views not in it have look4's own. */
type Meta = { epoch: string; rev: Record<string, number>; fetched: Record<string, number> }

/**
 * `<dir>/presets.json` (versions) and `<dir>/preset-<id>-<version>.jpg` (pictures), or memory
 * only when there is no directory.
 */
export const createPresetStore = (dir: string | null, o: { maxAgeMs?: number } = {}) => {
	const maxAgeMs = o.maxAgeMs ?? CAMERA_PICTURE_MAX_AGE_MS
	const memory = new Map<string, Buffer>()
	let meta: Meta | null = null
	/** Pictures the camera said it doesn't have, by `<id>:<version>`. */
	const missing = new Set<string>()

	const metaFile = dir ? join(dir, "presets.json") : null
	const fileOf = (id: number, v: string) => (dir ? join(dir, `preset-${id}-${v}.jpg`) : `${id}-${v}`)

	let loading: Promise<Meta> | null = null
	/** Loaded once; concurrent callers share the read (and the first write of a fresh epoch). */
	const load = (): Promise<Meta> =>
		(loading ??= (async () => {
			if (metaFile) {
				try {
					const m = JSON.parse(await readFile(metaFile, "utf8"))
					if (typeof m?.epoch === "string" && m.rev && typeof m.rev === "object")
						return (meta = { epoch: m.epoch, rev: m.rev, fetched: m.fetched && typeof m.fetched === "object" ? m.fetched : {} })
				} catch {}
			}
			// a fresh epoch, so a reset data dir never reuses a version a browser has cached
			meta = { epoch: randomUUID().slice(0, 8), rev: {}, fetched: {} }
			// unsaved, the versions only last until a restart; pictures still show
			await saveMeta().catch(() => {})
			return meta
		})())

	let writing: Promise<void> = Promise.resolve()
	/** Writes are queued, so two quick changes never race on the temp file. */
	const saveMeta = () => {
		const next = writing.then(async () => {
			if (!metaFile || !meta) return
			await mkdir(dir!, { recursive: true })
			// a unique temp name: a second server on the same data dir must not rename this one's half-written file
			const tmp = `${metaFile}.${randomUUID().slice(0, 8)}.tmp`
			await writeFile(tmp, `${JSON.stringify(meta)}\n`)
			await rename(tmp, metaFile)
		})
		writing = next.catch(() => {})
		return next
	}

	/** The version of view `id`'s picture: changes when look4 changes it, or the camera names a different image. */
	const version = async (id: number, imgName: string) => {
		const m = await load()
		return createHash("sha1").update(`${m.epoch}|${id}|${imgName}|${m.rev[id] ?? 0}`).digest("hex").slice(0, 10)
	}

	const has = (id: number, v: string) => (dir ? existsSync(fileOf(id, v)) : memory.has(fileOf(id, v)))

	const read = async (id: number, v: string): Promise<Buffer | null> => {
		if (!dir) return memory.get(fileOf(id, v)) ?? null
		try {
			return await readFile(fileOf(id, v))
		} catch {
			return null
		}
	}

	const removeFiles = async (id: number, keep: string | null) => {
		if (!dir) {
			for (const k of [...memory.keys()]) if (k.startsWith(`${id}-`) && k !== keep) memory.delete(k)
			return
		}
		const names = await readdir(dir).catch(() => [] as string[])
		const keepName = keep ? `preset-${id}-${keep}.jpg` : null
		await Promise.all(names.filter(n => n.startsWith(`preset-${id}-`) && n.endsWith(".jpg") && n !== keepName).map(n => unlink(join(dir, n)).catch(() => {})))
	}

	const store = async (id: number, v: string, jpeg: Buffer) => {
		if (!isJpeg(jpeg)) throw new Error("not a JPEG")
		if (!dir) {
			await removeFiles(id, null)
			memory.set(fileOf(id, v), jpeg)
			return
		}
		await mkdir(dir, { recursive: true })
		// two viewers may fetch the same picture at once
		const tmp = `${fileOf(id, v)}.${randomUUID().slice(0, 8)}.tmp`
		await writeFile(tmp, jpeg)
		await rename(tmp, fileOf(id, v))
		await removeFiles(id, v)
	}

	/** Records whether view `id`'s picture is the camera's (fetched now) or look4's own (never fetched again). */
	const setFetched = (m: Meta, id: number, fromCamera: boolean) => {
		if (fromCamera) m.fetched[id] = Date.now()
		else delete m.fetched[id]
	}

	/**
	 * Stores the picture under version `v` (as served). `fromCamera`: it is the camera's own (ExportImg),
	 * fetched just now, so it is fetched again once it is `maxAgeMs` old.
	 */
	const put = async (id: number, v: string, jpeg: Buffer, fromCamera = false) => {
		await store(id, v, jpeg)
		const m = await load()
		setFetched(m, id, fromCamera)
		// unsaved, a camera picture is only fetched again sooner after a restart
		await saveMeta().catch(() => {})
	}

	/**
	 * View `id` changed (look4 saved or deleted it, or the camera's picture of it is new): a new version,
	 * and its picture when there is one. `fromCamera` as for put(). Returns the new version.
	 */
	const replace = async (id: number, imgName: string, jpeg: Buffer | null, fromCamera = false) => {
		const m = await load()
		m.rev[id] = (m.rev[id] ?? 0) + 1
		setFetched(m, id, jpeg !== null && fromCamera)
		await saveMeta()
		const v = await version(id, imgName)
		if (jpeg) await store(id, v, jpeg)
		else await removeFiles(id, null)
		return v
	}

	/** View `id`'s stored picture is the camera's and old enough to fetch again. */
	const due = async (id: number) => {
		const at = (await load()).fetched[id]
		return at !== undefined && Date.now() - at >= maxAgeMs
	}

	return {
		version,
		has,
		read,
		put,
		replace,
		due,
		/** The camera has no picture for this version (ExportImg failed): show none until look4 makes one. */
		markMissing: (id: number, v: string) => missing.add(`${id}:${v}`),
		isMissing: (id: number, v: string) => missing.has(`${id}:${v}`)
	}
}

export type PresetStore = ReturnType<typeof createPresetStore>
