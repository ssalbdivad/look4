import type { TalkServerMessage } from "../../../src/api-types.ts"

// The browser half of Talk: the microphone, brought down to the camera's sample rate in an
// AudioWorklet and sent as 16-bit PCM over the talk WebSocket (src/server/live-talk.ts). Nothing is
// sent until the server says the camera's speaker is ours.

/** Microphones need a secure page: localhost, the desktop app, or HTTPS (Tailscale serve). */
export const talkAvailable = () => typeof window !== "undefined" && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== "undefined"

/** Averages each run of input samples into one output sample (a box filter: enough for a voice), posting 40 ms at a time. */
const WORKLET = `
class Look4Talk extends AudioWorkletProcessor {
	constructor(options) {
		super()
		this.ratio = sampleRate / options.processorOptions.rate
		this.chunk = Math.round(options.processorOptions.rate / 25)
		this.out = new Int16Array(this.chunk)
		this.k = 0
		this.acc = 0
		this.n = 0
		this.pos = 0
		this.last = 0
	}
	process(inputs) {
		const ch = inputs[0] && inputs[0][0]
		if (!ch) return true
		for (let i = 0; i < ch.length; i++) {
			this.acc += ch[i]
			this.n++
			this.pos += 1
			while (this.pos >= this.ratio) {
				this.pos -= this.ratio
				if (this.n) this.last = this.acc / this.n
				this.acc = 0
				this.n = 0
				this.out[this.k++] = Math.max(-1, Math.min(1, this.last)) * 32767
				if (this.k === this.chunk) {
					this.port.postMessage(this.out.buffer, [this.out.buffer])
					this.out = new Int16Array(this.chunk)
					this.k = 0
				}
			}
		}
		return true
	}
}
registerProcessor("look4-talk", Look4Talk)
`

export type TalkEvents = {
	/** The camera's speaker is ours and the microphone is flowing. */
	live(): void
	error(message: string): void
	/** Over, for whatever reason; always the last call. */
	ended(): void
}

/** Starts talking through `source`'s speaker; the returned function stops (what was said still plays out). */
export const startTalking = (source: string, on: TalkEvents): (() => void) => {
	let over = false
	let failed = false
	let ctx: AudioContext | null = null
	let stream: MediaStream | null = null
	const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live/${encodeURIComponent(source)}/talk`)
	ws.binaryType = "arraybuffer"
	const mic = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })

	const fail = (message: string) => {
		if (failed || over) return
		failed = true
		on.error(message)
		stop()
	}

	const stop = () => {
		if (over) return
		over = true
		for (const t of stream?.getTracks() ?? []) t.stop()
		void mic.then(s => s.getTracks().forEach(t => t.stop())).catch(() => {})
		void ctx?.close().catch(() => {})
		if (ws.readyState === WebSocket.OPEN) ws.send("end")
		ws.close()
		on.ended()
	}

	mic.catch((e: Error) =>
		fail(e.name === "NotAllowedError" ? "The browser wasn't allowed to use the microphone." : e.name === "NotFoundError" ? "No microphone was found." : `The microphone didn't start: ${e.message}`)
	)

	ws.onmessage = async e => {
		if (typeof e.data !== "string") return
		const m = JSON.parse(e.data) as TalkServerMessage
		if (m.type === "error") return fail(m.message)
		try {
			stream = await mic
			if (over) return
			ctx = new AudioContext()
			const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }))
			try {
				await ctx.audioWorklet.addModule(url)
			} finally {
				URL.revokeObjectURL(url)
			}
			if (over) return
			const node = new AudioWorkletNode(ctx, "look4-talk", { processorOptions: { rate: m.sampleRate } })
			node.port.onmessage = ev => ws.readyState === WebSocket.OPEN && ws.send(ev.data as ArrayBuffer)
			ctx.createMediaStreamSource(stream).connect(node)
			// a node nobody pulls from doesn't run in every browser; it outputs silence
			node.connect(ctx.destination)
			await ctx.resume()
			on.live()
		} catch (err) {
			// a refused microphone already said so
			if (stream) fail(`The microphone didn't start: ${(err as Error).message}`)
		}
	}
	ws.onerror = () => fail("Couldn't reach look4 to talk.")
	ws.onclose = () => fail("The talk connection closed.")

	return stop
}
