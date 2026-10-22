/// <reference lib="dom" />
// Builds every derived brand asset from the hand-written sources in brand/ (logo-mark.svg,
// logo-mark-mono.svg, favicon.svg) and the tokens in web/src/brand.css:
//   brand/logo.svg, brand/logo-{512,1024}.png, brand/social-card.png, brand/index.html,
//   web/public/{favicon.svg,logo-mark.svg,logo.svg,apple-touch-icon.png}, desktop/icon.ico
// and checks the contrast of every token text pair (exit 1 when one fails).
// Run: node brand/render.ts
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"

const brand = dirname(fileURLToPath(import.meta.url))
const repo = join(brand, "..")
const pub = join(repo, "web/public")
const read = (p: string) => readFileSync(p, "utf8")

const mark = read(join(brand, "logo-mark.svg"))
const mono = read(join(brand, "logo-mark-mono.svg"))
const favicon = read(join(brand, "favicon.svg"))

// --- tokens -------------------------------------------------------------------------------------

type Tokens = Record<string, string>
const parseTokens = (css: string) => {
	const grab = (block: string): Tokens =>
		Object.fromEntries([...block.matchAll(/--l4-([a-z0-9-]+):\s*([^;]+);/g)].map(m => [m[1]!, m[2]!.trim()]))
	const darkAt = css.indexOf("@media (prefers-color-scheme: dark)")
	const light = grab(css.slice(0, darkAt))
	return { light, dark: { ...light, ...grab(css.slice(darkAt)) } }
}
const tokens = parseTokens(read(join(repo, "web/src/brand.css")))

const luminance = (hex: string) => {
	const [r, g, b] = [1, 3, 5].map(i => {
		const c = parseInt(hex.slice(i, i + 2), 16) / 255
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
	}) as [number, number, number]
	return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string) => {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
	return (hi + 0.05) / (lo + 0.05)
}

// [foreground, background, minimum]. Body text needs 4.5:1 (WCAG AA). Status colours are used for
// short labels and icons, so 4.5 on surface but only 3:1 (AA large / UI) on the tinted surface-2.
const pairs: [string, string, number][] = [
	["ink", "bg", 4.5],
	["ink", "surface", 4.5],
	["ink", "surface-2", 4.5],
	["ink-soft", "bg", 4.5],
	["ink-soft", "surface", 4.5],
	["ink-soft", "surface-2", 4.5],
	["primary-ink", "primary", 4.5],
	["accent-ink", "accent", 4.5],
	["accent", "bg", 4.5],
	["accent", "surface", 4.5],
	["good", "surface", 4.5],
	["bad", "surface", 4.5],
	["warn", "surface", 4.5],
	["good", "surface-2", 3],
	["bad", "surface-2", 3],
	["warn", "surface-2", 3],
]
const checkContrast = () => {
	let failed = 0
	const rows: string[] = []
	for (const mode of ["light", "dark"] as const) {
		const t = tokens[mode]
		for (const [fg, bg, min] of pairs) {
			const ratio = contrast(t[fg]!, t[bg]!)
			if (ratio < min) failed++
			rows.push(`${mode.padEnd(5)} ${fg.padEnd(11)} on ${bg.padEnd(9)} ${ratio.toFixed(2).padStart(5)}:1 ${ratio < min ? `FAIL < ${min}` : "ok"}`)
		}
	}
	return { failed, rows }
}

// --- wordmark -----------------------------------------------------------------------------------

// "look4" as round-capped strokes traced over Fredoka SemiBold (600) at 200px, so the logo renders
// identically with no fonts installed. Fredoka is near-monoline with round terminals, which is
// exactly what a stroked path is; overlaid on the real glyphs the outlines match to a pixel or two.
// Units: Fredoka at font-size 200, baseline y=196; ink bbox x 38.5–508.5, y 50–196.
const STROKE = 29
const wordBox = { x: 38.5, y: 50, w: 470, h: 146 }
const wordmark = (look: string, four: string) =>
	`<g fill="none" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round">` +
	`<path stroke="${look}" d="M53 64.5V158Q53 181 73 181M331.5 64.5V181M382 110L346 147L388 181"/>` +
	`<circle stroke="${look}" cx="143" cy="145" r="36.5"/><circle stroke="${look}" cx="253" cy="145" r="36.5"/>` +
	`<path stroke="${four}" d="M494 69.5V181M443 69.5L426 140H494"/></g>`

