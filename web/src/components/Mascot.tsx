// The look4 mascot: the eagle from the logo mark (brand/logo-mark.svg), given a body so it can act.
// The head is the mark's own geometry, drawn in the mark's 512 units and scaled into place, so the
// face, eye, beak, tuft and blush are exactly the logo's. Off the disc, a white head would vanish on
// a white card, so the whole bird sits inside one navy sticker outline: every silhouette shape is
// drawn twice, first as a fat navy stroke (the "outline" layer) and then in colour on top (the
// "fill" layer). Both layers carry the same animation classes, so they move in lockstep.
//
// Each pose's resting shape is set with SVG transform attributes, and CSS only adds motion on top,
// so with `prefers-reduced-motion` (or in a renderer without CSS animation) every pose still reads.
//
// <Mascot pose="looking" size={120} /> is decorative (aria-hidden); pass `title` to make it an image.
// brand/mascot/render.ts renders the static SVGs in brand/mascot/ from this file (`standalone`).
import { useId } from "react"

export type MascotPose = "looking" | "found" | "sleepy" | "puzzled" | "hello" | "thinking"
export const mascotPoses: readonly MascotPose[] = ["looking", "found", "sleepy", "puzzled", "hello", "thinking"]

// Mark colours (brand/README.md), plus two derived browns for the wings and belly.
const NAVY = "#1b3354"
const PUPIL = "#13243b"
const GOLD = "#f6b52e"
const WHITE = "#ffffff"
const BROWN = "#6b3f22"
const WING = "#56311a"
const BELLY = "#7a4828"
const BLUSH = "#f9b8ad"
const LENS = "#fff3cf"
const SKY = "#2f6fb6"

// Outline thickness in viewBox units (512 = the whole figure).
const LINE = 18

// The head: the mark's head (centre 232,254, r 156) scaled by K and centred on HX,HY.
const HX = 236
const HY = 190
const K = 0.74
const HEAD = `translate(${HX} ${HY}) scale(${K}) translate(-232 -254)`

// Wing pivots, in figure units: tucked at the shoulders, or out at the sides of the body to raise.
const FRONT = { x: 318, y: 300 }
const BACK = { x: 146, y: 300 }
const FRONT_OUT = { x: 330, y: 334 }
const BACK_OUT = { x: 130, y: 334 }
// hello: the waving wing hinges further out than the found pose's, so its raised tip clears the head
const WAVE = { x: 116, y: 330 }

type Layer = "outline" | "fill"

// A silhouette shape: navy and fat in the outline layer, its colour in the fill layer. `k` is the
// scale of the group it sits in, so the outline is the same thickness everywhere.
const paint = (layer: Layer, fill: string, k = 1) =>
	layer === "outline" ? { fill: NAVY, stroke: NAVY, strokeWidth: LINE / k, strokeLinejoin: "round" as const } : { fill }

// A stroked silhouette (letters, the question-mark feather): its own width, plus the outline.
const line = (layer: Layer, colour: string, width: number, k = 1) => ({
	fill: "none",
	stroke: layer === "outline" ? NAVY : colour,
	strokeWidth: layer === "outline" ? width + LINE / k : width,
	strokeLinecap: "round" as const,
	strokeLinejoin: "round" as const,
})

// A four-point twinkle centred on x,y.
const star = (x: number, y: number, r: number) =>
	`M${x} ${y - r}Q${x} ${y} ${x + r} ${y}Q${x} ${y} ${x} ${y + r}Q${x} ${y} ${x - r} ${y}Q${x} ${y} ${x} ${y - r}Z`

// One gold foot: a pad and three round toes, centred on x, standing on y=486.
const foot = (x: number) =>
	`M${x - 22} 484C${x - 22} 469 ${x - 12} 461 ${x} 461C${x + 12} 461 ${x + 22} 469 ${x + 22} 484` +
	`C${x + 16} 491 ${x + 10} 491 ${x + 7} 485C${x + 3} 491 ${x - 3} 491 ${x - 7} 485C${x - 10} 491 ${x - 16} 491 ${x - 22} 484Z`

// A folded wing hanging from its shoulder at 0,0, bulging out to +x, with a notched feather tip.
const WING_PATH =
	"M-10 -8C24 -12 50 26 48 76C46 112 32 138 10 154C12 140 8 132 2 128C2 142 -4 150 -14 154C-10 134 -18 114 -24 98C-34 70 -34 18 -10 -8Z"

