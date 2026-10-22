import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { before, describe, test } from "node:test"
import { parseConfig } from "../src/config.ts"
import { iou } from "../src/geometry.ts"
import { probe, run } from "../src/media/ffmpeg.ts"
import { frameBudget, runMotionGate } from "../src/pipeline/motion.ts"
import type { MotionOptions } from "../src/pipeline/types.ts"
import type { NormBox } from "../src/types.ts"

const tmp = join(import.meta.dirname, ".tmp", "motion")
const fixtures = join(import.meta.dirname, "fixtures")
const defaults = parseConfig({}, null, tmp).pipeline.motion
const opts = (roi: NormBox | null = null): MotionOptions => ({ ...defaults, roi })

// 320x180 at 10 fps: a smooth deterministic texture with faint per-frame sensor noise, so lighting
// compensation and thresholds face something closer to a real scene than a flat colour.
const W = 320
const H = 180
const SQ = 20
const texture = `geq=lum='128+50*sin(X/7)*cos(Y/5)+20*sin((X+Y)/23)':cb=128:cr=128,noise=alls=3:allf=t`

const make = async (name: string, seconds: number, graph: string) => {
	const out = join(tmp, `${name}.mp4`)
	await run("ffmpeg", [
		"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", `color=c=gray:s=${W}x${H}:r=10:d=${seconds}`,
		"-f", "lavfi", "-i", `color=c=0x101010:s=${SQ}x${SQ}:r=10:d=${seconds}`,
		"-filter_complex", graph,
		"-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-pix_fmt", "yuv420p",
		out
	])
	return out
}

const gate = async (path: string, roi: NormBox | null = null) => runMotionGate(path, await probe(path), opts(roi))

/** Where the dark square of the `mover` clip is at `t`, in full-frame normalized coords. */
const moverAt = (t: number): NormBox => ({ x: (40 + 50 * t) / W, y: 70 / H, w: SQ / W, h: SQ / H })