const inner = (svg: string) =>
	svg
		.replace(/^[\s\S]*?<svg[^>]*>/, "")
		.replace(/<\/svg>\s*$/, "")
		.replace(/<title>[^<]*<\/title>/, "")
		.trim()

// Mark (512 units) at 200 high, then the wordmark at 0.78 scale, centred on the mark.
const LOGO_H = 200
const WORD_K = 0.78
const GAP = 32
const logoW = Math.round(LOGO_H + GAP + wordBox.w * WORD_K + 6)
const logoSvg = (opts: { dark?: boolean; mediaQuery?: boolean } = {}) => {
	const light = { look: "#1b3354", four: "#2f6fb6" }
	const dark = { look: "#eef1f6", four: "#f6b52e" }
	const c = opts.dark ? dark : light
	const tx = LOGO_H + GAP - wordBox.x * WORD_K
	const ty = LOGO_H / 2 - (wordBox.y + wordBox.h / 2) * WORD_K
	// With mediaQuery the file follows the page's colour scheme (as <img> or inline), matching
	// brand.css; renderers without media-query support (librsvg) get the light version.
	const style = opts.mediaQuery
		? `<style>@media (prefers-color-scheme: dark){.l4-look{stroke:${dark.look}}.l4-four{stroke:${dark.four}}}</style>`
		: ""
	const word = wordmark(c.look, c.four)
		.replace(`stroke="${c.look}" d=`, `class="l4-look" stroke="${c.look}" d=`)
		.replaceAll(`<circle stroke="${c.look}"`, `<circle class="l4-look" stroke="${c.look}"`)
		.replace(`stroke="${c.four}"`, `class="l4-four" stroke="${c.four}"`)
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${logoW}" height="${LOGO_H}" viewBox="0 0 ${logoW} ${LOGO_H}">
	<title>look4</title>${style}
	<svg width="${LOGO_H}" height="${LOGO_H}" viewBox="0 0 512 512">${inner(mark)}</svg>
	<g transform="translate(${+tx.toFixed(2)} ${+ty.toFixed(2)}) scale(${WORD_K})">${word}</g>
</svg>
`
}

// --- rasters ------------------------------------------------------------------------------------

// Render at 4x then downsample, so small sizes match a browser's area-averaged look.
const raster = (svg: string, w: number, h = w) =>
	sharp(Buffer.from(svg), { density: (72 * Math.max(w, h) * 4) / Math.max(svgSize(svg).w, svgSize(svg).h) })
		.resize(w, h, { kernel: "lanczos3", fit: "fill" })
		.png({ compressionLevel: 9 })
		.toBuffer()
const svgSize = (svg: string) => {
	const m = /<svg[^>]*?\swidth="(\d+)"\s+height="(\d+)"/.exec(svg)
	return { w: Number(m?.[1] ?? 512), h: Number(m?.[2] ?? 512) }
}

// iOS masks the icon to a rounded square and shows transparency as black: fill the square with the
// disc colour so the disc edge disappears, and inset the art so the corners never clip the bird.
const touchIcon = () => {
	const square = mark
		.replace(/<clipPath id="l4-disc"><circle[^>]*\/><\/clipPath>/, `<clipPath id="l4-disc"><rect width="512" height="512"/></clipPath>`)
		.replace(/<circle cx="256" cy="256" r="244" fill="([^"]+)"\/>/, `<rect width="512" height="512" fill="$1"/>`)
	return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
	<rect width="512" height="512" fill="#2f6fb6"/>
	<g transform="translate(256 270) scale(0.94) translate(-256 -256)">${inner(square)}</g>
</svg>`
}

