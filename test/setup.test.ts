import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import http from "node:http"
import { createServer, type AddressInfo, type Socket } from "node:net"
import { join } from "node:path"
import { after, before, describe, test } from "node:test"
import { parseEnv } from "node:util"
import type { CameraTestResult, SetupStatus, SourceDto } from "../src/api-types.ts"
import { startApp } from "../src/app.ts"
import { loadConfig } from "../src/config.ts"
import { lockoutSeconds, testCamera } from "../src/setup/camera-test.ts"
import { parseArpExe, parseIpconfig, parseIpNeigh, parseProcNetArp, type PortMap, scanSubnets } from "../src/setup/discover.ts"
import { updateEnvFile } from "../src/setup/envfile.ts"
import { FolderError, listFolder } from "../src/setup/fs-list.ts"
import { testStream } from "../src/setup/snapshot.ts"
import { type MockReolink, startMockReolink } from "./fixtures/mock-reolink.ts"

const root = join(import.meta.dirname, ".tmp", "setup")

before(() => rmSync(root, { recursive: true, force: true }))
after(() => rmSync(root, { recursive: true, force: true }))

const dirFor = (name: string) => {
	const d = join(root, name)
	mkdirSync(d, { recursive: true })
	return d
}

/** A port nothing listens on. */
const closedPort = async () => {
	const s = createServer()
	await new Promise<void>(r => s.listen(0, "127.0.0.1", r))
	const { port } = s.address() as AddressInfo
	await new Promise(r => s.close(r))
	return port
}

describe(".env editing", () => {
	test("sets and removes keys while every other line, comment and blank stays put", () => {
		const dir = dirFor("env-preserve")
		writeFileSync(join(dir, ".env"), "# camera\nREOLINK_PASSWORD=old\n\nexport OTHER=1\nREOLINK_PASSWORD=stale-twin\nGONE=x\n")
		updateEnvFile(dir, { REOLINK_PASSWORD: "new", GONE: null, ADDED: "" })
		assert.equal(readFileSync(join(dir, ".env"), "utf8"), "# camera\nREOLINK_PASSWORD=new\n\nexport OTHER=1\nADDED=\n")
		assert.equal(process.env.REOLINK_PASSWORD, "new")
		assert.equal(process.env.ADDED, "")
		assert.equal(process.env.GONE, undefined)
	})

	test("values with spaces, #, quotes and backslashes read back verbatim through Node's own parser", () => {
		const dir = dirFor("env-quoting")
		const values = {
			A: "pa ss#word",
			B: "it's",
			C: `it's "quoted"`,
			D: "back\\nslash 'and' \"both\"",
			E: "rtsp://admin:p@ss@192.168.1.50:554/h264Preview_01_main"
		}
		updateEnvFile(dir, values)
		assert.deepEqual({ ...parseEnv(readFileSync(join(dir, ".env"), "utf8")) }, values)
		assert.throws(() => updateEnvFile(dir, { F: "two\nlines" }), /line break/)
		assert.throws(() => updateEnvFile(dir, { "BAD KEY": "x" }), /not a valid environment variable name/)
	})

	test("a new file is owner-only, and an existing world-readable one is tightened", () => {
		const fresh = dirFor("env-mode-new")
		updateEnvFile(fresh, { K: "v" })
		assert.equal(statSync(join(fresh, ".env")).mode & 0o777, 0o600)
		const loose = dirFor("env-mode-old")
		writeFileSync(join(loose, ".env"), "K=v\n")
		chmodSync(join(loose, ".env"), 0o644)
		updateEnvFile(loose, { K: "w" })
		assert.equal(statSync(join(loose, ".env")).mode & 0o777, 0o600)
	})
})

