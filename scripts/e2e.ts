// End-to-end proof that look4 does what it is for: a (mock) Reolink camera holds the
// fixture clips as SD-card recordings, look4 pulls them, runs the real cascade
// (motion gate → OWL-ViT → judge) against three lookouts, and the web API serves the
// results. Then: labels, a backfill of a new lookout, a UI-style upload, "check now"
// picking up a fresh recording, and a delete.
//
//   pnpm e2e            judge = auto (here: real Claude Haiku via the Claude Code login)
//   pnpm e2e --mock     judge = mock (offline, deterministic, free; cannot tell species)
//   pnpm e2e --keep     leave test/.tmp/e2e/<mode>/ in place for poking at
//
// Exit 0 when every hard expectation holds. Soft ones (known detector gaps) are reported.

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer as netServer } from "node:net"
import { loadavg } from "node:os"
import { basename, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import type { ClipDetail, ClipSummary, LookoutDto, Page, StatsResponse, UploadResponse } from "../src/api-types.ts"
import { createContext, startApp } from "../src/app.ts"
import { loadConfig } from "../src/config.ts"
import { createLookout } from "../src/lookouts.ts"
import { isModelCached } from "../src/pipeline/detect.ts"
import type { Clip } from "../src/types.ts"
import { startMockReolink, type MockFile } from "../test/fixtures/mock-reolink.ts"

const ROOT = resolve(import.meta.dirname, "..")
const FIXTURES = join(ROOT, "test", "fixtures", "videos")
const MODELS = join(ROOT, "data", "models")

const { values: flags } = parseArgs({ options: { mock: { type: "boolean" }, keep: { type: "boolean" } } })
const MOCK = !!flags.mock
const mode = MOCK ? "mock" : "auto"
const WORK = join(ROOT, "test", ".tmp", "e2e", mode)
const T0 = Date.now()
process.env.LOOK4_LOG ??= "warn"

// ---- expectations ----

type Expect = {
	file: string
	/** Hard: kept for these lookouts, with a label matching the regex (real judge only). */
	keptFor?: Record<string, RegExp | null>
	/** Hard: not kept for these lookouts. */
	notKeptFor?: string[]
	/** Hard: rejected by the motion gate. */
	motionDrop?: boolean
	/** Soft: expected, reported, never fails the run. */
	softKeptFor?: string[]
	softNotKeptFor?: string[]
	note?: string
}

const BIRD_LOOKOUTS = ["cardinal-or-jay", "woodpecker"]
const ALL_LOOKOUTS = ["cardinal-or-jay", "squirrel", "woodpecker"]

const EXPECT: Expect[] = MOCK
	? [
			// the mock judge says yes whenever the detector's label is one of the lookout's nouns,
			// so every bird clip is kept for both bird lookouts: this mode tests the plumbing, not taste
			{ file: "blue-jay.mp4", keptFor: { "cardinal-or-jay": null, woodpecker: null } },
			{ file: "cardinal-woodpecker.mp4", keptFor: { "cardinal-or-jay": null, woodpecker: null } },
			{ file: "chipping-sparrow.mp4", softKeptFor: BIRD_LOOKOUTS, note: "mock judge cannot tell species" },
			{ file: "great-tits.mp4", softKeptFor: BIRD_LOOKOUTS, note: "mock judge cannot tell species" },
			{ file: "squirrel.mp4", softKeptFor: ["squirrel"], note: "known detector miss (squirrel half hidden by leaves)" },
			{ file: "empty-feeder-snow.mp4", notKeptFor: ALL_LOOKOUTS },
			{ file: "static.mp4", motionDrop: true },
			{ file: "light-change.mp4", motionDrop: true },
			{ file: "RecM07_20261014_093012_093042_6D28808_1E2F3A.mp4", softKeptFor: BIRD_LOOKOUTS, note: "4K HEVC: must be processed" }
		]
	: [
			{ file: "blue-jay.mp4", keptFor: { "cardinal-or-jay": /jay/i }, softNotKeptFor: ["woodpecker"] },
			{ file: "cardinal-woodpecker.mp4", keptFor: { "cardinal-or-jay": /cardinal/i, woodpecker: /woodpecker/i } },
			{ file: "chipping-sparrow.mp4", notKeptFor: ["cardinal-or-jay"], softNotKeptFor: ["woodpecker"] },
			{ file: "great-tits.mp4", notKeptFor: ["cardinal-or-jay"], softNotKeptFor: ["woodpecker"] },
			{ file: "squirrel.mp4", softKeptFor: ["squirrel"], note: "known detector miss (squirrel half hidden by leaves)" },
			{ file: "empty-feeder-snow.mp4", notKeptFor: ALL_LOOKOUTS },
			{ file: "static.mp4", motionDrop: true },
			{ file: "light-change.mp4", motionDrop: true },
			{
				file: "RecM07_20261014_093012_093042_6D28808_1E2F3A.mp4",
				softKeptFor: BIRD_LOOKOUTS,
				note: "4K HEVC upscale of the cardinal + woodpecker feeder: must be processed"
			}
		]

// ---- bookkeeping ----

const failures: string[] = []
const softMisses: string[] = []
const check = (ok: boolean, what: string) => {
	if (!ok) failures.push(what)
	console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`)
	return ok
}
const soft = (ok: boolean, what: string) => {
	if (!ok) softMisses.push(what)
	console.log(`  ${ok ? "ok  " : "soft"} ${what}`)
}
const section = (s: string) => console.log(`\n${s}`)
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`
const load = () => loadavg().map(n => n.toFixed(1)).join(" ")

const freePort = () =>
	new Promise<number>((res, rej) => {
		const s = netServer()
		s.once("error", rej)
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address() as { port: number }
			s.close(() => res(port))
		})
	})

