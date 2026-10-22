import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import http from "node:http"
import { createServer, type AddressInfo } from "node:net"
import { basename, join } from "node:path"
import { after, before, describe, test } from "node:test"
import { ReolinkSource } from "../src/config.ts"
import { openStore, type Store } from "../src/db.ts"
import { createBus } from "../src/events.ts"
import { ingestFile } from "../src/ingest.ts"
import { type DataPaths, dataPaths, ensureDataDirs } from "../src/paths.ts"
import type { SourceContext } from "../src/sources/index.ts"
import { createReolinkSource, reolinkCheck } from "../src/sources/reolink.ts"
import { createReolinkClient } from "../src/sources/reolink-api.ts"
import { type MockReolink, startMockReolink } from "./fixtures/mock-reolink.ts"

const root = join(import.meta.dirname, ".tmp", "sources", "reolink")
const PASSWORD_ENV = "LOOK4_TEST_REOLINK_PASSWORD"
let store: Store
let paths: DataPaths
const bus = createBus()

const ctx = (): SourceContext => ({
	store,
	paths,
	bus,
	ingest: input => ingestFile({ store, paths, bus }, input),
	kick: () => {}
})

const fixture = (name: string) => {
	const dir = join(root, "sd")
	mkdirSync(dir, { recursive: true })
	const p = join(dir, name)
	writeFileSync(p, randomBytes(20_000))
	return p
}

/** Cameras keep whole seconds. */
const recording = (name: string, at: Date, seconds = 30) => {
	const start = new Date(Math.floor(at.getTime() / 1000) * 1000)
	return { path: fixture(name), start, end: new Date(start.getTime() + seconds * 1000) }
}

before(() => {
	rmSync(root, { recursive: true, force: true })
	paths = dataPaths(join(root, "data"))
	ensureDataDirs(paths)
	store = openStore(paths.db)
})
after(() => store.close())

describe("reolink source", () => {
	const now = Date.now()
	const midnight = new Date(new Date(now).setHours(0, 0, 0, 0))
	let mock: MockReolink
	const cfg = () =>
		ReolinkSource.assert({
			type: "reolink",
			name: "feeder",
			host: mock.host,
			protocol: "http",
			passwordEnv: PASSWORD_ENV,
			lookbackHours: 48
		})
	const count = (cmd: string) => mock.requests.filter(r => r.cmd === cmd).length

	before(async () => {
		mock = await startMockReolink({
			files: [
				// yesterday: the source must split its search per day to see it
				recording("a", new Date(midnight.getTime() - 3600_000)),
				recording("b", new Date(now - 10 * 60_000))
			]
		})
		process.env[PASSWORD_ENV] = mock.password
	})
	after(() => mock.close())

	test("downloads each new recording once, across days", async () => {
		const src = createReolinkSource(cfg(), ctx())
		await src.pollNow()
		await src.pollNow()
		await src.stop()

		const clips = store.listClips({ source: "feeder" }).reverse()
		const names = mock.names()
		assert.deepEqual(
			clips.map(c => [c.sourceRef, c.originalName, c.recordedAt]),
			mock.files.map((f, i) => [names[i], basename(names[i]!), f.start.toISOString()])
		)
		assert.deepEqual(readFileSync(clips[0]!.path!), readFileSync(mock.files[0]!.path))
		assert.equal(count("Download"), 2)
		assert.equal(count("Login"), 1)
		assert.equal(count("Logout"), 1)
		assert.match(src.status().detail, /^stopped$/)
		assert.deepEqual(
			readdirSync(paths.partial).filter(n => n.startsWith("reolink-")),
			[]
		)
	})

	test("after a restart, resumes from the cursor instead of the lookback", async () => {
		mock.requests.length = 0
		mock.files.push(recording("c", new Date(now - 2 * 60_000)))
		const src = createReolinkSource(cfg(), ctx())
		await src.pollNow()
		assert.equal(count("Download"), 1)
		const earliest = Math.min(
			...mock.requests.filter(r => r.cmd === "Search").map(r => {
				const t = (r.param as any).Search.StartTime
				return new Date(t.year, t.mon - 1, t.day, t.hour, t.min, t.sec).getTime()
			})
		)
		assert.ok(now - earliest < 3600_000, `searched from ${new Date(earliest).toISOString()}`)
		assert.equal(src.status().state, "ok")
		// `capture: "auto"` fell back to the SD card because nothing answers RTSP on the mock, and says so
		assert.match(src.status().detail, /^RLC-823S1 · fw v3\.1\.0\.2368 · \d+ clips? today · from its SD card: its live stream \(RTSP\) is off$/)

		// the camera forgets the token (lease end, reboot): one -6, one fresh login, carry on
		mock.expireTokens()
		mock.files.push(recording("d", new Date(now - 60_000)))
		await src.pollNow()
		await src.stop()
		assert.deepEqual(
			mock.requests.filter(r => r.cmd !== "Search" || r.rspCode !== null).map(r => `${r.cmd}${r.rspCode ? ` ${r.rspCode}` : ""}`).slice(-4),
			["Search -6", "Login", "Download", "Logout"]
		)
		assert.equal(store.countClips({ source: "feeder" }), 4)
	})

	test("leaves a recording that is still being written for a later poll", async () => {
		mock.requests.length = 0
		const live = recording("e", new Date(Date.now() - 25_000), 20)
		mock.files.push(live)
		let clock = Date.now()
		const src = createReolinkSource(cfg(), ctx(), { now: () => clock })
		await src.pollNow()
		assert.equal(count("Download"), 0)

		clock += 30_000
		await src.pollNow()
		await src.stop()
		assert.equal(count("Download"), 1)
		assert.equal(store.findClipBySourceRef("feeder", mock.names().at(-1)!)?.recordedAt, live.start.toISOString())
	})

	test("without the password env var, reports how to fix it and never calls the camera", async () => {
		mock.requests.length = 0
		const src = createReolinkSource({ ...cfg(), passwordEnv: "LOOK4_TEST_UNSET" }, ctx())
		await src.pollNow()
		assert.deepEqual(src.status().state, "error")
		assert.equal(src.status().detail, "set LOOK4_TEST_UNSET in .env (`LOOK4_TEST_UNSET=` with nothing after it if the camera has no password)")
		assert.equal(mock.requests.length, 0)
	})
})

