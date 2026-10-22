import { useCallback, useEffect, useRef, useState } from "react"
import { ApiError, errorMessage } from "./api.ts"

export type Resource<t> = {
	data: t | null
	error: string | null
	/** HTTP status of the last failure (0 = unreachable), null when the last load succeeded. */
	errorStatus: number | null
	loading: boolean
	reload: () => void
	setData: (update: (prev: t | null) => t | null) => void
}

/** Loads on mount and whenever `deps` change; keeps the last data while reloading so the page does not flash. */
export const useResource = <t>(load: (signal: AbortSignal) => Promise<t>, deps: unknown[]): Resource<t> => {
	const [data, setDataState] = useState<t | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [errorStatus, setErrorStatus] = useState<number | null>(null)
	const [loading, setLoading] = useState(true)
	const [tick, setTick] = useState(0)
	useEffect(() => {
		const ac = new AbortController()
		setLoading(true)
		load(ac.signal).then(
			d => {
				if (ac.signal.aborted) return
				setDataState(d)
				setError(null)
				setErrorStatus(null)
				setLoading(false)
			},
			e => {
				if (ac.signal.aborted) return
				setError(errorMessage(e))
				setErrorStatus(e instanceof ApiError ? e.status : 0)
				setLoading(false)
			}
		)
		return () => ac.abort()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [...deps, tick])
	const reload = useCallback(() => setTick(n => n + 1), [])
	const setData = useCallback((update: (prev: t | null) => t | null) => setDataState(update), [])
	return { data, error, errorStatus, loading, reload, setData }
}

export const useDebounced = <t>(value: t, ms: number): t => {
	const [v, setV] = useState(value)
	useEffect(() => {
		const id = setTimeout(() => setV(value), ms)
		return () => clearTimeout(id)
	}, [value, ms])
	return v
}

export const useDocumentTitle = (title: string) => {
	useEffect(() => {
		document.title = title ? `${title} · look4` : "look4"
	}, [title])
}

/** Re-renders every `ms` so relative times ("3m ago") stay honest. */
export const useNow = (ms = 30_000) => {
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), ms)
		return () => clearInterval(id)
	}, [ms])
	return now
}

/** The latest value of a callback without re-subscribing effects that use it. */
export const useLatest = <t>(value: t) => {
	const ref = useRef(value)
	ref.current = value
	return ref
}