// The desktop window's icon (desktop/): Windows asks the taskbar, title bar and Alt-Tab for their
// own sizes, so one ICO carries each, as embedded PNGs (Vista and later). Up to 32 px is the favicon,
// drawn for that size; above it the full mark.
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
const ico = async () => {
	const images = await Promise.all(ICO_SIZES.map(size => raster(size <= 32 ? favicon : mark, size)))
	const header = Buffer.alloc(6 + 16 * images.length)
	header.writeUInt16LE(1, 2)
	header.writeUInt16LE(images.length, 4)
	let offset = header.length
	images.forEach((png, i) => {
		const size = ICO_SIZES[i]!
		const entry = 6 + 16 * i
		// 0 means 256 in the one-byte width and height
		header.writeUInt8(size % 256, entry)
		header.writeUInt8(size % 256, entry + 1)
		header.writeUInt16LE(1, entry + 4)
		header.writeUInt16LE(32, entry + 6)
		header.writeUInt32LE(png.length, entry + 8)
		header.writeUInt32LE(offset, entry + 12)
		offset += png.length
	})
	return Buffer.concat([header, ...images])
}

// --- social card --------------------------------------------------------------------------------

const fontCss = (pkg: string) => {
	// Inline the variable latin woff2 so the card renders the real fonts from a data: page.
	const file = join(repo, `node_modules/@fontsource-variable/${pkg}/files/${pkg}-latin-wght-normal.woff2`)
	const family = pkg === "fredoka" ? "Fredoka Variable" : "Nunito Variable"
	return `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${readFileSync(file).toString("base64")}) format("woff2");font-weight:200 900}`
}

const socialHtml = () => `<!doctype html><html><head><meta charset="utf-8"><style>
${fontCss("fredoka")}${fontCss("nunito")}
html,body{margin:0;width:1200px;height:630px;overflow:hidden}
body{background:${tokens.light.bg};color:${tokens.light.ink};font-family:"Nunito Variable",sans-serif;display:grid;grid-template-columns:440px 1fr;align-items:center;position:relative}
.art{display:grid;place-items:center;height:630px}
.art svg{width:360px;height:360px;filter:drop-shadow(0 18px 30px rgb(27 42 64 / .18))}
.copy{padding-right:80px}
.logo{width:250px;display:block;margin:0 0 34px}
h1{font-family:"Fredoka Variable",sans-serif;font-weight:600;font-size:58px;line-height:1.05;margin:0 0 20px;letter-spacing:-.5px}
h1 em{font-style:normal;color:${tokens.light.accent}}
p{font-size:27px;line-height:1.4;margin:0;color:${tokens.light["ink-soft"]};font-weight:500}
.band{position:absolute;left:0;right:0;bottom:0;height:14px;background:linear-gradient(90deg,${tokens.light.sky} 0 70%,${tokens.light.eye} 70%)}
</style></head><body>
<div class="art">${mark.replace(/<svg[^>]*>/, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">`)}</div>
<div class="copy">
	<svg class="logo" xmlns="http://www.w3.org/2000/svg" viewBox="${wordBox.x - STROKE / 2} ${wordBox.y - 2} ${wordBox.w + STROKE} ${wordBox.h + 4}">${wordmark("#1b3354", "#2f6fb6")}</svg>
	<h1>Keep only the clips<br><em>worth watching.</em></h1>
	<p>Describe what you're looking for: a cardinal at the feeder, a hawk, a squirrel on the pole. look4 watches your camera and keeps the matches.</p>
</div>
<div class="band"></div>
</body></html>`

const screenshot = async (html: string, path: string, w: number, h: number) => {
	const { chromium } = await import("playwright")
	const browser = await chromium.launch()
	try {
		const page = await browser.newPage({ viewport: { width: w, height: h } })
		await page.setContent(html)
		await page.evaluate(() => document.fonts.ready)
		const ok = await page.evaluate(() => document.fonts.check('600 58px "Fredoka Variable"') && document.fonts.check('500 27px "Nunito Variable"'))
		if (!ok) throw new Error("social card fonts did not load")
		writeFileSync(path, await page.screenshot({ type: "png" }))
	} finally {
		await browser.close()
	}
}

// Kept in sync with the "Terminal banner" section of README.md.
const BANNER = [
	"    ,--^-.",
	"   / (@)  `--.",
	"  |      .--. )   look4",
	"   \\     /   v    keep the clips worth watching",
	"    `~~~'",
].join("\n")
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

