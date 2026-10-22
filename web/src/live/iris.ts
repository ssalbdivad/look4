// Camera first's feedback on the Live picture (LiveStage's drawLens), from the first notch until the lens's
// move shows in the picture. The box the camera is about to fill the picture with stays sharp under a lit
// edge, and everything about to be zoomed away goes dim, grey and soft: the "iris". Each further notch pulls
// it tighter on a spring that keeps its momentum; while the first step is on its way a light runs round the
// edge; when the move reaches the picture the hole opens to the frame and the light dissolves, so the box
// visibly becomes the view. Later steps, whose picture is already moving, get only a quiet trace.
//
// Imperative and framework-free: one call per notch, each a handful of el.animate() calls, no per-frame
// script, so a notch never waits on React. The markup is LiveStage's `.stage-lens`, styled in live-stage.css.
// Everything that moves is a transform or an opacity, except the hole itself: the shade's mask (see
// holeMask), which repaints on the main thread for the ~0.3 s of a notch's spring and the exit, small next to
// the blur, which re-runs on every video frame anyway. The rim rides the main thread with it (see move). The pure parts (the springs, the hole, the readout's place) are
// exported for test/live-iris.test.ts.

/** A box on the stage, in CSS px. */
export type Rect = { x: number; y: number; w: number; h: number }
type Point = { x: number; y: number }

/**
 * Where the hole is: the rim (a picture-sized element) is mapped onto it by matrix(k, 0, 0, k, x, y), and the
 * shade's hole is the same box, its corners rounded by `r` (screen px).
 */
type Place = { x: number; y: number; k: number; r: number }

/** A damped spring's step response as a CSS linear() easing (`dur` ms), and the same curve to read it back. */
export type Curve = { dur: number; easing: string; x: (t: number) => number; dx: (t: number) => number }

/**
 * The step response (0 → 1) of a spring of `period` seconds and damping ratio `zeta`, starting with velocity
 * `v0` (whole distances per second), sampled into a linear() easing. Generated per notch from the hole's
 * velocity at that moment, so a notch landing mid-move carries on without a stall. `x` and `dx` take seconds.
 * Settled once it stays within `tol` of 1, nearly still.
 */
export const springCurve = (v0: number, period: number, zeta: number, tol = 0.0015): Curve => {
	const w = (2 * Math.PI) / period
	let x: (t: number) => number
	let dx: (t: number) => number
	if (zeta < 1) {
		const wd = w * Math.sqrt(1 - zeta * zeta)
		const b = (zeta * w - v0) / wd
		x = t => 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + b * Math.sin(wd * t))
		dx = t => {
			const e = Math.exp(-zeta * w * t)
			const c = Math.cos(wd * t)
			const s = Math.sin(wd * t)
			return e * (zeta * w * (c + b * s) + wd * s - b * wd * c)
		}
	} else {
		x = t => 1 - Math.exp(-w * t) * (1 + (w - v0) * t)
		dx = t => Math.exp(-w * t) * (w * (1 + (w - v0) * t) - (w - v0))
	}
	let dur = 0.05
	const step = 1 / 240
	for (let t = 0; t < 2; t += step) if (Math.abs(1 - x(t)) > tol || Math.abs(dx(t)) > tol * 33) dur = t + step
	// ~90 points a second: enough that the bends of the curve don't show as corners
	const n = Math.max(8, Math.ceil(dur * 90))
	const pts: string[] = []
	for (let i = 0; i <= n; i++) pts.push(i === n ? "1" : String(+x((i / n) * dur).toFixed(4)))
	return { dur: dur * 1000, easing: `linear(${pts.join(", ")})`, x: t => (t >= dur ? 1 : x(t)), dx: t => (t >= dur ? 0 : dx(t)) }
}

/**
 * The corner radius of the box for zoom `f`: square as `f` goes to 1, where the box is nearly the whole frame,
 * and never more than 12 px, so it never trims much of the box's corners.
 */
export const cornerRadius = (f: number) => Math.max(0, Math.min(12, (1 - 1 / f) * 40))

/**
 * The shade's hole, as the layers of its mask (live-stage.css .stage-lens-shade): four solid bands around the
 * box (the full width above and below it, the full height left and right of it, overlapping so no seam shows
 * where they meet) and four corner pieces, each `r` square, opaque outside a quarter circle. Only the layers'
 * positions and sizes change from box to box, so CSS interpolates between any two. Not a clip-path: under the
 * Live page's rounded frame (overflow hidden), and under any scaled ancestor, Chromium blurs the inside of a
 * clip-path hole in a backdrop-filter too; a mask hole stays sharp.
 */
