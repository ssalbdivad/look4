// What look4's live view and camera controls can reach on a camera, from this
// machine. By default it only knocks on ports (no sign-in, so it can never count
// toward a Reolink lockout). With --login it also signs in ONCE over the HTTP(S)
// API and reads (never changes) what the camera can do, then probes the RTSP sub
// and main streams with ffprobe.
//
//   node scripts/check-camera.ts 192.168.1.31
//   node scripts/check-camera.ts 192.168.1.31 --login [--user admin] [--password-env REOLINK_PASSWORD] [--rtsp-port 554]
//
// The password is read from the named env var (loaded from ./.env when present) and never printed.

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { parseArgs } from "node:util"
import type { LiveStream } from "../src/api-types.ts"
import { reolinkCapabilities } from "../src/live/reolink-control.ts"
import { reolinkRtspUrl } from "../src/live/inputs.ts"
import { FFPROBE } from "../src/media/ffmpeg.ts"
import { probePorts } from "../src/setup/discover.ts"
import { streamProblem } from "../src/setup/snapshot.ts"
import { createReolinkClient, loginProblem, ReolinkError } from "../src/sources/reolink-api.ts"
import { maskWith } from "../src/sources/rtsp.ts"

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		login: { type: "boolean", default: false },
		user: { type: "string", default: "admin" },
		"password-env": { type: "string", default: "REOLINK_PASSWORD" },
		"rtsp-port": { type: "string", default: "554" }
	}
})
const host = positionals[0]
if (!host) {
	console.error("usage: node scripts/check-camera.ts <camera address> [--login]")
	process.exit(2)
}
if (existsSync(".env")) process.loadEnvFile(".env")

const mark = (ok: boolean) => (ok ? "ok " : "-- ")
const { ports, cast } = await probePorts(host, 2000)
console.log(`ports at ${host}${cast ? " (also a Google Cast device: 9000 may not be Reolink)" : ""}`)
console.log(`  ${mark(ports.reolinkApp)} 9000  Reolink app port (camera is there)`)
console.log(`  ${mark(ports.https)} 443   HTTPS API (sign-in, clips, controls, snapshots)`)
console.log(`  ${mark(ports.http)} 80    HTTP API (same, unencrypted)`)
console.log(`  ${mark(ports.rtsp)} 554   RTSP (live video)`)
console.log(`  ${mark(ports.onvif)} 8000  ONVIF`)
if (!ports.https && !ports.http) console.log("  → turn on HTTPS (or HTTP): Reolink app → camera Settings → Network → Advanced → Server Settings")
if (!ports.rtsp) console.log("  → turn on RTSP for live video: same screen")

if (!values.login) {
	console.log("\n(ports only; add --login to sign in once and read abilities + probe the streams)")
	process.exit(0)
}

const envName = values["password-env"]!
const password = process.env[envName]
if (password === undefined) {
	console.error(`\n${envName} is not set (put it in .env); not signing in.`)
	process.exit(1)
}
if (!ports.https && !ports.http) {
	console.error("\nneither HTTPS nor HTTP answers, so there is nothing to sign in to.")
	process.exit(1)
}

const client = createReolinkClient({
	host,
	username: values.user!,
	password: () => password,
	protocol: ports.https ? "https" : "http",
	channel: 0,
	timeoutMs: 10_000
})
try {
	await client.login()
	const info = await client.devInfo()
	console.log(`\nsigned in over ${client.protocol()}: ${info.model} “${info.name ?? ""}”, firmware ${info.firmware}`)
	const caps = reolinkCapabilities(await client.command("GetAbility", { User: { userName: values.user } }), 0)
	console.log(`  controls: pan ${caps.pan} · tilt ${caps.tilt} · zoom ${caps.zoom} · presets ${caps.presets} · IR ${caps.ir} · spotlight ${caps.spotlight} · snap ${caps.snap}`)
	if (caps.presets) {
		const p = await client.command("GetPtzPreset", { channel: 0 }).catch(() => null)
		const names = (p?.PtzPreset ?? []).filter((x: any) => Number(x?.enable) === 1).map((x: any) => x.name)
		console.log(`  presets: ${names.join(", ") || "(none saved)"}`)
	}
} catch (e) {
	if (e instanceof ReolinkError && e.cmd === "Login") {
		console.error(`\nsign-in refused (${loginProblem(e)}): ${e.message}${e.attemptsLeft !== null ? ` — ${e.attemptsLeft} tries left before lockout` : ""}`)
		console.error("not probing RTSP with a password the camera just refused.")
		await client.close()
		process.exit(1)
	}
	console.error(`\nAPI check failed: ${e instanceof Error ? e.message : String(e)}`)
} finally {
	await client.close()
}

if (!ports.rtsp) process.exit(0)
if (password === "") {
	console.log("\nRTSP skipped: Reolink refuses RTSP while the camera has no password. Set one in the Reolink app.")
	process.exit(0)
}
const probe = (stream: LiveStream) =>
	new Promise<string>(resolve => {
		const url = reolinkRtspUrl({ host, username: values.user!, channel: 0, rtspPort: Number(values["rtsp-port"]) }, password, stream)!
		const mask = maskWith(url)
		const p = spawn(FFPROBE, ["-v", "error", "-rtsp_transport", "tcp", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate", "-of", "compact=p=0:nk=1", url])
		let out = ""
		let err = ""
		p.stdout.on("data", d => (out += d))
		p.stderr.on("data", d => (err += d))
		const timer = setTimeout(() => p.kill("SIGKILL"), 15_000)
		p.on("close", code => {
			clearTimeout(timer)
			resolve(code === 0 ? out.trim().replace(/\n/g, " · ") : `failed: ${streamProblem(mask(err.trim()) || "timeout")}`)
		})
	})
for (const s of ["sub", "main"] as const) console.log(`  rtsp ${s}: ${await probe(s)}`)