test("firmware that only serves files through Playback is detected once, then used directly", async () => {
	const start = Date.now() - 5 * 60_000
	const mock = await startMockReolink({
		files: [recording("p1", new Date(start)), recording("p2", new Date(start + 60_000))],
		downloadCmd: "Playback"
	})
	process.env[PASSWORD_ENV] = mock.password
	try {
		const src = createReolinkSource(
			ReolinkSource.assert({ type: "reolink", name: "hub", host: mock.host, protocol: "http", passwordEnv: PASSWORD_ENV }),
			ctx()
		)
		await src.pollNow()
		await src.stop()
		assert.deepEqual(
			mock.requests.filter(r => r.cmd === "Download" || r.cmd === "Playback").map(r => `${r.cmd}${r.rspCode ? ` ${r.rspCode}` : ""}`),
			["Download -9", "Playback", "Playback"]
		)
		assert.equal(store.countClips({ source: "hub" }), 2)
	} finally {
		await mock.close()
	}
})

describe("reolinkCheck", () => {
	test("auto finds HTTPS behind a self-signed cert, and falls back to HTTP", async () => {
		const secure = await startMockReolink({ files: [], protocol: "https" })
		const plain = await startMockReolink({ files: [], protocol: "http" })
		process.env[PASSWORD_ENV] = secure.password
		const check = (host: string) =>
			reolinkCheck(ReolinkSource.assert({ type: "reolink", name: "cam", host, passwordEnv: PASSWORD_ENV }))
		try {
			assert.deepEqual(await check(secure.host), {
				ok: true,
				detail: "RLC-823S1 · fw v3.1.0.2368 · https",
				model: "RLC-823S1",
				firmware: "v3.1.0.2368_23062700"
			})
			assert.equal((await check(plain.host)).detail, "RLC-823S1 · fw v3.1.0.2368 · http")
		} finally {
			await secure.close()
			await plain.close()
		}
	})

	test("a wrong password is a login failure that never echoes the password", async () => {
		const mock = await startMockReolink({ files: [] })
		process.env[PASSWORD_ENV] = "not-the-password"
		try {
			const r = await reolinkCheck(
				ReolinkSource.assert({ type: "reolink", name: "cam", host: mock.host, protocol: "http", passwordEnv: PASSWORD_ENV })
			)
			assert.deepEqual(r, { ok: false, detail: "login failed: Login: login failed (rspCode -7)" })
		} finally {
			await mock.close()
		}
	})

	test("an empty password variable is a blank password (Reolink's factory default), not a missing one", async () => {
		const mock = await startMockReolink({ files: [], password: "" })
		process.env[PASSWORD_ENV] = ""
		try {
			const r = await reolinkCheck(
				ReolinkSource.assert({ type: "reolink", name: "cam", host: mock.host, protocol: "http", passwordEnv: PASSWORD_ENV })
			)
			assert.equal(r.detail, "RLC-823S1 · fw v3.1.0.2368 · http")
			assert.deepEqual(mock.requests.filter(q => q.cmd === "Login").map(q => (q.param as any)?.User), [{ userName: "admin", password: "" }])
		} finally {
			await mock.close()
		}
	})

	test("with HTTP and HTTPS both refused, it says the camera's web servers are off and where to turn HTTPS on", async () => {
		// a port that was just free: nothing listens, so both schemes get ECONNREFUSED, as on firmware with only port 9000 open
		const probe = createServer()
		await new Promise<void>(r => probe.listen(0, "127.0.0.1", r))
		const { port } = probe.address() as AddressInfo
		await new Promise(r => probe.close(r))
		process.env[PASSWORD_ENV] = ""
		const r = await reolinkCheck(ReolinkSource.assert({ type: "reolink", name: "cam", host: `127.0.0.1:${port}`, passwordEnv: PASSWORD_ENV }))
		assert.deepEqual(r, {
			ok: false,
			detail: `127.0.0.1:${port} refused HTTPS and HTTP: the camera is there but HTTPS and HTTP are off — in the Reolink app: camera Settings → Network → Advanced → Server Settings, turn on HTTPS`
		})
	})
})

