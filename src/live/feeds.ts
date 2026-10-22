// The live picture, two ways, both made by ffmpeg from the camera's stream:
//
// - Fragmented MP4 for Media Source Extensions: the stream's own video copied
//   into MP4 fragments (no re-encoding), one ffmpeg per viewer. A stream the
//   browser can't play (4K HEVC main streams) is transcoded to H.264, on the GPU
//   when NVENC works (CUDA decode, scale, encode), else on the CPU at a lower
//   size and frame rate. The camera's sound track rides along when asked for.
// - Motion JPEG, for browsers without MSE and as the fallback when MP4 fails:
//   one ffmpeg per source and stream, shared by every viewer ("hub"). The same
//   hub carries stills polled from a camera's API when its stream is off.

import { type ChildProcess, spawn } from "node:child_process"
import type { Readable } from "node:stream"
import sharp from "sharp"
import { FFMPEG } from "../media/ffmpeg.ts"
import { streamProblem } from "../setup/snapshot.ts"
import { maskWith } from "../sources/rtsp.ts"
import { createMjpegParser } from "./mjpeg.ts"
import { codecsOf, initSegmentEnd } from "./mp4.ts"

/** streamProblem's sentences for a camera that is down, refusing the password or missing the stream: no decoder or encoder would do better. */
export const CAMERA_FAULT = /Nothing answered|Couldn't reach|username or password|no stream at that path/

export class FeedError extends Error {}

/** The sound track couldn't be copied into MP4 (G.711 and friends): try again re-encoding it to AAC. */
export class AudioCopyError extends FeedError {}

/**
 * ffmpeg input options for a live URL: TCP for RTSP (UDP through NAT or WSL
 * usually delivers nothing). No `-fflags nobuffer`: it throws away the keyframe
 * found while probing, so every start waited a whole extra GOP (+1.1 s on a
 * Reolink main stream, +4 s on its sub stream).
 */
export const inputArgs = (url: string, pre: string[] = []) => [
	"-hide_banner", "-nostdin", "-loglevel", "info",
	...(/^rtsps?:/i.test(url) ? ["-rtsp_transport", "tcp", "-stimeout", "10000000"] : ["-rw_timeout", "10000000"]),
	"-analyzeduration", "1500000", "-probesize", "2000000",
	...pre,
	"-i", url
]

/**
 * Decoding on the CPU: frame threads. `-flags low_delay` would make a 4K HEVC
 * decode single-threaded (one picture slice, no tiles), and it falls behind real
 * time next to anything else busy; 4 threads add at most ~160 ms at 25 fps.
 */
const CPU_DECODE = ["-threads", "4"]

/** NVDEC's own decoder for the input codec, frames kept on the GPU. */
const cudaDecode = (codec: "h264" | "hevc") => ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda", "-c:v", `${codec}_cuvid`]

/**
 * How a stream becomes browser-playable MP4: copied as it is (`hvc1`: the input
 * is HEVC, tag it the way Safari wants; the muxer refuses that tag on H.264), or
 * re-encoded to H.264. `gpu` decodes with NVDEC's own decoder for the input codec
 * (`hevc_cuvid`), scales and encodes without the frames leaving the GPU. (The
 * generic `-hwaccel cuda` decoder falls back to software frames on a Reolink
 * stream joined mid-GOP, which breaks the CUDA filter graph.) `nvenc` decodes on the CPU.
 */
export type Mp4Plan =
	| { kind: "copy"; hvc1?: boolean }
	| { kind: "transcode"; via: "gpu"; codec: "h264" | "hevc" }
	| { kind: "transcode"; via: "nvenc" | "x264" }

/** The camera's sound: left out, copied (AAC), or re-encoded to AAC (anything MP4 can't carry as is). */
export type Mp4Audio = "none" | "copy" | "aac"

/**
 * Drops decoded frames until the first keyframe. A viewer joins the camera's
 * stream mid-GOP; the frames before its next keyframe reference pictures the
 * decoder never saw and come out gray (CPU) or solid green (CUDA). Stream copy
 * skips them by itself.
 */
export const FROM_KEYFRAME = "select='gt(selected_n\\,0)+key'"

/**
 * Video first, so the codecs string starts with it. With sound, the muxer holds
 * video back at most 0.5 s waiting for audio: its 10 s default froze the picture
 * whenever the sound dropped out.
 */
const audioArgs = (audio: Mp4Audio) =>
	audio === "none"
		? ["-an"]
		: ["-map", "0:a:0?", ...(audio === "copy" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "64k"]), "-max_interleave_delta", "500000"]

const fragmented = (audio: Mp4Audio) => [...audioArgs(audio), "-f", "mp4", "-movflags", "empty_moov+default_base_moof+frag_every_frame", "pipe:1"]

