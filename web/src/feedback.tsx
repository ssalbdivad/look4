import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react"
import { Icon } from "./components/Icon.tsx"

type Tone = "info" | "good" | "bad"
type Toast = { id: number; message: string; tone: Tone; action?: { label: string; run: () => void } }
type ConfirmOpts = { title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean }

type Feedback = {
	toast: (message: string, opts?: { tone?: Tone; action?: Toast["action"] }) => void
	confirm: (opts: ConfirmOpts) => Promise<boolean>
}

const FeedbackContext = createContext<Feedback>({ toast: () => {}, confirm: async () => false })

export const useFeedback = () => useContext(FeedbackContext)

let nextId = 1

export const FeedbackProvider = ({ children }: { children: ReactNode }) => {
	const [toasts, setToasts] = useState<Toast[]>([])
	const [pending, setPending] = useState<(ConfirmOpts & { resolve: (ok: boolean) => void }) | null>(null)

	const dismiss = useCallback((id: number) => setToasts(ts => ts.filter(t => t.id !== id)), [])

	const toast = useCallback<Feedback["toast"]>(
		(message, opts = {}) => {
			const id = nextId++
			setToasts(ts => [...ts.slice(-3), { id, message, tone: opts.tone ?? "info", action: opts.action }])
			setTimeout(() => dismiss(id), opts.action ? 7000 : 4500)
		},
		[dismiss]
	)

	const confirm = useCallback<Feedback["confirm"]>(
		opts => new Promise<boolean>(resolve => setPending({ ...opts, resolve })),
		[]
	)

	const [value] = useState<Feedback>(() => ({ toast, confirm }))

	return (
		<FeedbackContext value={value}>
			{children}
			<div className="toasts" role="status" aria-live="polite">
				{toasts.map(t => (
					<div key={t.id} className={`toast toast-${t.tone}`}>
						<span className="toast-dot" aria-hidden="true" />
						<span className="toast-msg">{t.message}</span>
						{t.action && (
							<button
								type="button"
								className="btn btn-ghost btn-sm"
								onClick={() => {
									t.action?.run()
									dismiss(t.id)
								}}
							>
								{t.action.label}
							</button>
						)}
						<button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
							<Icon name="x" size={16} />
						</button>
					</div>
				))}
			</div>
			{pending && (
				<ConfirmDialog
					{...pending}
					onDone={ok => {
						pending.resolve(ok)
						setPending(null)
					}}
				/>
			)}
		</FeedbackContext>
	)
}

const ConfirmDialog = ({ title, body, confirmLabel = "Confirm", danger, onDone }: ConfirmOpts & { onDone: (ok: boolean) => void }) => (
	<Dialog open title={title} onClose={() => onDone(false)} size="sm">
		{body && <div className="dialog-body-text">{body}</div>}
		<div className="dialog-actions">
			<button type="button" className="btn btn-ghost" onClick={() => onDone(false)}>
				Cancel
			</button>
			<button
				type="button"
				className={danger ? "btn btn-danger" : "btn btn-primary"}
				autoFocus
				onClick={() => onDone(true)}
			>
				{confirmLabel}
			</button>
		</div>
	</Dialog>
)

/** A native modal <dialog>: the browser handles focus trapping, Escape and the top layer. */
export const Dialog = ({
	open,
	title,
	onClose,
	children,
	size = "md",
	className = ""
}: {
	open: boolean
	title: string
	onClose: () => void
	children: ReactNode
	size?: "sm" | "md" | "lg"
	className?: string
}) => {
	const ref = useRef<HTMLDialogElement>(null)
	const downOnBackdrop = useRef(false)
	useEffect(() => {
		const d = ref.current
		if (!d) return
		if (open && !d.open) {
			d.showModal()
			// showModal focuses the first control (the close button); a [data-autofocus] child asks for focus instead
			d.querySelector<HTMLElement>("[data-autofocus]")?.focus()
		}
		if (!open && d.open) d.close()
	}, [open])
	return (
		<dialog
			ref={ref}
			className={`dialog dialog-${size} ${className}`.trim()}
			aria-labelledby="dialog-title"
			onCancel={e => {
				e.preventDefault()
				onClose()
			}}
			onPointerDown={e => {
				downOnBackdrop.current = e.target === ref.current
			}}
			onClick={e => {
				// A click on the backdrop lands on the <dialog> element itself. Requiring the press to
				// start there too keeps a text selection dragged out of a field from closing the dialog.
				if (e.target === ref.current && downOnBackdrop.current) onClose()
			}}
		>
			<div className="dialog-inner">
				<header className="dialog-head">
					<h2 id="dialog-title">{title}</h2>
					<button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
						<Icon name="x" />
					</button>
				</header>
				{children}
			</div>
		</dialog>
	)
}