describe("motion gate on synthetic clips", () => {
	const clips: Record<string, string> = {}
	before(async () => {
		mkdirSync(tmp, { recursive: true })
		clips.still = await make("still", 4, `[0]${texture}`)
		// left to right across the left half: x 40 → 190 px over 3 s
		clips.mover = await make("mover", 3, `[0]${texture}[bg];[bg][1]overlay=x='40+50*t':y=70:shortest=1`)
		// a passing cloud and the camera's exposure catching up: offset and gain both drift
		clips.ramp = await make("ramp", 4, `[0]${texture},eq=brightness='-0.12+0.06*t':contrast='0.8+0.1*t':eval=frame`)
		// auto-exposure hunting hard enough that the brightest texture clips to white and back
		clips.clipping = await make("clipping", 4, `[0]${texture},eq=brightness='0.1+0.3*sin(t*2)':eval=frame`)
		// lands at 1 s and then sits still for the remaining 80% of the clip
		clips.sitter = await make("sitter", 5, `[0]${texture}[bg];[bg][1]overlay=x=200:y=100:enable='gte(t,1)':shortest=1`)
		// the mover, plus a bigger square drifting the other way across the lower half
		// a feeder swinging in the top right for all 20 s; the mover crosses alone from 16 s to 17.5 s
		clips.sway = await make(
			"sway",
			20,
			`[0]${texture}[bg];[1]split[a][b];[b]scale=40:40[big];[bg][big]overlay=x='240+15*sin(t*5)':y=10:shortest=1[t1];[t1][a]overlay=x='40+50*(t-16)':y=70:enable='between(t,16,17.5)':shortest=1`
		)
		clips.pair = await make(
			"pair",
			3,
			`[0]${texture}[bg];[1]split[a][b];[b]scale=30:30[big];[bg][a]overlay=x='40+50*t':y=70:shortest=1[t1];[t1][big]overlay=x='260-20*t':y=130:shortest=1`
		)
	})

	test("a still scene with sensor noise does not pass", async () => {
		const r = await gate(clips.still!)
		assert.equal(r.passed, false)
		assert.equal(r.reason, "no motion")
		// nothing scored, so the detector still gets the clip evenly, no two frames within half a second
		assert.deepEqual(r.frames.map(f => f.t).sort(), [0, 1, 2, 3])
	})

	test("a small mover passes, and its candidate frames are boxed around it", async () => {
		const r = await gate(clips.mover!)
		assert.equal(r.passed, true)
		assert.match(r.reason, /^peak \d+\.\d+% of the zone moved \(compact blob\)$/)
		// the square is 400 of 57600 px, ~0.7% of the frame
		assert.ok(r.score > 0.004 && r.score < 0.012, `score ${r.score}`)
		for (const f of r.frames.filter(f => f.score >= defaults.minArea)) {
			assert.ok(f.box, `frame ${f.t} has a box`)
			assert.ok(iou(f.box, moverAt(f.t)) > 0.5, `frame ${f.t}: ${JSON.stringify(f.box)} vs ${JSON.stringify(moverAt(f.t))}`)
		}
		const ts = r.frames.map(f => f.t)
		for (const a of ts) for (const b of ts) if (a !== b) assert.ok(Math.abs(a - b) > 0.5, `frames ${a} and ${b} are too close`)
	})

	test("a global brightness and contrast ramp does not pass", async () => {
		const r = await gate(clips.ramp!)
		assert.equal(r.passed, false, r.reason)
	})

	test("an exposure swing that clips the highlights does not pass", async () => {
		const r = await gate(clips.clipping!)
		assert.equal(r.passed, false, r.reason)
	})

	test("a subject that sits through most of the clip passes, and the best frames show it", async () => {
		const r = await gate(clips.sitter!)
		assert.equal(r.passed, true, r.reason)
		const truth: NormBox = { x: 200 / W, y: 100 / H, w: SQ / W, h: SQ / H }
		// the median background contains the square, so the empty first second is the "ghost"
		assert.ok(r.frames[0]!.t >= 1, `best frame at ${r.frames[0]!.t}s predates the arrival`)
		assert.ok(iou(r.frames[0]!.box!, truth) > 0.5, JSON.stringify(r.frames[0]))
	})

	test("two separated movers: the bigger is the frame's box, the other is reported in boxes", async () => {
		const r = await gate(clips.pair!)
		assert.equal(r.passed, true, r.reason)
		const bigAt = (t: number): NormBox => ({ x: (260 - 20 * t) / W, y: 130 / H, w: 30 / W, h: 30 / H })
		const moving = r.frames.filter(f => f.score >= defaults.minArea)
		assert.ok(moving.length >= 3, `${moving.length} moving frames`)
		for (const f of moving) {
			assert.ok(iou(f.box!, bigAt(f.t)) > 0.5, `frame ${f.t}: box ${JSON.stringify(f.box)}`)
			assert.ok(f.boxes?.some(b => iou(b, moverAt(f.t)) > 0.5), `frame ${f.t}: boxes ${JSON.stringify(f.boxes)}`)
		}
	})

	test("a big mover swaying in place all clip does not take every candidate from a brief one elsewhere", async () => {
		const r = await gate(clips.sway!)
		assert.equal(r.passed, true, r.reason)
		const brief = r.frames.filter(f => f.t >= 16 && f.t <= 17.5 && f.box && iou(f.box, moverAt(f.t - 16)) > 0.3)
		assert.ok(brief.length, JSON.stringify(r.frames))
	})

	test("a zone that excludes the mover does not pass", async () => {
		const r = await gate(clips.mover!, { x: 0.7, y: 0, w: 0.3, h: 1 })
		assert.equal(r.passed, false, r.reason)
	})

	test("boxes found inside a zone come back in full-frame coordinates", async () => {
		const roi = { x: 0.05, y: 0.2, w: 0.6, h: 0.6 }
		const r = await gate(clips.mover!, roi)
		assert.equal(r.passed, true)
		const best = r.frames[0]!
		assert.ok(iou(best.box!, moverAt(best.t)) > 0.5, `${JSON.stringify(best.box)} vs ${JSON.stringify(moverAt(best.t))}`)
	})
})

type Fixture = { file: string; expect: { motion: boolean } }

describe("motion gate on the fixture footage", () => {
	const manifestPath = join(fixtures, "manifest.json")
	const manifest: Fixture[] = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : []
	for (const f of manifest) {
		const path = join(fixtures, "videos", f.file)
		test(`${f.file} ${f.expect.motion ? "passes" : "is dropped"}`, async t => {
			if (!existsSync(path)) return t.skip("not downloaded (pnpm fixtures)")
			const r = await gate(path)
			assert.equal(r.passed, f.expect.motion, r.reason)
		})
	}
})

test("long clips get a detector frame per 10 s, never fewer than maxFrames and never more than 24", () => {
	assert.deepEqual(
		[frameBudget(6, 30), frameBudget(6, 60), frameBudget(6, 120.6), frameBudget(16, 120), frameBudget(6, 600)],
		[6, 6, 13, 16, 24]
	)
})