/** 1080p of a mostly still scene: 6M gave 6.7–7.3 Mbps, 3.5× the camera's own HEVC. */
const NVENC = ["-c:v", "h264_nvenc", "-preset", "p2", "-tune", "ll", "-zerolatency", "1", "-bf", "0", "-g", "50", "-b:v", "2.5M", "-maxrate", "4M", "-bufsize", "4M"]

export const mp4Args = (url: string, plan: Mp4Plan, audio: Mp4Audio = "none"): string[] => {
	if (plan.kind === "copy")
		// low_delay is harmless here (nothing is decoded) and keeps the demuxer from waiting
		return [...inputArgs(url, ["-flags", "low_delay"]), "-map", "0:v:0", "-c:v", "copy", ...(plan.hvc1 ? ["-tag:v", "hvc1"] : []), ...fragmented(audio)]
	if (plan.via === "gpu")
		return [
			...inputArgs(url, cudaDecode(plan.codec)),
			"-map", "0:v:0",
			"-vf", `${FROM_KEYFRAME},scale_cuda=w='min(1920,iw)':h=-2`,
			...NVENC,
			...fragmented(audio)
		]
	if (plan.via === "nvenc")
		return [...inputArgs(url, CPU_DECODE), "-map", "0:v:0", "-vf", `${FROM_KEYFRAME},fps=15,scale=w='min(1920,iw)':h=-2,format=yuv420p`, ...NVENC, ...fragmented(audio)]
	return [
		...inputArgs(url, CPU_DECODE),
		"-map", "0:v:0",
		"-vf", `${FROM_KEYFRAME},fps=12,scale=w='min(1280,iw)':h=-2,format=yuv420p`,
		"-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "main", "-g", "24", "-bf", "0",
		...fragmented(audio)
	]
}

export type MjpegOptions = { fps: number; maxWidth: number; /** Decode and scale on the GPU (NVDEC) when the input codec is known to it. */ gpu?: "h264" | "hevc" | null }

export const mjpegArgs = (url: string, o: MjpegOptions) =>
	o.gpu
		? [
				...inputArgs(url, cudaDecode(o.gpu)),
				"-an", "-vf", `${FROM_KEYFRAME},fps=${o.fps},scale_cuda=w='min(${o.maxWidth},iw)':h=-2,hwdownload,format=nv12`,
				"-q:v", "5", "-f", "mpjpeg", "-boundary_tag", "look4frame", "pipe:1"
			]
		: [
				...inputArgs(url, CPU_DECODE),
				"-an", "-vf", `${FROM_KEYFRAME},fps=${o.fps},scale=w='min(${o.maxWidth},iw)':h=-2`,
				"-q:v", "5", "-f", "mpjpeg", "-boundary_tag", "look4frame", "pipe:1"
			]

type Spawned = { proc: ChildProcess; stderr: () => string; exited: Promise<number | null> }

const run = (args: string[], url: string): Spawned => {
	const mask = maskWith(url)
	const proc = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] })
	let err = ""
	proc.stderr!.on("data", (d: Buffer) => {
		err = (err + d.toString()).slice(-16_000)
	})
	const exited = new Promise<number | null>(resolve => {
		proc.once("error", e => {
			err += (e as NodeJS.ErrnoException).code === "ENOENT" ? `\n${FFMPEG} is not installed` : `\n${e.message}`
			resolve(-1)
		})
		proc.once("close", code => resolve(code))
	})
	return { proc, stderr: () => mask(err.trim()), exited }
}

/** The input's video codec as ffmpeg names it ("h264", "hevc"), once ffmpeg has printed its stream info. */
export const inputCodec = (stderr: string) => /Input #0[\s\S]*?Stream #0:\d+[^:]*: Video: (\w+)/.exec(stderr)?.[1] ?? null

/** ffmpeg refusing to put the (second, audio) output stream into MP4 as it is. */
const AUDIO_COPY_REFUSED = /Could not find tag for codec \w+ in stream #1|in MP4 support is experimental/

export type Mp4Session = {
	/** RFC 6381 codecs string for `MediaSource.addSourceBuffer`: video, then audio when there is sound (`hvc1.1.6.L150,mp4a.40.2`). */
	codec: string
	/** The video track's codec string alone. */
	video: string
	/** The audio track's codec string, or null when the stream carries no sound. */
	audio: string | null
	/** The camera stream's own codec, so a stream the browser can't play is transcoded next time without trying. */
	inputCodec: string | null
	plan: Mp4Plan
	/** Init segment and then fragments, until the viewer goes away or the camera stops. */
	body: ReadableStream<Uint8Array>
	kill(): void
	/** Settles when ffmpeg has exited. */
	closed: Promise<void>
}

