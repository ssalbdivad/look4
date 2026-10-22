import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { before, test } from "node:test"
import sharp from "sharp"
import { createHwdecHealth, decodeGray, extractFrame, keyframeRegions, probe, run } from "../src/media/ffmpeg.ts"
import { feederLook } from "../src/pipeline/crops.ts"

const tmp = join(import.meta.dirname, ".tmp", "ffmpeg")

const make = async (name: string, src: string, extra: string[] = []) => {
	const out = join(tmp, name)
	await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", src, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", ...extra, out])
	return out
}

const clips: Record<string, string> = {}
before(async () => {
	mkdirSync(tmp, { recursive: true })
	clips.wide = await make("wide.mp4", "testsrc2=size=640x360:rate=10:duration=2")
	const upright = await make("upright.mp4", "testsrc2=size=640x360:rate=10:duration=1")
	// a phone held sideways: the pixels are stored 640x360 and the container says "rotate"
	clips.sideways = join(tmp, "sideways.mp4")
	await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", upright, "-c", "copy", "-metadata:s:v:0", "rotate=90", clips.sideways])
	clips.big = await make("big.mp4", "testsrc2=size=2560x1440:rate=5:duration=2")
})

test("probe reads duration, size, codec and frame rate", async () => {
	assert.deepEqual(await probe(clips.wide!), { durationS: 2, width: 640, height: 360, codec: "h264", fps: 10 })
})

test("probe reports a rotated clip in the dimensions its frames decode at", async () => {
	const p = await probe(clips.sideways!)
	assert.equal(p.rotation === 90 || p.rotation === 270, true, `rotation ${p.rotation}`)
	assert.deepEqual([p.width, p.height], [360, 640])
	const frame = await sharp(await extractFrame(clips.sideways!, 0)).metadata()
	assert.deepEqual([frame.width, frame.height], [360, 640])
})

test("probe rejects a file with no video stream", async () => {
	const audio = join(tmp, "tone.m4a")
	await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=duration=0.5", audio])
	await assert.rejects(probe(audio), /no video stream/)
})

// grey 3 s at 10 fps, keyframes at 0, 1 and 2 s; a red 40 px "bird" at (100, 50) from 2 s on
const birdAtTwo = () =>
	make("bird-at-2s.mp4", "color=gray:s=640x360:r=10:d=3[bg];color=red:s=40x40:r=10:d=3[b];[bg][b]overlay=100:50:enable='gte(t,2)'[out0]", [
		"-g", "10", "-keyint_min", "10", "-sc_threshold", "0"
	])
const redAt = (rgb: Buffer, width: number, x: number, y: number) => {
	const i = (y * width + x) * 3
	return rgb[i]! > 180 && rgb[i + 1]! < 90 && rgb[i + 2]! < 90
}

test("keyframeRegions cuts every keyframe to each region, in the regions' order, at its own time", async () => {
	const clip = await birdAtTwo()
	const bird = { left: 80, top: 30, width: 80, height: 80 }
	const empty = { left: 400, top: 200, width: 80, height: 80 }
	const frames = await keyframeRegions(clip, [bird, empty], 32)
	assert.deepEqual(
		frames.map(f => [f.t, f.tiles.map(t => t.length), f.tiles.map(t => redAt(t, 32, 16, 16))]),
		[
			[0, [32 * 32 * 3, 32 * 32 * 3], [false, false]],
			[1, [32 * 32 * 3, 32 * 32 * 3], [false, false]],
			[2, [32 * 32 * 3, 32 * 32 * 3], [true, false]]
		]
	)
})

test("feederLook: one image per feeder with every keyframe tiled in time order, so a bird in one keyframe is in its tile", async () => {
	const clip = await birdAtTwo()
	const feeder = { x: 120 / 640, y: 70 / 360, w: 0.01, h: 0.01 }
	const { sheets: [sheet] } = await feederLook("c", clip, { width: 640, height: 360 }, [feeder])
	assert.deepEqual([sheet!.label, sheet!.frameT, sheet!.sheet, sheet!.box], ["feeder timeline", 0, [0, 1, 2], feeder])
	const { data, info } = await sharp(sheet!.jpeg).raw().toBuffer({ resolveWithObject: true })
	// three 256 px tiles, two to a row; the bird sits mid-tile, clear of the time labels
	assert.deepEqual([info.width, info.height], [512, 512])
	assert.deepEqual(
		[[128, 128], [384, 128], [128, 384]].map(([x, y]) => redAt(data, info.width, x!, y!)),
		[false, false, true]
	)
})

