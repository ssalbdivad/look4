// Renders every concept mark to PNG (512/64/32/16), a contact sheet per concept, compare.png, and
// index.html. Run from anywhere: node brand/concepts/render.ts [concept-dir-prefix]
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"

type Swatches = Record<(typeof swatchKeys)[number], string>
type Palette = { light: Swatches; dark: Swatches }
type Concept = { dir: string; slug: string; name: string; pitch: string; mark: string; mono: string; palette: Palette }

const swatchKeys = ["bg", "surface", "surface-2", "border", "ink", "ink-soft", "primary", "primary-ink", "accent", "accent-ink", "good", "bad", "warn", "eye"] as const

const root = dirname(fileURLToPath(import.meta.url))
const sizes = [512, 64, 32, 16] as const

// Pitches live here rather than in palette.json so palette.json stays exactly the token set.
const pitches: Record<string, { name: string; pitch: string }> = {
	"1-eagle-eye": { name: "Eagle Eye", pitch: "A chubby bald-eagle head whose one huge golden eye, glint and all, doubles as a camera lens." },
	"2-binocular-bird": { name: "Binocular Bird", pitch: "A round little bluebird peering through binoculars: the two lenses are the \"oo\" in look." },
	"3-owl-lens": { name: "Owl Lens", pitch: "A wide-eyed owl wearing a magnifying-glass monocle; its right ear tuft is a little 4." },
	"4-viewfinder-finch": { name: "Viewfinder Finch", pitch: "A goldfinch perched dead-center in a camera viewfinder: the shot you were waiting for." },
	"5-search-robin": { name: "Search Robin", pitch: "The search icon, as a robin: a round bird is the lens and its tail is the handle." },
}

const read = (p: string) => readFileSync(p, "utf8")

const loadConcepts = (only?: string): Concept[] =>
	readdirSync(root, { withFileTypes: true })
		.filter(d => d.isDirectory() && /^\d+-/.test(d.name) && (!only || d.name.startsWith(only)))
		.map(d => d.name)
		.sort()
		.map(slug => {
			const dir = join(root, slug)
			const meta = pitches[slug] ?? { name: slug, pitch: "" }
			return {
				dir,
				slug,
				...meta,
				mark: read(join(dir, "mark.svg")),
				mono: existsSync(join(dir, "mark-mono.svg")) ? read(join(dir, "mark-mono.svg")) : read(join(dir, "mark.svg")),
				palette: JSON.parse(read(join(dir, "palette.json"))) as Palette,
			}
		})

// Rasterize at 4x the target then downsample, so small sizes match a browser's area-averaged look
// instead of a single-sample render.
const raster = (svg: string, size: number) =>
	sharp(Buffer.from(svg), { density: Math.max(72, (72 * size * 4) / 512) })
		.resize(size, size, { kernel: "lanczos3" })
		.png()
		.toBuffer()

const tile = (w: number, h: number, color: string) =>
	sharp({ create: { width: w, height: h, channels: 4, background: color } }).png()

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const label = (text: string, w: number, h: number, color: string, size = 22) =>
	Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><text x="0" y="${size}" font-family="DejaVu Sans" font-weight="bold" font-size="${size}" fill="${color}">${esc(text)}</text></svg>`,
	)

type Layer = { input: Buffer; left: number; top: number }

const swatchStrip = (p: Swatches, w: number) => {
	const cell = w / swatchKeys.length
	const rects = swatchKeys
		.map((k, i) => `<rect x="${i * cell}" y="0" width="${cell}" height="40" fill="${p[k]}"/>`)
		.join("")
	return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="40">${rects}</svg>`)
}