describe("network discovery parsers", () => {
	// captured on David's WSL2 machine (2026-10-14); MACs anonymized past the vendor prefix
	const ARP_EXE = `
Interface: 192.168.1.6 --- 0xb
  Internet Address      Physical Address      Type
  192.168.1.1           b4-cf-49-00-00-01     dynamic
  192.168.1.9           bc-df-58-00-00-02     dynamic
  192.168.1.31          ec-71-db-00-00-03     dynamic
  192.168.1.255         ff-ff-ff-ff-ff-ff     static
  224.0.0.22            01-00-5e-00-00-16     static
  239.255.255.250       01-00-5e-7f-ff-fa     static

Interface: 172.19.144.1 --- 0x26
  Internet Address      Physical Address      Type
  172.19.148.209        00-15-5d-00-00-04     dynamic
  172.19.159.255        ff-ff-ff-ff-ff-ff     static
`.replace(/\n/g, "\r\n")

	const IPCONFIG = `
Windows IP Configuration


Ethernet adapter Ethernet:

   Media State . . . . . . . . . . . : Media disconnected
   Connection-specific DNS Suffix  . :

Ethernet adapter Ethernet 2:

   Connection-specific DNS Suffix  . : mynetworksettings.com
   IPv6 Address. . . . . . . . . . . : fd30:2cc2:e9ef:22be:2ea5:d24:44b7:8ce7
   Link-local IPv6 Address . . . . . : fe80::19b2:52f6:e180:2219%11
   IPv4 Address. . . . . . . . . . . : 192.168.1.6(Preferred)
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . : 192.168.1.1

Ethernet adapter vEthernet (WSL (Hyper-V firewall)):

   Connection-specific DNS Suffix  . :
   IPv4 Address. . . . . . . . . . . : 172.19.144.1
   Subnet Mask . . . . . . . . . . . : 255.255.240.0
   Default Gateway . . . . . . . . . :
`.replace(/\n/g, "\r\n")

	test("arp.exe: dynamic unicast entries only, MACs normalized", () => {
		assert.deepEqual(parseArpExe(ARP_EXE), [
			{ ip: "192.168.1.1", mac: "B4:CF:49:00:00:01" },
			{ ip: "192.168.1.9", mac: "BC:DF:58:00:00:02" },
			{ ip: "192.168.1.31", mac: "EC:71:DB:00:00:03" },
			{ ip: "172.19.148.209", mac: "00:15:5D:00:00:04" }
		])
	})

	test("ipconfig.exe: each IPv4 address with its mask, (Preferred) suffix and IPv6 lines ignored", () => {
		assert.deepEqual(parseIpconfig(IPCONFIG), [
			{ address: "192.168.1.6", mask: "255.255.255.0" },
			{ address: "172.19.144.1", mask: "255.255.240.0" }
		])
		// German Windows labels its lines differently
		assert.deepEqual(parseIpconfig("   IPv4-Adresse  . . . . . . . . . . : 10.0.0.5\r\n   Subnetzmaske  . . . . . . . . . . : 255.255.255.0\r\n"), [
			{ address: "10.0.0.5", mask: "255.255.255.0" }
		])
	})

	test("/proc/net/arp and ip neigh skip incomplete and failed entries", () => {
		const proc = [
			"IP address       HW type     Flags       HW address            Mask     Device",
			"172.19.144.1     0x1         0x2         00:15:5d:00:00:05     *        eth0",
			"192.168.1.77     0x1         0x0         00:00:00:00:00:00     *        eth0"
		].join("\n")
		assert.deepEqual(parseProcNetArp(proc), [{ ip: "172.19.144.1", mac: "00:15:5D:00:00:05" }])
		const neigh = [
			"172.19.144.1 dev eth0 lladdr 00:15:5d:00:00:05 REACHABLE",
			"192.168.1.31 dev eth0 lladdr ec:71:db:00:00:03 STALE",
			"192.168.1.40 dev eth0  FAILED",
			"192.168.1.41 dev eth0 INCOMPLETE"
		].join("\n")
		assert.deepEqual(parseIpNeigh(neigh), [
			{ ip: "172.19.144.1", mac: "00:15:5D:00:00:05" },
			{ ip: "192.168.1.31", mac: "EC:71:DB:00:00:03" }
		])
	})

	test("subnets: the LAN's /24 only, skipping the WSL bridge unless it is all there is", () => {
		const wsl = [
			{ address: "172.19.148.209", mask: "255.255.240.0" },
			{ address: "127.0.0.1", mask: "255.0.0.0" },
			...parseIpconfig(IPCONFIG)
		]
		assert.deepEqual(scanSubnets(wsl), ["192.168.1.0/24"])
		// a /16 office network still scans just its own /24, not 65k addresses
		assert.deepEqual(scanSubnets([{ address: "10.20.30.40", mask: "255.255.0.0" }]), ["10.20.30.0/24"])
		assert.deepEqual(scanSubnets([{ address: "172.19.148.209", mask: "255.255.240.0" }]), ["172.19.148.0/24"])
	})
})

