// Finds cameras on the local network for the setup wizard: neighbour tables
// (Linux, and Windows' own via arp.exe when running under WSL, whose NAT hides
// the real LAN from Linux) plus a short TCP probe of every address in each
// local /24. Port probes only: nothing here ever logs in to anything.

import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { Socket } from "node:net"
import { networkInterfaces } from "node:os"
import type { DevicePorts, DiscoveredCamera, DiscoverResponse } from "../api-types.ts"
import type { SourceConfig } from "../config.ts"

/**
 * MAC prefixes registered to Reolink Innovation Limited. The IEEE registry (and
 * Home Assistant's Reolink DHCP matcher) list only this one; Wi-Fi models on
 * third-party radio modules are caught by their open app port instead.
 */
export const REOLINK_OUIS = new Set(["EC:71:DB"])

export const CAMERA_PORTS = { https: 443, http: 80, rtsp: 554, reolinkApp: 9000, onvif: 8000 } as const satisfies Record<keyof DevicePorts, number>

/**
 * Google Cast devices (Chromecast, Nest speakers) also listen on 9000, so an
 * open 9000 only means "Reolink" when Cast's own port 8009 is closed. Measured
 * on David's LAN: two Cast devices answered on 9000, 8008, 8009 and 8443.
 */
export const CAST_PORT = 8009

/** Whether open ports alone say "a Reolink camera": its app port, and not a Cast device. */
export const looksLikeReolink = (ports: DevicePorts, cast: boolean) => ports.reolinkApp && !cast

export type Neighbor = { ip: string; mac: string }
export type Iface = { address: string; mask: string }

const IPV4 = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/
const MAC = /\b([0-9a-f]{2}(?:[:-][0-9a-f]{2}){5})\b/i

export const normalizeMac = (mac: string) => mac.replace(/-/g, ":").toUpperCase()

const isUnicastMac = (mac: string) => {
	const m = normalizeMac(mac)
	// the multicast bit, broadcast and the all-zero "incomplete" entry
	return m !== "00:00:00:00:00:00" && m !== "FF:FF:FF:FF:FF:FF" && (parseInt(m.slice(0, 2), 16) & 1) === 0
}

