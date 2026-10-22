import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { type AddressInfo, createServer } from "node:net"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { webBuildState } from "../src/cli/start.ts"

const root = join(import.meta.dirname, ".tmp", "worker", "cli")
const main = join(import.meta.dirname, "..", "src", "cli", "main.ts")

const look4In = (dir: string, args: string[], env: Record<string, string | undefined> = {}) => {
	const r = spawnSync(process.execPath, [main, ...args], {
		cwd: dir,
		encoding: "utf8",
		env: { ...process.env, LOOK4_CONFIG: join(dir, "look4.config.json"), LOOK4_LOG: "warn", NO_COLOR: "1", ...env },
		timeout: 60_000
	})
	return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}
const look4 = (...args: string[]) => look4In(root, args)

before(() => {
	rmSync(root, { recursive: true, force: true })
	mkdirSync(root, { recursive: true })
	writeFileSync(join(root, "look4.config.json"), JSON.stringify({ pipeline: { judge: { provider: "mock" }, detector: { enabled: false } } }))
	const ff = (...args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args])
	ff("-f", "lavfi", "-i", "color=c=0x305030:s=320x240:d=3:r=10", "-f", "lavfi", "-i", "color=c=white:s=24x24:d=3:r=10",
		"-filter_complex", "[0][1]overlay=x='40+t*60':y=100,format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast", join(root, "mover.mp4"))
	ff("-f", "lavfi", "-i", "color=c=0x305030:s=320x240:d=3:r=10", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", join(root, "still.mp4"))
})
after(() => rmSync(root, { recursive: true, force: true }))

test("compile prints the detector nouns, and the node:sqlite warning is filtered", () => {
	const r = look4("compile", "--json", "a cardinal or blue jay at the feeder")
	assert.equal(r.code, 0, r.stderr)
	assert.equal(r.stderr, "")
	const compiled = JSON.parse(r.stdout)
	assert.deepEqual(compiled.queries, ["bird"])
	assert.equal(compiled.compiler, "mock:mock")
})

test("scan --json runs each file through the cascade with an ad-hoc lookout", () => {
	const r = look4("scan", "--json", "--prompt", "a squirrel on the pole", join(root, "mover.mp4"), join(root, "still.mp4"))
	assert.equal(r.code, 0, r.stderr)
	const rows = JSON.parse(r.stdout) as Array<{ file: string; clipId: string; status: string; droppedAt: string; best: { lookout: string } | null }>
	assert.deepEqual(
		rows.map(x => [x.file, x.status, x.droppedAt, x.best?.lookout ?? null]),
		[
			// detector off: the motion frames go to the (mock) judge, which finds no squirrel
			[join(root, "mover.mp4"), "rejected", "judge", "squirrel-on-the-pole"],
			[join(root, "still.mp4"), "rejected", "motion", null]
		]
	)
	for (const x of rows) assert.match(x.clipId, /^\d{8}-\d{6}-[0-9a-f]{6}$/)
	// the ad-hoc lookout is kept, disabled, so its verdicts have an owner
	const list = look4("lookout", "list")
	assert.match(list.stdout, /squirrel-on-the-pole\s+no\s+0\.60\s+squirrel/)
})

test("hints name the command that works where look4 was run from: `pnpm look4` from a package script, `look4` from a linked bin", () => {
	const dir = join(root, "hints")
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, "look4.config.json"), JSON.stringify({ pipeline: { judge: { provider: "mock" }, detector: { enabled: false } } }))
	const pnpm = { npm_lifecycle_event: "look4", npm_config_user_agent: "pnpm/10.18.0 npm/? node/v25.2.1 linux x64" }
	const bare = { npm_lifecycle_event: undefined, npm_config_user_agent: undefined }
	assert.equal(look4In(dir, ["lookout", "list"], pnpm).stdout, 'No lookouts yet. Add one: pnpm look4 lookout add "a cardinal at the feeder"\n')
	assert.equal(look4In(dir, ["lookout", "list"], bare).stdout, 'No lookouts yet. Add one: look4 lookout add "a cardinal at the feeder"\n')
	const scanned = look4In(dir, ["scan", "--prompt", "a squirrel on the pole", join(root, "still.mp4")], pnpm).stdout
	assert.match(scanned, /watch for it from now on with: pnpm look4 lookout enable squirrel-on-the-pole$/m)
	const usage = look4In(dir, ["--help"], { ...pnpm, npm_config_user_agent: "npm/11.6.0 node/v25.2.1 linux x64" }).stdout
	assert.match(usage, /^ {2}npm start -- \[--no-sources\] \[--port N\]/m)
	assert.match(usage, /^ {2}npm run look4 -- lookout list$/m)
})

test("usage errors exit 2", () => {
	assert.equal(look4("scan").code, 2)
	assert.equal(look4("lookout", "add", "x", "--threshold", "7").code, 2)
	assert.equal(look4("nope").code, 2)
})

test("init for a camera with no password saves a blank one and explains a camera whose web servers are off", async () => {
	const dir = join(root, "init")
	mkdirSync(dir, { recursive: true })
	// a port nothing listens on: both HTTPS and HTTP are refused, as on firmware with only port 9000 open
	const probe = createServer()
	await new Promise<void>(r => probe.listen(0, "127.0.0.1", r))
	const { port } = probe.address() as AddressInfo
	await new Promise(r => probe.close(r))

	const r = look4In(dir, ["init", "--reolink", `127.0.0.1:${port}`], { REOLINK_PASSWORD: undefined })
	assert.equal(r.code, 0, r.stderr)
	assert.match(r.stderr, /REOLINK_PASSWORD is not set: assuming the camera has no password/)
	assert.match(r.stdout, new RegExp(`✗ 127\\.0\\.0\\.1:${port} refused HTTPS and HTTP: the camera is there but HTTPS and HTTP are off — in the Reolink app: camera Settings → Network → Advanced → Server Settings, turn on HTTPS`))
	assert.equal(readFileSync(join(dir, ".env"), "utf8"), "REOLINK_PASSWORD=\n")
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "look4.config.json"), "utf8")).sources, [
		{ type: "reolink", name: "camera", host: `127.0.0.1:${port}`, username: "admin" }
	])
})

test("start rebuilds the web UI when any of its sources is newer than the last build, however deep", () => {
	const dir = join(root, "web-build")
	const file = (path: string, at: number) => {
		mkdirSync(join(dir, path, ".."), { recursive: true })
		writeFileSync(join(dir, path), "x")
		utimesSync(join(dir, path), at, at)
	}
	file("web/src/pages/Settings.tsx", 1000)
	file("vite.config.ts", 1000)
	assert.equal(webBuildState(dir), "missing")
	file("web/dist/index.html", 2000)
	assert.equal(webBuildState(dir), "fresh")
	file("web/src/setup/deep/ReolinkFlow.tsx", 3000)
	assert.equal(webBuildState(dir), "stale")
})
