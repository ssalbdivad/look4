// The macOS half of `pnpm desktop`: a look4.app in ~/Applications that the Dock can keep.
//
// A Dock pin is a pin on an app BUNDLE, and the loop otherwise runs the bare Electron.app inside
// node_modules: keeping that window in the Dock pins Electron, which reopened from the Dock shows
// Electron's default app, under Electron's name and icon, from a path the next electron bump deletes.
// So, as the Windows build keeps its copy under %LOCALAPPDATA% for the taskbar (windows.ts), this keeps
// one here:
// - The bundle: a copy of the pinned Electron.app, renamed look4 in its Info.plist, carrying look4's icon
//   and main.ts's APP_ID, and signed ad hoc again since the edit breaks Electron's own signature. It is
//   rebuilt only when the electron version or BUNDLE_REVISION changes, so a pin survives every other run.
// - The app: dist/ is copied into Contents/Resources/app, which Electron loads in place of its default
//   app, refreshed before every launch. Its server.json is how a window opened from the Dock starts look4
//   when none is running (src/launch.ts), with the PATH of the terminal that last ran `pnpm desktop`:
//   launchd's own has neither Homebrew's ffmpeg nor ~/.local/bin's claude.
// - The launch: the loop runs THIS bundle, so its window and the Dock pin are one app with one icon.
//
// ntwine's desktop/scripts/mac.ts is the same file; a fix to one belongs in both.
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"

/** main.ts's APP_ID: the bundle identifier, so macOS keeps the Dock pin, notifications and permissions on it. */
const BUNDLE_ID = "dev.look4.desktop"
/**
 * What this script puts in the bundle beyond Electron, as a number in its Info.plist: raise it when that
 * changes (the icon, the plist), so a bundle already in the Dock is rebuilt without waiting for an electron bump.
 */
const BUNDLE_REVISION = "1"

export type MacApp = {
	bundle: string
	start: (dist: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess
}

export const prepareMacApp = (electronBinary: string, electronVersion: string, iconPng: string): MacApp => {
	const bundle = join(homedir(), "Applications", "look4.app")
	const plist = join(bundle, "Contents", "Info.plist")
	const current =
		existsSync(plist) && plistValue(plist, "CFBundleVersion") === electronVersion && plistValue(plist, "Look4BundleRevision") === BUNDLE_REVISION
	if (!current) {
		console.log(`[desktop] building ${bundle} on Electron ${electronVersion}`)
		buildBundle(resolve(electronBinary, "..", "..", ".."), bundle, iconPng)
	}
	const appDir = join(bundle, "Contents", "Resources", "app")
	const exe = join(bundle, "Contents", "MacOS", "Electron")
	return {
		bundle,
		start: (dist, args, env) => {
			mkdirSync(appDir, { recursive: true })
			writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "look4-desktop", productName: "look4", main: "main.mjs" }))
			// No icon.png: the bundle carries the Dock icon, and the window takes none on macOS.
			for (const file of ["main.mjs", "preload.cjs"]) copyFileSync(join(dist, file), join(appDir, file))
			// Kept rather than deleted when this run wrote none: the Dock opens this folder too, and without the
			// record its window cannot start look4.
			if (existsSync(join(dist, "server.json"))) copyFileSync(join(dist, "server.json"), join(appDir, "server.json"))
			// The copy changed sealed resources; re-seal so the bundle stays valid for the next Dock launch.
			sign(bundle, false)
			return spawn(exe, args, { env, stdio: "inherit" })
		}
	}
}

const buildBundle = (electronApp: string, bundle: string, iconPng: string) => {
	const partial = `${bundle}.partial`
	rmSync(partial, { recursive: true, force: true })
	mkdirSync(resolve(bundle, ".."), { recursive: true })
	// ditto, not cp: the frameworks are symlink trees that a plain copy flattens or breaks.
	execFileSync("ditto", [electronApp, partial])
	const plist = join(partial, "Contents", "Info.plist")
	for (const [key, value] of [
		["CFBundleName", "look4"],
		["CFBundleDisplayName", "look4"],
		["CFBundleIdentifier", BUNDLE_ID],
		["CFBundleIconFile", "look4.icns"],
		["Look4BundleRevision", BUNDLE_REVISION]
	] as const)
		execFileSync("plutil", ["-replace", key, "-string", value, plist])
	writeIcns(iconPng, join(partial, "Contents", "Resources", "look4.icns"))
	// The app the last launch put here goes with it: until the next one, the Dock opens THIS bundle, and an
	// empty Resources/app is Electron's default app under look4's name.
	const app = join(bundle, "Contents", "Resources", "app")
	if (existsSync(app)) execFileSync("ditto", [app, join(partial, "Contents", "Resources", "app")])
	sign(partial, true)
	// Whole or not at all: a build killed halfway must not pass the version check.
	rmSync(bundle, { recursive: true, force: true })
	renameSync(partial, bundle)
	// So Finder and the Dock read the new name and icon now rather than from a cached registration.
	execFileSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", bundle])
}

/**
 * The 512px PNG every other platform uses, as the icon set macOS wants (sips and iconutil ship with macOS).
 *
 * Inset first: that PNG's shape fills its canvas edge to edge, as a web icon's does, while a macOS icon draws
 * its shape at 824 of 1024px and leaves the rest transparent (Apple's app icon grid). Unpadded, the app
 * stands a fifth taller than every other one in the Dock.
 */
const writeIcns = (png: string, icns: string) => {
	const work = mkdtempSync(join(tmpdir(), "look4-icns-"))
	try {
		const inset = join(work, "inset.png")
		const master = join(work, "master.png")
		execFileSync("sips", ["-z", "824", "824", png, "--out", inset], { stdio: "ignore" })
		execFileSync("sips", ["--padToHeightWidth", "1024", "1024", inset, "--out", master], { stdio: "ignore" })
		const iconset = join(work, "look4.iconset")
		mkdirSync(iconset)
		for (const size of [16, 32, 128, 256, 512]) {
			execFileSync("sips", ["-z", String(size), String(size), master, "--out", join(iconset, `icon_${size}x${size}.png`)], { stdio: "ignore" })
			execFileSync("sips", ["-z", String(size * 2), String(size * 2), master, "--out", join(iconset, `icon_${size}x${size}@2x.png`)], { stdio: "ignore" })
		}
		execFileSync("iconutil", ["-c", "icns", iconset, "-o", icns])
	} finally {
		rmSync(work, { recursive: true, force: true })
	}
}

/** Ad hoc: the bundle never leaves this machine. `deep` once on a build, for the helpers and frameworks. */
const sign = (bundle: string, deep: boolean) =>
	execFileSync("codesign", ["--force", ...(deep ? ["--deep"] : []), "--sign", "-", bundle], { stdio: "ignore" })

const plistValue = (plist: string, key: string) => {
	try {
		return execFileSync("plutil", ["-extract", key, "raw", plist], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
	} catch {
		return undefined
	}
}
