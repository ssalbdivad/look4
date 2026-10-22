import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react"
import type { ClipSummary } from "../../src/api-types.ts"
import { errorMessage, uploadFile } from "./api.ts"
import { Icon } from "./components/Icon.tsx"
import { Mascot } from "./components/Mascot.tsx"
import { useFeedback } from "./feedback.tsx"
import { navigate } from "./router.tsx"

export const VIDEO_ACCEPT = "video/*,.mp4,.mov,.mkv,.avi,.webm,.m4v,.ts,.mts"
const VIDEO_EXT = /\.(mp4|mov|mkv|avi|webm|m4v|ts|mts|3gp|flv|wmv)$/i
const isVideo = (f: File) => f.type.startsWith("video/") || VIDEO_EXT.test(f.name)

type Item = {
	id: number
	name: string
	size: number
	progress: number
	state: "uploading" | "done" | "error"
	error?: string
	clip?: ClipSummary
	abort: () => void
}

type Upload = {
	upload: (files: FileList | File[]) => void
	pick: () => void
	/** Bumps after every finished upload so pages can refresh. */
	version: number
}

const UploadContext = createContext<Upload>({ upload: () => {}, pick: () => {}, version: 0 })
export const useUpload = () => useContext(UploadContext)

let nextId = 1

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files")

/** Drag a video anywhere on the page, or pick one, and it is uploaded and queued for processing. */
export const UploadProvider = ({ children }: { children: ReactNode }) => {
	const { toast } = useFeedback()
	const [items, setItems] = useState<Item[]>([])
	const [dragging, setDragging] = useState(false)
	const [version, setVersion] = useState(0)
	const input = useRef<HTMLInputElement>(null)

	const patch = (id: number, p: Partial<Item>) => setItems(xs => xs.map(x => (x.id === id ? { ...x, ...p } : x)))

	const upload = useCallback(
		(list: FileList | File[]) => {
			const files = Array.from(list)
			const videos = files.filter(isVideo)
			const skipped = files.length - videos.length
			if (skipped) toast(`Skipped ${skipped} file${skipped === 1 ? "" : "s"} that ${skipped === 1 ? "isn't a video" : "aren't videos"}`, { tone: "bad" })
			if (!videos.length) return
			let done = 0
			let ok = 0
			for (const file of videos) {
				const id = nextId++
				const { promise, abort } = uploadFile(file, progress => patch(id, { progress }))
				setItems(xs => [...xs, { id, name: file.name, size: file.size, progress: 0, state: "uploading", abort }])
				promise
					.then(res => {
						ok++
						patch(id, { state: "done", progress: 1, clip: res.clips[0] })
					})
					.catch(e => patch(id, { state: "error", error: errorMessage(e) }))
					.finally(() => {
						done++
						if (done < videos.length) return
						setVersion(v => v + 1)
						if (ok)
							toast(
								ok === 1 ? "Uploaded 1 clip. It is in the queue now." : `Uploaded ${ok} clips. They are in the queue now.`,
								{ tone: "good", action: { label: "Watch progress", run: () => navigate("/activity") } }
							)
					})
			}
		},
		[toast]
	)

	// Finished uploads clear themselves after a while; failures stay until dismissed.
	useEffect(() => {
		if (!items.length || items.some(i => i.state === "uploading")) return
		if (items.some(i => i.state === "error")) return
		const t = setTimeout(() => setItems([]), 4000)
		return () => clearTimeout(t)
	}, [items])

	useEffect(() => {
		let depth = 0
		const enter = (e: DragEvent) => {
			if (!hasFiles(e)) return
			e.preventDefault()
			depth++
			setDragging(true)
		}
		const over = (e: DragEvent) => {
			if (!hasFiles(e)) return
			e.preventDefault()
			if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"
		}
		const leave = (e: DragEvent) => {
			if (!hasFiles(e)) return
			depth = Math.max(0, depth - 1)
			if (!depth) setDragging(false)
		}
		const drop = (e: DragEvent) => {
			if (!hasFiles(e)) return
			e.preventDefault()
			depth = 0
			setDragging(false)
			if (e.dataTransfer?.files.length) upload(e.dataTransfer.files)
		}
		window.addEventListener("dragenter", enter)
		window.addEventListener("dragover", over)
		window.addEventListener("dragleave", leave)
		window.addEventListener("drop", drop)
		return () => {
			window.removeEventListener("dragenter", enter)
			window.removeEventListener("dragover", over)
			window.removeEventListener("dragleave", leave)
			window.removeEventListener("drop", drop)
		}
	}, [upload])

	const pick = useCallback(() => input.current?.click(), [])

	return (
		<UploadContext value={{ upload, pick, version }}>
			{children}
			<input
				ref={input}
				type="file"
				accept={VIDEO_ACCEPT}
				multiple
				hidden
				onChange={e => {
					if (e.target.files?.length) upload(e.target.files)
					e.target.value = ""
				}}
			/>
			<div className={dragging ? "drop-overlay is-on" : "drop-overlay"} aria-hidden={!dragging}>
				<div className="drop-card">
					<Mascot pose="looking" size={120} />
					<p className="drop-title">Drop videos to scan them</p>
					<p className="muted">Every lookout gets a look. Matches land in Sightings.</p>
				</div>
			</div>
			{items.length > 0 && (
				<section className="upload-tray" aria-label="Uploads">
					<header>
						<Icon name="upload" size={16} />
						<span>
							{items.some(i => i.state === "uploading")
								? `Uploading ${items.filter(i => i.state === "uploading").length} of ${items.length}`
								: "Uploads finished"}
						</span>
						<button type="button" className="icon-btn" aria-label="Close uploads" onClick={() => {
							for (const i of items) if (i.state === "uploading") i.abort()
							setItems([])
						}}>
							<Icon name="x" size={16} />
						</button>
					</header>
					<ul>
						{items.map(i => (
							<li key={i.id} className={`upload-item is-${i.state}`}>
								<div className="upload-name" title={i.name}>
									{i.name}
								</div>
								<div className="upload-meta">
									{i.state === "uploading" && `${Math.round(i.progress * 100)}%`}
									{i.state === "done" && (
										<>
											<Icon name="check" size={14} /> queued
										</>
									)}
									{i.state === "error" && i.error}
								</div>
								<div className="bar" aria-hidden="true">
									<span style={{ width: `${Math.round(i.progress * 100)}%` }} />
								</div>
							</li>
						))}
					</ul>
				</section>
			)}
		</UploadContext>
	)
}

/** An inline drop target for empty states; clicking it opens the file picker. */
export const DropZone = ({ compact }: { compact?: boolean }) => {
	const { pick } = useUpload()
	const [over, setOver] = useState(false)
	return (
		<button
			type="button"
			className={`dropzone${over ? " is-over" : ""}${compact ? " is-compact" : ""}`}
			onClick={pick}
			// The window-level handler does the upload; this only lights the target up.
			onDragOver={() => setOver(true)}
			onDragLeave={() => setOver(false)}
			onDrop={() => setOver(false)}
		>
			<span className="dropzone-icon">
				<Icon name="upload" size={compact ? 20 : 26} />
			</span>
			{/* phones can't drag files: there it's a plain button that opens the picker (CSS picks the words) */}
			<span className="dropzone-title say-fine">Drop a clip here, or click to choose</span>
			<span className="dropzone-title say-coarse">Tap to pick a video</span>
			{!compact && <span className="muted dropzone-sub">MP4, MOV, MKV, AVI or WebM. Anything ffmpeg can read.</span>}
		</button>
	)
}
