// Renders the mascot poses from their one source, web/src/components/Mascot.tsx:
//   brand/mascot/<pose>.svg  self-contained, animated (CSS inside the SVG, so it moves in an <img>)
//   brand/mascot/<pose>-dark.svg  the same with the pale outline the app uses on dark backgrounds
//   brand/mascot/poses.png   contact sheet: every pose at 200 and 48 px on light and dark
// Node cannot load .tsx, so this compiles the component with Vite's own transform and imports it
// from a data: URL, with its react imports pointed at the repo's copies.
// Run: node brand/mascot/render.ts
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import sharp from "sharp"
import { transformWithOxc } from "vite"

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, "../../web/src/components/Mascot.tsx")

const { code } = await transformWithOxc(readFileSync(source, "utf8"), source, { jsx: { runtime: "automatic" }, lang: "tsx" })
const linked = code.replace(/from\s*"(react(?:\/jsx-runtime)?)"/g, (_, spec: string) => `from "${import.meta.resolve(spec)}"`)
// The component's surface as this script uses it (the root tsconfig does not compile JSX).
type MascotModule = {
	Mascot: (props: { pose: string; size?: number; title?: string; standalone?: boolean }) => ReactNode
	mascotPoses: readonly string[]
}
const { Mascot, mascotPoses } = (await import(`data:text/javascript;base64,${Buffer.from(linked).toString("base64")}`)) as MascotModule

const titles: Record<string, string> = {
	looking: "look4 eagle looking around",
	found: "look4 eagle, delighted: found one",
	sleepy: "look4 eagle, sleepy",
	puzzled: "look4 eagle, puzzled",
	hello: "look4 eagle waving hello",
	thinking: "look4 eagle thinking",
}

// On dark backgrounds the app turns the navy sticker outline pale (--l4m-line in web/src/app.css), so
// the bird keeps its edge. <pose>-dark.svg bakes that in: the variable for browsers, and the outline
// layer's own colours for rasterisers that don't read CSS.
const DARK_LINE = "#c6d5ea"
const darken = (svg: string) => {
	const start = svg.indexOf('<g class="l4m-outline">')
	const end = svg.indexOf('<g class="l4m-hop">', svg.indexOf('<g class="l4m-hop">', start) + 1)
	return svg
		.replace("<svg ", `<svg style="--l4m-line:${DARK_LINE}" `)
		.replace(svg.slice(start, end), svg.slice(start, end).replaceAll("#1b3354", DARK_LINE))
}

const svgs = new Map<string, string>()
for (const pose of mascotPoses) {
	const svg = `${renderToStaticMarkup(createElement(Mascot, { pose, size: 512, standalone: true, title: titles[pose] }))}\n`
	svgs.set(pose, svg)
	svgs.set(`${pose}-dark`, darken(svg))
	writeFileSync(join(here, `${pose}.svg`), svg)
	writeFileSync(join(here, `${pose}-dark.svg`), darken(svg))
}

// Contact sheet: a column per pose; rows are 200 px on light bg, light surface, dark bg, then the
// 48 px versions side by side on each.
const backgrounds = ["#f7f3ea", "#ffffff", "#111823"]
const big = 200
const small = 48
const pad = 20
const col = big + pad
const rasterise = (svg: string, px: number) =>
	sharp(Buffer.from(svg), { density: (72 * px * 4) / 512 })
		.resize(px, px, { kernel: "lanczos3" })
		.png()
		.toBuffer()
const width = pad + mascotPoses.length * col
const height = pad + backgrounds.length * (big + pad) + backgrounds.length * (small + pad)
const tiles: Parameters<ReturnType<typeof sharp>["composite"]>[0] = []
for (const [i, bg] of backgrounds.entries()) {
	tiles.push({ input: { create: { width, height: big + pad, channels: 4, background: bg } }, left: 0, top: i * (big + pad) + pad / 2 })
	tiles.push({
		input: { create: { width, height: small + pad, channels: 4, background: bg } },
		left: 0,
		top: backgrounds.length * (big + pad) + i * (small + pad) + pad / 2,
	})
}
for (const [j, pose] of mascotPoses.entries()) {
	for (const [i, bg] of backgrounds.entries()) {
		// the dark row shows the dark variant, as the app does
		const svg = svgs.get(bg === "#111823" ? `${pose}-dark` : pose)!
		const bigPng = await rasterise(svg, big)
		const smallPng = await rasterise(svg, small)
		tiles.push({ input: bigPng, left: pad + j * col, top: pad + i * (big + pad) })
		tiles.push({ input: smallPng, left: pad + j * col + (big - small) / 2, top: pad + backgrounds.length * (big + pad) + i * (small + pad) })
	}
}
await sharp({ create: { width, height: height + pad, channels: 4, background: "#e9e5dc" } })
	.composite(tiles)
	.png({ compressionLevel: 9 })
	.toFile(join(here, "poses.png"))

console.log(`wrote ${mascotPoses.map(p => `${p}.svg`).join(", ")}, their -dark variants and poses.png`)