// The mark's head pieces, in the mark's own 512 units.
const NAPE = "M112 300 Q70 342 64 384 Q100 362 128 362 Q108 394 112 428 Q154 392 196 388 Z"
const TUFT = "M204 108 C190 80 202 54 232 44 C226 66 236 86 230 104 Z M236 102 C244 80 266 70 288 74 C272 84 264 96 258 108 Z"
const BEAK = "M330 194 C392 180 452 196 470 246 C484 286 476 320 450 338 C454 316 446 300 422 298 L334 310 Z"

type Look = {
	brow: string
	pupil: [number, number]
	headTilt: number
	front: number // front wing rotation, degrees (0 = folded)
	frontScale?: number
	// Raised wings hinge from the sides of the body instead of the shoulders, so they clear the head.
	spread?: "both" | "back"
	back: number
	closed?: boolean // sleepy: the eye shut in a soft smile-shaped curve, dozing rather than side-eyeing
	sparkleEye?: boolean
	// hello: the back wing is raised from WAVE, out at the side, so the whole wing reads clear of the head
	wave?: boolean
}

const LOOKS: Record<MascotPose, Look> = {
	looking: { brow: "M208 164 Q280 124 354 166", pupil: [0, 0], headTilt: 0, front: 0, back: 0 },
	found: { brow: "M210 148 Q282 102 356 150", pupil: [-4, -4], headTilt: -4, front: -128, back: 130, spread: "both", sparkleEye: true },
	// a relaxed, raised brow over a shut eye: a heavy half-lid under a low flat brow read as unimpressed
	sleepy: { brow: "M214 162 Q284 132 352 158", pupil: [0, 0], headTilt: 12, front: 0, back: 0, closed: true },
	puzzled: { brow: "M204 176 Q272 134 350 132", pupil: [10, -14], headTilt: -16, front: 0, back: 0 },
	hello: { brow: "M210 156 Q282 112 356 156", pupil: [-8, -2], headTilt: 6, front: 0, back: 146, wave: true },
	thinking: { brow: "M208 160 Q282 118 354 148", pupil: [12, -16], headTilt: -4, front: -112, frontScale: 0.56, back: 0 },
}

type WingProps = { layer: Layer; pivot: { x: number; y: number }; angle: number; scale?: number; mirror?: boolean; cls: string }
const Wing = ({ layer, pivot, angle, scale = 1, mirror, cls }: WingProps) => (
	<g transform={`translate(${pivot.x} ${pivot.y}) rotate(${angle}) scale(${mirror ? -scale : scale} ${scale})`}>
		<g className={cls}>
			<path d={WING_PATH} {...paint(layer, WING, scale)} />
		</g>
	</g>
)

const Figure = ({ layer, pose, id }: { layer: Layer; pose: MascotPose; id: string }) => {
	const look = LOOKS[pose]
	const fill = layer === "fill"
	const [px, py] = look.pupil
	return (
		<g className="l4m-hop">
			<g className="l4m-breathe">
				<Wing layer={layer} pivot={look.wave ? WAVE : look.spread ? BACK_OUT : BACK} angle={look.back} scale={look.wave ? 1.06 : 1} mirror cls="l4m-wing-back" />
				{/* the white tail of a bald eagle, fanned out behind */}
				<path
					d="M170 424C142 428 116 440 104 454C98 462 104 468 112 464C104 474 108 482 118 478C114 488 122 494 132 486C148 476 166 466 184 456Z"
					{...paint(layer, WHITE)}
				/>
				<ellipse cx="230" cy="372" rx="106" ry="100" {...paint(layer, BROWN)} />
				{fill && <ellipse cx="246" cy="396" rx="54" ry="62" fill={BELLY} />}
				<path d={foot(200)} {...paint(layer, GOLD)} />
				<path d={foot(264)} {...paint(layer, GOLD)} />
				<g transform={`rotate(${look.headTilt} ${HX} 300)`}>
					<g className="l4m-head">
						<g transform={HEAD}>
							<path d={NAPE} {...paint(layer, WHITE, K)} />
							<path d={TUFT} {...paint(layer, WHITE, K)} />
							<path d={BEAK} {...paint(layer, GOLD, K)} />
							<circle cx="232" cy="254" r="156" {...paint(layer, WHITE, K)} />
							{fill && <Face look={look} id={id} px={px} py={py} />}
						</g>
					</g>
				</g>
				<Wing layer={layer} pivot={look.spread === "both" ? FRONT_OUT : FRONT} angle={look.front} scale={look.frontScale} cls="l4m-wing-front" />
			</g>
			<Props layer={layer} pose={pose} />
		</g>
	)
}