// One sheet per concept: sizes on its own light and dark bg, mono, a nearest-neighbour blowup of
// the 16px render (to judge what actually survives), and the palette.
const contactSheet = async (c: Concept) => {
	const W = 1240
	const rowH = 300
	const H = 60 + rowH * 2
	const layers: Layer[] = [{ input: label(`${c.name} — ${c.pitch}`, W - 40, 40, "#222", 20), left: 20, top: 14 }]
	for (const [i, mode] of (["light", "dark"] as const).entries()) {
		const p = c.palette[mode]
		const top = 60 + i * rowH
		layers.push({ input: await tile(W, rowH, p.bg).toBuffer(), left: 0, top })
		layers.push({ input: await raster(c.mark, 256), left: 20, top: top + 22 })
		let x = 300
		for (const n of [64, 32, 16]) {
			layers.push({ input: await raster(c.mark, n), left: x, top: top + 150 - n / 2 })
			x += n + 30
		}
		const s16 = await raster(c.mark, 16)
		const blown = await sharp(s16).resize(128, 128, { kernel: "nearest" }).png().toBuffer()
		layers.push({ input: blown, left: x + 10, top: top + 86 })
		x += 170
		const mono = c.mono.replace(/currentColor/g, p.ink)
		layers.push({ input: await raster(mono, 128), left: x, top: top + 86 })
		x += 160
		for (const n of [32, 16]) {
			layers.push({ input: await raster(mono, n), left: x, top: top + 150 - n / 2 })
			x += n + 24
		}
		layers.push({ input: swatchStrip(p, 340), left: W - 360, top: top + rowH - 60 })
	}
	const out = await tile(W, H, "#ffffff").composite(layers).png().toBuffer()
	writeFileSync(join(c.dir, "contact.png"), out)
}

const renderConcept = async (c: Concept) => {
	const out = join(c.dir, "png")
	mkdirSync(out, { recursive: true })
	for (const n of sizes) {
		writeFileSync(join(out, `mark-${n}.png`), await raster(c.mark, n))
		writeFileSync(join(out, `mark-mono-${n}.png`), await raster(c.mono, n))
	}
	await contactSheet(c)
}

// All marks at 256 and 32 on a light and a dark bg, one row per concept.
const compare = async (cs: Concept[]) => {
	const light = "#f6f3ec"
	const dark = "#1a1a1e"
	const rowH = 300
	const W = 2 * (256 + 40 + 32 + 40 + 16 + 40) + 40
	const H = rowH * cs.length
	const layers: Layer[] = []
	for (const [i, c] of cs.entries()) {
		const top = i * rowH
		for (const [j, bg] of [light, dark].entries()) {
			const left = j * (W / 2)
			layers.push({ input: await tile(W / 2, rowH, bg).toBuffer(), left, top })
			layers.push({ input: await raster(c.mark, 256), left: left + 20, top: top + 30 })
			layers.push({ input: await raster(c.mark, 32), left: left + 316, top: top + 142 })
			layers.push({ input: await raster(c.mark, 16), left: left + 388, top: top + 150 })
			layers.push({ input: label(`${i + 1}`, 40, 30, j ? "#888" : "#999", 18), left: left + 6, top: top + 4 })
		}
	}
	writeFileSync(join(root, "compare.png"), await tile(W, H, light).composite(layers).png().toBuffer())
}

// Inline SVGs share one document, so every id (masks, clipPaths) gets a per-instance suffix.
let instance = 0
const inline = (svg: string, size: number, extra = "") => {
	const sfx = `-i${instance++}`
	return svg
		.replace(/<\?xml[^>]*>/, "")
		.replace(/\bid="([^"]+)"/g, (_, id) => `id="${id}${sfx}"`)
		.replace(/url\(#([^)]+)\)/g, (_, id) => `url(#${id}${sfx})`)
		.replace(/href="#([^"]+)"/g, (_, id) => `href="#${id}${sfx}"`)
		.replace(/<svg([^>]*?)\swidth="\d+"\sheight="\d+"/, `<svg$1 width="${size}" height="${size}" ${extra}`)
		.trim()
}

const htmlSizes = [16, 24, 32, 48, 64, 128, 256]

const luminance = (hex: string) => {
	const [r, g, b] = [1, 3, 5].map(i => {
		const c = parseInt(hex.slice(i, i + 2), 16) / 255
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
	}) as [number, number, number]
	return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string) => {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
	return (hi + 0.05) / (lo + 0.05)
}
// The "4" in the wordmark should stand apart from "look": primary, unless primary is basically ink.
const fourColor = (p: Swatches) => (contrast(p.primary, p.ink) < 1.6 ? p.accent : p.primary)

