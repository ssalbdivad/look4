import { type FormEvent, type ReactNode, useState } from "react"
import type { SourceDto } from "../../../src/api-types.ts"
import type { WatchSourceConfig } from "../../../src/config.ts"
import { api, errorMessage } from "../api.ts"
import { Icon } from "../components/Icon.tsx"
import { ErrorNote, Skeleton } from "../components/ui.tsx"
import { plural } from "../format.ts"
import { useResource } from "../hooks.ts"
import { ChoiceCards, FlowActions, NameField, StepHead, toSourceName } from "./ui.tsx"

/** Watch a folder: pick it by clicking through folders (no typing paths), choose copy or move, save. */
export const FolderFlow = ({
	existing,
	takenNames = [],
	onBack,
	onSaved,
	notice
}: {
	existing?: WatchSourceConfig
	takenNames?: string[]
	onBack: () => void
	onSaved: (s: SourceDto) => void
	/** Shown under the heading, e.g. what is wrong with an existing source. */
	notice?: ReactNode
}) => {
	const [path, setPath] = useState<string | null>(existing?.dir ?? null)
	const [move, setMove] = useState<"copy" | "move">(existing?.move ? "move" : "copy")
	const [name, setName] = useState(existing?.name ?? "")
	const [nameTouched, setNameTouched] = useState(false)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const listing = useResource(s => api.listFolder(path, s), [path])
	const here = listing.data

	const open = (p: string) => setPath(p)
	// Until someone types a name, the name follows the folder: "NVR" → "nvr".
	const effectiveName = nameTouched || existing ? name : toSourceName(lastPart(here?.path ?? "") ?? "")

	const save = async (e: FormEvent) => {
		e.preventDefault()
		if (!here) return
		setSaving(true)
		setError(null)
		try {
			const s = existing
				? await api.updateSource(existing.name, { dir: here.path, move: move === "move" })
				: await api.addSource({ type: "watch", name: effectiveName || undefined, dir: here.path, move: move === "move" })
			onSaved(s)
		} catch (err) {
			setError(errorMessage(err))
		} finally {
			setSaving(false)
		}
	}

	const crumbs = here ? breadcrumbs(here.path) : []
	return (
		<form onSubmit={save}>
			<StepHead eyebrow="A folder" title={existing ? `Change ${existing.name}'s folder` : "Pick the folder your videos land in"}>
				<p>
					Any folder where videos show up: a camera's upload folder, an export from a video recorder, or your phone's synced
					videos. look4 checks it every few seconds for new ones.
				</p>
			</StepHead>
			{notice}
			<div className="picker">
				{here && (
					<div className="picker-shortcuts" role="list" aria-label="Places">
						{here.shortcuts.map(s => (
							<button key={s.path} type="button" role="listitem" className={s.path === here.path ? "pill is-on" : "pill"} onClick={() => open(s.path)}>
								<Icon name={/drive/i.test(s.label) ? "disk" : "folder"} size={16} />
								{s.label}
							</button>
						))}
					</div>
				)}
				<div className="picker-box">
					<div className="picker-path" aria-label="Current folder">
						{here?.parent && (
							<button type="button" className="icon-btn" aria-label="Up one folder" onClick={() => open(here.parent!)}>
								<Icon name="arrowLeft" size={18} />
							</button>
						)}
						<span className="crumbs">
							{crumbs.map((c, i) => (
								<span key={c.path}>
									{i > 0 && <span className="crumb-sep">/</span>}
									{i === crumbs.length - 1 ? (
										<strong>{c.label}</strong>
									) : (
										<button type="button" className="crumb" onClick={() => open(c.path)}>
											{c.label}
										</button>
									)}
								</span>
							))}
						</span>
					</div>
					{listing.error && <ErrorNote message={listing.error} onRetry={() => setPath(here?.parent ?? null)} />}
					{!here && !listing.error && <Skeleton style={{ height: 180, margin: 12 }} />}
					{here && (
						<ul className={listing.loading ? "picker-list is-busy" : "picker-list"}>
							{here.dirs.length === 0 && <li className="picker-none muted">No folders inside this one.</li>}
							{here.dirs.map(d => (
								<li key={d.path}>
									<button type="button" onClick={() => open(d.path)}>
										<Icon name="folder" size={18} />
										<span>{d.name}</span>
									</button>
								</li>
							))}
						</ul>
					)}
					{here && (
						<div className={here.videoCount ? "picker-count has-videos" : "picker-count"}>
							<Icon name="film" size={16} />
							{here.videoCount ? `${plural(here.videoCount, "video")} in this folder right now` : "No videos in this folder yet. That's fine if they'll arrive later."}
						</div>
					)}
				</div>
			</div>
			<div className="field">
				<span className="field-label">When a new video appears</span>
				<ChoiceCards
					name="watch-move"
					label="Copy or move"
					value={move}
					onChange={setMove}
					options={[
						{ value: "copy", title: "Copy it", badge: "Safest", body: "Your original stays right where it is. Uses a little more disk space." },
						{ value: "move", title: "Move it into look4", body: "The folder empties as look4 takes each video. Good for a camera that only uploads." }
					]}
				/>
			</div>
			{!existing && (
				<div className="field-row">
					<NameField
						id="wf-name"
						value={effectiveName}
						onChange={v => {
							setNameTouched(true)
							setName(v)
						}}
						taken={takenNames}
					/>
				</div>
			)}
			{error && <ErrorNote message={error} />}
			<FlowActions onBack={onBack}>
				<button type="submit" className="btn btn-primary" disabled={!here || saving || (!existing && takenNames.includes(effectiveName))}>
					{saving && <span className="spinner" aria-hidden="true" />}
					{here ? `Watch “${crumbs.at(-1)?.label ?? here.path}”` : "Watch this folder"}
				</button>
			</FlowActions>
		</form>
	)
}

const lastPart = (path: string) => path.split("/").filter(Boolean).at(-1)

/**
 * "/mnt/c/Users/David" → Computer › C: drive › Users › David, each with the path it opens. On WSL,
 * Windows drives live under /mnt/<letter>; people know them as "C: drive", not "mnt › c".
 */
const breadcrumbs = (path: string) => {
	const parts = path.split("/").filter(Boolean)
	const out = [{ label: "Computer", path: "/" }]
	parts.forEach((p, i) => {
		const at = `/${parts.slice(0, i + 1).join("/")}`
		if (i === 0 && p === "mnt" && /^[a-z]$/.test(parts[1] ?? "")) return
		if (i === 1 && parts[0] === "mnt" && /^[a-z]$/.test(p)) out.push({ label: `${p.toUpperCase()}: drive`, path: at })
		else out.push({ label: p, path: at })
	})
	return out
}