test("a keep-alive socket the camera dropped while idle is retried once on a fresh one, not reported as an error", async () => {
	// answers each socket's first request, and hangs up on any later one, like a camera that closed an idle connection
	const seen: string[] = []
	const server = http.createServer((req, res) => {
		const cmd = new URL(req.url ?? "/", "http://x").searchParams.get("cmd") ?? ""
		const sock = req.socket as typeof req.socket & { served?: number }
		sock.served = (sock.served ?? 0) + 1
		seen.push(`${cmd}#${sock.served}`)
		if (sock.served > 1) return sock.destroy()
		const value = cmd === "Login" ? { Token: { leaseTime: 3600, name: "tok" } } : { DevInfo: { model: "RLC-823S1", firmVer: "v3" } }
		res.setHeader("content-type", "application/json")
		res.end(JSON.stringify([{ cmd, code: 0, value }]))
	})
	await new Promise<void>(r => server.listen(0, "127.0.0.1", r))
	const { port } = server.address() as AddressInfo
	const client = createReolinkClient({ host: `127.0.0.1:${port}`, username: "admin", password: () => "", protocol: "http", channel: 0 })
	try {
		await client.login()
		assert.equal((await client.devInfo()).model, "RLC-823S1")
		assert.deepEqual(seen, ["Login#1", "GetDevInfo#2", "GetDevInfo#1"])
	} finally {
		server.closeAllConnections()
		await new Promise(r => server.close(r))
	}
})