const html = (cs: Concept[]) => {
	const section = (c: Concept, n: number) => {
		const tiles = (["light", "dark"] as const)
			.map(mode => {
				const p = c.palette[mode]
				const marks = htmlSizes.map(s => inline(c.mark, s)).join("")
				const monos = [16, 32, 64].map(s => inline(c.mono, s, `style="color:${p.ink}"`)).join("")
				const sw = swatchKeys
					.map(
						k =>
							`<div class="sw"><span style="background:${p[k]}"></span><b>${k}</b><code>${p[k]}</code></div>`,
					)
					.join("")
				return `<div class="tile" style="background:${p.bg};color:${p.ink};--border:${p.border};--soft:${p["ink-soft"]}">
	<div class="marks">${marks}</div>
	<div class="row">
		<div class="word">${inline(c.mark, 56)}<span>look<em style="color:${fourColor(p)}">4</em></span></div>
		<div class="monos">${monos}</div>
		<div class="chip" style="background:${p.primary};color:${p["primary-ink"]}">Primary</div>
		<div class="chip" style="background:${p.accent};color:${p["accent-ink"]}">Accent</div>
		<div class="card" style="background:${p.surface};border-color:${p.border}"><b>Cardinal at the feeder</b><small style="color:${p["ink-soft"]}">92% · 2 min ago</small><i style="background:${p.good}"></i><i style="background:${p.warn}"></i><i style="background:${p.bad}"></i></div>
	</div>
	<div class="swatches">${sw}</div>
</div>`
			})
			.join("")
		return `<section><h2><span>${n}</span> ${esc(c.name)} <small>brand/concepts/${c.slug}/</small></h2><p>${esc(c.pitch)}</p>${tiles}</section>`
	}
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>look4 — logo concepts</title>
<link rel="stylesheet" href="../../node_modules/@fontsource-variable/fredoka/index.css">
<style>
	body { margin: 0; padding: 32px; font-family: "Fredoka Variable", ui-rounded, system-ui, sans-serif; background: #ece8e1; color: #222; }
	h1 { font-weight: 600; margin: 0 0 4px; }
	h2 { font-weight: 600; margin: 40px 0 4px; display: flex; align-items: baseline; gap: 10px; }
	h2 span { display: inline-grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; background: #222; color: #fff; font-size: 18px; }
	h2 small { font-weight: 400; font-size: 14px; color: #777; font-family: ui-monospace, monospace; }
	section > p { margin: 0 0 14px; font-size: 18px; color: #444; }
	.tile { border-radius: 18px; padding: 24px; margin-bottom: 12px; }
	.marks { display: flex; align-items: flex-end; gap: 22px; flex-wrap: wrap; }
	.row { display: flex; align-items: center; gap: 22px; margin-top: 20px; flex-wrap: wrap; }
	.word { display: flex; align-items: center; gap: 10px; font-size: 48px; font-weight: 600; letter-spacing: -0.5px; }
	.word em { font-style: normal; }
	.monos { display: flex; align-items: flex-end; gap: 12px; }
	.chip { padding: 8px 16px; border-radius: 999px; font-weight: 600; }
	.card { border: 1px solid; border-radius: 14px; padding: 10px 14px; display: grid; grid-template-columns: auto auto auto auto; gap: 2px 8px; align-items: center; }
	.card b { grid-column: 1 / -1; font-weight: 600; }
	.card i { width: 14px; height: 14px; border-radius: 50%; }
	.swatches { display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px; margin-top: 20px; }
	.sw { display: grid; grid-template-columns: 28px 1fr; gap: 0 8px; font-size: 13px; align-items: center; }
	.sw span { grid-row: span 2; width: 28px; height: 28px; border-radius: 8px; border: 1px solid var(--border); }
	.sw b { font-weight: 500; }
	.sw code { color: var(--soft); font-size: 12px; }
</style>
</head>
<body>
<h1>look4 — logo concepts</h1>
<p>Five directions for the mark. Each is shown at 16 → 256 px on its own light and dark palette, with the single-colour version, the wordmark and the palette tokens. Generated by <code>render.ts</code>.</p>
${cs.map((c, i) => section(c, i + 1)).join("\n")}
</body>
</html>
`
}

const only = process.argv[2]
const concepts = loadConcepts(only)
for (const c of concepts) await renderConcept(c)
if (!only) {
	await compare(concepts)
	writeFileSync(join(root, "index.html"), html(concepts))
}
console.log(`rendered ${concepts.map(c => c.slug).join(", ")}`)
