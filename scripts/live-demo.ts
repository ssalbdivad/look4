// The live view against fake cameras, for working on it without a real one: a
// mock Reolink PTZ camera (HTTPS API with GetAbility, PtzCtrl, lights, Snap) whose
// RTSP streams are the fixture videos (sub: 720p H.264, main: 4K HEVC), plus a
// generic RTSP camera with Hikvision-style stream paths. Every stream carries a
// 16 kHz mono AAC track of bird chirps, like a Reolink camera's microphone. Runs
// the real look4 server (without --record no source adapters, so nothing is ingested) on its own data dir.
//
//   node scripts/live-demo.ts [--port 4041] [--work <dir>] [--blank-password] [--rtsp-off] [--record]
//
// --port            look4's port (default 4041)
// --work            data dir and config (default test/.tmp/live-demo; emptied at start)
// --blank-password  the Reolink camera has no password (live video falls back to stills)
// --rtsp-off        the Reolink camera's RTSP port is closed (stills, with the "turn on RTSP" walkthrough)
// --record          run the Reolink source, recording its stream, so Record works. The mock camera reports
//                   no motion, so the rest of the footage goes to unchecked/; the porch camera is paused
//                   (still on Live, never recorded)
//
// The camera streams are made once and kept in test/.tmp/live-demo-cache.

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { startApp } from "../src/app.ts"
import { loadConfig } from "../src/config.ts"
import { extractFrame } from "../src/media/ffmpeg.ts"
import { startMockReolink } from "../test/fixtures/mock-reolink.ts"
import { startMockRtsp } from "../test/fixtures/mock-rtsp.ts"

const { values } = parseArgs({
	options: {
		port: { type: "string", default: "4041" },
		work: { type: "string" },
		"blank-password": { type: "boolean" },
		"rtsp-off": { type: "boolean" },
		record: { type: "boolean" }
	}
})

const ROOT = resolve(import.meta.dirname, "..")
const VIDEOS = join(ROOT, "test", "fixtures", "videos")
const WORK = values.work ? resolve(values.work) : join(ROOT, "test", ".tmp", "live-demo")
const CACHE = join(ROOT, "test", ".tmp", "live-demo-cache")
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
mkdirSync(CACHE, { recursive: true })
process.env.LOOK4_LOG ??= "warn"

const MAIN_SOURCE = join(VIDEOS, "RecM07_20261014_093012_093042_6D28808_1E2F3A.mp4")

/** Short rising chirps in bursts, as `-f lavfi` input args: something to hear when the page unmutes. */
const CHIRPS = ["-f", "lavfi", "-i", "aevalsrc=exprs='0.3*sin(2*PI*(2200*t+6000*mod(t\\,0.5)*mod(t\\,0.5)))*lt(mod(t\\,0.5)\\,0.09)*lt(mod(t\\,2.7)\\,1.4)':s=16000:c=mono"]
/** The camera's own sound format: AAC-LC, 16 kHz, mono. */
const AAC = ["-map", "1:a:0", "-c:a", "aac", "-b:a", "32k", "-shortest"]

/** A camera stream made from a fixture once (several demos can share the cache: written aside, then renamed). */
const stream = (name: string, input: string, video: string[], decode: string[] = []) => {
	const out = join(CACHE, name)
	if (existsSync(out)) return out
	const part = join(CACHE, `${process.pid}-${name}`)
	execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...decode, "-i", input, ...CHIRPS, "-map", "0:v:0", ...video, ...AAC, part])
	renameSync(part, out)
	return out
}

const password = values["blank-password"] ? "" : "hunter2"
// Snap answers with a full-resolution frame of the 4K main stream, as the real camera does
const snapshot = await extractFrame(MAIN_SOURCE, 2, { maxEdge: 3840, quality: 85 })
// a camera sends a keyframe every second or two; the fixtures' 10 s GOP would make every viewer wait for one
const sub = stream("sub.mp4", join(VIDEOS, "blue-jay.mp4"), ["-c:v", "libx264", "-preset", "veryfast", "-g", "25"])
let main: string
try {
	main = stream("main-nvenc.mp4", MAIN_SOURCE, ["-c:v", "hevc_nvenc", "-g", "50", "-b:v", "8M"], ["-hwaccel", "cuda"])
} catch {
	console.log("(no NVENC: making the mock main stream with x265 at 1080p, once; this takes a few minutes on a busy machine)")
	main = stream("main-x265.mp4", MAIN_SOURCE, ["-vf", "scale=1920:-2", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=0", "-g", "50"])
}
const porchMain = stream("porch-main.mp4", join(VIDEOS, "squirrel.mp4"), ["-c:v", "copy"])
const porchSub = stream("porch-sub.mp4", join(VIDEOS, "great-tits.mp4"), ["-c:v", "copy"])

const reolink = await startMockReolink({ files: [], protocol: "https", abilities: "ptz", password, snapshot })
const rtsp = await startMockRtsp({ password, paths: { "/h264Preview_01_sub": sub, "/h264Preview_01_main": main } })
// another camera at another address: one at the Reolink camera's address would be the same camera, listed once
const porch = await startMockRtsp({ password, host: "127.0.0.2", paths: { "/Streaming/Channels/101": porchMain, "/Streaming/Channels/102": porchSub } })

writeFileSync(join(WORK, ".env"), `LIVE_DEMO_PW=${password}\nLIVE_DEMO_PORCH=rtsp://admin:${password}@${porch.host}/Streaming/Channels/101\n`)
const configPath = join(WORK, "look4.config.json")
writeFileSync(
	configPath,
	JSON.stringify(
		{
			dataDir: "data",
			server: { port: Number(values.port) },
			pipeline: { detector: { enabled: false }, judge: { provider: "none" } },
			sources: [
				{
					type: "reolink",
					name: "backyard",
					host: reolink.host,
					protocol: "https",
					passwordEnv: "LIVE_DEMO_PW",
					// a closed port: nothing listens on 9 here
					rtspPort: values["rtsp-off"] ? 9 : rtsp.port,
					...(values.record && { capture: "stream" })
				},
				{ type: "rtsp", name: "porch", urlEnv: "LIVE_DEMO_PORCH", ...(values.record && { enabled: false }) }
			]
		},
		null,
		"\t"
	)
)

const app = await startApp(loadConfig(configPath), { server: true, sources: !!values.record })
console.log(`look4 live demo: ${app.url}/live   (mock Reolink API ${reolink.host}, mock RTSP ${rtsp.host} and ${porch.host}, work ${WORK})`)

// startApp stops look4 and exits on SIGINT/SIGTERM; take the fake cameras down with it
process.once("exit", () => void Promise.all([reolink.close(), rtsp.close(), porch.close()]))
