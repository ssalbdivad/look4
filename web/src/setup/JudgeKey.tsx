import { type FormEvent, useState } from "react"
import type { SetupStatus } from "../../../src/api-types.ts"
import { api, errorMessage } from "../api.ts"
import { ErrorNote } from "../components/ui.tsx"
import { modelLabel } from "../format.ts"
import { PasswordInput } from "./ui.tsx"

/** "claude-haiku-5-5" → "Claude Haiku 5.5": format.ts modelLabel, the one place model ids get their names. */
export const modelName = (id: string) => modelLabel(id)

/** How the judge is reached, in words: "through your Claude Code login". */
export const judgeVia = (provider: string) =>
	provider === "claude-code"
		? "through your Claude Code login"
		: provider === "anthropic"
			? "with your Anthropic API key"
			: provider === "mock"
				? "in test mode (pretend answers)"
				: `via ${provider}`

export const hasJudge = (j: SetupStatus["judge"]) => j.ok && j.provider !== "none"

/** Paste an Anthropic API key; the server stores it in .env and switches the judge on without a restart. */
export const JudgeKeyForm = ({ onSaved, compact }: { onSaved: (s: SetupStatus) => void; compact?: boolean }) => {
	const [key, setKey] = useState("")
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const submit = async (e: FormEvent) => {
		e.preventDefault()
		if (!key.trim()) return
		setSaving(true)
		setError(null)
		try {
			onSaved(await api.saveJudgeKey({ apiKey: key.trim() }))
			setKey("")
		} catch (err) {
			setError(errorMessage(err))
		} finally {
			setSaving(false)
		}
	}
	return (
		<form className={compact ? "key-form is-compact" : "key-form"} onSubmit={submit}>
			<div className="field">
				<label className="field-label" htmlFor="judge-key">
					Anthropic API key
				</label>
				<div className="key-row">
					<PasswordInput id="judge-key" value={key} onChange={setKey} placeholder="sk-ant-…" describedBy="judge-key-help" />
					<button type="submit" className="btn btn-primary" disabled={!key.trim() || saving}>
						{saving && <span className="spinner" aria-hidden="true" />}
						Save key
					</button>
				</div>
				<span className="field-help" id="judge-key-help">
					Get one at{" "}
					<a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
						console.anthropic.com
					</a>{" "}
					→ API keys → Create key, then paste it here. look4 keeps it in a private file on this computer.
				</span>
			</div>
			{error && <ErrorNote message={error} />}
		</form>
	)
}