// --- brand sheet --------------------------------------------------------------------------------

type Scores = [cute: number, birdLooking: number, eagleEye: number, small: number, distinct: number, mono: number]
const criteria = ["Cute", "Bird + looking", "Eagle-eye nod", "16–32 px", "Distinctive", "One colour"]
const concepts: { slug: string; name: string; scores: Scores; note: string }[] = [
	{
		slug: "1-eagle-eye",
		name: "Eagle Eye",
		scores: [6, 8, 10, 8, 6, 8],
		note: "The only literal answer to “eagle eye”, and the strongest at 16 px: white head, gold eye, yellow beak. Read a little stern, and the navy disc vanished on dark backgrounds.",
	},
	{
		slug: "2-binocular-bird",
		name: "Binocular Bird",
		scores: [9, 9, 3, 7, 8, 8],
		note: "The cutest of the five and the clearest “looking”, but nothing says eagle, and at 16 px the binoculars become two blue dots.",
	},
	{
		slug: "3-owl-lens",
		name: "Owl Lens",
		scores: [7, 8, 3, 4, 5, 6],
		note: "Charming at 256 px; the magnifier + owl pairing is a common “search” trope, and the ear-tuft 4 and handle turn to mush below 32 px.",
	},
	{
		slug: "4-viewfinder-finch",
		name: "Viewfinder Finch",
		scores: [5, 7, 2, 4, 5, 6],
		note: "Good idea (the shot you were waiting for), but a small bird inside a ring inside a disc leaves too little bird at small sizes.",
	},
	{
		slug: "5-search-robin",
		name: "Search Robin",
		scores: [5, 7, 1, 5, 7, 5],
		note: "Clever search-icon silhouette, but the brown body disappears on dark backgrounds and the mono version reads as an open mouth.",
	},
]
const total = (s: Scores) => s.reduce((a, b) => a + b, 0)