/**
 * ffmpeg's stdout as a web stream. (Node's `Readable.toWeb` can still enqueue a
 * buffered chunk after the viewer hung up, which throws outside any handler.)
 */
const webStream = (out: Readable): ReadableStream<Uint8Array> => {
	let done = false
	return new ReadableStream<Uint8Array>(
		{
			start(ctrl) {
				out.on("data", (d: Buffer) => {
					if (done) return
					ctrl.enqueue(new Uint8Array(d.buffer, d.byteOffset, d.byteLength))
					if ((ctrl.desiredSize ?? 1) <= 0) out.pause()
				})
				const end = (e?: Error) => {
					if (done) return
					done = true
					if (e) ctrl.error(e)
					else ctrl.close()
				}
				out.once("end", () => end())
				out.once("error", end)
			},
			pull() {
				out.resume()
			},
			cancel() {
				done = true
				out.destroy()
			}
		},
		{ highWaterMark: 1 << 20, size: c => c.byteLength }
	)
}

/** Starts one ffmpeg and resolves once the init segment is out, so a failure becomes a sentence instead of a dead video. */
export const openMp4 = (url: string, plan: Mp4Plan, audio: Mp4Audio = "none", timeoutMs = 15_000): Promise<Mp4Session> => {
	const p = run(mp4Args(url, plan, audio), url)
	const out = p.proc.stdout!
	let head = Buffer.alloc(0)
	return new Promise<Mp4Session>((resolve, reject) => {
		let settled = false
		const fail = (msg: string, error: typeof FeedError = FeedError) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			out.off("data", onData)
			p.proc.kill("SIGKILL")
			reject(new error(msg))
		}
		const timer = setTimeout(() => fail(streamProblem("timeout")), timeoutMs)
		const onData = (d: Buffer) => {
			head = Buffer.concat([head, d])
			const end = initSegmentEnd(head)
			if (end === null) {
				if (head.length > 8 << 20) fail("The stream's first bytes weren't a video ffmpeg could package.")
				return
			}
			settled = true
			clearTimeout(timer)
			out.off("data", onData)
			out.pause()
			out.unshift(head)
			const codecs = codecsOf(head.subarray(0, end))
			const kill = () => {
				if (p.proc.exitCode === null) p.proc.kill("SIGKILL")
			}
			out.once("close", kill)
			if (!codecs) {
				kill()
				reject(new FeedError("The stream didn't say which video format it uses."))
				return
			}
			resolve({
				codec: codecs.codecs,
				video: codecs.video,
				audio: codecs.audio,
				inputCodec: inputCodec(p.stderr()),
				plan,
				body: webStream(out),
				kill,
				closed: p.exited.then(() => {})
			})
		}
		out.on("data", onData)
		p.exited.then(code => {
			const err = p.stderr()
			if (audio === "copy" && AUDIO_COPY_REFUSED.test(err)) fail("The camera's sound can't be copied into MP4 as it is.", AudioCopyError)
			else fail(streamProblem(err || `ffmpeg exited ${code}`))
		})
	})
}

let nvenc: Promise<boolean> | null = null

/** Whether ffmpeg's NVENC encoder works on this machine (an NVIDIA GPU with its driver), checked once with a blank clip. */
export const hasNvenc = () =>
	(nvenc ??= new Promise<boolean>(resolve => {
		const child = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=256x144:r=5", "-t", "0.4", "-c:v", "h264_nvenc", "-f", "null", "-"], {
			stdio: "ignore"
		})
		const timer = setTimeout(() => child.kill("SIGKILL"), 10_000)
		child.once("error", () => resolve(false))
		child.once("close", code => {
			clearTimeout(timer)
			resolve(code === 0)
		})
	}))

// ---- shared Motion JPEG hubs ----

/** Makes frames until `signal` aborts or the camera fails; rejects with a sentence for the user. */
export type FrameProducer = (emit: (jpeg: Buffer) => void, signal: AbortSignal) => Promise<void>

/**
 * Frames from the stream. A GPU decode that dies before its first frame (a
 * codec NVDEC lacks, no free decoder) is retried on the CPU straight away and
 * reported through `onGpuFailed` once the CPU gets a frame; `onCodec` learns the
 * input's codec.
 */
