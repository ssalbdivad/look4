import type { ReactNode } from "react"
import type { SourceDto } from "../../../src/api-types.ts"
import type { SourceConfig } from "../../../src/config.ts"
import { FolderFlow } from "./FolderFlow.tsx"
import { ReolinkFlow } from "./ReolinkFlow.tsx"
import { RtspFlow } from "./RtspFlow.tsx"
import { ChoiceCards, type ChoiceOption } from "./ui.tsx"

export type SourceKind = "reolink" | "rtsp" | "watch" | "upload"

const KINDS: ChoiceOption<SourceKind>[] = [
	{
		value: "reolink",
		title: "A Reolink camera",
		badge: "Recommended",
		icon: "camera",
		body: "look4 finds it on your network and keeps the moments its own motion detection flags, from its live stream or its memory card."
	},
	{
		value: "rtsp",
		title: "Another camera",
		icon: "camera",
		body: "Any network camera that can share a live stream (RTSP). look4 records it in short clips."
	},
	{
		value: "watch",
		title: "A folder on this computer",
		icon: "folder",
		body: "Where something else saves videos: a camera's upload folder, a recorder export, your phone's videos."
	},
	{
		value: "upload",
		title: "I'll just upload videos",
		icon: "upload",
		body: "Add videos with the Upload button whenever you like. You can connect a camera later."
	}
]

export const SourceKindChoice = ({
	value,
	onChange,
	withUpload
}: {
	value: SourceKind | null
	onChange: (k: SourceKind) => void
	withUpload: boolean
}) => (
	<ChoiceCards
		name="source-kind"
		label="Where your videos come from"
		value={value}
		onChange={onChange}
		columns={2}
		options={withUpload ? KINDS : KINDS.filter(k => k.value !== "upload")}
	/>
)

/** The connect flow for one kind of source; `existing` edits that source instead of adding one. */
export const ConnectFlow = ({
	kind,
	existing,
	takenNames,
	rtspHost,
	onBack,
	onSaved,
	onUseRtsp,
	notice,
	autoTest
}: {
	kind: Exclude<SourceKind, "upload">
	existing?: SourceConfig
	takenNames: string[]
	rtspHost?: string
	onBack: () => void
	onSaved: (s: SourceDto) => void
	onUseRtsp?: (host?: string) => void
	notice?: ReactNode
	autoTest?: boolean
}) => {
	if (kind === "reolink")
		return (
			<ReolinkFlow
				existing={existing?.type === "reolink" ? existing : undefined}
				takenNames={takenNames}
				onBack={onBack}
				onSaved={onSaved}
				onUseRtsp={onUseRtsp}
				notice={notice}
				autoTest={autoTest}
			/>
		)
	if (kind === "rtsp")
		return <RtspFlow existing={existing?.type === "rtsp" ? existing : undefined} initialHost={rtspHost} takenNames={takenNames} onBack={onBack} onSaved={onSaved} notice={notice} />
	return <FolderFlow existing={existing?.type === "watch" ? existing : undefined} takenNames={takenNames} onBack={onBack} onSaved={onSaved} notice={notice} />
}

export const kindOf = (c: SourceConfig): Exclude<SourceKind, "upload"> => c.type
