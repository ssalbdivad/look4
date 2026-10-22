// Downloads pinned, freely licensed feeder videos from Wikimedia Commons, cuts short
// segments into test/fixtures/videos/, generates synthetic clips, and rewrites
// test/fixtures/manifest.json. Idempotent: existing outputs are skipped.
//
//   node scripts/fetch-fixtures.ts [--force]
//
// Raw downloads are untrusted and live in test/fixtures/videos/.src/; nothing there is
// ever executed, only read by ffmpeg.

import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const exec = promisify(execFile)

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const fixturesDir = join(root, "test/fixtures")
const videosDir = join(fixturesDir, "videos")
const srcDir = join(videosDir, ".src")
const manifestPath = join(fixturesDir, "manifest.json")
const force = process.argv.includes("--force")

// Wikimedia's user-agent policy requires a descriptive UA with contact info.
const userAgent = "look4-fixtures/0.1 (https://github.com/ssalbdivad/look4; test footage for a bird-feeder clip filter)"

type Source = {
	title: string
	page: string
	url: string
	sha256: string
	license: string
	author: string
}

// The squirrel original is a 1 GB 1080p file, so we pin Commons' 720p VP9 transcode.
// Transcodes can in principle be regenerated server-side; if its hash ever drifts,
// re-check the segment visually and update the pin.
const sources = {
	bluejay: {
		title: "Blue Jay at bird feeder, video (3675639120).webm",
		page: "https://commons.wikimedia.org/wiki/File:Blue_Jay_at_bird_feeder,_video_(3675639120).webm",
		url: "https://upload.wikimedia.org/wikipedia/commons/b/bf/Blue_Jay_at_bird_feeder%2C_video_%283675639120%29.webm",
		sha256: "b74fd9acca841dc4b5618ef4c0e3ff77916305921f3c32e1de0592bb374b821a",
		license: "CC BY 2.0",
		author: "Matt MacGillivray"
	},
	busy: {
		title: "Busy Bird Feeder (31524812531).webm",
		page: "https://commons.wikimedia.org/wiki/File:Busy_Bird_Feeder_(31524812531).webm",
		url: "https://upload.wikimedia.org/wikipedia/commons/4/40/Busy_Bird_Feeder_%2831524812531%29.webm",
		sha256: "f135fc8059068aeac280a1115fc47120ff3ed8b9b95fe906c076c0cd15e0eaee",
		license: "Public domain",
		author: "U.S. Fish and Wildlife Service - Midwest Region"
	},
	chipping: {
		title: "Chipping sparrow and black-capped chickadee.webm",
		page: "https://commons.wikimedia.org/wiki/File:Chipping_sparrow_and_black-capped_chickadee.webm",
		url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Chipping_sparrow_and_black-capped_chickadee.webm",
		sha256: "000cc8eecd0f6c9779f486c45c77885b6af79ac1dcf8e2080de15f7efcb528e6",
		license: "CC BY 3.0",
		author: "kev0nte 77x"
	},
	slovakia: {
		title: "Bird feeder in the mountains of Slovakia.webm",
		page: "https://commons.wikimedia.org/wiki/File:Bird_feeder_in_the_mountains_of_Slovakia.webm",
		url: "https://upload.wikimedia.org/wikipedia/commons/3/30/Bird_feeder_in_the_mountains_of_Slovakia.webm",
		sha256: "abfe7919c86e36d7a8da8a69d0294fa905af829beb68efd89341e3360529a832",
		license: "CC BY 3.0",
		author: "Lubo Ondrasko"
	},
	squirrel: {
		title: "Grey squirrel eating from bird feeder.webm",
		page: "https://commons.wikimedia.org/wiki/File:Grey_squirrel_eating_from_bird_feeder.webm",
		url: "https://upload.wikimedia.org/wikipedia/commons/transcoded/7/77/Grey_squirrel_eating_from_bird_feeder.webm/Grey_squirrel_eating_from_bird_feeder.webm.720p.vp9.webm",
		sha256: "cd9b929d45922e21ac42f1b0cb6cf8c187ea670bc7b6a9120c89af2b73e13adb",
		license: "CC BY-SA 3.0",
		author: "Alexis Markwick (User:Dr-Mx)"
	}
} satisfies Record<string, Source>

type SourceKey = keyof typeof sources

type Expect = { motion: boolean; subjects: string[]; species: string[] | null }