const ipToInt = (ip: string) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0)
const intToIp = (n: number) => [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join(".")
const validIp = (ip: string) => ip.split(".").every(o => Number(o) <= 255)

/** `/proc/net/arp`: `IP HWtype Flags HWaddress Mask Device`; flags 0x0 is an incomplete entry. */
export const parseProcNetArp = (text: string): Neighbor[] =>
	text
		.split("\n")
		.slice(1)
		.map(l => l.trim().split(/\s+/))
		.filter(f => f.length >= 4 && f[2] !== "0x0" && IPV4.test(f[0]!) && isUnicastMac(f[3]!))
		.map(f => ({ ip: f[0]!, mac: normalizeMac(f[3]!) }))

/** `ip -4 neigh`: `192.168.1.31 dev eth0 lladdr ec:71:db:… REACHABLE`. */
export const parseIpNeigh = (text: string): Neighbor[] =>
	text.split("\n").flatMap(l => {
		const m = /^(\d{1,3}(?:\.\d{1,3}){3})\s.*\blladdr\s+(\S+)/.exec(l.trim())
		if (!m || /\b(FAILED|INCOMPLETE)\b/.test(l) || !isUnicastMac(m[2]!)) return []
		return [{ ip: m[1]!, mac: normalizeMac(m[2]!) }]
	})

/**
 * Windows `arp.exe -a`: an `Interface: <ip>` header per adapter, then
 * `<ip>  <aa-bb-…>  dynamic|static`. Static rows are broadcast and multicast.
 */
export const parseArpExe = (text: string): Neighbor[] =>
	text.split(/\r?\n/).flatMap(l => {
		const ip = IPV4.exec(l)?.[1]
		const mac = MAC.exec(l)?.[1]
		if (!ip || !mac || /interface/i.test(l) || !/\bdynamic\b/i.test(l) || !isUnicastMac(mac)) return []
		return [{ ip, mac: normalizeMac(mac) }]
	})

/**
 * Windows `ipconfig.exe`: each `IPv4 Address. . . : 192.168.1.6(Preferred)` and
 * the `Subnet Mask` that follows it. Matched loosely (an "IPv4" label, then the
 * next 255.x line) so localized Windows ("IPv4-Adresse", "Subnetzmaske") works.
 */
export const parseIpconfig = (text: string): Iface[] => {
	const out: Iface[] = []
	let pending: string | null = null
	for (const l of text.split(/\r?\n/)) {
		const ip = IPV4.exec(l.slice(l.indexOf(":") + 1))?.[1]
		if (/ipv4/i.test(l) && ip) pending = ip
		else if (pending && ip?.startsWith("255.")) {
			out.push({ address: pending, mask: ip })
			pending = null
		}
	}
	return out
}

const prefixLength = (mask: string) => ipToInt(mask).toString(2).replace(/0+$/, "").length

/** Hyper-V's WSL bridge lives in 172.16.0.0/12; scanning it finds only Windows itself. */
const isWslBridge = (ip: string) => {
	const n = ipToInt(ip)
	return n >= ipToInt("172.16.0.0") && n <= ipToInt("172.31.255.255")
}

/**
 * The /24 around each interface address worth scanning, as `a.b.c.0/24`. Wider
 * networks still get only their own /24 (a /16 is 65k hosts); loopback,
 * link-local and the WSL bridge are skipped unless nothing else is left.
 */
export const scanSubnets = (ifaces: Iface[]): string[] => {
	const usable = ifaces.filter(
		i => validIp(i.address) && !i.address.startsWith("127.") && !i.address.startsWith("169.254.") && prefixLength(i.mask) >= 8
	)
	const lan = usable.filter(i => !isWslBridge(i.address))
	const chosen = lan.length ? lan : usable
	return [...new Set(chosen.map(i => `${i.address.split(".").slice(0, 3).join(".")}.0/24`))]
}

/** Resolves true when a TCP connection opens within `timeoutMs`. Never sends a byte. */
export const probePort = (host: string, port: number, timeoutMs: number) =>
	new Promise<boolean>(resolve => {
		const s = new Socket()
		const done = (open: boolean) => {
			s.destroy()
			resolve(open)
		}
		s.setTimeout(timeoutMs, () => done(false))
		s.once("connect", () => done(true))
		s.once("error", () => done(false))
		s.connect(port, host)
	})

export type PortMap = Record<keyof DevicePorts | "cast", number>

export const DEFAULT_PORTS: PortMap = { ...CAMERA_PORTS, cast: CAST_PORT }

/** The camera ports, plus whether the host is a Cast device (see CAST_PORT). `portMap` moves them, for tests. */
export const probePorts = async (host: string, timeoutMs: number, portMap: PortMap = DEFAULT_PORTS): Promise<{ ports: DevicePorts; cast: boolean }> => {
	const keys = Object.keys(CAMERA_PORTS) as Array<keyof DevicePorts>
	const [cast, ...open] = await Promise.all([probePort(host, portMap.cast, timeoutMs), ...keys.map(k => probePort(host, portMap[k], timeoutMs))])
	return { ports: Object.fromEntries(keys.map((k, i) => [k, open[i]])) as DevicePorts, cast: cast! }
}

/** Runs `tasks` with at most `limit` in flight. */
const pool = async <t>(tasks: Array<() => Promise<t>>, limit: number): Promise<t[]> => {
	const out: t[] = new Array(tasks.length)
	let next = 0
	const worker = async () => {
		while (next < tasks.length) {
			const i = next++
			out[i] = await tasks[i]!()
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
	return out
}

const run = (bin: string, args: string[]) =>
	new Promise<string>(resolve =>
		execFile(bin, args, { timeout: 4000, windowsHide: true, maxBuffer: 1 << 20 }, (e, stdout) => resolve(e && !stdout ? "" : String(stdout)))
	)

export const isWsl = () => {
	try {
		return /microsoft/i.test(readFileSync("/proc/version", "utf8"))
	} catch {
		return false
	}
}

/** The bare host in an address (`https://192.168.1.31:443/x` → `192.168.1.31`), lowercased. */
export const hostOf = (raw: string): string | null => {
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `http://${raw.trim()}`
	try {
		return new URL(withScheme).hostname.replace(/^\[|\]$/g, "").toLowerCase() || null
	} catch {
		return null
	}
}

/** The host a camera source points at, for "already set up as". */
export const sourceHost = (s: SourceConfig, env: NodeJS.ProcessEnv = process.env): string | null => {
	const raw = s.type === "reolink" ? s.host : s.type === "rtsp" ? (s.url ?? (s.urlEnv ? env[s.urlEnv] : undefined)) : undefined
	return raw ? hostOf(raw) : null
}

export type DiscoverOptions = {
	sources?: SourceConfig[]
	/** Per-connect timeout for addresses not in any neighbour table. */
	timeoutMs?: number
	concurrency?: number
}

/**
 * Probes every address in each local /24 on the camera ports. Hosts seen in a
 * neighbour table get a longer timeout, since they are known to exist. Returns
 * cameras (Reolink by MAC prefix or app port, or anything serving RTSP),
 * Reolink first, then by address.
 */
export const discover = async (opts: DiscoverOptions = {}): Promise<DiscoverResponse> => {
	const wsl = isWsl()
	const notes: string[] = []
	const linuxIfaces: Iface[] = Object.values(networkInterfaces())
		.flat()
		.flatMap(i => (i && i.family === "IPv4" && !i.internal ? [{ address: i.address, mask: i.netmask }] : []))
	const [procArp, ipNeigh, arpExe, ipconfig] = await Promise.all([
		Promise.resolve().then(() => {
			try {
				return readFileSync("/proc/net/arp", "utf8")
			} catch {
				return ""
			}
		}),
		run("ip", ["-4", "neigh"]),
		wsl ? run("arp.exe", ["-a"]) : Promise.resolve(""),
		wsl ? run("ipconfig.exe", []) : Promise.resolve("")
	])
	if (wsl && !ipconfig) notes.push("couldn't read Windows' network settings, so only this Linux side of the network was scanned")
	const ifaces = [...linuxIfaces, ...parseIpconfig(ipconfig)]
	const neighbors = [...parseProcNetArp(procArp), ...parseIpNeigh(ipNeigh), ...parseArpExe(arpExe)]
	const macOf = new Map<string, string>()
	for (const n of neighbors) if (!macOf.has(n.ip)) macOf.set(n.ip, n.mac)

	const subnets = scanSubnets(ifaces)
	const own = new Set(ifaces.map(i => i.address))
	const hosts = new Set<string>()
	for (const s of subnets) {
		const base = ipToInt(s.replace("/24", ""))
		for (let i = 1; i < 255; i++) hosts.add(intToIp(base + i))
	}
	// a camera the neighbour table knows about outside the scanned /24s (a second LAN) still counts
	for (const ip of macOf.keys()) hosts.add(ip)
	for (const ip of own) hosts.delete(ip)

	const timeout = opts.timeoutMs ?? 700
	const probes = [...(Object.entries(CAMERA_PORTS) as Array<[keyof DevicePorts, number]>), ["cast", CAST_PORT] as const]
	const tasks = [...hosts].flatMap(host =>
		probes.map(([k, port]) => () => probePort(host, port, macOf.has(host) ? timeout * 2 : timeout).then(open => ({ host, k, open })))
	)
	const results = await pool(tasks, opts.concurrency ?? 512)
	const ports = new Map<string, DevicePorts>()
	const cast = new Set<string>()
	for (const r of results) {
		const p = ports.get(r.host) ?? { https: false, http: false, rtsp: false, reolinkApp: false, onvif: false }
		if (r.k === "cast") {
			if (r.open) cast.add(r.host)
		} else p[r.k] ||= r.open
		ports.set(r.host, p)
	}

	const configured = new Map<string, string>()
	for (const s of opts.sources ?? []) {
		const h = sourceHost(s)
		if (h && !configured.has(h)) configured.set(h, s.name)
	}
	const cameras: DiscoveredCamera[] = []
	for (const [host, p] of ports) {
		const mac = macOf.get(host) ?? null
		const reolink = (mac !== null && REOLINK_OUIS.has(mac.slice(0, 8))) || looksLikeReolink(p, cast.has(host))
		if (!reolink && !p.rtsp) continue
		cameras.push({ host, mac, vendor: reolink ? "reolink" : "unknown", ports: p, configuredAs: configured.get(host) ?? null })
	}
	cameras.sort((a, b) => Number(b.vendor === "reolink") - Number(a.vendor === "reolink") || ipToInt(a.host) - ipToInt(b.host))
	if (!subnets.length) notes.push("couldn't work out this computer's network, so no addresses were scanned. Type the camera's address instead")
	return { cameras, scannedSubnets: subnets, note: notes.length ? `${notes.join("; ")}.`.replace(/^./, c => c.toUpperCase()) : null }
}
