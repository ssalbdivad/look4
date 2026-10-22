import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react"
import type { NormBox } from "../../../src/types.ts"
import { fmtPct } from "../format.ts"

type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"
type Drag = { mode: "move" | "draw" | Handle; start: { x: number; y: number }; box0: NormBox | null }
type Edges = { l: number; t: number; r: number; b: number }

const MIN = 0.04
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"]
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const round = (v: number) => Math.round(v * 1000) / 1000

const toEdges = (b: NormBox): Edges => ({ l: b.x, t: b.y, r: b.x + b.w, b: b.y + b.h })
const toBox = (e: Edges): NormBox => ({ x: round(e.l), y: round(e.t), w: round(e.r - e.l), h: round(e.b - e.t) })

/**
 * Draw the detection zone on a real frame: drag on empty space to draw, drag the box to move it,
 * drag a handle to resize. Arrow keys move the focused box; Shift+arrows resize it.
 */
export const RoiEditor = ({
	box,
	onChange,
	snapshot,
	onSnapshotError
}: {
	box: NormBox | null
	onChange: (b: NormBox | null) => void
	snapshot: string | null
	onSnapshotError: () => void
}) => {
	const stage = useRef<HTMLDivElement>(null)
	const [drag, setDrag] = useState<Drag | null>(null)

	const pointAt = (e: PointerEvent) => {
		const r = stage.current!.getBoundingClientRect()
		return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) }
	}

	const down = (e: PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return
		const p = pointAt(e)
		const handle = (e.target as HTMLElement).closest<HTMLElement>("[data-handle]")?.dataset.handle as Handle | undefined
		const inBox = (e.target as HTMLElement).closest("[data-roi]") !== null
		const mode = handle ?? (inBox && box ? "move" : "draw")
		e.currentTarget.setPointerCapture(e.pointerId)
		e.preventDefault()
		setDrag({ mode, start: p, box0: box })
	}

	const move = (e: PointerEvent<HTMLDivElement>) => {
		if (!drag) return
		const p = pointAt(e)
		const { mode, start, box0 } = drag
		if (mode === "draw") {
			onChange(toBox({ l: Math.min(start.x, p.x), t: Math.min(start.y, p.y), r: Math.max(start.x, p.x), b: Math.max(start.y, p.y) }))
			return
		}
		if (!box0) return
		if (mode === "move") {
			const x = clamp(box0.x + p.x - start.x, 0, 1 - box0.w)
			const y = clamp(box0.y + p.y - start.y, 0, 1 - box0.h)
			onChange({ ...box0, x: round(x), y: round(y) })
			return
		}
		const e0 = toEdges(box0)
		const next = { ...e0 }
		if (mode.includes("w")) next.l = Math.min(p.x, e0.r - MIN)
		if (mode.includes("e")) next.r = Math.max(p.x, e0.l + MIN)
		if (mode.includes("n")) next.t = Math.min(p.y, e0.b - MIN)
		if (mode.includes("s")) next.b = Math.max(p.y, e0.t + MIN)
		onChange(toBox(next))
	}

	const up = () => {
		if (!drag) return
		// A click without a drag would leave a sliver; keep the old zone instead.
		if (drag.mode === "draw" && box && (box.w < MIN || box.h < MIN)) onChange(drag.box0)
		setDrag(null)
	}

	const key = (e: KeyboardEvent) => {
		if (!box) return
		const step = e.altKey ? 0.002 : 0.01
		const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
		if (!d) return
		e.preventDefault()
		const [dx = 0, dy = 0] = d
		if (e.shiftKey) {
			const w = clamp(box.w + dx, MIN, 1 - box.x)
			const h = clamp(box.h + dy, MIN, 1 - box.y)
			onChange({ ...box, w: round(w), h: round(h) })
		} else {
			onChange({ ...box, x: round(clamp(box.x + dx, 0, 1 - box.w)), y: round(clamp(box.y + dy, 0, 1 - box.h)) })
		}
	}

	return (
		<div
			ref={stage}
			className={`roi-stage${drag ? " is-dragging" : ""}${box ? " has-box" : ""}`}
			onPointerDown={down}
			onPointerMove={move}
			onPointerUp={up}
			onPointerCancel={up}
		>
			{snapshot ? (
				<img src={snapshot} alt="Latest frame from your camera" draggable={false} onError={onSnapshotError} />
			) : (
				<div className="roi-blank" aria-hidden="true" />
			)}
			{!box && <div className="roi-hint">Drag to draw the zone</div>}
			{box && (
				<div
					data-roi
					className={box.y < 0.08 ? "roi-box is-top" : "roi-box"}
					tabIndex={0}
					role="group"
					aria-label={`Detection zone: ${fmtPct(box.x)} from left, ${fmtPct(box.y)} from top, ${fmtPct(box.w)} wide, ${fmtPct(box.h)} tall. Arrow keys move it, Shift+arrows resize it.`}
					onKeyDown={key}
					style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }}
				>
					<span className="roi-tag">zone</span>
					{HANDLES.map(h => (
						<span key={h} data-handle={h} className={`roi-handle h-${h}`} aria-hidden="true" />
					))}
				</div>
			)}
		</div>
	)
}
