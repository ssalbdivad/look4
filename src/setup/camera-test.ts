// "Test connection" in the setup wizard: probe the camera's ports, and only if
// its web API answers, log in and read what it is. Saves nothing. A login is
// never attempted against a camera whose HTTP and HTTPS ports are closed: there
// is nothing to log in to, and a Reolink camera locks the account after a few
// failed logins, so every attempt has to count.

import type { CameraProblem, CameraTestBody, CameraTestResult, DevicePorts } from "../api-types.ts"
import {
	createReolinkClient,
	lockoutSeconds,
	loginProblem,
	parseHost,
	type ReolinkProtocol,
	ReolinkError,
	ReolinkNetworkError
} from "../sources/reolink-api.ts"
import { looksLikeReolink, type PortMap, probePort, probePorts } from "./discover.ts"

export { lockoutSeconds, loginProblem }

/** `host[:port]` (IPv6 in brackets) from what the user typed, minus any scheme or path. */
export const splitHostPort = (hostPort: string): { hostname: string; port: number | null } => {
	const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostPort) ?? /^([^:]+)(?::(\d+))?$/.exec(hostPort)
	if (!m) return { hostname: hostPort, port: null }
	return { hostname: m[1]!, port: m[2] ? Number(m[2]) : null }
}

const sentence: Record<Exclude<CameraProblem, "unknown">, (host: string) => string> = {
	unreachable: host =>
		`Nothing answered at ${host}. Check that the camera is plugged in and on the same network as this computer. Its address may also have changed, so try looking for it again.`,
	"http-disabled": host =>
		`Your camera is there at ${host}, but its HTTPS setting is switched off, so look4 can't sign in to it yet. You can turn it on in the Reolink app.`,
	"bad-credentials": () =>
		"The camera said that username or password is wrong. If you never set a password, leave the password empty.",
	"locked-out": () =>
		"The camera is refusing sign-ins for a while after too many wrong passwords. Wait about 5 minutes, then try again.",
	"not-reolink": host => `Something answered at ${host}, but it isn't a Reolink camera. Double-check the address.`
}

const fail = (problem: CameraProblem, detail: string, ports: DevicePorts, protocol?: ReolinkProtocol): CameraTestResult => ({
	ok: false,
	problem,
	detail,
	ports,
	...(protocol ? { protocol } : {})
})

export type CameraTestOptions = {
	/** Per port probe. */
	probeTimeoutMs?: number
	/** Per API call once a port answers. */
	apiTimeoutMs?: number
	/** Where each service is probed. Tests move them off the real well-known ports. */
	portMap?: PortMap
}

export const testCamera = async (body: CameraTestBody, opts: CameraTestOptions = {}): Promise<CameraTestResult> => {
	const typed = body.host.trim()
	const { hostPort, protocols } = parseHost(typed, body.protocol ?? "auto")
	const { hostname, port } = splitHostPort(hostPort)
	const probeMs = opts.probeTimeoutMs ?? 1500
	const [{ ports, cast }, explicitOpen] = await Promise.all([
		probePorts(hostname, probeMs, opts.portMap),
		port !== null ? probePort(hostname, port, probeMs) : Promise.resolve(false)
	])

	// with a port in the address, that port is the API; otherwise each scheme needs its standard port open
	const usable: ReolinkProtocol[] =
		port !== null ? (explicitOpen ? protocols : []) : protocols.filter(p => (p === "https" ? ports.https : ports.http))
	if (!usable.length) {
		if (looksLikeReolink(ports, cast) || ports.rtsp || ports.onvif) return fail("http-disabled", sentence["http-disabled"](hostname), ports)
		if (!Object.values(ports).some(Boolean) && !cast && !explicitOpen) return fail("unreachable", sentence.unreachable(hostname), ports)
		return fail("not-reolink", sentence["not-reolink"](hostname), ports)
	}

	const client = createReolinkClient({
		host: hostPort,
		username: body.username?.trim() || "admin",
		password: () => body.password ?? "",
		protocol: usable.length === 1 ? usable[0]! : "auto",
		channel: 0,
		timeoutMs: opts.apiTimeoutMs ?? 8000
	})
	try {
		await client.login()
		const protocol = client.protocol() ?? undefined
		const reached = protocol === "https" ? { ...ports, https: true } : protocol === "http" ? { ...ports, http: true } : ports
		const info = await client.devInfo().catch(() => null)
		const what = info ? (info.name ? `“${info.name}” (${info.model})` : info.model) : "the camera"
		return {
			ok: true,
			problem: null,
			detail: `Signed in to ${what}.`,
			...(info ? { model: info.model, firmware: info.firmware, ...(info.name ? { name: info.name } : {}) } : {}),
			...(protocol ? { protocol } : {}),
			ports: reached
		}
	} catch (e) {
		if (e instanceof ReolinkError && e.cmd === "Login") {
			const problem = loginProblem(e)
			const detail = problem === "unknown" ? `The camera turned down the sign-in: ${e.message}` : sentence[problem](hostname)
			const retry = problem === "locked-out" ? lockoutSeconds(e.message) : null
			const left = problem === "bad-credentials" ? e.attemptsLeft : null
			return {
				...fail(problem, detail, ports, client.protocol() ?? undefined),
				...(retry ? { retryAfterSeconds: retry } : {}),
				...(left !== null ? { attemptsLeft: left } : {})
			}
		}
		if (e instanceof ReolinkNetworkError && /without JSON|unexpected answer/.test(e.message))
			return fail("not-reolink", sentence["not-reolink"](hostname), ports)
		return fail("unknown", `Couldn't finish talking to the camera: ${e instanceof Error ? e.message : String(e)}`, ports)
	} finally {
		await client.close()
	}
}