describe("camera trouble", () => {
	const source = (mock: MockReolink, name: string, extra: Record<string, unknown> = {}) =>
		({ ...ReolinkSource.assert({ type: "reolink", name, host: mock.host, protocol: "http", passwordEnv: PASSWORD_ENV }), ...extra })
	const cmds = (mock: MockReolink, cmd: string) => mock.requests.filter(r => r.cmd === cmd)
	const waitFor = async (what: string, ok: () => boolean) => {
		for (let i = 0; i < 200 && !ok(); i++) await new Promise(r => setTimeout(r, 10))
		assert.ok(ok(), `timed out waiting for ${what}`)
	}
	/** Lets the (fast) automatic poller run several more cycles. */
	const idle = () => new Promise(r => setTimeout(r, 150))

	test("a camera clock an hour behind (DST switched off) still has its new recordings found, stamped in this computer's time", async () => {
		const now = Date.now()
		const visit = recording("skew", new Date(now - 2 * 60_000))
		const mock = await startMockReolink({ files: [visit], clockOffsetMs: -3600_000 })
		process.env[PASSWORD_ENV] = mock.password
		// steady state: the last poll was 5 minutes ago
		store.setKv("reolink:skewed:cursor", new Date(now - 5 * 60_000).toISOString())
		try {
			const src = createReolinkSource(source(mock, "skewed"), ctx())
			await src.pollNow()
			assert.equal(src.status().state, "ok")
			assert.match(src.status().detail, /camera clock is 60 min behind this computer: check its time zone and DST in the Reolink app/)
			await src.stop()
			assert.equal(store.findClipBySourceRef("skewed", mock.names()[0]!)?.recordedAt, visit.start.toISOString())
		} finally {
			await mock.close()
		}
	})

	test("a recording that keeps failing to download holds the cursor through backoff and is still pulled after a restart", async () => {
		const t0 = Date.now()
		let clock = t0
		const broken = { on: true }
		const mock = await startMockReolink({
			files: [recording("flaky", new Date(t0 - 10 * 60_000))],
			failDownload: () => broken.on,
			now: () => clock
		})
		process.env[PASSWORD_ENV] = mock.password
		const opts = { now: () => clock }
		try {
			const src = createReolinkSource(source(mock, "flaky"), ctx(), opts)
			// four failures, each poll after the previous one's wait (1, 5, 30 min) has passed
			for (const at of [0, 2, 8, 40]) {
				clock = t0 + at * 60_000
				await src.pollNow()
			}
			assert.equal(cmds(mock, "Download").length, 4)
			// inside the 2 h wait after the fourth failure: not even tried
			clock = t0 + 60 * 60_000
			await src.pollNow()
			assert.equal(cmds(mock, "Download").length, 4)
			assert.match(src.status().detail, / · 1 recording to retry: RecM07_.*\.mp4: Download: device busy/)
			await src.stop()

			// the camera recovers; look4 restarts hours later and still owes that recording
			broken.on = false
			clock = t0 + 3 * 3600_000
			const again = createReolinkSource(source(mock, "flaky"), ctx(), opts)
			await again.pollNow()
			await again.stop()
			assert.ok(store.findClipBySourceRef("flaky", mock.names()[0]!))
		} finally {
			await mock.close()
		}
	})

	test("below the free-space floor nothing is downloaded and the cursor holds, so the recording is pulled once space frees up", async () => {
		const t0 = Date.now()
		const visit = recording("full", new Date(t0 - 10 * 60_000))
		const mock = await startMockReolink({ files: [visit] })
		process.env[PASSWORD_ENV] = mock.password
		const disk = { free: 5.2e9 }
		// the recording is 20 KB, so 5.2 GB free stays under a 5.2 GB floor once it lands
		const tight: SourceContext = { ...ctx(), minFreeBytes: () => 5.2e9, freeBytes: () => disk.free }
		try {
			const src = createReolinkSource(source(mock, "full"), tight)
			await src.pollNow()
			assert.equal(cmds(mock, "Download").length, 0)
			assert.equal(src.status().state, "error")
			assert.match(src.status().detail, / · disk nearly full: 5\.2 GB free, pulling paused$/)
			assert.ok(Date.parse(store.getKv<string>("reolink:full:cursor")!) <= visit.start.getTime())
			await src.stop()

			disk.free = 40e9
			const again = createReolinkSource(source(mock, "full"), tight)
			await again.pollNow()
			await again.stop()
			assert.equal(cmds(mock, "Download").length, 1)
			assert.ok(store.findClipBySourceRef("full", mock.names()[0]!))
		} finally {
			await mock.close()
		}
	})

	test("after the camera calls the password wrong, automatic polls stop trying it until the password changes", async () => {
		let clock = Date.now()
		const mock = await startMockReolink({ files: [] })
		process.env[PASSWORD_ENV] = "the-old-password"
		const src = createReolinkSource(source(mock, "relocked", { pollSeconds: 0.01 }), ctx(), { now: () => clock })
		try {
			src.start()
			await waitFor("the first login", () => cmds(mock, "Login").length === 1 && src.status().state === "error")
			assert.match(src.status().detail, /^The camera turned down look4's sign-in: the username or password is wrong .* Until then look4 won't try again/)
			clock += 24 * 3600_000
			await idle()
			assert.equal(cmds(mock, "Login").length, 1)

			// Check now is the user asking, so it does spend a login
			await src.pollNow()
			assert.equal(cmds(mock, "Login").length, 2)

			process.env[PASSWORD_ENV] = mock.password
			await waitFor("a login with the new password", () => src.status().state === "ok")
			assert.deepEqual(cmds(mock, "Login").map(r => r.rspCode), [-7, -7, null])
		} finally {
			await src.stop()
			await mock.close()
		}
	})

	test("a locked camera is left alone for its lockout, and each lockout in a row doubles the wait", async () => {
		let clock = Date.now()
		const mock = await startMockReolink({ files: [], locked: true })
		process.env[PASSWORD_ENV] = mock.password
		const src = createReolinkSource(source(mock, "locked", { pollSeconds: 0.01 }), ctx(), { now: () => clock })
		const logins = () => cmds(mock, "Login").length
		// The mock counts a login when the request arrives, before the source has read the refusal and
		// set its wait from now(). Moving the clock in that gap starts the wait late, so wait for the
		// source's own "tries once more in N min" too: the nth lockout in a row waits 5 · 2^(n-1) min.
		const lockedOut = (n: number) => () =>
			logins() === n && src.status().detail.includes(`tries once more in ${5 * 2 ** (n - 1)} min`)
		try {
			src.start()
			await waitFor("the first lockout", lockedOut(1))
			// no stated wait in "Login has been locked": 5 min, then 10
			for (const [minutes, expected] of [[4, 1], [2, 2], [9, 2], [2, 3]] as const) {
				const before = logins()
				clock += minutes * 60_000
				if (expected > before) await waitFor(`a login after another ${minutes} min`, lockedOut(expected))
				await idle()
				assert.equal(logins(), expected, `after another ${minutes} min`)
			}
		} finally {
			await src.stop()
			await mock.close()
		}
	})
})
