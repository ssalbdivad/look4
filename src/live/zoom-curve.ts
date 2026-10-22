// The lens's real magnification at each zoom position, shared by the server (the `box` op's zoom) and the
// Live page (the zoom slider's label, the wheel's room and target positions).
//
// Measured on the RLC-823S1 (2026-10-15) by registering its sub stream at every fourth position against the
// wide picture (normalized cross-correlation 0.89–0.95): 1.00× at 0, 1.15× at 4, 1.38× at 8, 1.61× at 12,
// 1.84× at 16, 2.07× at 20, 2.30× at 24, 2.53× at 28. The linear 1–5× model this replaces said 5.0× at 28,
// twice too much, so every factor → position conversion overshot. A camera with another range is mapped onto
// the same curve by its share of its own range (`(pos - min) / (max - min) * 28`): the only lens measured.

/** [position on a 0–28 range, magnification]: piecewise linear in between. */
export const LENS_CURVE: ReadonlyArray<readonly [number, number]> = [
	[0, 1],
	[4, 1.15],
	[8, 1.38],
	[12, 1.61],
	[16, 1.84],
	[20, 2.07],
	[24, 2.3],
	[28, 2.53]
]

const SPAN = LENS_CURVE[LENS_CURVE.length - 1]![0]

export type LensRange = { min: number; max: number }

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** The magnification at lens position `pos` of range `r` (1 for a range with no span). */
export const lensFactor = (pos: number, r: LensRange) => {
	if (!(r.max > r.min)) return 1
	const u = ((clamp(pos, r.min, r.max) - r.min) / (r.max - r.min)) * SPAN
	for (let i = 1; i < LENS_CURVE.length; i++) {
		const [p1, f1] = LENS_CURVE[i]!
		if (u > p1) continue
		const [p0, f0] = LENS_CURVE[i - 1]!
		return f0 + ((u - p0) / (p1 - p0)) * (f1 - f0)
	}
	return LENS_CURVE[LENS_CURVE.length - 1]![1]
}

/** The (fractional) lens position of range `r` with magnification `factor`, kept inside the range. */
export const lensPosition = (factor: number, r: LensRange) => {
	if (!(r.max > r.min)) return r.min
	const at = (u: number) => r.min + (u / SPAN) * (r.max - r.min)
	if (factor <= LENS_CURVE[0]![1]) return r.min
	for (let i = 1; i < LENS_CURVE.length; i++) {
		const [p1, f1] = LENS_CURVE[i]!
		if (factor > f1) continue
		const [p0, f0] = LENS_CURVE[i - 1]!
		return at(p0 + ((factor - f0) / (f1 - f0)) * (p1 - p0))
	}
	return r.max
}