describe("camera test", () => {
	let mock: MockReolink
	let locked: MockReolink
	/** Every well-known port moved somewhere closed, so nothing on this machine can answer. */
	let closed: PortMap
	before(async () => {
		mock = await startMockReolink({ files: [] })
		locked = await startMockReolink({ files: [], locked: true })
		closed = {
			https: await closedPort(),
			http: await closedPort(),
			rtsp: await closedPort(),
			reolinkApp: await closedPort(),
			onvif: await closedPort(),
			cast: await closedPort()
		}
	})
	after(async () => {
		await mock.close()
		await locked.close()
	})
	// Every port here listens or refuses at once, so the timeout costs nothing; a short one turned an
	// open port into "closed" whenever the machine was loaded enough to stall the probe.
	const opts = (portMap: PortMap) => ({ portMap, probeTimeoutMs: 5000 })

	test("only the app port answering is http-disabled, and not one byte is sent to the camera", async () => {
		const received: Buffer[] = []
		const sockets: Socket[] = []
		const app = createServer(s => {
			sockets.push(s)
			s.on("data", d => received.push(d as Buffer))
		})
		await new Promise<void>(r => app.listen(0, "127.0.0.1", r))
		const reolinkApp = (app.address() as AddressInfo).port
		try {
			const r = await testCamera({ host: "127.0.0.1", password: "" }, opts({ ...closed, reolinkApp }))
			assert.equal(r.problem, "http-disabled")
			assert.deepEqual(r.ports, { https: false, http: false, rtsp: false, reolinkApp: true, onvif: false })
			assert.match(r.detail, /HTTPS setting is switched off/)
			await new Promise(r => setTimeout(r, 50))
			assert.equal(Buffer.concat(received).length, 0)
		} finally {
			for (const s of sockets) s.destroy()
			await new Promise(r => app.close(r))
		}
	})

	test("an app port that is really a Cast device is not called a Reolink camera", async () => {
		const both = [createServer(s => s.destroy()), createServer(s => s.destroy())]
		for (const s of both) await new Promise<void>(r => s.listen(0, "127.0.0.1", r))
		const [app, cast] = both.map(s => (s.address() as AddressInfo).port)
		try {
			const r = await testCamera({ host: "127.0.0.1" }, opts({ ...closed, reolinkApp: app!, cast: cast! }))
			assert.equal(r.problem, "not-reolink")
		} finally {
			for (const s of both) await new Promise(r => s.close(r))
		}
	})

	test("nothing answering anywhere is unreachable", async () => {
		const r = await testCamera({ host: `127.0.0.1:${await closedPort()}` }, opts(closed))
		assert.deepEqual([r.ok, r.problem], [false, "unreachable"])
	})

	test("the right login signs in and names the camera", async () => {
		const r = await testCamera({ host: mock.host, username: "admin", password: mock.password, protocol: "http" }, opts(closed))
		assert.deepEqual(r, {
			ok: true,
			problem: null,
			detail: "Signed in to “Feeder” (RLC-823S1).",
			model: "RLC-823S1",
			firmware: "v3.1.0.2368_23062700",
			name: "Feeder",
			protocol: "http",
			ports: { https: false, http: true, rtsp: false, reolinkApp: false, onvif: false }
		} satisfies CameraTestResult)
		// the test session is given back, not left holding one of the camera's few slots
		assert.equal(mock.requests.at(-1)?.cmd, "Logout")
	})

	test("a wrong password is bad-credentials after exactly one login attempt", async () => {
		const before = mock.requests.filter(q => q.cmd === "Login").length
		const r = await testCamera({ host: mock.host, password: "not-hunter2", protocol: "http" }, opts(closed))
		assert.equal(r.problem, "bad-credentials")
		assert.doesNotMatch(JSON.stringify(r), /not-hunter2/)
		assert.equal(mock.requests.filter(q => q.cmd === "Login").length - before, 1)
	})

	test("a locked account is locked-out even though the camera sends the bad-password code", async () => {
		const r = await testCamera({ host: locked.host, password: locked.password, protocol: "http" }, opts(closed))
		assert.equal(r.problem, "locked-out")
		assert.match(r.detail, /Wait about 5 minutes/)
		// reolink_aio's "Login has been locked" names no time, so none is made up
		assert.equal(r.retryAfterSeconds, undefined)
		assert.deepEqual([lockoutSeconds("Login: locked, retry after 300 seconds (rspCode -7)"), lockoutSeconds("locked for 5 min")], [300, 300])
	})

	test("a web server that is not a Reolink API is not-reolink", async () => {
		const web = http.createServer((_, res) => res.writeHead(404, { "content-type": "text/html" }).end("<h1>router login</h1>"))
		await new Promise<void>(r => web.listen(0, "127.0.0.1", r))
		try {
			const r = await testCamera({ host: `127.0.0.1:${(web.address() as AddressInfo).port}`, protocol: "http" }, opts(closed))
			assert.equal(r.problem, "not-reolink")
		} finally {
			web.closeAllConnections()
			await new Promise(r => web.close(r))
		}
	})
})

