import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { quoteWindowsArg } from "../desktop/src/launch.ts"
import { appPath, classifyNavigation, startAddress } from "../desktop/src/navigation.ts"
import { locateServer, LOOK4_PORT, look4Answers, VITE_PORT } from "../desktop/src/server.ts"

const origin = "http://127.0.0.1:4040"

test("look4's own origin stays in the app; the web goes to the OS browser", () => {
	assert.equal(classifyNavigation(`${origin}/clips/abc`, origin), "app")
	assert.equal(classifyNavigation("https://console.anthropic.com/settings/keys", origin), "external")
	assert.equal(classifyNavigation("mailto:someone@example.com", origin), "external")
	// The same port under another name is another origin: the camera's own page, or a dev server.
	assert.equal(classifyNavigation("http://localhost:4040/", origin), "external")
})

test("links with any other scheme are dropped, not launched", () => {
	for (const url of ["file:///etc/passwd", "javascript:alert(1)", "vscode://file/tmp/x", "data:text/html,hi", "not a url"]) {
		assert.equal(classifyNavigation(url, origin), "blocked", url)
	}
})

test("before a server is found nothing is in-app, but external links still route", () => {
	assert.equal(classifyNavigation(`${origin}/`, undefined), "external")
	assert.equal(classifyNavigation("file:///tmp", undefined), "blocked")
})

test("only an in-app path is remembered, without its origin", () => {
	assert.equal(appPath(`${origin}/clips?status=kept#top`, origin), "/clips?status=kept#top")
	assert.equal(appPath("https://github.com/", origin), undefined)
	assert.equal(appPath("data:text/html,x", origin), undefined)
})

test("a remembered path reopens on this launch's server, never on another host", () => {
	assert.equal(startAddress("/live", "http://127.0.0.1:5173"), "http://127.0.0.1:5173/live")
	assert.equal(startAddress(undefined, origin), `${origin}/`)
	assert.equal(startAddress("//evil.example/steal", origin), `${origin}/`)
	assert.equal(startAddress("https://evil.example/", origin), `${origin}/`)
})

test("the running server wins over a dev server; nothing answering is undefined", async () => {
	const probed: string[] = []
	const found = await locateServer({
		answers: async o => {
			probed.push(o)
			return true
		}
	})
	assert.equal(found, `http://127.0.0.1:${LOOK4_PORT}`)
	assert.deepEqual(probed, [`http://127.0.0.1:${LOOK4_PORT}`])
	assert.equal(await locateServer({ answers: async o => o.endsWith(`:${VITE_PORT}`) }), `http://127.0.0.1:${VITE_PORT}`)
	assert.equal(await locateServer({ answers: async () => false }), undefined)
})

test("a port is look4 only if its health names look4", async () => {
	let body: unknown = { ok: true, app: "look4", version: "0.1.0" }
	const server = createServer((request, response) => {
		if (request.url !== "/api/health") return response.writeHead(404).end()
		response.setHeader("content-type", "application/json")
		response.end(JSON.stringify(body))
	})
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done))
	const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	try {
		assert.equal(await look4Answers(at), true)
		// Some other app's health endpoint on the same port
		body = { ok: true }
		assert.equal(await look4Answers(at), false)
		body = "<!doctype html>"
		assert.equal(await look4Answers(at), false)
	} finally {
		server.close()
	}
})

test("arguments survive Windows' command-line parsing into wsl.exe", () => {
	assert.equal(quoteWindowsArg("--no-open"), "--no-open")
	assert.equal(quoteWindowsArg(""), '""')
	assert.equal(quoteWindowsArg('exec "$0" "$@" >> log'), '"exec \\"$0\\" \\"$@\\" >> log"')
	// backslashes double only before a quote, the closing one included
	assert.equal(quoteWindowsArg("C:\\a b\\"), '"C:\\a b\\\\"')
	assert.equal(quoteWindowsArg('a\\"b'), '"a\\\\\\"b"')
})