const Face = ({ look, id, px, py }: { look: Look; id: string; px: number; py: number }) => (
	<>
		<defs>
			<clipPath id={`${id}-iris`}>
				<circle cx="286" cy="236" r="62" />
			</clipPath>
			<clipPath id={`${id}-eye`}>
				<circle cx="286" cy="236" r="79" />
			</clipPath>
		</defs>
		<ellipse className="l4m-blush" cx="256" cy="324" rx="28" ry="15" fill={BLUSH} />
		<circle cx="286" cy="236" r="76" fill={NAVY} />
		<circle cx="286" cy="236" r="62" fill={GOLD} />
		<g clipPath={`url(#${id}-iris)`}>
			<g transform={`translate(${px} ${py})`}>
				<g className="l4m-pupil">
					<circle cx="296" cy="242" r={look.sparkleEye ? 42 : 38} fill={PUPIL} />
					{look.sparkleEye ? (
						<>
							<path className="l4m-glint" d={star(314, 220, 24)} fill={WHITE} />
							<circle cx="280" cy="264" r="8" fill={WHITE} />
						</>
					) : (
						<>
							<circle cx="312" cy="222" r="15" fill={WHITE} />
							<circle cx="282" cy="262" r="7" fill={WHITE} />
						</>
					)}
				</g>
			</g>
		</g>
		<path d="M243 220 A46 46 0 0 1 270 193" fill="none" stroke={LENS} strokeWidth="9" strokeLinecap="round" />
		<g clipPath={`url(#${id}-eye)`}>
			{look.closed ? (
				// sleepy: the whole eye covered, then a gentle downward curve with two little lashes
				<>
					<circle cx="286" cy="236" r="80" fill={WHITE} />
					<path d="M226 240 Q286 292 346 240" fill="none" stroke={NAVY} strokeWidth="16" strokeLinecap="round" />
					<path d="M244 257 L232 276 M328 257 L340 276" fill="none" stroke={NAVY} strokeWidth="11" strokeLinecap="round" />
				</>
			) : (
				// the blink: parked above the eye, it drops for a moment every few seconds
				<g className="l4m-blink" transform="translate(0 -180)">
					<rect x="200" y="140" width="180" height="160" fill={WHITE} />
					<path d="M206 296 Q286 320 366 296" fill="none" stroke={NAVY} strokeWidth="14" strokeLinecap="round" />
				</g>
			)}
		</g>
		<path className="l4m-brow" d={look.brow} fill="none" stroke={NAVY} strokeWidth="18" strokeLinecap="round" />
	</>
)

