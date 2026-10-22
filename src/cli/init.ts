// `look4 init`: connect a camera (or folder, or stream), save the config and the
// password, add a first lookout. Interactive on a TTY; flags for scripts.

import { existsSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { createContext } from "../app.ts"
import {
	CONFIG_FILE,
	configJsonSchema,
	findConfigPath,
	loadEnv,
	type ReolinkSourceConfig,
	SourceConfig,
	updateConfigFile
} from "../config.ts"
import { createLookout, slugify } from "../lookouts.ts"
import { updateEnvFile } from "../setup/envfile.ts"
import { reolinkCheck } from "../sources/index.ts"
import { args, UsageError } from "./cli.ts"
import { c, cmd, err, out } from "./ui.ts"

const SCHEMA_FILE = "look4.schema.json"

const ask = async (question: string, fallback = "") => {
	const rl = createInterface({ input: process.stdin, output: process.stdout })
	try {
		const a = (await rl.question(`${question}${fallback ? c.dim(` [${fallback}]`) : ""}: `)).trim()
		return a || fallback
	} finally {
		rl.close()
	}
}

const askHidden = (question: string) =>
	new Promise<string>((resolve, reject) => {
		const stdin = process.stdin
		process.stdout.write(`${question}: `)
		stdin.setRawMode(true)
		stdin.resume()
		stdin.setEncoding("utf8")
		let value = ""
		const finish = (fn: () => void) => {
			stdin.off("data", onData)
			stdin.setRawMode(false)
			stdin.pause()
			process.stdout.write("\n")
			fn()
		}
		const onData = (chunk: string) => {
			for (const ch of chunk) {
				if (ch === "\r" || ch === "\n") return finish(() => resolve(value))
				if (ch === "\u0003") return finish(() => reject(new Error("cancelled")))
				if (ch === "\u007f" || ch === "\b") {
					if (value) {
						value = value.slice(0, -1)
						process.stdout.write("\b \b")
					}
				} else if (ch >= " ") {
					value += ch
					process.stdout.write("•")
				}
			}
		}
		stdin.on("data", onData)
	})

const yes = async (question: string, fallback: boolean) => {
	const a = (await ask(`${question} ${c.dim(fallback ? "(Y/n)" : "(y/N)")}`)).toLowerCase()
	return a ? a.startsWith("y") : fallback
}

const uniqueSourceName = (taken: string[], base: string) => {
	if (!taken.includes(base)) return base
	for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`
}

type Plan = {
	sources: SourceConfig[]
	env: Array<[string, string]>
	lookout: string | null
}

const reolinkSource = (host: string, username: string): ReolinkSourceConfig => ({
	type: "reolink",
	name: "camera",
	enabled: true,
	host,
	username,
	passwordEnv: "REOLINK_PASSWORD",
	channel: 0,
	stream: "main",
	protocol: "auto",
	rtspPort: 554,
	pollSeconds: 60,
	lookbackHours: 24,
	capture: "auto",
	segmentSeconds: 6,
	motionGate: "both",
	closeUps: false
})

const watchSource = (dir: string): SourceConfig => {
	const abs = resolve(dir)
	return SourceConfig.assert({ type: "watch", name: slugify(basename(abs)) || "folder", dir: abs })
}

/** What goes in the file: only what differs from the schema defaults, so the config stays readable. */
const written = (s: SourceConfig): Record<string, unknown> => {
	if (s.type === "reolink") return { type: s.type, name: s.name, host: s.host, username: s.username }
	if (s.type === "watch") return { type: s.type, name: s.name, dir: s.dir }
	return { type: s.type, name: s.name, ...(s.urlEnv ? { urlEnv: s.urlEnv } : { url: s.url }) }
}

const printCheck = async (src: ReolinkSourceConfig) => {
	out(c.dim(`  logging in to ${src.host}…`))
	const r = await reolinkCheck(src)
	if (r.ok) out(`  ${c.green("✓")} ${r.detail}`)
	else out(`  ${c.red("✗")} ${r.detail}`)
	return r.ok
}

const interactive = async (): Promise<Plan> => {
	const plan: Plan = { sources: [], env: [], lookout: null }
	out(`${c.bold("look4 setup")} ${c.dim("— blank answers skip a step")}\n`)
	for (;;) {
		const host = await ask("Reolink camera IP or hostname")
		if (!host) break
		const username = await ask("Camera username", "admin")
		// Enter alone = no password, which is how Reolink cameras ship
		const password = await askHidden(`Camera password ${c.dim("(Enter if it has none)")}`)
		const src = reolinkSource(host, username)
		process.env[src.passwordEnv] = password
		if ((await printCheck(src)) || (await yes("Save it anyway?", false))) {
			plan.sources.push(src)
			plan.env.push([src.passwordEnv, password])
			break
		}
		if (!(await yes("Try again?", true))) break
	}
	const dir = await ask("Also watch a folder for clips (FTP target, NVR export)")
	if (dir) plan.sources.push(watchSource(dir))
	plan.lookout = (await ask("What should look4 look for", "a cardinal or blue jay at the feeder")) || null
	return plan
}

export const initCmd = async (argv: string[]) => {
	const { values } = args(
		argv,
		{
			reolink: { type: "string" },
			user: { type: "string" },
			watch: { type: "string" },
			rtsp: { type: "string" },
			lookout: { type: "string" }
		},
		false
	)
	const configPath = findConfigPath() ?? resolve(CONFIG_FILE)
	const rootDir = dirname(configPath)
	loadEnv(rootDir)
	const envPath = join(rootDir, ".env")
	const flagged = values.reolink ?? values.watch ?? values.rtsp ?? values.lookout
	if (values.user && !values.reolink) throw new UsageError("--user goes with --reolink <host>")

	let plan: Plan
	if (flagged === undefined && process.stdin.isTTY) plan = await interactive()
	else {
		plan = { sources: [], env: [], lookout: values.lookout?.trim() || null }
		if (values.reolink) {
			const src = reolinkSource(values.reolink, values.user ?? "admin")
			if (process.env[src.passwordEnv] === undefined) {
				// Reolink's factory default is admin with a blank password
				err(`${c.yellow("!")} ${src.passwordEnv} is not set: assuming the camera has no password (Reolink's default). If it has one, put it in ${envPath}`)
				process.env[src.passwordEnv] = ""
				plan.env.push([src.passwordEnv, ""])
			}
			await printCheck(src)
			plan.sources.push(src)
		}
		if (values.watch) {
			const dir = resolve(values.watch)
			if (!existsSync(dir)) err(`${c.yellow("!")} ${dir} does not exist yet`)
			plan.sources.push(watchSource(dir))
		}
		if (values.rtsp) {
			if (!/^rtsps?:\/\/\S+$/i.test(values.rtsp))
				throw new UsageError(`--rtsp needs a URL like rtsp://user:pass@192.168.1.50:554/h264Preview_01_sub (got "${values.rtsp}")`)
			// a URL with credentials goes in .env, never in the config file
			if (/^rtsps?:\/\/[^/]*@/i.test(values.rtsp)) {
				plan.sources.push({ type: "rtsp", name: "stream", enabled: true, urlEnv: "LOOK4_RTSP_URL", segmentSeconds: 30 })
				plan.env.push(["LOOK4_RTSP_URL", values.rtsp])
			} else plan.sources.push({ type: "rtsp", name: "stream", enabled: true, url: values.rtsp, segmentSeconds: 30 })
		}
	}

	const config = updateConfigFile(configPath, raw => {
		const list: Array<Record<string, any>> = Array.isArray(raw.sources) ? raw.sources : []
		for (const s of plan.sources) {
			// re-running init for the same camera or folder replaces it rather than adding a twin
			const same = list.findIndex(
				x => x.type === s.type && (s.type === "reolink" ? x.host === s.host : s.type === "watch" ? resolve(rootDir, String(x.dir)) === s.dir : true)
			)
			if (same >= 0) list[same] = { ...written(s), name: list[same]!.name }
			else list.push({ ...written(s), name: uniqueSourceName(list.map(x => String(x.name)), s.name) })
		}
		// `$schema` first, for editors and for whoever reads the file next
		const rest = { ...raw, sources: list }
		for (const k of Object.keys(raw)) delete raw[k]
		Object.assign(raw, { $schema: `./${SCHEMA_FILE}` }, rest)
	})
	writeFileSync(join(rootDir, SCHEMA_FILE), JSON.stringify(configJsonSchema(), null, "\t") + "\n")
	if (plan.env.length) updateEnvFile(rootDir, Object.fromEntries(plan.env))
	out(`${c.green("✓")} wrote ${configPath}`)
	if (plan.env.length) out(`${c.green("✓")} saved ${plan.env.map(([k]) => k).join(", ")} to ${envPath} (owner-only)`)

	if (plan.lookout) {
		const ctx = await createContext(config)
		try {
			const existing = ctx.store.listLookouts().find(l => l.prompt.toLowerCase() === plan.lookout!.toLowerCase())
			const l = existing ?? (await createLookout(ctx, { prompt: plan.lookout }))
			out(`${c.green("✓")} lookout ${c.bold(l.name)}: ${l.compiled?.summary ?? l.prompt} ${c.dim(`(looks for ${l.compiled?.queries.join(", ")})`)}`)
		} finally {
			ctx.store.close()
		}
	}
	out(`\nNext: ${c.cyan(cmd("start"))}${c.dim(", then open the URL it prints")}`)
	return 0
}