export const holeMask = (cw: number, ch: number, b: Rect, r: number) => {
	const f = (n: number) => `${+n.toFixed(2)}px`
	const x0 = b.x
	const y0 = b.y
	const x1 = b.x + b.w
	const y1 = b.y + b.h
	const rr = Math.max(0, Math.min(r, b.w / 2, b.h / 2))
	const layers: [number, number, number, number][] = [
		[0, 0, cw, y0],
		[0, y1, cw, ch - y1],
		[0, 0, x0, ch],
		[x1, 0, cw - x1, ch],
		[x0, y0, rr, rr],
		[x1 - rr, y0, rr, rr],
		[x0, y1 - rr, rr, rr],
		[x1 - rr, y1 - rr, rr, rr]
	]
	return {
		maskPosition: layers.map(([x, y]) => `${f(x)} ${f(y)}`).join(", "),
		maskSize: layers.map(([, , w, h]) => `${f(Math.max(0, w))} ${f(Math.max(0, h))}`).join(", ")
	}
}

export type ReadoutSide = "below" | "above" | "inside"

/**
 * Where the factor readout (`pill` px) goes for box `b` on a `cw × ch` stage: `gap` px under the box's
 * bottom-left corner; above it when there's no room below; inside its bottom-left corner when there's no room
 * either way (a box nearly the stage's height). `side` forces one, so a box springing towards its target keeps
 * the target's side all the way.
 */
export const readoutAt = (b: Rect, pill: { w: number; h: number }, cw: number, ch: number, gap: number, side?: ReadoutSide): Point & { side: ReadoutSide } => {
	const s: ReadoutSide = side ?? (b.y + b.h + gap + pill.h <= ch - gap ? "below" : b.y - gap - pill.h >= gap ? "above" : "inside")
	const y = s === "below" ? b.y + b.h + gap : s === "above" ? b.y - gap - pill.h : b.y + b.h - gap - pill.h
	const x = s === "inside" ? b.x + gap : b.x
	return { x: Math.max(gap, Math.min(cw - pill.w - gap, x)), y, side: s }
}

// Springs: the first notch's settle onto the box, each further notch (a few % overshoot, so it lands with a
// click), the retreat when a run is cancelled (no overshoot), the lit band's per-notch tick (k 520, ζ 0.42)
const ENTER = { period: 0.3, zeta: 0.86 }
const NOTCH = { period: 0.36, zeta: 0.64 }
const RELAX = { period: 0.5, zeta: 1 }
const TICK = springCurve(0, (2 * Math.PI) / Math.sqrt(520), 0.42, 0.08)
/** The first notch's hole starts this much larger about the pointer and settles onto the box. */
const ENTER_GROW = 1.07
/**
 * The exit: the hole opens to the frame as the picture zooms. The move is only seen once it is under way (the
 * picture is sampled every 100 ms; measured ~110 ms in), so not the zoom's whole ease-in-out but the rest of
 * it: the brief's zoom (700 ms, cubic-bezier(0.45, 0, 0.55, 1)) from 110 ms on. By then the box's contents
 * have grown 4.5% of the way to the frame, so the hole starts there (EXIT_FROM, one frame's jump, under the
 * rim's flare) rather than at the box, where the shade covered a strip of the zooming contents at its edges;
 * and runs the remaining 590 ms along that curve's remainder, renormalised (a cubic's tail is a cubic: this
 * one matches it to 0.07%). The hole then grows as the box's contents do, its edges staying on them.
 */
export const EXIT_FROM = 0.045
export const EXIT_MS = 590
export const EXIT_EASE = "cubic-bezier(0.384, 0.204, 0.534, 1)"
const OUT = "cubic-bezier(0.2, 0.7, 0.3, 1)"
const BREATHE = "cubic-bezier(0.45, 0, 0.55, 1)"

type Mode = "off" | "aim" | "exit" | "cancel" | "fade" | "quiet"
type Track = { anims: Animation[]; curve: Curve | null; from: Place; to: Place }

const same = (a: Place | null, b: Place) => !!a && Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.k - b.k) < 1e-5

