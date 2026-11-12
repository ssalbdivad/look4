// `look4 export` and `look4 import`: move settings, the life list and the clips worth keeping to
// another machine. `import --listen` waits for the other machine to push its export straight over
// the network, so nothing needs copying by hand.

import { randomBytes } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { networkInterfaces } from "node:os"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { loadConfig } from "../config.ts"
import { exportBundle, importBundle, type ImportResult, TransferError } from "../transfer.ts"
import { args, UsageError } from "./cli.ts"
import { bytes, c, cmd, err, out } from "./ui.ts"

const counter = () => {
	let n = 0
	const t = new Transform({
		transform(chunk: Buffer, _, done) {
			n += chunk.length
			done(null, chunk)
		}
	})
	return { t, bytes: () => n }
}

export const exportCmd = async (argv: string[]) => {
	const { positionals } = args(argv, {})
	const dest = positionals[0]
	if (!dest && process.stdout.isTTY) throw new UsageError(`${cmd("export <file.tgz | url>")}  (or pipe it somewhere)`)
	const bundle = exportBundle(loadConfig())
	const sent = counter()
	const body = bundle.stream.pipe(sent.t)
	try {
		if (dest && /^https?:\/\//.test(dest)) {
			err(`sending ${bundle.manifest.clips} clips to ${dest} …`)
			const res = await fetch(dest, { method: "PUT", body: Readable.toWeb(body) as ReadableStream, duplex: "half" } as RequestInit)
			const reply = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as Partial<ImportResult> & { error?: string }
			if (!res.ok || reply.error) throw new TransferError(`the other machine refused the import: ${reply.error ?? res.status}`)
			await bundle.done
			err(`${c.green("✓")} sent ${bytes(sent.bytes())}: ${reply.clips} clips and ${reply.lifeList} life-list birds imported`)
			return 0
		}
		await pipeline(body, dest ? createWriteStream(dest) : process.stdout)
		await bundle.done
		err(`${c.green("✓")} exported ${bundle.manifest.clips} clips, ${bytes(sent.bytes())}${dest ? ` to ${dest}` : ""}`)
		return 0
	} catch (e) {
		bundle.stream.destroy()
		await bundle.done.catch(() => {})
		throw e
	}
}

const report = (r: ImportResult) => {
	out(`${c.green("✓")} imported from ${r.manifest.from} (exported ${r.manifest.exportedAt})`)
	out(`  ${r.clips} clips with their photos, ${r.lifeList} life-list birds`)
	if (r.missing) out(c.dim(`  ${r.missing} clips' files were not in the export and are marked deleted`))
	if (r.configPath) out(`  settings written to ${r.configPath}`)
	if (r.envKeys) out(`  ${r.envKeys} secret${r.envKeys === 1 ? "" : "s"} added to .env`)
}

const lanAddresses = () => {
	const ips = Object.values(networkInterfaces())
		.flat()
		.filter(a => a && a.family === "IPv4" && !a.internal)
		.map(a => a!.address)
	return ips.length ? ips : ["127.0.0.1"]
}

export const importCmd = async (argv: string[]) => {
	const { values, positionals } = args(argv, {
		force: { type: "boolean" },
		listen: { type: "boolean" },
		port: { type: "string" }
	})
	const config = loadConfig()
	const force = values.force ?? false
	if (!values.listen) {
		const src = positionals[0]
		if (!src) throw new UsageError(cmd("import <file.tgz | -> [--force]   or   import --listen [--port 4041]"))
		report(await importBundle(config, src === "-" ? process.stdin : createReadStream(src), { force }))
		return 0
	}

	const port = Number(values.port ?? 4041)
	const token = randomBytes(12).toString("hex")
	return new Promise<number>((resolve, reject) => {
		let busy = false
		const server = createServer((req, res) => {
			const reply = (status: number, body: unknown) => {
				res.writeHead(status, { "content-type": "application/json" })
				res.end(JSON.stringify(body))
			}
			if (req.method !== "PUT" || req.url !== `/${token}`) return reply(404, { error: "not found" })
			if (busy) return reply(409, { error: "an import is already running" })
			busy = true
			err(`receiving from ${req.socket.remoteAddress} …`)
			importBundle(config, req, { force })
				.then(r => {
					reply(200, r)
					report(r)
					server.close(() => resolve(0))
				})
				.catch(e => {
					reply(400, { error: e instanceof Error ? e.message : String(e) })
					busy = false
					// a refusal (data already here, look4 running) will refuse again; anything else may be a dropped connection worth retrying
					if (e instanceof TransferError && /--force|stop it first/.test(e.message)) server.close(() => reject(e))
					else err(`${c.red("✗")} ${e instanceof Error ? e.message : e}; still listening`)
				})
		})
		server.on("error", reject)
		server.listen(port, "0.0.0.0", () => {
			const { port } = server.address() as AddressInfo
			out(`Waiting for an export. On the other machine, in its look4 folder, run:\n`)
			for (const ip of lanAddresses()) out(`  ${cmd(`export http://${ip}:${port}/${token}`)}`)
			out(c.dim(`\n(one line per network address of this machine; use the one the other machine can reach. Ctrl-C stops.)`))
		})
	})
}
