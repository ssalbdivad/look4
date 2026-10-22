import type { Bus, Look4Events } from "../events.ts"

const EVENTS = ["clip", "sighting", "source", "queue", "lookout", "lifelist"] as const satisfies ReadonlyArray<keyof Look4Events>

export const HEARTBEAT_MS = 20_000

/** Open SSE streams, so shutting the server down can end them (they would hold it open). */
export type SseHub = { open: Set<() => void>; closeAll(): void }

export const createSseHub = (): SseHub => {
	const open = new Set<() => void>()
	return {
		open,
		closeAll: () => {
			for (const close of [...open]) close()
		}
	}
}

/**
 * A `text/event-stream` response relaying every bus event. Listeners are
 * removed on whichever comes first: the client disconnecting (the body is
 * cancelled), the request aborting, or the server shutting down.
 */
export const sseResponse = (bus: Bus, hub: SseHub, signal: AbortSignal, heartbeatMs = HEARTBEAT_MS): Response => {
	const encoder = new TextEncoder()
	let cleanup = () => {}
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			let done = false
			const send = (chunk: string) => {
				if (done) return
				try {
					controller.enqueue(encoder.encode(chunk))
				} catch {
					cleanup()
				}
			}
			const listeners = EVENTS.map(event => {
				const fn = (data: unknown) => send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
				bus.on(event, fn as never)
				return [event, fn] as const
			})
			const heartbeat = setInterval(() => send(": hb\n\n"), heartbeatMs)
			heartbeat.unref?.()
			cleanup = () => {
				if (done) return
				done = true
				clearInterval(heartbeat)
				for (const [event, fn] of listeners) bus.off(event, fn as never)
				signal.removeEventListener("abort", onAbort)
				hub.open.delete(close)
			}
			const close = () => {
				const wasOpen = !done
				cleanup()
				if (wasOpen)
					try {
						controller.close()
					} catch {}
			}
			const onAbort = () => close()
			signal.addEventListener("abort", onAbort)
			hub.open.add(close)
			// retry hint + an initial comment so proxies flush headers immediately
			send("retry: 3000\n: connected\n\n")
			if (signal.aborted) close()
		},
		cancel() {
			cleanup()
		}
	})
	return new Response(body, {
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no"
		}
	})
}
