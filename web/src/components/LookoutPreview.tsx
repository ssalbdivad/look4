import { useEffect, useState } from "react"
import type { CompilePreviewResponse } from "../../../src/api-types.ts"
import { api, errorMessage } from "../api.ts"
import { modelLabel } from "../format.ts"
import { useDebounced } from "../hooks.ts"
import { Icon } from "./Icon.tsx"
import { Mascot } from "./Mascot.tsx"

export type CompilePreviewState = { prompt: string; result: CompilePreviewResponse | null; error: string | null } | null

/**
 * Compiles the prompt as you type (debounced) so you see what the detector and judge will look for
 * before saving. Shared by the lookout editor and the setup wizard.
 */
export const useCompilePreview = (prompt: string, initial: CompilePreviewState = null, onResult?: (r: CompilePreviewResponse) => void) => {
	const [preview, setPreview] = useState<CompilePreviewState>(initial)
	const [fetching, setFetching] = useState(false)
	const debounced = useDebounced(prompt.trim(), 700)
	useEffect(() => {
		if (debounced.length < 3 || preview?.prompt === debounced) return
		const ac = new AbortController()
		setFetching(true)
		api.preview({ prompt: debounced }, ac.signal).then(
			result => {
				setPreview({ prompt: debounced, result, error: null })
				setFetching(false)
				onResult?.(result)
			},
			e => {
				if (ac.signal.aborted) return
				setPreview({ prompt: debounced, result: null, error: errorMessage(e) })
				setFetching(false)
			}
		)
		return () => ac.abort()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [debounced])
	// The old preview stays visible (dimmed) while the next one compiles, so the layout doesn't jump.
	const typing = prompt.trim().length >= 3 && (prompt.trim() !== debounced || fetching)
	return { preview, typing }
}

export const CompilePreview = ({ prompt, preview, typing }: { prompt: string; preview: CompilePreviewState; typing: boolean }) => {
	const result = preview?.result
	return (
		<div className={`preview${typing ? " is-busy" : ""}`} aria-live="polite">
			<div className="preview-head">
				<Icon name="sparkle" size={16} />
				<span>How look4 reads it</span>
				{typing && <span className="spinner" aria-label="Updating" />}
			</div>
			{!result && !preview?.error &&
				(prompt.trim().length < 3 ? (
					<p className="muted">Start typing and you'll see what the detector and the spotter will look for.</p>
				) : (
					<p className="preview-reading muted">
						<Mascot pose="thinking" size={56} />
						Reading…
					</p>
				))}
			{preview?.error && <p className="preview-error">{preview.error}</p>}
			{result && (
				<>
					<div className="preview-block">
						<span className="kv-k">The detector will look for</span>
						<span className="nouns">
							{result.queries.map(q => (
								<span key={q} className="chip chip-noun">
									{q}
								</span>
							))}
						</span>
					</div>
					<div className="preview-block">
						<span className="kv-k">Then the spotter checks</span>
						<p className="rubric">{result.rubric}</p>
					</div>
					<div className="preview-foot muted">
						{result.fineGrained && (
							<span className="chip chip-soft" title="Sends bigger close-ups to the spotter">
								fine detail
							</span>
						)}
						<span>{result.compiler === "fallback" ? "from look4's word list" : `worked out by ${modelLabel(result.compiler)}`}</span>
					</div>
				</>
			)}
		</div>
	)
}