describe("stream test", () => {
	/** Answers OPTIONS, then DESCRIBE with `status`, like a camera refusing the login or the path. */
	const fakeRtsp = async (status: string) => {
		const s = createServer(sock => {
			sock.on("data", d => {
				const req = d.toString()
				const cseq = /CSeq:\s*(\d+)/i.exec(req)?.[1] ?? "1"
				const head = req.startsWith("OPTIONS")
					? `RTSP/1.0 200 OK\r\nCSeq: ${cseq}\r\nPublic: OPTIONS, DESCRIBE, SETUP, PLAY\r\n`
					: `RTSP/1.0 ${status}\r\nCSeq: ${cseq}\r\n${status.startsWith("401") ? 'WWW-Authenticate: Basic realm="cam"\r\n' : ""}`
				sock.write(`${head}\r\n`)
			})
			sock.on("error", () => {})
		})
		await new Promise<void>(r => s.listen(0, "127.0.0.1", r))
		return { port: (s.address() as AddressInfo).port, close: () => new Promise(r => s.close(r)) }
	}

	test("a refused login is the username or password in the address, never echoed back", async () => {
		const cam = await fakeRtsp("401 Unauthorized")
		try {
			const r = await testStream(`rtsp://admin:s3cret-pw@127.0.0.1:${cam.port}/h264Preview_01_main`)
			assert.deepEqual(r, { ok: false, detail: "The camera said the username or password in the address is wrong." })
		} finally {
			await cam.close()
		}
	})

	test("a missing path is a wrong stream path", async () => {
		const cam = await fakeRtsp("404 Not Found")
		try {
			const r = await testStream(`rtsp://127.0.0.1:${cam.port}/nope`)
			assert.match(r.detail, /no stream at that path/)
		} finally {
			await cam.close()
		}
	})

	test("a closed port is nothing answering, and silence is a timeout with the same advice", async () => {
		const refused = await testStream(`rtsp://admin:s3cret-pw@127.0.0.1:${await closedPort()}/x`)
		assert.deepEqual(refused, { ok: false, detail: "Nothing answered at that address: RTSP may be turned off on the camera, or the port is wrong." })
		// accepts the connection and never says a word
		const mute = createServer(() => {})
		await new Promise<void>(r => mute.listen(0, "127.0.0.1", r))
		try {
			const r = await testStream(`rtsp://127.0.0.1:${(mute.address() as AddressInfo).port}/x`, 1500)
			assert.match(r.detail, /^Nothing answered at that address in time/)
		} finally {
			mute.close()
		}
	})

	test("a working stream gives a preview frame and its size and codec", async () => {
		const video = join(dirFor("stream"), "clip.ts")
		execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=5", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", video])
		const body = readFileSync(video)
		const web = http.createServer((_, res) => res.writeHead(200, { "content-type": "video/mp2t", "content-length": body.length }).end(body))
		await new Promise<void>(r => web.listen(0, "127.0.0.1", r))
		try {
			const r = await testStream(`http://127.0.0.1:${(web.address() as AddressInfo).port}/live.ts`)
			assert.deepEqual([r.ok, r.detail, r.width, r.height, r.codec], [true, "Got a picture from the camera.", 320, 240, "h264"])
			assert.ok(r.preview?.startsWith("data:image/jpeg;base64,/9j/"))
		} finally {
			web.closeAllConnections()
			await new Promise(r => web.close(r))
		}
	})
})

