// `look4 doctor`: every dependency the pipeline needs, one ✓/✗ line each, with the fix.

import { accessSync, constants, existsSync, statfsSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { createContext } from "../app.ts"
import { ConfigError, findConfigPath, loadConfig, type LoadedConfig } from "../config.ts"
import { FFMPEG, FFPROBE, run } from "../media/ffmpeg.ts"
import { reolinkCheck } from "../sources/index.ts"
import { SERVER_SETTINGS_HINT } from "../sources/reolink-api.ts"
import { args } from "./cli.ts"
import { bad, bytes, c, cmd, ok, out, warn } from "./ui.ts"

const versionOf = async (bin: string) => {
	const raw = (await run(bin, ["-version"], { signal: AbortSignal.timeout(10_000) })).toString()
	return /version\s+(\S+)/.exec(raw)?.[1] ?? "unknown version"
}

export const doctorCmd = async (argv: string[]) => {
	args(argv, {}, false)
	let failures = 0
	const fail = (label: string, detail: string, fix: string) => {
		failures++
		bad(label, detail, fix)
	}

	const [major = 0, minor = 0] = process.versions.node.split(".").map(Number)
	if (major > 23 || (major === 23 && minor >= 6)) ok("node", process.versions.node)
	else fail("node", process.versions.node, "install Node 23.6 or newer (look4 runs its TypeScript directly)")

	for (const [name, bin] of [["ffmpeg", FFMPEG], ["ffprobe", FFPROBE]] as const) {
		try {
			ok(name, await versionOf(bin))
		} catch {
			fail(name, "not found", "sudo apt install ffmpeg")
		}
	}

	let config: LoadedConfig
	try {
		config = loadConfig()
		if (config.configPath) ok("config", config.configPath)
		else warn("config", "no look4.config.json here, using defaults", `run \`${cmd("init")}\` to connect a camera, or open the web UI`)
	} catch (e) {
		fail("config", e instanceof ConfigError ? e.message : String(e), `fix ${findConfigPath() ?? "look4.config.json"}`)
		return 1
	}

	const ctx = await createContext(config)
	try {
		// data dir: writable, and room for clips
		try {
			accessSync(config.dataDir, constants.W_OK)
			const fs = statfsSync(config.dataDir)
			const free = fs.bavail * fs.bsize
			const line = `${config.dataDir} · ${bytes(free)} free`
			if (free < 2e9) warn("data dir", line, "under 2 GB free: lower retention.rejectedDays or move dataDir")
			else ok("data dir", line)
		} catch (e) {
			fail("data dir", `${config.dataDir}: ${e instanceof Error ? e.message : e}`, "check the path and its permissions")
		}

		const det = config.pipeline.detector
		if (!det.enabled) warn("detector", "off", "every motion clip goes to the spotter; enable pipeline.detector to save cost")
		else {
			const before = ctx.detector.status().detail
			if (/download/i.test(before)) out(c.dim(`  detector: ${before}…`))
			const started = performance.now()
			try {
				await ctx.detector.warmup()
				ok("detector", `${det.model} · loaded in ${((performance.now() - started) / 1000).toFixed(1)} s · threshold ${det.threshold}`)
			} catch (e) {
				fail("detector", `${det.model}: ${e instanceof Error ? e.message : e}`, "check your network for the first download, or set pipeline.detector.model")
			}
		}

		const judge = ctx.judge
		if (!ctx.llm) {
			const off = config.pipeline.judge.provider === "none"
			;(off ? warn : fail)(
				"spotter",
				judge.detail || "none",
				off ? "the detector decides alone: no species calls" : "set ANTHROPIC_API_KEY in .env, or install and log in to Claude Code (`claude`)"
			)
		} else {
			const check = await ctx.llm.check().catch(e => ({ ok: false, detail: String(e) }))
			if (check.ok) ok("spotter", `${judge.detail || ctx.llm.backend} · ${check.detail}`)
			else fail("spotter", check.detail, ctx.llm.backend === "claude-code" ? "run `claude` once and log in" : "check ANTHROPIC_API_KEY in .env")
			if (config.pipeline.judge.escalateModel) ok("escalation", `${config.pipeline.judge.escalateModel} below ${config.pipeline.judge.escalateBelow}`)
		}

		if (!config.sources.length) warn("sources", "none configured", `drop videos in ${ctx.paths.inbox}, upload in the web UI, or run \`${cmd("init")}\``)
		for (const s of config.sources) {
			const label = `source ${s.name}`
			if (s.type === "reolink") {
				const r = await reolinkCheck(s)
				if (r.ok) ok(label, `reolink ${s.host} · ${r.detail}`)
				else
					fail(
						label,
						// the servers-off message already names the host and says what to do
						r.detail.includes(SERVER_SETTINGS_HINT) ? r.detail : `reolink ${s.host}: ${r.detail}`,
						r.detail.includes(SERVER_SETTINGS_HINT)
							? ""
							: /^login failed/.test(r.detail)
								? `check ${s.passwordEnv} in .env (\`${s.passwordEnv}=\` alone means no password); the camera locks out after a few bad logins`
								: `check the camera IP and ${s.passwordEnv} in .env`
					)
			} else if (s.type === "watch") {
				const dir = resolve(config.rootDir, s.dir)
				if (existsSync(dir) && statSync(dir).isDirectory()) ok(label, `watching ${dir}`)
				else fail(label, `${dir} does not exist`, "create it or fix `dir`")
			} else {
				const url = s.url ?? (s.urlEnv ? process.env[s.urlEnv] : undefined)
				if (!url) {
					fail(label, `rtsp: ${s.urlEnv} is not set`, `add ${s.urlEnv}=rtsp://… to .env`)
					continue
				}
				try {
					await run(FFPROBE, ["-v", "error", "-rtsp_transport", "tcp", "-show_entries", "stream=codec_name", "-of", "csv=p=0", url], {
						signal: AbortSignal.timeout(10_000)
					})
					ok(label, "rtsp stream answers")
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e)
					fail(label, `rtsp: ${msg.replace(/\/\/[^/@\s]*@/g, "//***@")}`, "check the URL, credentials and that the camera has RTSP enabled")
				}
			}
		}

		const lookouts = ctx.store.listLookouts()
		const on = lookouts.filter(l => l.enabled)
		if (on.length) ok("lookouts", on.map(l => l.name).join(", "))
		else warn("lookouts", lookouts.length ? "all disabled" : "none", `add one: ${cmd('lookout add "a cardinal at the feeder"')}`)
	} finally {
		ctx.store.close()
	}
	out()
	out(failures ? c.red(`${failures} problem${failures === 1 ? "" : "s"} to fix`) : c.green("all good"))
	return failures ? 1 : 0
}