type Segment = { start: number; duration: number }

// crop: an ffmpeg crop= argument for sources with baked-in letterbox/pillarbox bars.
type RealClip = { file: string; from: SourceKey; segment: Segment; crop?: string; description: string; expect: Expect }

// Segment times were chosen by looking at extracted frames: the subject is visible
// throughout each segment, and no segment spans a scene cut or a caption overlay.
const realClips: RealClip[] = [
	{
		file: "blue-jay.mp4",
		from: "bluejay",
		segment: { start: 0, duration: 12 },
		description: "A Blue Jay on a wooden platform feeder, close up, shifting around and pecking seed.",
		expect: { motion: true, subjects: ["bird"], species: ["blue jay"] }
	},
	{
		file: "cardinal-woodpecker.mp4",
		from: "busy",
		segment: { start: 4, duration: 12 },
		description: "A male Northern Cardinal and a Downy Woodpecker at a snowy suet feeder.",
		expect: { motion: true, subjects: ["bird"], species: ["northern cardinal", "downy woodpecker"] }
	},
	{
		file: "chipping-sparrow.mp4",
		from: "chipping",
		segment: { start: 28, duration: 15 },
		crop: "1440:1080:240:0",
		description: "A Chipping Sparrow eating peanuts on a tube feeder tray, filmed from a feeder-mounted camera.",
		expect: { motion: true, subjects: ["bird"], species: ["chipping sparrow"] }
	},
	{
		file: "great-tits.mp4",
		from: "slovakia",
		segment: { start: 91.2, duration: 8.8 },
		description: "Two Great Tits (Eurasian, chickadee-like) and a Willow Tit landing on a platform feeder; a bird flies off at the end.",
		expect: { motion: true, subjects: ["bird"], species: ["great tit", "willow tit"] }
	},
	{
		file: "squirrel.mp4",
		from: "squirrel",
		segment: { start: 64, duration: 15 },
		description: "A grey squirrel hanging upside down below a caged hanging feeder, partly hidden by leaves moving in the wind.",
		expect: { motion: true, subjects: ["squirrel"], species: ["eastern gray squirrel"] }
	},
	{
		// The longest animal-free stretch we found in a real feeder video. Snow falls and
		// the handheld camera drifts, so pixels change but nothing should be detected.
		file: "empty-feeder-snow.mp4",
		from: "busy",
		segment: { start: 95.7, duration: 5.3 },
		description: "An empty snowy suet feeder: falling snow and slight camera drift, no animal visible.",
		expect: { motion: true, subjects: [], species: [] }
	}
]

// An animal-free frame of the snowy feeder, the base for the synthetic clips.
const still = { from: "busy" as SourceKey, at: 99 }

// A Reolink SD-card name: RecM<ch>_<date>_<start>_<end>_<flags>_<size hex>. The
// RLC-823S1 records 4K H.265, so this exercises the HEVC + 4K decode path.
const reolinkName = "RecM07_20261014_093012_093042_6D28808_1E2F3A.mp4"

const ffmpeg = async (args: string[]) => {
	await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { maxBuffer: 16 * 1024 * 1024 })
}

const sha256File = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex")

const srcPath = (key: SourceKey) => join(srcDir, `${key}.webm`)

const fetchSource = async (key: SourceKey) => {
	const s = sources[key]
	const dest = srcPath(key)
	if (existsSync(dest)) {
		if ((await sha256File(dest)) === s.sha256) return dest
		console.warn(`${key}: cached download has the wrong hash, re-downloading`)
	}
	console.log(`${key}: downloading ${s.url}`)
	const res = await fetch(s.url, { headers: { "user-agent": userAgent } })
	if (!res.ok) throw new Error(`${key}: HTTP ${res.status} for ${s.url}`)
	const buf = Buffer.from(await res.arrayBuffer())
	const got = createHash("sha256").update(buf).digest("hex")
	if (got !== s.sha256) throw new Error(`${key}: sha256 mismatch (expected ${s.sha256}, got ${got}); the upstream file changed, re-verify segments before re-pinning`)
	const partial = `${dest}.partial`
	await writeFile(partial, buf)
	await rename(partial, dest)
	return dest
}