describe("folder browser", () => {
	test("lists folders (not dot-folders, following links to folders) and counts the videos", async () => {
		const dir = dirFor("fs/Videos")
		for (const d of ["b-cam", "A-cam", ".cache", "$Recycle.Bin"]) mkdirSync(join(dir, d), { recursive: true })
		for (const f of ["one.MP4", "two.mkv", "notes.txt", ".hidden.mp4"]) writeFileSync(join(dir, f), "")
		symlinkSync(join(dir, "A-cam"), join(dir, "link-to-a"))
		symlinkSync(join(dir, "notes.txt"), join(dir, "link-to-file"))
		const r = await listFolder(dir, { home: dirFor("fs"), wsl: false })
		assert.deepEqual(r.dirs.map(d => d.name), ["A-cam", "b-cam", "link-to-a"])
		assert.equal(r.videoCount, 2)
		assert.equal(r.parent, join(root, "fs"))
		assert.deepEqual(r.shortcuts, [
			{ label: "Home", path: join(root, "fs") },
			{ label: "Videos", path: dir }
		])
	})

	test("refuses relative paths and says when a folder is missing", async () => {
		await assert.rejects(listFolder("Videos"), (e: FolderError) => e.status === 400 && /must start with \//.test(e.message))
		await assert.rejects(listFolder("../etc"), (e: FolderError) => e.status === 400)
		await assert.rejects(listFolder(join(root, "nope")), (e: FolderError) => e.status === 404)
		assert.equal((await listFolder("/")).parent, null)
	})
})

describe("sources API on a running app", () => {
	let mock: MockReolink
	let app: Awaited<ReturnType<typeof startApp>>
	let dir: string
	let base: string
	const responses: string[] = []

	const call = async <t>(method: string, path: string, body?: unknown): Promise<{ status: number; body: t }> => {
		const res = await fetch(`${base}${path}`, {
			method,
			headers: body === undefined ? {} : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body)
		})
		const text = res.headers.get("content-type")?.includes("json") ? await res.text() : ""
		responses.push(text)
		return { status: res.status, body: (text ? JSON.parse(text) : await res.arrayBuffer()) as t }
	}

	const waitFor = async (name: string, pred: (s: SourceDto["status"]) => boolean) => {
		for (let i = 0; i < 100; i++) {
			const { body } = await call<SourceDto[]>("GET", "/api/sources")
			const s = body.find(x => x.config.name === name)?.status
			if (s && pred(s)) return s
			await new Promise(r => setTimeout(r, 100))
		}
		throw new Error(`source ${name} never reached the expected state`)
	}

	before(async () => {
		mock = await startMockReolink({ files: [] })
		dir = dirFor("app")
		delete process.env.REOLINK_PASSWORD
		writeFileSync(
			join(dir, "look4.config.json"),
			JSON.stringify({ dataDir: "data", pipeline: { detector: { enabled: false }, judge: { provider: "none" } } })
		)
		const config = loadConfig(join(dir, "look4.config.json"))
		app = await startApp({ ...config, server: { host: "127.0.0.1", port: 0 } as never })
		base = app.url!
	})
	after(async () => {
		await app.stop()
		await mock.close()
	})

	test("add → running → live snapshot → wrong password → fixed → paused → removed", async () => {
		const fresh = await call<SetupStatus>("GET", "/api/setup")
		assert.deepEqual([fresh.body.completed, fresh.body.steps.source], [false, false])

		const added = await call<SourceDto>("POST", "/api/sources", { type: "reolink", host: mock.host, password: mock.password })
		assert.equal(added.status, 201)
		assert.equal(added.body.config.name, "camera")
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "look4.config.json"), "utf8")).sources, [
			{ type: "reolink", name: "camera", host: mock.host, username: "admin", passwordEnv: "REOLINK_PASSWORD" }
		])
		assert.equal(readFileSync(join(dir, ".env"), "utf8"), `REOLINK_PASSWORD=${mock.password}\n`)
		const running = await waitFor("camera", s => s.state === "ok")
		assert.match(running.detail, /RLC-823S1/)

		const after = await call<SetupStatus>("GET", "/api/setup")
		assert.deepEqual([after.body.completed, after.body.steps.source], [true, true])

		const snap = await fetch(`${base}/api/sources/camera/snapshot`)
		assert.equal(snap.headers.get("content-type"), "image/jpeg")
		assert.deepEqual([...new Uint8Array(await snap.arrayBuffer()).subarray(0, 2)], [0xff, 0xd8])

		// a new password restarts the adapter with it, even though the config file did not change
		await call("PATCH", "/api/sources/camera", { password: "nope" })
		await waitFor("camera", s => s.state === "error" && /turned down look4's sign-in: the username or password is wrong/.test(s.detail))
		// and a source that is being refused does not get another login spent on a snapshot
		const logins = mock.requests.filter(r => r.cmd === "Login").length
		assert.equal((await call("GET", "/api/sources/camera/snapshot")).status, 502)
		assert.equal(mock.requests.filter(r => r.cmd === "Login").length, logins)
		await call("PATCH", "/api/sources/camera", { password: mock.password })
		await waitFor("camera", s => s.state === "ok")

		// "Fix it" re-tests the saved camera without the password being sent again
		const retest = await call<CameraTestResult>("POST", "/api/setup/test-camera", { host: mock.host, protocol: "http", source: "camera" })
		assert.deepEqual([retest.body.ok, retest.body.name], [true, "Feeder"])
		// but never to another address: anything that can reach the API could name its own and collect the password
		const loginsSoFar = mock.requests.filter(r => r.cmd === "Login").length
		const elsewhere = `localhost:${mock.port}`
		const redirected = await call<{ error: string }>("POST", "/api/setup/test-camera", { host: elsewhere, protocol: "http", source: "camera" })
		assert.deepEqual([redirected.status, redirected.body.error], [400, `${elsewhere} is a new address for “camera”, so type the camera's password again. look4 only sends the saved password to the address it was saved for.`])
		assert.equal((await call("PATCH", "/api/sources/camera", { host: elsewhere })).status, 400)
		assert.equal(mock.requests.filter(r => r.cmd === "Login").length, loginsSoFar)
		assert.equal(JSON.parse(readFileSync(join(dir, "look4.config.json"), "utf8")).sources[0].host, mock.host)

		const paused = await call<SourceDto>("PATCH", "/api/sources/camera", { enabled: false })
		assert.deepEqual([paused.body.status.state, paused.body.status.detail, paused.body.config.enabled], ["stopped", "paused", false])
		assert.equal(JSON.parse(readFileSync(join(dir, "look4.config.json"), "utf8")).sources[0].enabled, false)
		assert.equal(mock.requests.at(-1)?.cmd, "Logout")

		assert.equal((await call("POST", "/api/sources", { type: "reolink", host: mock.host })).status, 409)

		assert.deepEqual((await call("DELETE", "/api/sources/camera")).body, { ok: true })
		assert.deepEqual((await call<SourceDto[]>("GET", "/api/sources")).body, [])
		assert.deepEqual(app.ctx.sourceStatuses().map(s => s.name), ["inbox"])
		assert.equal(readFileSync(join(dir, ".env"), "utf8"), "")

		for (const text of responses) assert.doesNotMatch(text, new RegExp(mock.password))
	})

	test("rtsp URLs go to .env under the source's name and come back masked", async () => {
		const url = "rtsp://admin:s3cret-pw@127.0.0.1:1/h264Preview_01_sub"
		const added = await call<SourceDto>("POST", "/api/sources", { type: "rtsp", name: "porch", url })
		assert.equal(added.status, 201)
		assert.deepEqual(added.body.config, { type: "rtsp", name: "porch", enabled: true, urlEnv: "LOOK4_RTSP_URL_PORCH", segmentSeconds: 30 })
		assert.match(readFileSync(join(dir, ".env"), "utf8"), /^LOOK4_RTSP_URL_PORCH=rtsp:\/\/admin:s3cret-pw@127\.0\.0\.1:1\/h264Preview_01_sub$/m)
		assert.equal((await call("POST", "/api/sources", { type: "rtsp", name: "Bad Name", url })).status, 400)
		assert.equal((await call("POST", "/api/sources", { type: "rtsp", url: "192.168.1.5/stream" })).status, 400)
		await call("DELETE", "/api/sources/porch")
		for (const text of responses) assert.doesNotMatch(text, /s3cret-pw/)
	})

	test("an API key Anthropic rejects is not saved; a good one switches the judge on live", async () => {
		const anthropic = http.createServer((req, res) => {
			const ok = req.url?.startsWith("/v1/models") && req.headers["x-api-key"] === "sk-ant-good-key-0001"
			res.writeHead(ok ? 200 : 401, { "content-type": "application/json" })
			res.end(
				JSON.stringify(
					ok
						? { data: [], has_more: false, first_id: null, last_id: null }
						: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }
				)
			)
		})
		await new Promise<void>(r => anthropic.listen(0, "127.0.0.1", r))
		process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(anthropic.address() as AddressInfo).port}`
		try {
			assert.equal((await call("POST", "/api/setup/judge-key", { apiKey: "not-a-key" })).status, 400)
			const rejected = await call<{ error: string }>("POST", "/api/setup/judge-key", { apiKey: "sk-ant-bad-key-0001" })
			assert.deepEqual([rejected.status, /didn't accept/.test(rejected.body.error)], [400, true])
			assert.doesNotMatch(readFileSync(join(dir, ".env"), "utf8"), /ANTHROPIC_API_KEY/)

			const before = await call<SetupStatus>("GET", "/api/setup")
			assert.equal(before.body.judge.provider, "none")
			const saved = await call<SetupStatus>("POST", "/api/setup/judge-key", { apiKey: "sk-ant-good-key-0001" })
			assert.equal(saved.status, 200)
			assert.deepEqual([saved.body.judge.provider, saved.body.judge.ok, saved.body.steps.judge], ["anthropic", true, true])
			assert.match(readFileSync(join(dir, ".env"), "utf8"), /^ANTHROPIC_API_KEY=sk-ant-good-key-0001$/m)
			// "none" would have ignored the key
			assert.equal(JSON.parse(readFileSync(join(dir, "look4.config.json"), "utf8")).pipeline.judge.provider, "auto")
		} finally {
			delete process.env.ANTHROPIC_BASE_URL
			await new Promise(r => anthropic.close(r))
		}
	})

	test("changing the judge's backend in Settings takes effect without a restart", async () => {
		assert.notEqual((await call<SetupStatus>("GET", "/api/setup")).body.judge.provider, "mock")
		assert.equal((await call("PATCH", "/api/settings", { judge: { provider: "mock" } })).status, 200)
		assert.deepEqual((await call<SetupStatus>("GET", "/api/setup")).body.judge, { ok: true, detail: "Mock spotter (offline, for tests)", provider: "mock", model: app.ctx.llm!.model })
	})
})
