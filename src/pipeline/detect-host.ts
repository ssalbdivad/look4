// The detector's model, in a child process of its own. src/pipeline/detect.ts forks this
// file and sends it one view at a time.
//
// Why not in the server's process: onnxruntime-node loads the model and runs every
// inference synchronously on the calling thread (its `run` is a native call in a
// setImmediate), and transformers.js pre- and post-processes in plain JS. In-process, each
// view froze the event loop (the UI, the API, SSE, live view) for its whole inference:
// 3-6 s at load 40-60, and 9 s for the model load. A worker thread would free the loop but
// leave the ~600 MB the model holds in the server's process, and every ffmpeg spawn forks
// that process, which itself blocked it 0.3-0.5 s per spawn at that load.

import type { RawImage } from "@huggingface/transformers"

/** A raw model hit, as transformers.js returns it: label is the prompt, box in view-image pixels. */
export type RawHit = { label: string; score: number; box: { xmin: number; ymin: number; xmax: number; ymax: number } }

export type HostRequest =
	| { type: "load"; id: string; dtype: string; modelsDir: string; threads: number }
	| { type: "run"; seq: number; data: Uint8Array; width: number; height: number; labels: string[]; threshold: number }

export type HostReply =
	| { type: "progress"; progress: number; total: number }
	| { type: "ready" }
	| { type: "result"; seq: number; hits: RawHit[]; ms: number }
	| { type: "error"; seq: number | null; message: string }

const send = (m: HostReply) => process.send?.(m)
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

type Pipe = (image: RawImage, labels: string[], opts: { threshold: number }) => Promise<unknown>
let pipe: Pipe | null = null
let Image: typeof RawImage | null = null

const load = async (m: Extract<HostRequest, { type: "load" }>) => {
	const tf = await import("@huggingface/transformers")
	Image = tf.RawImage
	pipe = (await tf.pipeline("zero-shot-object-detection", m.id, {
		dtype: m.dtype as "q8",
		device: "cpu",
		cache_dir: m.modelsDir,
		session_options: { intraOpNumThreads: m.threads },
		progress_callback: info => {
			if (info.status === "progress_total") send({ type: "progress", progress: info.progress, total: info.total })
		}
	})) as unknown as Pipe
}

// Requests come one at a time (detect.ts chains them), so there is no queue here.
process.on("message", (m: HostRequest) => {
	if (m.type === "load")
		load(m).then(
			() => send({ type: "ready" }),
			e => send({ type: "error", seq: null, message: message(e) })
		)
	else if (m.type === "run") {
		const started = performance.now()
		if (!pipe || !Image) {
			send({ type: "error", seq: m.seq, message: "detector model is not loaded" })
			return
		}
		pipe(new Image(m.data, m.width, m.height, 3), m.labels, { threshold: m.threshold }).then(
			hits => send({ type: "result", seq: m.seq, hits: hits as RawHit[], ms: performance.now() - started }),
			e => send({ type: "error", seq: m.seq, message: message(e) })
		)
	}
})

// the server exited (or was killed): nothing will ask again
process.on("disconnect", () => process.exit(0))
