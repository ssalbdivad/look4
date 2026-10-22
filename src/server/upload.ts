import { randomBytes } from "node:crypto"
import { createWriteStream } from "node:fs"
import { rm, stat, utimes, writeFile } from "node:fs/promises"
import { basename, extname, join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as NodeReadableStream } from "node:stream/web"
import type { AppContext, IngestResult } from "../context.ts"
import { HttpError } from "./http.ts"

export const VIDEO_EXTENSIONS = new Set([
	".mp4", ".m4v", ".mov", ".mkv", ".avi", ".webm", ".ts", ".mts", ".m2ts", ".flv", ".3gp", ".wmv", ".mpg", ".mpeg"
])

/** Multipart is parsed in memory, so it is for small files only; big videos use the raw-body form. */
export const MULTIPART_LIMIT_BYTES = 64 * 1024 * 1024

/** The display name the user gave, stripped to a basename; rejects anything that is not a video. */
export const uploadName = (raw: string | undefined | null): string => {
	const name = basename((raw ?? "").replaceAll("\\", "/")).trim()
	if (!name) throw new HttpError(400, "missing file name (?name=<file name>)")
	if (!VIDEO_EXTENSIONS.has(extname(name).toLowerCase()))
		throw new HttpError(415, `"${name}" is not a video file (${[...VIDEO_EXTENSIONS].join(", ")})`)
	return name
}

const tmpFile = (ctx: AppContext, name: string) =>
	join(ctx.paths.tmp, `upload-${Date.now()}-${randomBytes(4).toString("hex")}${extname(name).toLowerCase()}`)

const ingestTmp = async (ctx: AppContext, file: string, name: string): Promise<IngestResult> => {
	try {
		const size = (await stat(file)).size
		if (size === 0) throw new HttpError(400, `"${name}" is empty`)
		return await ctx.ingest({ file, source: "upload", originalName: name, mode: "move" })
	} finally {
		// `move` normally takes the file; a duplicate or a failure may leave it behind
		await rm(file, { force: true })
	}
}

/**
 * Streams a raw request body (one video) to data/tmp, then ingests it.
 * `lastModified` (epoch ms, the browser's `File.lastModified`) becomes the temp
 * file's mtime, which ingest uses as the recording time when the name has none.
 */
export const ingestRawUpload = async (
	ctx: AppContext,
	rawName: string | undefined,
	body: ReadableStream<Uint8Array> | null,
	lastModified?: string
) => {
	const name = uploadName(rawName)
	if (!body) throw new HttpError(400, `"${name}" is empty`)
	const file = tmpFile(ctx, name)
	try {
		await pipeline(Readable.fromWeb(body as NodeReadableStream<Uint8Array>), createWriteStream(file))
		const mtime = Number(lastModified)
		if (lastModified && Number.isFinite(mtime) && mtime > 0) await utimes(file, new Date(), new Date(mtime))
	} catch (e) {
		await rm(file, { force: true })
		throw e
	}
	return ingestTmp(ctx, file, name)
}

/** Ingests every `File` from a multipart form (field `files`). */
export const ingestMultipart = async (ctx: AppContext, files: File[]) => {
	if (!files.length) throw new HttpError(400, 'no files in the "files" field')
	const names = files.map(f => uploadName(f.name))
	const results: IngestResult[] = []
	for (const [i, f] of files.entries()) {
		const name = names[i]!
		const file = tmpFile(ctx, name)
		await writeFile(file, Buffer.from(await f.arrayBuffer()))
		results.push(await ingestTmp(ctx, file, name))
	}
	return results
}