// Inline SVGs share one document, so every id gets a per-copy suffix.
let copy = 0
const inline = (svg: string, size: number | string, attrs = "") => {
	const sfx = `-c${copy++}`
	return svg
		.replace(/<title>[^<]*<\/title>/, "")
		.replace(/\bid="([^"]+)"/g, (_, id: string) => `id="${id}${sfx}"`)
		.replace(/url\(#([^)]+)\)/g, (_, id: string) => `url(#${id}${sfx})`)
		.replace(/<svg([^>]*?)\swidth="\d+"\s+height="\d+"/, `<svg$1 width="${size}" height="${size}" ${attrs}`)
		.trim()
}
const inlineLogo = (svg: string, height: number) => {
	const { w, h } = svgSize(svg)
	return inline(svg, 0).replace(/width="0" height="0"/, `width="${Math.round((w * height) / h)}" height="${height}"`)
}

// The mascot poses (brand/mascot/<pose>.svg, rendered from web/src/components/Mascot.tsx by
// brand/mascot/render.ts) and where each one belongs. Shown as <img>, so their CSS motion plays.
const mascotPoses: [pose: string, use: string][] = [
	["looking", "Watching: the first pull, scanning the network"],
	["found", "A find: wizard success, the first sighting"],
	["sleepy", "Nothing yet: empty states"],
	["puzzled", "Something's off: errors, setup problems"],
	["hello", "Welcome: the setup wizard's first step"],
	["thinking", "Working: “the judge is looking…”"],
]
const mascotPanel = (mode: "light" | "dark") => {
	const t = tokens[mode]
	return `<div class="panel mascots" style="background:${t.bg};color:${t.ink};--soft:${t["ink-soft"]}">${mascotPoses
		.map(
			([pose, use]) =>
				`<figure><img src="mascot/${pose}${mode === "dark" ? "-dark" : ""}.svg" width="160" height="160" alt="${pose}"><div class="tiny"><img src="mascot/${pose}${mode === "dark" ? "-dark" : ""}.svg" width="48" height="48" alt=""></div><figcaption><b>${pose}</b>${use}</figcaption></figure>`,
		)
		.join("")}</div>`
}

const tokenOrder = ["bg", "surface", "surface-2", "border", "ink", "ink-soft", "primary", "primary-ink", "accent", "accent-ink", "good", "bad", "warn", "eye", "sky"]

const sheet = (contrastRows: string[]) => {
	const panel = (mode: "light" | "dark") => {
		const t = tokens[mode]
		const sizes = [16, 24, 32, 48, 64, 96, 128, 256]
		return `<div class="panel" style="background:${t.bg};color:${t.ink};--soft:${t["ink-soft"]};--border:${t.border};--surface:${t.surface}">
	<div class="sizes">${sizes.map(s => `<figure>${inline(s <= 32 ? favicon : mark, s)}<figcaption>${s}${s <= 32 ? " · favicon" : ""}</figcaption></figure>`).join("")}</div>
	<div class="row">
		${inlineLogo(logoSvg({ dark: mode === "dark" }), 84)}
		<div class="monos">${[24, 48, 96].map(s => inline(mono, s, `style="color:${t.ink}"`)).join("")}</div>
	</div>
	<div class="row">
		<button style="background:${t.primary};color:${t["primary-ink"]}">Add lookout</button>
		<button style="background:${t.accent};color:${t["accent-ink"]}">Check camera now</button>
		<div class="card" style="background:${t.surface};border-color:${t.border}">
			<b>Cardinal at the feeder</b>
			<small style="color:${t["ink-soft"]}">92% · 2 min ago · <a style="color:${t.accent}" href="#">view clip</a></small>
			<span><i style="color:${t.good}">kept</i><i style="color:${t.warn}">unsure</i><i style="color:${t.bad}">rejected</i></span>
		</div>
	</div>
	<div class="swatches">${tokenOrder.map(k => `<div class="sw"><span style="background:${t[k]}"></span><b>--l4-${k}</b><code>${t[k]}</code></div>`).join("")}</div>
</div>`
	}
	const rows = concepts
		.map(
			(c, i) => `<tr${i === 0 ? ' class="win"' : ""}>
	<td>${inline(read(join(brand, "concepts", c.slug, "mark.svg")), 72)}</td>
	<td>${inline(read(join(brand, "concepts", c.slug, "mark.svg")), 16)} ${inline(read(join(brand, "concepts", c.slug, "mark.svg")), 32)}</td>
	<th>${i + 1}. ${c.name}${i === 0 ? " <mark>winner</mark>" : ""}<small>${c.note}</small></th>
	${c.scores.map(s => `<td class="n">${s}</td>`).join("")}<td class="n tot">${total(c.scores)}</td>
</tr>`,
		)
		.join("")
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>look4 — brand</title>
<link rel="icon" href="../web/public/favicon.svg">
<link rel="stylesheet" href="../node_modules/@fontsource-variable/fredoka/index.css">
<link rel="stylesheet" href="../node_modules/@fontsource-variable/nunito/index.css">
<style>
	body { margin: 0; padding: 40px; background: #e9e5dc; color: #1b2a40; font: 16px/1.5 "Nunito Variable", system-ui, sans-serif; }
	h1, h2, h3, button, .display { font-family: "Fredoka Variable", ui-rounded, system-ui, sans-serif; }
	h1 { font-weight: 600; font-size: 34px; margin: 0; }
	h2 { font-weight: 600; font-size: 24px; margin: 48px 0 12px; }
	p { max-width: 820px; }
	.hero { display: flex; align-items: center; gap: 28px; margin-bottom: 8px; }
	.panel { border-radius: 20px; padding: 28px; margin-bottom: 16px; }
	.sizes { display: flex; align-items: flex-end; gap: 26px; flex-wrap: wrap; }
	figure { margin: 0; display: grid; justify-items: center; gap: 6px; }
	figcaption { font-size: 12px; color: var(--soft); }
	.row { display: flex; align-items: center; gap: 28px; margin-top: 26px; flex-wrap: wrap; }
	.monos { display: flex; align-items: flex-end; gap: 16px; }
	button { border: 0; border-radius: 999px; padding: 10px 20px; font-size: 16px; font-weight: 600; }
	.card { border: 1px solid; border-radius: 14px; padding: 12px 16px; display: grid; gap: 2px; min-width: 260px; }
	.card b { font-family: "Fredoka Variable", sans-serif; font-weight: 600; }
	.card span { display: flex; gap: 12px; font-size: 13px; font-weight: 700; }
	.card i { font-style: normal; }
	.swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px 16px; margin-top: 26px; }
	.table-scroll { overflow-x: auto; border-radius: 16px; }
	img, svg { max-width: 100%; height: auto; }
	.sw { display: grid; grid-template-columns: 30px 1fr; gap: 0 10px; font-size: 13px; align-items: center; }
	.sw span { grid-row: span 2; width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--border); }
	.sw b { font-weight: 600; }
	.sw code { color: var(--soft); font-size: 12px; }
	.type { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
	.type > div { background: #fff; border-radius: 16px; padding: 20px 24px; }
	.type .big { font-size: 44px; line-height: 1.1; margin: 4px 0 8px; }
	table { border-collapse: separate; border-spacing: 0; background: #fff; border-radius: 16px; overflow: hidden; width: 100%; }
	th, td { padding: 10px 12px; border-bottom: 1px solid #eee7da; text-align: left; vertical-align: middle; }
	thead th { font-family: "Fredoka Variable", sans-serif; font-weight: 600; font-size: 13px; background: #f7f3ea; }
	tbody th { font-family: "Fredoka Variable", sans-serif; font-weight: 600; font-size: 17px; width: 40%; }
	tbody th small { display: block; font-family: "Nunito Variable", sans-serif; font-weight: 400; font-size: 13px; color: #5a6577; margin-top: 2px; }
	td.n { text-align: center; font-variant-numeric: tabular-nums; font-size: 17px; }
	td.tot { font-weight: 800; }
	tr.win { background: #fff8e6; }
	mark { background: #f6b52e; color: #1b2a40; border-radius: 999px; padding: 1px 8px; font-size: 12px; margin-left: 6px; vertical-align: 2px; }
	pre { background: #111823; color: #eef1f6; border-radius: 16px; padding: 20px 24px; font-size: 15px; line-height: 1.35; overflow-x: auto; }
	pre .eye { color: #f6b52e; } pre .four { color: #2f6fb6; }
	.mascots { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 24px 16px; }
	.mascots figure { gap: 4px; align-content: start; }
	.mascots .tiny { display: flex; align-items: flex-end; gap: 10px; }
	.mascots figcaption { text-align: center; max-width: 180px; }
	@media (max-width: 600px) { body { padding: 20px 14px; } .type { grid-template-columns: minmax(0, 1fr); } .type .big { font-size: 32px; } .card { min-width: 0; } .hero svg { width: 100%; } }
	.mascots figcaption b { display: block; font-family: "Fredoka Variable", sans-serif; font-weight: 600; font-size: 16px; color: inherit; }
</style>
</head>
<body>
<div class="hero">${inlineLogo(logoSvg(), 120)}</div>
<p>The final mark is a chubby bald eagle whose one huge gold eye, glint and all, is also a camera lens: it is the eagle eye that watches the feeder for you. Sources: <code>brand/logo-mark.svg</code>, <code>logo-mark-mono.svg</code>, <code>favicon.svg</code>; everything else is generated by <code>node brand/render.ts</code>.</p>

<h2>Light and dark</h2>
${panel("light")}
${panel("dark")}

<h2>Mascot</h2>
<p>The eagle from the mark, with a body so it can act. The head is the mark's own geometry; a navy sticker outline keeps the white head visible on white cards, and on dark backgrounds the outline turns pale (<code>--l4m-line</code>; <code>mascot/&lt;pose&gt;-dark.svg</code>). Below 48 px use the logo mark or an icon instead of a pose. In the app: <code>&lt;Mascot pose="looking" size={120} /&gt;</code> from <code>web/src/components/Mascot.tsx</code>. Every pose blinks every few seconds and has its own motion, and all of it stops under <code>prefers-reduced-motion</code>. Rebuild these files with <code>node brand/mascot/render.ts</code>.</p>
${mascotPanel("light")}
${mascotPanel("dark")}

<h2>Type</h2>
<div class="type">
	<div><small>Display + wordmark · Fredoka SemiBold 600</small><div class="big display" style="font-weight:600">Cardinal at the feeder</div><small>The wordmark in the logo is drawn as strokes traced over Fredoka, so it needs no font.</small></div>
	<div><small>Body · Nunito 400 / 700</small><div class="big" style="font-weight:700">Keep the clips worth watching</div><small>Nunito's rounded terminals match Fredoka at text sizes, where Fredoka gets too soft to read.</small></div>
</div>

<h2>Terminal banner</h2>
<p>For the CLI startup banner (also in README.md). Colour the eye gold and the 4 sky blue only when stdout is a colour TTY.</p>
<pre>${esc(BANNER).replace("(@)", '<span class="eye">(@)</span>').replace("look4", '<b>look<span class="four">4</span></b>')}</pre>

<h2>Contrast (WCAG, from web/src/brand.css)</h2>
<pre>${contrastRows.join("\n")}</pre>

<h2>The five concepts, scored</h2>
<p><b>Why Eagle Eye won:</b> it was the only concept that answers “eagle eye” literally, and the most legible at 16 px. Binocular Bird was cuter, so the final grafts its charm onto the eagle: a feather tuft, a rounder eye with a lens glint, a blush, a softer brow. A sky-blue disc replaces the navy one that disappeared on dark backgrounds, and the favicon drops the details that blur below 32 px.</p>
<div class="table-scroll"><table>
	<thead><tr><th>Mark</th><th>16 · 32 px</th><th>Concept</th>${criteria.map(c => `<th>${c}</th>`).join("")}<th>Total /60</th></tr></thead>
	<tbody>${rows}</tbody>
</table></div>
<p>Each concept's full sheet (palettes, mono, wordmark) is in <a href="concepts/index.html">concepts/index.html</a>.</p>
</body>
</html>
`
}

// --- main ---------------------------------------------------------------------------------------

const { failed, rows } = checkContrast()
console.log(rows.join("\n"))
console.log(`\n${BANNER}\n`)

const logo = logoSvg({ mediaQuery: true })
writeFileSync(join(brand, "logo.svg"), logo)
writeFileSync(join(pub, "logo.svg"), logo)
writeFileSync(join(pub, "logo-mark.svg"), mark)
writeFileSync(join(pub, "favicon.svg"), favicon)
writeFileSync(join(brand, "logo-512.png"), await raster(mark, 512))
writeFileSync(join(brand, "logo-1024.png"), await raster(mark, 1024))
// Opaque: flatten onto the disc colour so no alpha channel survives.
writeFileSync(join(pub, "apple-touch-icon.png"), await sharp(await raster(touchIcon(), 180)).flatten({ background: "#2f6fb6" }).removeAlpha().png().toBuffer())
writeFileSync(join(repo, "desktop/icon.ico"), await ico())
writeFileSync(join(brand, "index.html"), sheet(rows))
if (!process.argv.includes("--no-browser")) await screenshot(socialHtml(), join(brand, "social-card.png"), 1200, 630)

console.log(`wrote logo.svg, logo-512.png, logo-1024.png, index.html${process.argv.includes("--no-browser") ? "" : ", social-card.png"}, desktop/icon.ico and web/public assets`)
if (failed) {
	console.error(`${failed} contrast pair(s) below minimum`)
	process.exit(1)
}