export class Iris {
	readonly root: HTMLElement
	private shade: HTMLElement
	private rim: HTMLElement
	private edge: HTMLElement
	private halo: HTMLElement
	private trace: HTMLElement
	private glow: HTMLElement
	/** The band's comet and its glow's, turned together. */
	private comets: HTMLElement[]
	private read: HTMLElement
	private digits: HTMLElement
	private ripples: HTMLElement[]
	private mode: Mode = "off"
	private reduced = false
	/** The stage and the picture in it (letterboxed), CSS px. */
	private cw = 0
	private ch = 0
	private frame: Rect = { x: 0, y: 0, w: 0, h: 0 }
	/** The stage's own scale (its height over 720 px): line widths, glow, blur and the readout grow with it. */
	private s = 1
	private resized = false
	private track: Track | null = null
	/** Where the hole is going (and rests once its spring settles). */
	private target: Place | null = null
	private side: ReadoutSide | undefined
	private text = ""
	private pill = { w: 0, h: 0 }
	private sent = false
	private breath: Animation | null = null
	private ripple = 0
	/** A later step came during the exit: the quiet cue follows once the exit is done. */
	private quietNext = false
	private token: object | null = null

	constructor(root: HTMLElement) {
		this.root = root
		const q = (c: string) => root.querySelector<HTMLElement>(`.stage-lens-${c}`)!
		this.shade = q("shade")
		this.rim = q("rim")
		this.edge = q("edge")
		this.halo = q("halo")
		this.trace = q("trace")
		this.glow = q("glow")
		this.comets = [...root.querySelectorAll<HTMLElement>(".stage-lens-comet")]
		this.read = q("read")
		this.digits = this.read.firstElementChild as HTMLElement
		this.ripples = [...root.querySelectorAll<HTMLElement>(".stage-lens-ripple")]
		root.dataset.mode = "off"
	}

	/** The phase, also on the root as `data-mode`, for scripts that check the feedback from outside. */
	private go(mode: Mode) {
		this.mode = mode
		this.root.dataset.mode = mode
	}

	/** The stage's window: a Picture-in-Picture window has its own media queries, styles and clock. */
	private win() {
		return this.root.ownerDocument.defaultView ?? window
	}

	/** The stage is `cw × ch` with the picture at `frame`; on a change, a box on screen jumps to its new place. */
	size(cw: number, ch: number, frame: Rect) {
		const f = this.frame
		if (cw === this.cw && ch === this.ch && frame.x === f.x && frame.y === f.y && frame.w === f.w && frame.h === f.h) return
		this.cw = cw
		this.ch = ch
		this.frame = { ...frame }
		this.resized = true
		const s = (this.s = Math.min(3, Math.max(0.7, frame.h / 720)))
		const st = this.root.style
		st.setProperty("--lens-s", s.toFixed(3))
		// past ~16 px a stage-wide blur gets costly at 4K and reads no better
		st.setProperty("--lens-blur", `${Math.min(9 * s, 16).toFixed(1)}px`)
		this.rim.style.width = `${frame.w}px`
		this.rim.style.height = `${frame.h}px`
		this.rim.style.setProperty("--diag", `${Math.ceil(Math.hypot(frame.w, frame.h) * 1.05)}px`)
		for (const el of this.ripples) {
			el.style.left = `${frame.x}px`
			el.style.top = `${frame.y}px`
			el.style.width = `${frame.w}px`
			el.style.height = `${frame.h}px`
		}
		this.pill = { w: 0, h: 0 }
		// the quiet rim follows the frame; an exit or a retreat, whose ends were the old frame's, is over at once
		if (this.mode === "quiet") this.move(this.quietPlace(), this.quietPlace(), 0, "", null)
		else if (this.mode === "exit" || this.mode === "cancel" || this.mode === "fade") this.settle()
	}

	// ---------- geometry ----------

	private placeOf(b: Rect, f: number): Place {
		return { x: b.x, y: b.y, k: b.w / this.frame.w, r: cornerRadius(f) }
	}

	private rectOf(p: Place): Rect {
		return { x: p.x, y: p.y, w: p.k * this.frame.w, h: p.k * this.frame.h }
	}

	private full(): Place {
		return { x: this.frame.x, y: this.frame.y, k: 1, r: 0 }
	}

	private hole(p: Place) {
		return holeMask(this.cw, this.ch, this.rectOf(p), p.r)
	}