// What floats around the bird: sparkles, z's, a question mark, a thought bubble.
const Props = ({ layer, pose }: { layer: Layer; pose: MascotPose }) => {
	if (pose === "found")
		return (
			<>
				<path className="l4m-spark l4m-spark-1" d={star(84, 96, 30)} {...paint(layer, GOLD)} />
				<path className="l4m-spark l4m-spark-2" d={star(442, 64, 22)} {...paint(layer, GOLD)} />
				<path className="l4m-spark l4m-spark-3" d={star(470, 170, 14)} {...paint(layer, GOLD)} />
				<path className="l4m-spark l4m-spark-2" d={star(58, 214, 12)} {...paint(layer, GOLD)} />
			</>
		)
	if (pose === "sleepy")
		return (
			<>
				<path className="l4m-z l4m-z-1" d="M384 106h22l-22 24h22" {...line(layer, SKY, 9)} />
				<path className="l4m-z l4m-z-2" d="M420 62h28l-28 30h28" {...line(layer, SKY, 11)} />
				<path className="l4m-z l4m-z-3" d="M458 20h34l-34 38h34" {...line(layer, SKY, 12)} />
			</>
		)
	if (pose === "puzzled")
		return (
			<>
				<circle cx="356" cy="112" r="8" {...paint(layer, WHITE)} />
				<circle cx="378" cy="84" r="12" {...paint(layer, WHITE)} />
				<circle cx="440" cy="50" r="44" {...paint(layer, WHITE)} />
				{layer === "fill" && (
					<g className="l4m-q">
						<path d="M424 38Q424 22 440 22Q456 22 456 37Q456 48 446 53Q440 56 440 64" fill="none" stroke={NAVY} strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" />
						<circle cx="440" cy="81" r="6.5" fill={NAVY} />
					</g>
				)}
			</>
		)
	// hello: two little gold motion arcs beside the wing tip, no outline (an outlined stroke this thin reads as a smudge)
	if (pose === "hello")
		return layer === "fill" ? (
			<g className="l4m-waves" fill="none" stroke={GOLD} strokeWidth="11" strokeLinecap="round">
				<path d="M40 176Q26 150 38 120" />
				<path d="M14 168Q-2 136 14 98" />
			</g>
		) : null
	if (pose === "thinking")
		return (
			<>
				<circle cx="368" cy="122" r="8" {...paint(layer, WHITE)} />
				<circle cx="388" cy="96" r="12" {...paint(layer, WHITE)} />
				<rect x="384" y="18" width="116" height="60" rx="30" {...paint(layer, WHITE)} />
				{layer === "fill" && (
					<>
						<circle className="l4m-dot l4m-dot-1" cx="414" cy="48" r="9" fill={NAVY} />
						<circle className="l4m-dot l4m-dot-2" cx="442" cy="48" r="9" fill={NAVY} />
						<circle className="l4m-dot l4m-dot-3" cx="470" cy="48" r="9" fill={NAVY} />
					</>
				)}
			</>
		)
	return null
}

