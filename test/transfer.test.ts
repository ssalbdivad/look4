import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { openStore } from "../src/db.ts"
import { dataPaths, ensureDataDirs, localDate } from "../src/paths.ts"
import { mergeEnv } from "../src/transfer.ts"
import type { ClipStatus } from "../src/types.ts"

const root = join(import.meta.dirname, ".tmp", "worker", "transfer")
const from = join(root, "windows")
const to = join(root, "mac")
const main = join(import.meta.dirname, "..", "src", "cli", "main.ts")
const recordedAt = "2026-10-13T15:00:00.000Z"
const day = localDate(recordedAt)

// found in the working directory, as on a machine with no config yet
const env = () => {
	const e: NodeJS.ProcessEnv = { ...process.env, LOOK4_LOG: "warn", NO_COLOR: "1" }
	delete e.LOOK4_CONFIG
	return e
}
const look4 = (dir: string, ...args: string[]) => {
	const r = spawnSync(process.execPath, [main, ...args], { cwd: dir, encoding: "utf8", env: env(), timeout: 60_000 })
	return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

before(() => {
	rmSync(root, { recursive: true, force: true })
	// the exporting machine keeps its data somewhere other than ./data, as an absolute path
	const dataDir = join(from, "store")
	mkdirSync(from, { recursive: true })
	writeFileSync(join(from, "look4.config.json"), JSON.stringify({ dataDir, sources: [{ type: "reolink", name: "feeder", host: "192.168.1.31" }] }))
	writeFileSync(join(from, ".env"), "REOLINK_PASSWORD=hunter2\nANTHROPIC_API_KEY=from-windows\n")
	const paths = dataPaths(dataDir)
	ensureDataDirs(paths)
	const store = openStore(paths.db)
	store.insertLookout({ id: "lk", name: "new birds", prompt: "any bird not on my life list", enabled: true, threshold: 0.6, compiled: null })
	const clip = (id: string, status: ClipStatus, expiresAt: string | null) => {
		const dir = join(status === "kept" ? paths.kept : paths.clips, day)
		mkdirSync(dir, { recursive: true })
		const path = join(dir, `${id}.mp4`)
		writeFileSync(path, id)
		mkdirSync(join(paths.media, id), { recursive: true })
		writeFileSync(join(paths.media, id, "poster.jpg"), `poster of ${id}`)
		store.insertClip({ id, source: "feeder", sourceRef: null, originalName: `${id}.mp4`, path, sizeBytes: id.length, sha256: id, recordedAt })
		store.updateClip(id, { status, expiresAt, media: { poster: "poster.jpg", preview: null, crops: [] } })
	}
	clip("20261013-150000-kept01", "kept", null)
	clip("20261013-150000-expire", "rejected", "2026-10-20T00:00:00.000Z")
	clip("20261013-150000-labeld", "rejected", null)
	store.setLabel({ clipId: "20261013-150000-labeld", lookoutId: "lk", truth: false, species: "House Finch" })
	clip("20261013-150000-lifer1", "rejected", "2026-10-20T00:00:00.000Z")
	store.addLifer({ species: "Northern Cardinal", firstSeenAt: recordedAt, clipId: "20261013-150000-kept01" })
	store.addLifer({ species: "Blue Jay", firstSeenAt: recordedAt, clipId: "20261013-150000-lifer1" })
	store.close()

	// the importing machine has its own secret already, and no config
	mkdirSync(to, { recursive: true })
	writeFileSync(join(to, ".env"), "ANTHROPIC_API_KEY=mac-key\n")
})
after(() => rmSync(root, { recursive: true, force: true }))

test("export pushed to import --listen brings settings, the life list and the clips worth keeping, filed under this data dir", async () => {
	const listener = spawn(process.execPath, [main, "import", "--listen", "--port", "0"], { cwd: to, env: env() })
	let printed = ""
	const url = await new Promise<string>((ok, fail) => {
		listener.stdout.on("data", d => {
			printed += d
			// any of this machine's addresses will do: the listener takes all of them
			const m = /export http:\/\/[\d.]+:(\d+\/\w+)/.exec(printed)
			if (m) ok(`http://127.0.0.1:${m[1]}`)
		})
		listener.on("exit", code => fail(new Error(`listener exited ${code}: ${printed}`)))
	})
	const sent = look4(from, "export", url)
	assert.equal(sent.code, 0, sent.stderr)
	assert.match(sent.stderr, /3 clips and 2 life-list birds imported/)
	assert.equal(await new Promise(ok => listener.on("exit", ok)), 0)

	const paths = dataPaths(join(to, "data"))
	const store = openStore(paths.db)
	try {
		// filed by status, as the pipeline does, and the rows point there
		const at = (id: string) => store.getClip(id)!.path
		assert.equal(at("20261013-150000-kept01"), join(paths.kept, day, "20261013-150000-kept01.mp4"))
		assert.equal(at("20261013-150000-labeld"), join(paths.clips, day, "20261013-150000-labeld.mp4"))
		assert.equal(at("20261013-150000-lifer1"), join(paths.clips, day, "20261013-150000-lifer1.mp4"))
		assert.equal(readFileSync(join(paths.media, "20261013-150000-lifer1", "poster.jpg"), "utf8"), "poster of 20261013-150000-lifer1")
		// a rejected clip due to expire stays behind, its row marked deleted as retention would
		const expired = store.getClip("20261013-150000-expire")!
		assert.deepEqual([expired.path, expired.media.poster], [null, null])
		assert.ok(!existsSync(join(paths.clips, day, "20261013-150000-expire.mp4")))
		assert.deepEqual(store.lifeListSpecies(), ["Blue Jay", "Northern Cardinal"])
	} finally {
		store.close()
	}
	// the absolute Windows-side dataDir is dropped, so the config resolves to the data just imported
	const config = JSON.parse(readFileSync(join(to, "look4.config.json"), "utf8"))
	assert.deepEqual(config, { sources: [{ type: "reolink", name: "feeder", host: "192.168.1.31" }] })
	// this machine's own key wins; the camera password it lacked comes over
	assert.equal(readFileSync(join(to, ".env"), "utf8"), "ANTHROPIC_API_KEY=mac-key\nREOLINK_PASSWORD=hunter2\n")
})

test("import refuses to replace data already here without --force", () => {
	const bundle = join(root, "bundle.tgz")
	assert.equal(look4(from, "export", bundle).code, 0)
	const r = look4(to, "import", bundle)
	assert.equal(r.code, 1)
	assert.match(r.stderr, /already has 4 clips, 1 lookouts and 2 life-list birds; --force replaces them/)
	assert.equal(look4(to, "import", bundle, "--force").code, 0)
})

test("mergeEnv adds only the keys the base lacks, and keeps comments out", () => {
	assert.equal(mergeEnv("A=1", "# note\nA=2\nexport B=3\n"), "A=1\nexport B=3\n")
	assert.equal(mergeEnv("A=1\n", "A=2\n"), "A=1\n")
})
