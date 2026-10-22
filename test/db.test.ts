import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { openStore, type Store } from "../src/db.ts"

const root = join(import.meta.dirname, ".tmp", "worker", "db")
const dbPath = join(root, "look4.db")
let store: Store

before(() => {
	rmSync(root, { recursive: true, force: true })
	mkdirSync(root, { recursive: true })
	store = openStore(dbPath)
})
after(() => store.close())

const clip = (id: string) =>
	store.insertClip({ id, source: "scan", sourceRef: null, originalName: `${id}.mp4`, path: null, sizeBytes: 1, sha256: id, recordedAt: "2026-10-14T12:00:00.000Z" })

/** A row as a crashed process leaves it: processing, claimed by `pid` a minute ago. */
const claimedBy = (id: string, pid: number) =>
	store.db.prepare("UPDATE clips SET status = 'processing', claimed_by = ?, claimed_at = ? WHERE id = ?").run(pid, Date.now() - 60_000, id)

/** Another look4 process (a server, a scan) that opens the store and claims `id`, then works on it until killed. */
const otherProcess = async (id: string) => {
	const code = `const { openStore } = await import(${JSON.stringify(join(import.meta.dirname, "../src/db.ts"))})
		openStore(${JSON.stringify(dbPath)}).claimClip(${JSON.stringify(id)}, null)
		console.log("claimed")
		setInterval(() => {}, 60_000)`
	const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] })
	await once(child.stdout, "data")
	return child
}

test("a clip a live look4 process is processing is neither claimed again nor reset; once it dies, a scan takes the clip over", async () => {
	clip("live")
	clip("kept")
	store.updateClip("kept", { status: "kept" })
	const other = await otherProcess("live")
	try {
		assert.equal(store.claimClip("live", ["lk"]), null)
		assert.equal(store.resetProcessing(), 0)
	} finally {
		other.kill("SIGKILL")
		await once(other, "exit")
	}
	// a crashed server, not restarted: `look4 scan` on the same bytes does the work itself
	const taken = store.claimClip("live", ["lk"])!
	assert.deepEqual([taken.status, taken.pendingLookouts], ["processing", ["lk"]])

	// any settled clip can be taken for a scan, with the scan's lookouts
	const settled = store.claimClip("kept", ["lk"])!
	assert.deepEqual([settled.status, settled.pendingLookouts], ["processing", ["lk"]])
	for (const id of ["live", "kept"]) store.updateClip(id, { status: "kept" })
})

test("a claim whose pid now belongs to some other live process (after a reboot) is reset, and a dead process's is too", () => {
	clip("reused")
	clip("dead")
	// the test runner that spawned this file is alive but is no look4 process with the store open
	claimedBy("reused", process.ppid)
	claimedBy("dead", spawnSync(process.execPath, ["-e", ""]).pid!)
	assert.equal(store.resetProcessing(), 2)
	assert.deepEqual(["reused", "dead"].map(id => store.getClip(id)!.status), ["pending", "pending"])
})
