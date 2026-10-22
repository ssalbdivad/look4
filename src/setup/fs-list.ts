// A read-only folder browser for picking a `watch` folder without typing a
// path: directory names and a count of the videos in one folder. It never
// reads a file's contents.

import { readdirSync, statSync } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { dirname, extname, isAbsolute, join, resolve } from "node:path"
import type { FolderListing } from "../api-types.ts"
import { VIDEO_EXTENSIONS } from "../sources/common.ts"
import { isWsl } from "./discover.ts"

/** Rejections the server turns into 400/403/404 with this message. */
export class FolderError extends Error {
	readonly status: 400 | 403 | 404
	constructor(status: 400 | 403 | 404, message: string) {
		super(message)
		this.status = status
	}
}

const MAX_DIRS = 2000
const VIDEO = new Set(VIDEO_EXTENSIONS)
/** Windows profile folders that are not a person. */
const NOT_A_USER = new Set(["public", "default", "default user", "all users", "defaultapppool", "wdagutilityaccount", "wsiaccount"])

/** Dot-folders, and Windows' `$Recycle.Bin`-style system folders. */
const hidden = (name: string) => name.startsWith(".") || name.startsWith("$") || name === "System Volume Information"

const isDir = (p: string) => {
	try {
		return statSync(p).isDirectory()
	} catch {
		return false
	}
}

export type ShortcutOptions = { home?: string; wsl?: boolean; mnt?: string; user?: string }

/**
 * Home and its Videos/Downloads/Desktop, and on WSL each Windows user's
 * Videos/Downloads/Desktop and every mounted drive, where they exist.
 */
export const folderShortcuts = (opts: ShortcutOptions = {}): FolderListing["shortcuts"] => {
	const home = opts.home ?? homedir()
	const out: FolderListing["shortcuts"] = [{ label: "Home", path: home }]
	for (const d of ["Videos", "Downloads", "Desktop"]) if (isDir(join(home, d))) out.push({ label: d, path: join(home, d) })
	if (!(opts.wsl ?? isWsl())) return out
	const mnt = opts.mnt ?? "/mnt"
	const drives = (() => {
		try {
			return readdirSync(mnt).filter(d => /^[a-z]$/.test(d)).sort()
		} catch {
			return []
		}
	})()
	const users = (() => {
		try {
			return readdirSync(join(mnt, "c", "Users"), { withFileTypes: true })
				.filter(e => e.isDirectory() && !NOT_A_USER.has(e.name.toLowerCase()) && !hidden(e.name))
				.map(e => e.name)
				.filter(u => ["Videos", "Downloads", "Desktop"].some(d => isDir(join(mnt, "c", "Users", u, d))))
		} catch {
			return []
		}
	})()
	// WSL installs usually reuse the Windows account name; when one matches, the others are someone else's
	const me = users.filter(u => u.toLowerCase() === (opts.user ?? userInfo().username).toLowerCase())
	const shown = me.length ? me : users
	for (const u of shown)
		for (const d of ["Videos", "Downloads", "Desktop"]) {
			const p = join(mnt, "c", "Users", u, d)
			if (isDir(p)) out.push({ label: shown.length > 1 ? `Windows ${d} (${u})` : `Windows ${d}`, path: p })
		}
	for (const d of drives) out.push({ label: `${d.toUpperCase()}: drive`, path: join(mnt, d) })
	return out
}

export const listFolder = async (path: string | null | undefined, opts: ShortcutOptions = {}): Promise<FolderListing> => {
	const raw = path?.trim() || (opts.home ?? homedir())
	if (!isAbsolute(raw)) throw new FolderError(400, `"${raw}" is not a full path; it must start with /`)
	const dir = resolve(raw)
	let entries
	try {
		entries = await readdir(dir, { withFileTypes: true })
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code
		if (code === "ENOENT") throw new FolderError(404, `There's no folder at ${dir}`)
		if (code === "ENOTDIR") throw new FolderError(400, `${dir} is a file, not a folder`)
		if (code === "EACCES" || code === "EPERM") throw new FolderError(403, `look4 isn't allowed to look inside ${dir}`)
		throw e
	}
	const dirs: FolderListing["dirs"] = []
	let videoCount = 0
	for (const e of entries) {
		if (hidden(e.name)) continue
		const p = join(dir, e.name)
		if (e.isDirectory()) dirs.push({ name: e.name, path: p })
		else if (e.isFile()) {
			if (VIDEO.has(extname(e.name).toLowerCase())) videoCount++
		} else if (e.isSymbolicLink()) {
			// follow links to folders (a ~/Videos that points at a Windows drive), never to files
			const s = await stat(p).catch(() => null)
			if (s?.isDirectory()) dirs.push({ name: e.name, path: p })
		}
	}
	dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }))
	return {
		path: dir,
		parent: dir === "/" ? null : dirname(dir),
		shortcuts: folderShortcuts(opts),
		dirs: dirs.slice(0, MAX_DIRS),
		videoCount
	}
}