export const ffmpegFrames =
	(url: string, o: MjpegOptions & { onCodec?: (codec: string) => void; onGpuFailed?: () => void }): FrameProducer =>
	async (emit, signal) => {
		// `onFirst`: the CPU retry's first frame is what blames the GPU. A camera that is down (rebooting, off the network)
		// gives the GPU attempt no frames either, and that must not turn GPU decoding off for good
		const attempt = async (gpu: MjpegOptions["gpu"], onFirst?: () => void) => {
			const p = run(mjpegArgs(url, { ...o, gpu }), url)
			const parse = createMjpegParser()
			let frames = 0
			const stop = () => p.proc.kill("SIGKILL")
			signal.addEventListener("abort", stop, { once: true })
			p.proc.stdout!.on("data", (d: Buffer) => {
				try {
					for (const f of parse(d)) {
						if (frames++ === 0) {
							const codec = inputCodec(p.stderr())
							if (codec) o.onCodec?.(codec)
							onFirst?.()
						}
						emit(f)
					}
				} catch {
					stop()
				}
			})
			const code = await p.exited
			signal.removeEventListener("abort", stop)
			return { code, frames, stderr: p.stderr() }
		}
		let r = await attempt(o.gpu)
		// a camera that is down or refusing the password fails the CPU the same way: retrying would only
		// spend another login, and blame the GPU if the camera happened to come back in between
		if (o.gpu && !signal.aborted && r.frames === 0 && !CAMERA_FAULT.test(streamProblem(r.stderr)))
			r = await attempt(null, () => o.onGpuFailed?.())
		if (!signal.aborted) throw new FeedError(streamProblem(r.stderr || `ffmpeg exited ${r.code}`))
	}

/** Stills from the camera's own API (Reolink `Snap`) about once a second, scaled to a size a browser repaints easily. */
export const polledFrames =
	(snap: (signal: AbortSignal) => Promise<Buffer>, o: { intervalMs: number; maxWidth: number }): FrameProducer =>
	async (emit, signal) => {
		while (!signal.aborted) {
			const started = Date.now()
			const jpeg = await snap(signal)
			emit(await sharp(jpeg).resize({ width: o.maxWidth, withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer())
			const wait = o.intervalMs - (Date.now() - started)
			if (wait > 0) await new Promise(r => setTimeout(r, wait))
		}
	}

export type Viewer = { frame: (jpeg: Buffer) => void; end: (error: string | null) => void }

export type Hub = {
	/** Resolves with the first frame; rejects (with a sentence) when the camera gives none. */
	ready: Promise<Buffer>
	latest(): Buffer | null
	join(v: Viewer): () => void
	viewers(): number
	stop(): void
}

/**
 * One producer shared by every viewer. It restarts after a hiccup while anyone
 * watches, and stops `lingerMs` after the last viewer leaves (a pop-out opening
 * as the main page closes keeps the camera connection).
 */
export const createHub = (produce: FrameProducer, o: { lingerMs?: number; onIdle?: () => void; restartMs?: number } = {}): Hub => {
	const viewers = new Set<Viewer>()
	let latest: Buffer | null = null
	let stopped = false
	let ac = new AbortController()
	let idle: NodeJS.Timeout | null = null
	let resolveReady!: (b: Buffer) => void
	let rejectReady!: (e: Error) => void
	const ready = new Promise<Buffer>((res, rej) => {
		resolveReady = res
		rejectReady = rej
	})
	ready.catch(() => {})

	const emit = (jpeg: Buffer) => {
		const first = latest === null
		latest = jpeg
		if (first) resolveReady(jpeg)
		for (const v of viewers) v.frame(jpeg)
	}

	const stop = () => {
		if (stopped) return
		stopped = true
		if (idle) clearTimeout(idle)
		ac.abort()
		rejectReady(new FeedError("stopped"))
		for (const v of viewers) v.end(null)
		viewers.clear()
		o.onIdle?.()
	}

	const loop = async () => {
		let failures = 0
		while (!stopped) {
			const framesBefore = latest
			try {
				await produce(emit, ac.signal)
			} catch (e) {
				if (stopped) return
				const msg = e instanceof Error ? e.message : String(e)
				// never a frame, or one failure after another: give up and tell everyone why
				if (latest === null || (latest === framesBefore && ++failures >= 3)) {
					stopped = true
					rejectReady(new FeedError(msg))
					for (const v of viewers) v.end(msg)
					viewers.clear()
					o.onIdle?.()
					return
				}
				if (latest !== framesBefore) failures = 0
			}
			if (stopped) return
			ac = new AbortController()
			await new Promise(r => setTimeout(r, o.restartMs ?? 1000))
		}
	}
	void loop()
	// a hub nobody joins (the request went away first) does not run forever
	idle = setTimeout(stop, o.lingerMs ?? 4000)
	idle.unref()

	return {
		ready,
		latest: () => latest,
		viewers: () => viewers.size,
		join: v => {
			if (idle) clearTimeout(idle)
			idle = null
			viewers.add(v)
			return () => {
				if (!viewers.delete(v) || viewers.size || stopped) return
				idle = setTimeout(stop, o.lingerMs ?? 4000)
				idle.unref()
			}
		},
		stop
	}
}