// Writes to a temp name and renames, so an interrupted run never leaves a truncated
// output that the idempotency check would then skip.
const produce = async (file: string, make: (out: string) => Promise<void>) => {
	const out = join(videosDir, file)
	if (!force && existsSync(out)) {
		console.log(`${file}: exists, skipping`)
		return
	}
	const tmp = join(videosDir, `.tmp-${file}`)
	try {
		await make(tmp)
		await rename(tmp, out)
	} finally {
		await rm(tmp, { force: true })
	}
	console.log(`${file}: ${((await stat(out)).size / 1e6).toFixed(1)} MB`)
}

const h264 = ["-an", "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4"]
const fit1280 = "scale='min(1280,iw)':-2"
// Sources range from 24 to 60 fps; a constant 25 fps is close to what a Reolink
// main stream records and keeps the 60 fps squirrel source from bloating the repo.
const realFilters = (clip: RealClip) => [clip.crop && `crop=${clip.crop}`, fit1280, "fps=25"].filter(Boolean).join(",")

const cutReal = (clip: RealClip) =>
	produce(clip.file, async out => {
		const input = await fetchSource(clip.from)
		const { start, duration } = clip.segment
		await ffmpeg(["-ss", String(start), "-t", String(duration), "-i", input, "-vf", realFilters(clip), ...h264, out])
	})

const main = async () => {
	await mkdir(srcDir, { recursive: true })
	for (const clip of realClips) await cutReal(clip)

	const stillPath = join(videosDir, ".src", "still.png")
	const ensureStill = async () => {
		if (existsSync(stillPath)) return
		const input = await fetchSource(still.from)
		await ffmpeg(["-ss", String(still.at), "-i", input, "-frames:v", "1", "-vf", fit1280, stillPath])
	}

	await produce("static.mp4", async out => {
		await ensureStill()
		await ffmpeg(["-loop", "1", "-framerate", "25", "-t", "10", "-i", stillPath, "-vf", "noise=alls=4:allf=t", ...h264, out])
	})

	// A passing cloud: luma dips to 70% and recovers over 10 s, chroma untouched.
	await produce("light-change.mp4", async out => {
		await ensureStill()
		await ffmpeg([
			"-loop", "1", "-framerate", "25", "-t", "10", "-i", stillPath,
			"-vf", "format=yuv420p,geq=lum='lum(X,Y)*(1-0.3*sin(PI*T/10))':cb='cb(X,Y)':cr='cr(X,Y)',noise=alls=4:allf=t",
			...h264, out
		])
	})

	await produce(reolinkName, async out => {
		const input = await fetchSource("busy")
		await ffmpeg([
			"-ss", "20", "-t", "10", "-i", input,
			"-vf", "scale=3840:2160:flags=lanczos,fps=25",
			"-an", "-c:v", "libx265", "-preset", "fast", "-crf", "30", "-pix_fmt", "yuv420p", "-tag:v", "hvc1",
			"-x265-params", "log-level=error", "-movflags", "+faststart", "-f", "mp4", out
		])
	})

	const manifest = [
		...realClips.map(c => {
			const s = sources[c.from]
			return {
				file: c.file,
				description: c.description,
				kind: "real",
				source: s.page,
				license: s.license,
				author: s.author,
				segment: c.segment,
				expect: c.expect
			}
		}),
		{
			file: "static.mp4",
			description: "10 s still of the empty snowy feeder with faint temporal noise; nothing moves.",
			kind: "synthetic",
			source: sources[still.from].page,
			license: sources[still.from].license,
			author: sources[still.from].author,
			expect: { motion: false, subjects: [], species: [] }
		},
		{
			file: "light-change.mp4",
			description: "The same still with brightness dipping ~30% and recovering over 10 s, like a passing cloud; no animal.",
			kind: "synthetic",
			source: sources[still.from].page,
			license: sources[still.from].license,
			author: sources[still.from].author,
			expect: { motion: false, subjects: [], species: [] }
		},
		{
			file: reolinkName,
			description: "Reolink-named 3840x2160 H.265 clip upscaled from the cardinal + woodpecker suet feeder (source 20-30 s).",
			kind: "synthetic",
			source: sources.busy.page,
			license: sources.busy.license,
			author: sources.busy.author,
			segment: { start: 20, duration: 10 },
			expect: { motion: true, subjects: ["bird"], species: ["northern cardinal", "downy woodpecker"] }
		}
	]
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`)
	console.log(`wrote ${manifestPath}`)
}

await main()