	private matrix(p: Place) {
		return `matrix(${p.k}, 0, 0, ${p.k}, ${p.x}, ${p.y})`
	}

	private readAt(p: Place) {
		const at = readoutAt(this.rectOf(p), this.pill, this.cw, this.ch, 6 * this.s, this.side)
		return `translate(${at.x.toFixed(2)}px, ${at.y.toFixed(2)}px)`
	}

	/**
	 * Where the hole is now and how fast it moves (px and scale per second): read off the running spring's own
	 * clock and curve, so a retarget starts exactly there. Mid-exit (a fixed curve), only where, from the rim.
	 */
	private state(): { at: Place; v: Place } | null {
		const g = this.track
		if (!g) return this.target && { at: this.target, v: { x: 0, y: 0, k: 0, r: 0 } }
		const a = g.anims[0]!
		const done = a.playState === "finished" || a.playState === "idle"
		if (!g.curve && !done) {
			const m = new DOMMatrix(this.win().getComputedStyle(this.rim).transform)
			const e = (m.a - g.from.k) / (g.to.k - g.from.k || 1)
			return { at: { x: m.e, y: m.f, k: m.a, r: g.from.r + (g.to.r - g.from.r) * e }, v: { x: 0, y: 0, k: 0, r: 0 } }
		}
		const t = Math.max(0, Number(a.currentTime ?? 0) / 1000)
		const e = done || !g.curve ? 1 : g.curve.x(t)
		const de = done || !g.curve ? 0 : g.curve.dx(t)
		const lerp = (k: keyof Place) => g.from[k] + (g.to[k] - g.from[k]) * e
		const vel = (k: keyof Place) => (g.to[k] - g.from[k]) * de
		return { at: { x: lerp("x"), y: lerp("y"), k: lerp("k"), r: lerp("r") }, v: { x: vel("x"), y: vel("y"), k: vel("k"), r: vel("r") } }
	}

	/**
	 * The hole and its rim (and the readout) move as one: the same endpoints, duration and easing, started in
	 * the same task, so they start on the same frame and stay glued. `local` keeps the rim's own corner radius
	 * (the exit: the hole squares off while the rim dissolves); otherwise it is set for `to`.
	 */
	private move(from: Place, to: Place, duration: number, easing: string, curve: Curve | null, local?: boolean) {
		this.track?.anims.forEach(a => a.cancel())
		this.track = null
		if (!local) {
			// line widths and corners are set in the rim's own units for the target's scale, so they are right
			// on screen once it lands
			this.rim.style.setProperty("--u", (1 / to.k).toFixed(4))
			this.rim.style.setProperty("--r", `${(to.r / to.k).toFixed(2)}px`)
		}
		Object.assign(this.shade.style, this.hole(to))
		this.rim.style.transform = this.matrix(to)
		if (!local) this.read.style.transform = this.readAt(to)
		if (this.reduced || !duration) return
		const o = { duration, easing }
		const h0 = this.hole(from)
		const h1 = this.hole(to)
		const shade = this.shade.animate({ maskPosition: [h0.maskPosition, h1.maskPosition], maskSize: [h0.maskSize, h1.maskSize] }, o)
		// The mask can only animate on the main thread. Left to the compositor, the rim's transform runs ahead
		// of the hole whenever the main thread is busy (seen in software rendering: the edge a box ahead of the
		// hole), so a property that can't be composited (and changes nothing) keeps the rim and the readout on
		// the main thread too, in the same frames as the hole: a transform each, no repaint.
		const glue = { outlineColor: ["transparent", "transparent"] }
		const anims = [shade, this.rim.animate({ transform: [this.matrix(from), this.matrix(to)], ...glue }, o)]
		if (!local) anims.push(this.read.animate({ transform: [this.readAt(from), this.readAt(to)], ...glue }, o))
		this.track = { anims, curve, from, to }
	}

