// Screenshots every page of the UI at desktop and phone sizes, light and dark, for visual review.
//
//   node web/scripts/screenshots.ts [--base http://localhost:5173] [--out test/.tmp/ui/shots] [--only sightings,clip]
//
// Needs the UI (Vite dev or `look4 start`) at --base with an API behind it (scripts/mock-api.ts works).

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { chromium, type Page } from "playwright"

const { values: args } = parseArgs({
	options: {
		base: { type: "string", default: "http://localhost:5173" },
		out: { type: "string", default: "test/.tmp/ui/shots" },
		only: { type: "string" },
		prefix: { type: "string", default: "" }
	}
})

const base = args.base.replace(/\/$/, "")
mkdirSync(args.out, { recursive: true })

const firstSighting = async () => {
	const res = await fetch(`${base}/api/sightings?limit=1`)
	const page = (await res.json()) as { items: { id: string }[] }
	return page.items[0]?.id ?? null
}

const clipId = await firstSighting()
type Shot = { name: string; path: string; ready: string; full?: boolean; act?: (page: Page) => Promise<void> }
const pages: Shot[] = [
	{ name: "sightings", path: "/", ready: ".sighting:not(.is-skeleton), .empty" },
	...(clipId
		? [
				{ name: "clip", path: `/clips/${clipId}`, ready: ".detail" },
				{
					name: "clip-boxes",
					path: `/clips/${clipId}`,
					ready: ".detail",
					full: false,
					act: async (page: Page) => {
						const box = page.getByLabel(/Show what the detector found/)
						if (await box.count()) await box.check()
					}
				}
			]
		: []),
	{
		// the live compile preview; against a real server this is one real (cheap) judge-model call per shot
		name: "lookout-new",
		path: "/?new=1",
		ready: ".editor",
		full: false,
		act: async (page: Page) => {
			await page.locator(".editor textarea").fill("a hawk or any bird of prey")
			await page.waitForSelector(".preview .rubric", { timeout: 120_000 })
		}
	},
	{ name: "activity", path: "/activity", ready: ".funnel, .funnel-empty" },
	{ name: "settings", path: "/settings", ready: ".roi-stage" },
	{
		// a zone being drawn (not saved): drag across the feeder on the snapshot
		name: "settings-zone",
		path: "/settings",
		ready: ".roi-stage img",
		full: false,
		act: async (page: Page) => {
			const r = (await page.locator(".roi-stage").boundingBox())!
			await page.mouse.move(r.x + r.width * 0.08, r.y + r.height * 0.3)
			await page.mouse.down()
			await page.mouse.move(r.x + r.width * 0.72, r.y + r.height * 0.95, { steps: 6 })
			await page.mouse.up()
		}
	}
].filter(p => !args.only || args.only.split(",").includes(p.name))

const viewports = [
	{ name: "desktop", width: 1440, height: 900 },
	{ name: "phone", width: 390, height: 844 }
]

/** Waits until every <img> has loaded (or failed) and every <video> has a frame, so shots aren't half-blank. */
const imagesSettled = (page: Page) =>
	page
		.waitForFunction(
			// a video still fetching its first frame shows a spinner over the poster
			() => Array.from(document.images).every(i => i.complete) && Array.from(document.querySelectorAll("video")).every(v => v.readyState >= 2 || v.error),
			undefined,
			{ timeout: 10_000 }
		)
		.catch(() => {})

const browser = await chromium.launch()
const errors: string[] = []
for (const scheme of ["light", "dark"] as const) {
	for (const vp of viewports) {
		const ctx = await browser.newContext({
			viewport: { width: vp.width, height: vp.height },
			deviceScaleFactor: vp.name === "phone" ? 2 : 1,
			colorScheme: scheme,
			reducedMotion: "reduce"
		})
		const page = await ctx.newPage()
		page.on("console", m => {
			if (m.type() === "error") errors.push(`${vp.name}/${scheme}: ${m.text()}`)
		})
		page.on("pageerror", e => errors.push(`${vp.name}/${scheme}: ${e.message}`))
		for (const p of pages) {
			await page.goto(`${base}${p.path}`)
			await page.waitForSelector(p.ready, { timeout: 15_000 })
			await p.act?.(page)
			// Lazy images only load once scrolled near; walk the page so a full-page shot has them all.
			if (vp.name === "desktop") {
				await page.evaluate(async () => {
					for (let y = 0; y < document.body.scrollHeight; y += 600) {
						window.scrollTo(0, y)
						await new Promise(r => setTimeout(r, 60))
					}
					window.scrollTo(0, 0)
				})
			}
			await imagesSettled(page)
			// Chromium's video controls keep their loading spinner up for a beat after the first frame
			await page.waitForTimeout((await page.locator("video").count()) ? 2000 : 400)
			const file = join(args.out, `${args.prefix}${p.name}-${vp.name}-${scheme}.png`)
			// Phones get what a person actually sees (the fixed bottom nav lands mid-page in full-page shots).
			await page.screenshot({ path: file, fullPage: vp.name === "desktop" && p.full !== false })
			console.log(file)
		}
		await ctx.close()
	}
}
await browser.close()
if (errors.length) {
	console.error(`\n${errors.length} console error(s):\n${errors.join("\n")}`)
	process.exitCode = 1
}
