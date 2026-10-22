// `pnpm dev`: the real backend (sources, worker, API) plus Vite with hot reload
// for the UI, which proxies /api and /media to the backend.
//
//   pnpm dev [--no-sources] [--port <backend port>]
//
// The `dev` package script passes --disable-warning=ExperimentalWarning for node:sqlite.

import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { createServer } from "vite"
import { startApp } from "../src/app.ts"
import { loadConfig } from "../src/config.ts"

const repo = resolve(import.meta.dirname, "..")

const { values } = parseArgs({
	options: { "no-sources": { type: "boolean", default: false }, port: { type: "string" } },
	strict: true
})

const loaded = loadConfig()
const config = values.port ? { ...loaded, server: { ...loaded.server, port: Number(values.port) } } : loaded

const backend = await startApp(config, { server: true, sources: !values["no-sources"] })
// the server reports "localhost" for a wildcard bind; Node may resolve that to ::1, which 0.0.0.0 does not cover
const target = backend.url!.replace("//localhost:", "//127.0.0.1:")
process.env.LOOK4_API = target

// changeOrigin stays false so the browser's Origin and the forwarded Host agree (the backend's CSRF check)
const proxy = { target, changeOrigin: false }
const vite = await createServer({
	configFile: resolve(repo, "vite.config.ts"),
	root: resolve(repo, "web"),
	server: { proxy: { "/api": proxy, "/media": proxy } }
})
await vite.listen()
console.log(`\n  look4 backend  ${backend.url}`)
vite.printUrls()

// startApp already stops the backend and exits on SIGINT/SIGTERM; close Vite alongside it
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void vite.close())