	/** To `to` along a spring from the hole's position and velocity now (or from `from`, still). */
	private spring(to: Place, cfg: { period: number; zeta: number }, from?: Place) {
		const st = from ? { at: from, v: { x: 0, y: 0, k: 0, r: 0 } } : this.state()
		if (!st) return this.move(to, to, 0, "", null)
		// The rim scales its corners with it, so the hole's radius does too: it starts at what the rim's
		// corners are at the start, and both arrive at `to`'s together. (A jump of a pixel or two at most.)
		const at = { ...st.at, r: (to.r / to.k) * st.at.k }
		// distance and velocity in screen px (the scale counted at the picture's width), projected on the move
		const w = this.frame.w
		const d = { x: to.x - at.x, y: to.y - at.y, k: (to.k - at.k) * w }
		const dd = d.x * d.x + d.y * d.y + d.k * d.k
		if (dd < 0.01) return this.move(at, to, 0, "", null)
		const v0 = (st.v.x * d.x + st.v.y * d.y + st.v.k * w * d.k) / dd
		const curve = springCurve(v0, cfg.period, cfg.zeta)
		this.move(at, to, curve.dur, curve.easing, curve)
	}

	/** Opacity to `to`: from where it is (or along `keyframes`), replacing the element's last fade. */
	private fade(el: HTMLElement, to: number, duration: number, easing = "ease-out", keyframes?: number[]) {
		const from = this.win().getComputedStyle(el).opacity
		el.getAnimations().forEach(a => a.id === "fade" && a.cancel())
		el.style.opacity = String(to)
		if (duration <= 0) return null
		const a = el.animate({ opacity: keyframes ?? [Number(from), to] }, { duration, easing })
		a.id = "fade"
		return a
	}

	// ---------- the run ----------

	/**
	 * The target for the zoom asked so far: `box` on the stage, for zoom `f`, anchored at pointer `p` (stage
	 * px). Called on every notch (`notch`), and whenever the box follows the pointer before its step goes.
	 */
	aim(box: Rect, p: Point, f: number, notch: boolean) {
		const to = this.placeOf(box, f)
		this.pointer(p)
		if (this.mode !== "aim") return this.enter(to, f, p)
		const resized = this.resized
		this.resized = false
		if (same(this.target, to) && !notch && !resized) return
		this.target = to
		this.readout(f, to)
		if (resized || this.reduced) return this.move(to, to, 0, "", null)
		this.spring(to, NOTCH)
		if (!notch) return
		// each notch lands with a click: the lit band swells outward by 1.5 px and back on a bouncy spring, and
		// the glow flares. Not a scale of the rim: that would pull the rim off the hole (1% of a 1500 px box is
		// 15 px a side, a band of shade showing between them); the band's inner edge stays on the box.
		const px = (n: number) => `calc(var(--px) * ${n})`
		this.edge.animate(
			{ inset: [px(-4.5), px(-3)], padding: [px(3.5), px(2)], borderRadius: [`calc(var(--r) + ${px(4.5)})`, `calc(var(--r) + ${px(3)})`] },
			{ duration: TICK.dur, easing: TICK.easing }
		)
		this.halo.animate({ opacity: [1, 0.75] }, { duration: 420, easing: OUT })
		if (this.sent) this.breathe()
	}

	/** On: the hole already at the box (a hair larger, settling in), the shade most of the way down. */
	private enter(to: Place, f: number, p: Point) {
		const was = this.mode
		const at = was === "exit" || was === "cancel" ? this.state()?.at : null
		if (at) {
			// re-aimed while it was going: carry on from where it is; a new run, nothing on its way yet
			this.token = null
			this.quietNext = false
			this.sent = false
			this.root.classList.remove("is-sent")
			for (const el of this.comets) el.getAnimations().forEach(a => a.cancel())
			for (const el of [this.trace, this.glow]) this.fade(el, 0, 0)
			this.fade(this.edge, 1, 0)
		} else {
			this.reset()
			this.reduced = this.win().matchMedia("(prefers-reduced-motion: reduce)").matches
			this.root.classList.toggle("is-reduced", this.reduced)
		}
		this.go("aim")
		this.resized = false
		this.target = to
		this.root.classList.add("is-on")
		this.readout(f, to)
		if (this.reduced) {
			this.move(to, to, 0, "", null)
			this.fade(this.shade, 1, 0)
			this.fade(this.rim, 1, 0)
			this.fade(this.read, 1, 0)
			return
		}
		const grow = (n: number, o: number) => o + (n - o) * ENTER_GROW
		this.spring(to, ENTER, at ?? { x: grow(to.x, p.x), y: grow(to.y, p.y), k: to.k * ENTER_GROW, r: 0 })
		this.fade(this.shade, 1, 200, "cubic-bezier(0.16, 1, 0.3, 1)", at ? undefined : [0.8, 1])
		this.fade(this.rim, 1, 90, "ease-out", at ? undefined : [0, 1])
		this.fade(this.read, 1, 140)
	}