const until = async (what: string, fn: () => Promise<boolean> | boolean, timeoutMs: number, everyMs = 1000) => {
	const end = Date.now() + timeoutMs
	while (!(await fn())) {
		if (Date.now() > end) throw new Error(`timed out after ${secs(timeoutMs)} waiting for ${what}`)
		await new Promise(r => setTimeout(r, everyMs))
	}
}

/** A trimmed re-mux: different bytes (so not a duplicate), same content. */
const variant = (src: string, out: string, start: number, dur: number) => {
	execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(start), "-i", src, "-t", String(dur), "-c", "copy", "-an", out])
	return out
}

// ---- main ----

const main = async () => {
	console.log(`look4 e2e · judge=${mode} · load avg ${load()} (16 cores, shared: timings are contended)`)

	const missing = EXPECT.map(e => e.file).filter(f => !existsSync(join(FIXTURES, f)))
	if (missing.length) {
		console.error(`missing fixtures: ${missing.join(", ")}\n→ run: pnpm fixtures`)
		return 2
	}
	if (!isModelCached("Xenova/owlvit-base-patch32", MODELS))
		console.log(`! OWL-ViT is not cached in ${MODELS}; the first run downloads ~158 MB`)

	rmSync(WORK, { recursive: true, force: true })
	mkdirSync(join(WORK, "data"), { recursive: true })
	mkdirSync(MODELS, { recursive: true })
	// reuse the cached detector weights rather than downloading them per run
	symlinkSync(MODELS, join(WORK, "data", "models"), "dir")

	// The camera's SD card: one motion recording per fixture over the last few hours.
	const now = Date.now()
	const files: MockFile[] = EXPECT.map((e, i) => {
		const start = new Date(now - (3 * 3600_000) + i * 15 * 60_000)
		return { path: join(FIXTURES, e.file), start, end: new Date(start.getTime() + 15_000) }
	})
	const mock = await startMockReolink({ files, protocol: "https" })
	const fixtureOf = new Map(mock.names().map((name, i) => [name, EXPECT[i]!.file]))
	process.env.REOLINK_PASSWORD = mock.password

	const port = await freePort()
	const configPath = join(WORK, "look4.config.json")
	writeFileSync(
		configPath,
		JSON.stringify(
			{
				dataDir: "data",
				server: { host: "127.0.0.1", port },
				sources: [{ type: "reolink", name: "backyard", host: mock.host, pollSeconds: 10, lookbackHours: 24 }],
				pipeline: { judge: { provider: mode } }
			},
			null,
			"\t"
		)
	)
	const config = loadConfig(configPath)

	// Lookouts first, the way `look4 init --lookout` / `look4 lookout add` make them.
	section("lookouts (compiled by the judge's model)")
	{
		const setup = await createContext(config)
		console.log(`  judge: ${setup.judge.provider} · ${setup.judge.detail}`)
		for (const [name, prompt] of [
			["cardinal-or-jay", "a cardinal or blue jay at the feeder"],
			["squirrel", "a squirrel"],
			["woodpecker", "a woodpecker"]
		] as const) {
			const t = Date.now()
			const l = await createLookout(setup, { name, prompt })
			console.log(`  ${name.padEnd(16)} → detector looks for [${l.compiled?.queries.join(", ")}] · ${l.compiled?.compiler} · ${secs(Date.now() - t)}`)
		}
		setup.store.close()
	}

	section("start: reolink source → worker → server")
	const app = await startApp(config, { server: true, sources: true })
	const base = app.url!
	const ctx = app.ctx
	console.log(`  ${base} · camera mock https://${mock.host}`)
	const api = async <t>(path: string, init?: RequestInit): Promise<t> => {
		const get = (init?.method ?? "GET") === "GET"
		const res = await fetch(base + path, init).catch(e => {
			// The server and this client share one event loop. When it stalls past the server's 5 s
			// keep-alive (a heavily loaded machine, a detector run), the server's idle timer fires
			// before it reads the request already sent on the reused socket and closes it. A browser
			// retries an idempotent request on a reused socket that closes like this, so a GET does too.
			if (!get || !(e instanceof TypeError) || !/^(UND_ERR_SOCKET|ECONNRESET)$/.test((e.cause as { code?: string })?.code ?? "")) throw e
			return fetch(base + path, init)
		})
		const body = await res.text()
		if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 200)}`)
		return JSON.parse(body) as t
	}
	const post = <t>(path: string, body: unknown, method = "POST") =>
		api<t>(path, { method, headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body) })

	const pendingRetry = (c: Clip) => c.status === "error" && /\(retry \d+\/\d+ at/.test(c.reason ?? "")
	/** Queue empty and nothing waiting on a judge retry. */
	const drained = async () => {
		const s = await api<StatsResponse>("/api/stats")
		if (s.queue.pending + s.queue.processing) return false
		return !ctx.store.listClips({ status: "error", limit: 10_000 }).some(pendingRetry)
	}

	let stopped = false
	try {
		const tPull = Date.now()
		await until("9 recordings pulled from the camera", () => ctx.store.countClips({ source: "backyard" }) >= EXPECT.length, 5 * 60_000)
		console.log(`  pulled ${EXPECT.length} recordings in ${secs(Date.now() - tPull)}`)
		await until("the queue to drain", drained, 30 * 60_000, 2000)
		console.log(`  cascade drained ${secs(Date.now() - tPull)} after the first pull`)

		// ---- per-clip outcomes ----
		section("per clip")
		const details = new Map<string, ClipDetail>()
		for (const c of ctx.store.listClips({ source: "backyard", limit: 100 })) {
			const d = await api<ClipDetail>(`/api/clips/${c.id}`)
			details.set(fixtureOf.get(c.sourceRef ?? "") ?? c.id, d)
		}
		const keptFor = (d: ClipDetail, lookout: string) => d.matches.find(m => m.lookoutName === lookout)
		type Row = string[]
		const rows: Row[] = []
		for (const e of EXPECT) {
			const d = details.get(e.file)
			if (!check(!!d, `${e.file}: pulled and processed`) || !d) continue
			const best = [...d.verdicts].sort((a, b) => b.confidence - a.confidence)[0]
			const took = Object.values(d.clip.timings ?? {}).reduce((a, b) => a + (b ?? 0), 0)
			rows.push([
				e.file.length > 24 ? `${e.file.slice(0, 21)}…` : e.file,
				d.status,
				d.droppedAt ?? "",
				d.matches.map(m => m.lookoutName).join(",") || "-",
				d.matches[0]?.label ?? best?.label ?? "",
				(d.matches[0]?.confidence ?? best?.confidence)?.toFixed(2) ?? "",
				secs(took),
				`$${d.usage.costUsd.toFixed(4)}`,
				d.reason ?? ""
			])
			check(d.status !== "error" && d.status !== "pending", `${e.file}: finished (${d.status}${d.droppedAt ? ` at ${d.droppedAt}` : ""})`)
			if (e.motionDrop) check(d.status === "rejected" && d.droppedAt === "motion", `${e.file}: rejected at motion`)
			for (const [l, label] of Object.entries(e.keptFor ?? {})) {
				const m = keptFor(d, l)
				check(!!m, `${e.file}: kept for ${l}`)
				if (m && label) check(label.test(m.label ?? ""), `${e.file}: ${l} label "${m.label}" matches ${label}`)
			}
			for (const l of e.notKeptFor ?? []) check(!keptFor(d, l), `${e.file}: not kept for ${l}`)
			for (const l of e.softKeptFor ?? []) soft(!!keptFor(d, l), `${e.file}: kept for ${l}${e.note ? ` (${e.note})` : ""}`)
			for (const l of e.softNotKeptFor ?? []) soft(!keptFor(d, l), `${e.file}: not kept for ${l}`)
		}
		const hevc = details.get("RecM07_20261014_093012_093042_6D28808_1E2F3A.mp4")
		if (hevc) check(hevc.clip.width === 3840 && hevc.clip.height === 2160 && hevc.clip.motion !== null, "4K HEVC clip probed at 3840x2160 and went through the cascade")

		// ---- funnel ----
		section("GET /api/stats funnel vs per-clip outcomes")
		const stats = await api<StatsResponse>("/api/stats")
		const ds = [...details.values()]
		const count = (f: (d: ClipDetail) => boolean) => ds.filter(f).length
		const expectFunnel = {
			ingested: ds.length,
			errors: count(d => d.status === "error"),
			kept: count(d => d.status === "kept"),
			passed: {
				motion: count(d => d.status === "kept" || d.droppedAt === "detect" || d.droppedAt === "judge"),
				detect: count(d => d.status === "kept" || d.droppedAt === "judge")
			},
			droppedAt: {
				probe: count(d => d.droppedAt === "probe"),
				motion: count(d => d.droppedAt === "motion"),
				detect: count(d => d.droppedAt === "detect"),
				judge: count(d => d.droppedAt === "judge")
			}
		}
		const f = stats.funnel.all
		const got = { ingested: f.ingested, errors: f.errors, kept: f.kept, passed: f.passed, droppedAt: f.droppedAt }
		check(JSON.stringify(got) === JSON.stringify(expectFunnel), `funnel ${JSON.stringify(got)}`)
		check(f.droppedAt.motion === 2, "funnel: exactly the 2 motionless clips dropped at motion")
		check(stats.pipeline.judge.provider === (MOCK ? "mock" : "claude-code") || (!MOCK && stats.pipeline.judge.provider === "anthropic"), `judge provider ${stats.pipeline.judge.provider}: ${stats.pipeline.judge.detail}`)
		check(stats.sources.some(s => s.name === "backyard" && s.state !== "error"), `source backyard: ${stats.sources.find(s => s.name === "backyard")?.detail}`)

		// ---- sightings ----
		section("GET /api/sightings")
		const sightings = await api<Page<ClipSummary>>("/api/sightings?limit=100")
		const keptIds = ds.filter(d => d.status === "kept").sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)).map(d => d.id)
		check(JSON.stringify(sightings.items.map(s => s.id)) === JSON.stringify(keptIds), `${sightings.items.length} sightings = the kept clips, newest first`)
		const jayOnly = await api<Page<ClipSummary>>("/api/sightings?lookout=cardinal-or-jay&limit=100")
		check(jayOnly.items.every(s => s.matches.some(m => m.lookoutName === "cardinal-or-jay")), `?lookout=cardinal-or-jay → ${jayOnly.items.length}, all matching it`)

		// ---- media ----
		section("media")
		const showcase = details.get("cardinal-woodpecker.mp4") ?? ds.find(d => d.status === "kept")
		if (check(!!showcase && showcase.status === "kept", "a kept clip to fetch media for") && showcase) {
			const m = showcase.media
			check(!!m.poster && !!m.preview && !!m.original && m.crops.length > 0, `media urls: poster, preview, original, ${m.crops.length} crops`)
			for (const url of [m.poster, ...m.crops].filter((u): u is string => !!u)) {
				const r = await fetch(base + url)
				const n = (await r.arrayBuffer()).byteLength
				check(r.status === 200 && r.headers.get("content-type") === "image/jpeg" && n > 1000, `${url.split("?")[0]} → ${r.status} ${r.headers.get("content-type")} ${n} B`)
			}
			for (const url of [m.preview, m.original].filter((u): u is string => !!u)) {
				const r = await fetch(base + url, { headers: { range: "bytes=0-1023" } })
				const n = (await r.arrayBuffer()).byteLength
				check(r.status === 206 && n === 1024 && /^bytes 0-1023\/\d+$/.test(r.headers.get("content-range") ?? ""), `${url.split("?")[0]} Range → ${r.status} ${r.headers.get("content-range")}`)
			}
		}

		// ---- labels ----
		section("labels")
		const lookouts = await api<LookoutDto[]>("/api/lookouts")
		const lid = (name: string) => lookouts.find(l => l.name === name)!.id
		const jay = details.get("blue-jay.mp4")
		const sparrow = details.get("chipping-sparrow.mp4")
		if (jay && sparrow) {
			const a = await post<ClipDetail>(`/api/clips/${jay.id}/label`, { lookoutId: lid("cardinal-or-jay"), truth: true })
			check(a.labels.some(l => l.lookoutId === lid("cardinal-or-jay") && l.truth) && a.clip.expiresAt === null, "thumbs-up on the jay: label stored, never expires")
			const b = await post<ClipDetail>(`/api/clips/${sparrow.id}/label`, { lookoutId: lid("cardinal-or-jay"), truth: false })
			check(b.labels.length === 1 && b.labels[0]!.truth === false && b.clip.expiresAt === null, "thumbs-down on the sparrow: labeled, retention spares it")
			const again = await api<ClipDetail>(`/api/clips/${sparrow.id}`)
			check(again.labels.length === 1, "label survives a re-read")
			const cleared = await post<ClipDetail>(`/api/clips/${sparrow.id}/label`, { lookoutId: lid("cardinal-or-jay"), truth: null })
			// kept clips never expire; a rejected one goes back on the retention clock
			const clock = cleared.status === "kept" ? cleared.clip.expiresAt === null : cleared.clip.expiresAt !== null
			check(cleared.labels.length === 0 && clock, `clearing it: no labels, expiresAt ${cleared.clip.expiresAt ?? "null"} (${cleared.status})`)
			const lk = (await api<LookoutDto[]>("/api/lookouts")).find(l => l.name === "cardinal-or-jay")!
			check(lk.stats.labeled === 1 && lk.stats.precision === 1, `lookout stats from labels: labeled ${lk.stats.labeled}, precision ${lk.stats.precision}`)
		}

		// ---- backfill ----
		section("backfill a new lookout over clips on disk")
		const keptBefore = new Set(keptIds)
		const tB = Date.now()
		const sp = await post<LookoutDto>("/api/lookouts", { name: "sparrow", prompt: "a sparrow" })
		console.log(`  created "${sp.name}" → [${sp.compiled?.queries.join(", ")}] in ${secs(Date.now() - tB)}`)
		const onDisk = ds.filter(d => d.droppedAt !== "motion" && d.droppedAt !== "probe").length
		const { queued } = await post<{ queued: number }>(`/api/lookouts/${sp.id}/backfill`, {})
		check(queued === onDisk, `queued ${queued} clips (every clip on disk that passed motion: ${onDisk})`)
		await until("the backfill to drain", drained, 20 * 60_000, 2000)
		console.log(`  backfill drained in ${secs(Date.now() - tB)}`)
		const afterIds = new Set((await api<Page<ClipSummary>>("/api/sightings?limit=100")).items.map(s => s.id))
		check([...keptBefore].every(id => afterIds.has(id)), "every clip kept before the backfill is still kept")
		const spSightings = await api<Page<ClipSummary>>(`/api/sightings?lookout=${sp.id}&limit=100`)
		const spFiles = spSightings.items.map(s => fixtureOf.get(ctx.store.getClip(s.id)?.sourceRef ?? "") ?? s.id)
		console.log(`  kept for sparrow: ${spFiles.join(", ") || "none"}`)
		// the mechanism: every clip on disk with a bird detection got a fresh sparrow verdict, nothing else did
		const withBird: string[] = []
		const withVerdict: string[] = []
		for (const [file, d] of details) {
			const now = await api<ClipDetail>(`/api/clips/${d.id}`)
			if (now.detections.some(x => x.label === "bird")) withBird.push(file)
			if (now.verdicts.some(v => v.lookoutId === sp.id)) withVerdict.push(file)
		}
		check(withBird.length > 0 && JSON.stringify(withVerdict.sort()) === JSON.stringify(withBird.sort()), `sparrow verdicts on exactly the ${withBird.length} clips with a bird detection`)
		if (MOCK) check(spFiles.includes("chipping-sparrow.mp4"), "chipping-sparrow kept for sparrow (mock: any bird)")
		else {
			// a Chipping Sparrow (unstreaked) vs "a sparrow" is a near-threshold Haiku call: kept in 2 of 3 live runs after
			// the compiler stopped requiring breast streaks (0 of 1 before), so it is reported, not gating
			soft(spFiles.includes("chipping-sparrow.mp4"), "chipping-sparrow kept for sparrow")
			check(!spFiles.includes("blue-jay.mp4") && !spFiles.includes("cardinal-woodpecker.mp4"), "jay and cardinal clips not kept for sparrow")
		}
		const usageNow = await api<StatsResponse>("/api/stats")
		console.log(`  cost so far ${usageNow.cost.allUsd.toFixed(4)} USD`)

		// ---- upload ----
		section("upload (raw body, like the UI's drag-and-drop)")
		const upFile = variant(join(FIXTURES, "blue-jay.mp4"), join(WORK, "jay-from-phone.mp4"), 2, 8)
		const tU = Date.now()
		const up = await api<UploadResponse>(`/api/upload?name=${encodeURIComponent(basename(upFile))}&lastModified=${Date.now() - 60_000}`, {
			method: "POST",
			headers: { "content-type": "video/mp4", origin: base },
			body: readFileSync(upFile)
		})
		const upId = up.clips[0]?.id
		check(!!upId && up.clips[0]!.source === "upload", `uploaded ${basename(upFile)} (${statSync(upFile).size} B) → ${upId}`)
		if (upId) {
			await until("the upload to be processed", () => ["kept", "rejected", "error"].includes(ctx.store.getClip(upId)!.status), 10 * 60_000)
			const d = await api<ClipDetail>(`/api/clips/${upId}`)
			check(!!keptFor(d, "cardinal-or-jay"), `upload processed in ${secs(Date.now() - tU)}: ${d.status} · ${d.reason}`)

			const del = await api<{ ok: boolean }>(`/api/clips/${upId}`, { method: "DELETE", headers: { origin: base } })
			const gone = await fetch(`${base}/api/clips/${upId}`)
			check(del.ok && gone.status === 404 && !existsSync(d.clip.path ?? "/nonexistent"), "DELETE removed the row and the file")
		}

		// ---- check now ----
		section('"check now" picks up a new recording')
		const fresh = variant(join(FIXTURES, "cardinal-woodpecker.mp4"), join(WORK, "new-recording.mp4"), 3, 6)
		const end = new Date(Date.now() - 30_000)
		mock.files.push({ path: fresh, start: new Date(end.getTime() - 6_000), end })
		const before = ctx.store.countClips({ source: "backyard" })
		const tC = Date.now()
		await post<{ ok: boolean }>("/api/sources/backyard/poll", {})
		await until("the new recording", () => ctx.store.countClips({ source: "backyard" }) > before, 60_000, 250)
		console.log(`  pulled in ${secs(Date.now() - tC)}`)
		await until("it to be processed", drained, 10 * 60_000, 1000)
		const newest = ctx.store.listClips({ source: "backyard", limit: 1 })[0]!
		check(newest.status === "kept", `new recording ${newest.status} in ${secs(Date.now() - tC)}: ${newest.reason}`)

		// ---- report ----
		section("report (each fixture as the first pull left it, before the backfill)")
		const widths = ["fixture", "outcome", "stage", "kept for", "label", "conf", "time", "cost", "reason"]
		const all = [widths, ...rows]
		const w = widths.map((_, i) => Math.max(...all.map(r => (r[i] ?? "").length)))
		for (const r of all) console.log("  " + r.map((v, i) => (i === r.length - 1 ? v.slice(0, 90) : v.padEnd(w[i]!))).join("  "))
		const s = await api<StatsResponse>("/api/stats")
		const fa = s.funnel.all
		console.log(
			`\n  funnel (all ${fa.ingested} clips incl. upload + new recording): ${fa.ingested} in → ${fa.passed.motion} past motion → ${fa.passed.detect} past detect → ${fa.kept} kept · dropped motion ${fa.droppedAt.motion} / detect ${fa.droppedAt.detect} / judge ${fa.droppedAt.judge} · errors ${fa.errors}`
		)
		const calls = ctx.store.usageSince()
		console.log(`  judge + compile: ${calls.calls} calls, ${calls.costUsd.toFixed(4)} USD${MOCK ? " (mock: free)" : " (API-price equivalent; the Claude Code login does not bill per call)"}`)
		console.log(`  wall time ${secs(Date.now() - T0)} · load avg now ${load()}`)
	} finally {
		if (!stopped) {
			stopped = true
			await app.stop()
		}
		await mock.close()
		if (!flags.keep && !failures.length) rmSync(WORK, { recursive: true, force: true })
	}

	if (softMisses.length) console.log(`\n  ${softMisses.length} soft miss${softMisses.length === 1 ? "" : "es"} (expected gaps, not failures):\n    ${softMisses.join("\n    ")}`)
	if (failures.length) {
		console.log(`\nFAILED ${failures.length}:\n  ${failures.join("\n  ")}\n  (data kept in ${WORK})`)
		return 1
	}
	console.log("\nPASS")
	return 0
}

main().then(
	code => process.exit(code),
	e => {
		console.error(e)
		process.exit(1)
	}
)