// Motion. Every keyframe set includes the resting transform, since a CSS transform replaces the
// element's transform attribute while it runs. transform-origin is in viewBox units.
export const mascotCss = `
.l4m { display: inline-block; overflow: visible; vertical-align: middle; }
.l4m-outline :is(path, ellipse, circle, rect) { stroke: var(--l4m-line, ${NAVY}); }
.l4m-outline :is(path, ellipse, circle, rect):not([fill="none"]) { fill: var(--l4m-line, ${NAVY}); }
.l4m-blink { animation: l4m-blink 5.2s infinite; }
@keyframes l4m-blink { 0%, 93%, 100% { transform: translate(0, -180px); } 95.5% { transform: translate(0, 0); } }
.l4m-looking .l4m-pupil { animation: l4m-scan 4s cubic-bezier(.45, 0, .2, 1) infinite; }
@keyframes l4m-scan { 0%, 12%, 100% { transform: translate(0, 0); } 25%, 42% { transform: translate(-24px, 4px); } 58%, 78% { transform: translate(14px, 0); } }
.l4m-looking .l4m-head { transform-origin: 236px 300px; animation: l4m-turn 4s cubic-bezier(.45, 0, .2, 1) infinite; }
@keyframes l4m-turn { 0%, 12%, 100% { transform: rotate(0); } 25%, 42% { transform: rotate(-4deg); } 58%, 78% { transform: rotate(3deg); } }
.l4m-found .l4m-hop { transform-origin: 236px 490px; animation: l4m-hop 1.6s cubic-bezier(.3, 0, .3, 1) infinite; }
@keyframes l4m-hop { 0%, 60%, 100% { transform: translate(0, 0) scale(1, 1); } 10% { transform: translate(0, 0) scale(1.04, .95); } 30% { transform: translate(0, -30px) scale(.98, 1.03); } 52% { transform: translate(0, 0) scale(1.05, .94); } }
.l4m-found .l4m-shadow { transform-origin: 232px 492px; animation: l4m-shadow 1.6s cubic-bezier(.3, 0, .3, 1) infinite; }
@keyframes l4m-shadow { 0%, 60%, 100% { transform: scale(1); } 30% { transform: scale(.75); } }
.l4m-found .l4m-wing-front, .l4m-found .l4m-wing-back { animation: l4m-flap .4s ease-in-out infinite alternate; }
@keyframes l4m-flap { from { transform: rotate(-10deg); } to { transform: rotate(8deg); } }
.l4m-spark { transform-box: fill-box; transform-origin: center; animation: l4m-twinkle 1.6s ease-in-out infinite; }
.l4m-spark-2 { animation-delay: -.5s; }
.l4m-spark-3 { animation-delay: -1s; }
@keyframes l4m-twinkle { 0%, 100% { transform: scale(1) rotate(0); opacity: 1; } 50% { transform: scale(.55) rotate(25deg); opacity: .7; } }
.l4m-glint { transform-box: fill-box; transform-origin: center; animation: l4m-twinkle 1.6s ease-in-out infinite; }
.l4m-sleepy .l4m-breathe { transform-origin: 236px 486px; animation: l4m-breathe 4.4s ease-in-out infinite; }
.l4m-sleepy .l4m-head { transform-origin: 236px 300px; animation: l4m-doze 4.4s ease-in-out infinite; }
@keyframes l4m-doze { 0%, 100% { transform: rotate(0) translate(0, 0); } 45%, 60% { transform: rotate(5deg) translate(0, 6px); } }
@keyframes l4m-breathe { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(1.015, 1.03); } }
.l4m-z { animation: l4m-z 4.4s ease-out infinite backwards; }
.l4m-z-2 { animation-delay: .7s; }
.l4m-z-3 { animation-delay: 1.4s; }
@keyframes l4m-z { 0% { opacity: 0; transform: translate(-12px, 14px); } 20%, 70% { opacity: 1; } 100% { opacity: 0; transform: translate(10px, -10px); } }
.l4m-puzzled .l4m-head { transform-origin: 236px 300px; animation: l4m-ponder 3.2s ease-in-out infinite; }
@keyframes l4m-ponder { 0%, 100% { transform: rotate(0); } 50% { transform: rotate(-5deg); } }
.l4m-hello .l4m-wing-back { animation: l4m-wave 1.2s ease-in-out infinite; }
.l4m-waves { animation: l4m-waves 1.2s ease-in-out infinite; }
@keyframes l4m-waves { 0%, 100% { opacity: 1; transform: translate(0, 0); } 50% { opacity: .45; transform: translate(-6px, 4px); } }
.l4m-q { transform-box: fill-box; transform-origin: 50% 80%; animation: l4m-q 3.2s ease-in-out infinite; }
@keyframes l4m-q { 0%, 100% { transform: rotate(0); } 50% { transform: rotate(10deg); } }
@keyframes l4m-wave { 0%, 100% { transform: rotate(0); } 25% { transform: rotate(-16deg); } 50% { transform: rotate(3deg); } 75% { transform: rotate(-12deg); } }
.l4m-hello .l4m-head { transform-origin: 236px 300px; animation: l4m-ponder 2.4s ease-in-out infinite; }
.l4m-thinking .l4m-head { transform-origin: 236px 300px; animation: l4m-nod 3s ease-in-out infinite; }
@keyframes l4m-nod { 0%, 100% { transform: rotate(0); } 50% { transform: rotate(3deg); } }
.l4m-dot { animation: l4m-dot 1.2s ease-in-out infinite; }
.l4m-dot-2 { animation-delay: .2s; }
.l4m-dot-3 { animation-delay: .4s; }
@keyframes l4m-dot { 0%, 60%, 100% { opacity: .3; } 30% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .l4m, .l4m * { animation: none !important; } }
`

export const Mascot = ({
	pose,
	size = 96,
	title,
	className = "",
	standalone = false,
}: {
	pose: MascotPose
	size?: number
	// Makes the mascot an image with this accessible name; otherwise it is decorative.
	title?: string
	className?: string
	// A self-contained <svg> (xmlns and its own <style>), for writing .svg files.
	standalone?: boolean
}) => {
	// Clip-path ids must be unique per instance; useId's punctuation is not valid in url(#...).
	const id = `l4m${useId().replace(/[^a-zA-Z0-9]/g, "")}`
	return (
		<>
			{!standalone && (
				<style href="look4-mascot" precedence="look4-mascot">
					{mascotCss}
				</style>
			)}
			<svg
				xmlns={standalone ? "http://www.w3.org/2000/svg" : undefined}
				className={`l4m l4m-${pose} ${className}`.trim()}
				viewBox="0 0 512 512"
				width={size}
				height={size}
				focusable="false"
				{...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true })}
			>
				{standalone && <style>{mascotCss}</style>}
				{title && <title>{title}</title>}
				<ellipse className="l4m-shadow" cx="232" cy="494" rx="96" ry="11" fill={PUPIL} opacity="0.14" />
				<g className="l4m-outline">
					<Figure layer="outline" pose={pose} id={id} />
				</g>
				<Figure layer="fill" pose={pose} id={id} />
			</svg>
		</>
	)
}