	/**
	 * The readout for a new target: its side (below the box, above or inside) is chosen for where the box is
	 * going and kept while it gets there; its digits roll in when the factor changes.
	 */
	private readout(f: number, to: Place) {
		const text = `${f.toFixed(1)}×`
		const roll = text !== this.text
		if (roll) this.digits.textContent = this.text = text
		// measured once per size (the digits are tabular, so every factor is as wide)
		if (!this.pill.w) this.pill = { w: this.read.offsetWidth, h: this.read.offsetHeight }
		this.side = readoutAt(this.rectOf(to), this.pill, this.cw, this.ch, 6 * this.s).side
		if (!roll || this.reduced) return
		this.digits.animate({ transform: [`translateY(${(-6 * this.s).toFixed(1)}px)`, "none"], opacity: [0, 1] }, { duration: 220, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" })
	}

	/** The vignette darkens away from the pointer, the point every anchored box closes in on. */
	private pointer(p: Point) {
		const st = this.root.style
		st.setProperty("--lens-ax", `${p.x.toFixed(1)}px`)
		st.setProperty("--lens-ay", `${p.y.toFixed(1)}px`)
	}

	/** The first step is on its way to the camera: a light runs round the rim and the glow breathes. */
	working(on: boolean) {
		if (!on || this.sent || this.mode !== "aim") return
		this.sent = true
		this.root.classList.add("is-sent")
		// reduced motion: the band lights evenly instead (.is-reduced in live-stage.css)
		this.fade(this.trace, 1, this.reduced ? 0 : 260)
		if (this.reduced) return
		// the band dims to half, so the comet's white head stands out on it, and a soft glow runs with the head
		// outside the box (never in it)
		this.fade(this.edge, 0.45, 260)
		this.fade(this.glow, 0.8, 260)
		for (const el of this.comets) el.animate({ transform: ["rotate(0turn)", "rotate(1turn)"] }, { duration: 1150, iterations: Infinity, easing: "linear" })
		this.breathe()
	}

	/** After a notch's flare (420 ms): restarted then, so the breathing picks up where the flare ends. */
	private breathe() {
		this.breath?.cancel()
		this.breath = this.halo.animate({ opacity: [0.75, 0.55] }, { duration: 900, delay: 420, iterations: Infinity, direction: "alternate", easing: BREATHE })
	}

	/** The move reaches the picture: the hole opens to the frame with the picture's zoom, its light dissolving. */
	open() {
		if (this.mode !== "aim") return
		this.go("exit")
		this.breath?.cancel()
		// reduced: the rim and readout sit at the old box while the picture zooms under them, so they go at once
		// (60 ms); only the shade, which covers the frame, fades
		if (this.reduced) return this.fadeOut(140, 60)
		// the comet stops at the handoff: the lit band comes back to full for the flare and the light that ran
		// round it goes, so the exit reads as the band flaring and going, not as a spinner over the opening hole
		this.fade(this.edge, 1, 120)
		this.fade(this.glow, 0, 120)
		const unlit = this.fade(this.trace, 0, 120)
		const stop = () => {
			if (this.mode === "exit") for (const el of this.comets) el.getAnimations().forEach(a => a.cancel())
		}
		if (unlit) unlit.finished.then(stop, () => {})
		else stop()
		const now = this.state()?.at ?? this.target ?? this.full()
		const full = this.full()
		// from where the box's contents already are (see EXIT_FROM)
		const at = { ...now }
		for (const k of ["x", "y", "k", "r"] as const) at[k] += (full[k] - now[k]) * EXIT_FROM
		this.rim.style.setProperty("--u", (1 / at.k).toFixed(4))
		this.move(at, full, EXIT_MS, EXIT_EASE, null, true)
		// the rim flares once and is gone within the first ~2/3; the shade, riding off the frame, goes last
		this.fade(this.rim, 0, 420, "linear", [1, 0.9, 0])
		this.halo.animate({ opacity: [0.75, 1, 0.4] }, { duration: 420, easing: "ease-out" })
		this.fade(this.read, 0, 140)
		this.finishAfter(this.fade(this.shade, 0, EXIT_MS, "linear", [1, 1, 0]))
	}

	/** Cancelled before anything was sent: the hole relaxes back out to the frame as it dims away. */
	retreat() {
		if (this.mode !== "aim") return this.end()
		this.go("cancel")
		if (this.reduced) return this.fadeOut(160)
		this.breath?.cancel()
		this.spring(this.full(), RELAX)
		for (const el of [this.rim, this.read]) this.fade(el, 0, 320)
		this.finishAfter(this.fade(this.shade, 0, 320, "cubic-bezier(0.4, 0, 0.6, 1)"))
	}

	/** The run is over some other way (refused, taken over by a zoom out): it just goes. An exit under way finishes. */
	end() {
		this.quietNext = false
		if (this.mode === "aim" || this.mode === "quiet") this.fadeOut(this.reduced ? 140 : 200)
	}

	/** Shade over `ms`; the rim and readout over `lit` (default the same). */
	private fadeOut(ms: number, lit = ms) {
		this.go("fade")
		this.breath?.cancel()
		for (const el of [this.rim, this.read]) this.fade(el, 0, lit)
		this.finishAfter(this.fade(this.shade, 0, ms))
	}

	/**
	 * Later steps, whose picture is already moving (or a run that started on a picture still catching up): no
	 * shade, only a faint rim at the frame's edge, and on each notch one line closing in towards the pointer.
	 * `pending`: a step past the one the box showed is asked for or on its way, so the rim is on without a
	 * notch. A box still up here has no target any more (scrolled back out before it went, or a pinch took the
	 * zoom): it retreats.
	 */
	quiet(p: Point, notch: boolean, pending = false) {
		if (this.mode === "aim") return this.retreat()
		if (!notch && !pending) return
		if (this.mode === "exit" || this.mode === "cancel") this.quietNext = true
		else if (this.mode !== "quiet") this.enterQuiet()
		if (this.reduced || !notch) return
		// two lines take turns, so quick notches don't cut one off
		const el = this.ripples[this.ripple++ % this.ripples.length]
		if (!el) return
		el.style.transformOrigin = `${(p.x - this.frame.x).toFixed(1)}px ${(p.y - this.frame.y).toFixed(1)}px`
		el.animate(
			[
				// already moving where it shows most, so it reads as a close rather than a flicker at the frame's edge
				{ transform: "scale(1)", opacity: 0 },
				{ transform: "scale(0.96)", opacity: 0.85, offset: 0.2 },
				{ transform: "scale(0.86)", opacity: 0 }
			],
			{ duration: 620, easing: OUT }
		)
	}

	private enterQuiet() {
		this.reset()
		this.reduced = this.win().matchMedia("(prefers-reduced-motion: reduce)").matches
		this.root.classList.toggle("is-reduced", this.reduced)
		this.go("quiet")
		this.root.classList.add("is-quiet", "is-on")
		this.move(this.full(), this.quietPlace(), 0, "", null)
		this.fade(this.rim, 0.5, this.reduced ? 0 : 220)
	}

	/** The quiet rim's place: just inside the frame, since the rim's light lies outside its box, here the stage's edge. */
	private quietPlace(): Place {
		const f = this.frame
		const k = Math.max(0.5, 1 - (2 * (3 * this.s + 1)) / f.h)
		return { x: f.x + (f.w * (1 - k)) / 2, y: f.y + (f.h * (1 - k)) / 2, k, r: 0 }
	}

	/** Off once `anim` (the last fade) is done, unless something else took over meanwhile. */
	private finishAfter(anim: Animation | null) {
		const token = (this.token = {})
		const done = () => {
			if (this.token === token) this.settle()
		}
		if (anim) anim.finished.then(done, () => {})
		else done()
	}

	/** A fade, exit or retreat is over: off, or the quiet cue a later step asked for meanwhile. */
	private settle() {
		if (this.quietNext) this.enterQuiet()
		else this.reset()
	}

	/** Idle: the root hidden (no cost), every layer at opacity 0, nothing running. */
	reset() {
		this.go("off")
		this.token = null
		this.quietNext = false
		this.track = null
		this.target = null
		this.sent = false
		this.text = ""
		this.breath = null
		this.root.classList.remove("is-on", "is-quiet", "is-sent")
		for (const el of [this.shade, this.rim, this.edge, this.halo, this.trace, this.glow, ...this.comets, this.read, this.digits]) el.getAnimations().forEach(a => a.cancel())
		for (const el of [this.shade, this.rim, this.trace, this.glow, this.read]) el.style.opacity = "0"
		this.edge.style.opacity = ""
	}
}