test("extractFrame crops first, then bounds the long edge", async () => {
	// the bottom-right quarter of 640x360 is 320x180; a 100 px long edge makes it 100x56
	const jpeg = await extractFrame(clips.wide!, 1, { crop: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, maxEdge: 100 })
	const meta = await sharp(jpeg).metadata()
	assert.deepEqual([meta.format, meta.width, meta.height], ["jpeg", 100, 56])
})

test("decodeGray samples at the requested rate and stops early at maxFrames", async () => {
	const p = await probe(clips.wide!)
	const all = await decodeGray(clips.wide!, p, { fps: 4, maxEdge: 160, maxFrames: 100 })
	assert.deepEqual([all.frames.length, all.width, all.height], [8, 160, 90])
	assert.ok(all.frames.every(f => f.length === 160 * 90))
	const capped = await decodeGray(clips.wide!, p, { fps: 4, maxEdge: 160, maxFrames: 3 })
	assert.equal(capped.frames.length, 3)
})

test("decodeGray's GPU and CPU paths see the same cropped region", async t => {
	const p = await probe(clips.big!)
	const crop = { x: 0.1, y: 0.3, w: 0.4, h: 0.5 }
	const opts = { fps: 2, crop, maxEdge: 320, maxFrames: 4 }
	const gpu = await decodeGray(clips.big!, p, opts)
	if (gpu.decoder !== "cuvid") return t.skip("NVDEC is not available here")
	process.env.LOOK4_HWDEC = "off"
	try {
		const cpu = await decodeGray(clips.big!, p, opts)
		assert.equal(cpu.decoder, "cpu")
		assert.deepEqual([gpu.width, gpu.height, gpu.region], [cpu.width, cpu.height, cpu.region])
		assert.equal(gpu.frames.length, cpu.frames.length)
		for (let k = 0; k < cpu.frames.length; k++) {
			let sum = 0
			for (let i = 0; i < cpu.frames[k]!.length; i++) sum += Math.abs(cpu.frames[k]![i]! - gpu.frames[k]![i]!)
			// the two resizers differ by well under a grey level; a misplaced crop is off by dozens
			assert.ok(sum / cpu.frames[k]!.length < 2, `frame ${k}: mean abs diff ${sum / cpu.frames[k]!.length}`)
		}
	} finally {
		delete process.env.LOOK4_HWDEC
	}
})

test("keyframeRegions' GPU path picks the same keyframes and cuts the same regions as the CPU path", async t => {
	const clip = await make("big-gop.mp4", "testsrc2=size=2560x1440:rate=5:duration=3", ["-g", "5", "-keyint_min", "5", "-sc_threshold", "0"])
	const p = await probe(clip)
	if ((await decodeGray(clip, p, { fps: 1, maxEdge: 64, maxFrames: 1 })).decoder !== "cuvid") return t.skip("NVDEC is not available here")
	// odd offsets, so the GPU's even-pixel crop around both has to be undone exactly
	const rects = [{ left: 301, top: 97, width: 349, height: 349 }, { left: 1871, top: 803, width: 349, height: 349 }]
	const gpu = await keyframeRegions(clip, rects, 64, undefined, p)
	process.env.LOOK4_HWDEC = "off"
	try {
		const cpu = await keyframeRegions(clip, rects, 64, undefined, p)
		assert.deepEqual(gpu.map(f => f.t), [0, 1, 2])
		assert.deepEqual(gpu.map(f => f.t), cpu.map(f => f.t))
		gpu.forEach((f, k) =>
			f.tiles.forEach((tile, r) => {
				let sum = 0
				for (let i = 0; i < tile.length; i++) sum += Math.abs(tile[i]! - cpu[k]!.tiles[r]![i]!)
				// testsrc2 moves every frame, so a wrong frame or a shifted crop is off by dozens
				assert.ok(sum / tile.length < 2, `keyframe ${k}, region ${r}: mean abs diff ${sum / tile.length}`)
			})
		)
	} finally {
		delete process.env.LOOK4_HWDEC
	}
})

test("NVDEC is switched off only by failures in a row, and re-probed after the cool-down", () => {
	let clock = 0
	const hw = createHwdecHealth({ limit: 3, coolDownMs: 1000, now: () => clock })
	// one odd clip between good ones never adds up
	assert.deepEqual([hw.failed(), hw.failed()], [false, false])
	hw.succeeded()
	assert.deepEqual([hw.failed(), hw.failed(), hw.usable()], [false, false, true])
	assert.equal(hw.failed(), true)
	assert.equal(hw.usable(), false)

	clock += 1000
	assert.equal(hw.usable(), true)
	// a failed re-probe goes straight back off, without announcing it again
	assert.deepEqual([hw.failed(), hw.usable()], [false, false])
	clock += 1000
	hw.succeeded()
	assert.deepEqual([hw.failed(), hw.usable()], [false, true])
})
